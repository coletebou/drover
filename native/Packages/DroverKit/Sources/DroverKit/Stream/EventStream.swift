import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum StreamUpdate: Sendable, Equatable {
    case connecting, open, waiting(retryIn: Duration), stopped(DroverError)
    case event(ServerEvent)
}

/// Reconnecting SSE client for `/api/stream`.
public struct EventStream: Sendable {
    public typealias Connect = @Sendable (URLRequest) async throws -> (status: Int, lines: AsyncThrowingStream<String, any Error>)

    private let request: @Sendable () async throws -> URLRequest
    private let backoff: Backoff
    private let connect: Connect
    /// A connection resets the backoff only if it delivered an event and stayed up this long, so a daemon that
    /// sends `hello` and drops the connection at once still backs off. Internal so tests can shorten it.
    var healthyAfter: Duration = .seconds(10)

    public init(request: @escaping @Sendable () async throws -> URLRequest, backoff: Backoff = .standard, connect: Connect? = nil) {
        self.request = request
        self.backoff = backoff
        if let connect {
            self.connect = connect
        } else {
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = 90
            config.timeoutIntervalForResource = 7 * 24 * 3600
            let session = URLSession(configuration: config)
            self.connect = { req in try await Self.sessionConnect(session, req) }
        }
    }

    /// Connects on first iteration, reconnects with backoff forever, resets backoff after a good connection,
    /// ends with .stopped on 401/403 or a missing configuration, ends when the consumer cancels.
    public func updates() -> AsyncStream<StreamUpdate> {
        let (stream, continuation) = AsyncStream<StreamUpdate>.makeStream(bufferingPolicy: .bufferingNewest(256))
        let request = self.request, backoff = self.backoff, connect = self.connect, healthyAfter = self.healthyAfter
        let task = Task {
            await Self.run(request: request, backoff: backoff, connect: connect, healthyAfter: healthyAfter, continuation: continuation)
            continuation.finish()
        }
        continuation.onTermination = { _ in task.cancel() }
        return stream
    }

    private static func run(request: @Sendable () async throws -> URLRequest, backoff: Backoff, connect: Connect,
                            healthyAfter: Duration, continuation: AsyncStream<StreamUpdate>.Continuation) async {
        var attempt = 0
        var serverRetry: Duration?
        while !Task.isCancelled {
            continuation.yield(.connecting)
            var deliveredEvent = false
            var openedAt: ContinuousClock.Instant?
            do {
                let req: URLRequest
                do {
                    req = try await request()
                } catch let e as DroverError where e == .notConfigured || e == .unauthorized {
                    continuation.yield(.stopped(e))
                    return
                }
                let (status, lines) = try await connect(req)
                if status == 401 { continuation.yield(.stopped(.unauthorized)); return }
                if status == 403 { continuation.yield(.stopped(.forbidden(nil))); return }
                guard (200..<300).contains(status) else {
                    throw DroverError.server(status: status, message: nil)
                }
                continuation.yield(.open)
                openedAt = .now
                var parser = SSEParser()
                for try await line in lines {
                    if let event = parser.feed(line: line) {
                        deliveredEvent = true
                        continuation.yield(.event(event))
                    }
                    serverRetry = parser.retry ?? serverRetry
                }
            } catch {
                if Task.isCancelled || error is CancellationError { return }
            }
            if Task.isCancelled { return }
            if deliveredEvent, let openedAt, ContinuousClock.now - openedAt >= healthyAfter { attempt = 0 }
            var b = backoff
            if let serverRetry { b.initial = serverRetry }
            let delay = b.delay(attempt: attempt)
            continuation.yield(.waiting(retryIn: delay))
            do { try await Task.sleep(for: delay) } catch { return }
            attempt += 1
        }
    }

#if canImport(Darwin)
    static func sessionConnect(_ session: URLSession, _ req: URLRequest) async throws -> (status: Int, lines: AsyncThrowingStream<String, any Error>) {
        let (bytes, response): (URLSession.AsyncBytes, URLResponse)
        do {
            (bytes, response) = try await session.bytes(for: req)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw DroverError.transport(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else { throw DroverError.transport("Not an HTTP response") }
        let (lines, continuation) = AsyncThrowingStream<String, any Error>.makeStream()
        let task = Task {
            do {
                var buffer: [UInt8] = []
                for try await byte in bytes {
                    if byte == 0x0A {
                        if buffer.last == 0x0D { buffer.removeLast() }
                        continuation.yield(String(decoding: buffer, as: UTF8.self))
                        buffer.removeAll(keepingCapacity: true)
                    } else {
                        buffer.append(byte)
                    }
                }
                continuation.finish()
            } catch is CancellationError {
                continuation.finish()
            } catch {
                continuation.finish(throwing: DroverError.transport(error.localizedDescription))
            }
        }
        continuation.onTermination = { _ in task.cancel() }
        return (http.statusCode, lines)
    }
#else
    /// URLSession.bytes(for:) does not exist in swift-corelibs-foundation. Linux builds exist for
    /// CI of the portable logic (parser, backoff, reconnect loop with a fake connection).
    static func sessionConnect(_ session: URLSession, _ req: URLRequest) async throws -> (status: Int, lines: AsyncThrowingStream<String, any Error>) {
        throw DroverError.transport("Live event streaming needs an Apple platform")
    }
#endif
}
