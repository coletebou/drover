import Foundation

enum StreamUpdate: Sendable, Equatable {
    case connected
    case event(SSEEvent)
    case disconnected(DroverError)
}

/// SSE connection with reconnect and exponential backoff (1, 2, 4 ... 60 s, plus up to 20% jitter).
struct EventStream: Sendable {
    let makeRequest: @Sendable () throws -> URLRequest
    let transport: any HTTPTransport
    let sleep: @Sendable (Duration) async throws -> Void

    init(
        makeRequest: @escaping @Sendable () throws -> URLRequest,
        transport: any HTTPTransport,
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.makeRequest = makeRequest
        self.transport = transport
        self.sleep = sleep
    }

    /// Cancelling the consumer (or dropping the stream) cancels the connection task.
    func updates() -> AsyncStream<StreamUpdate> {
        AsyncStream { continuation in
            let task = Task {
                await run(continuation)
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func run(_ out: AsyncStream<StreamUpdate>.Continuation) async {
        var attempt = 0
        let clock = ContinuousClock()
        while !Task.isCancelled {
            do {
                let request = try makeRequest()
                let (lines, response) = try await transport.lines(for: request)
                if response.statusCode == 401 || response.statusCode == 403 {
                    out.yield(.disconnected(.unauthorized))
                    return
                }
                guard (200..<300).contains(response.statusCode) else { throw DroverError.http(response.statusCode) }
                out.yield(.connected)
                let started = clock.now
                var parser = SSEParser()
                for try await line in lines {
                    if let event = parser.feed(line) {
                        // Not on the first event: the daemon sends `hello` on every connect, so only
                        // a connection that stayed up resets the backoff.
                        if attempt > 0, clock.now - started > .seconds(30) { attempt = 0 }
                        out.yield(.event(event))
                    }
                }
                if clock.now - started > .seconds(30) { attempt = 0 }
                out.yield(.disconnected(.transport("The connection closed.")))
            } catch {
                if Task.isCancelled || error is CancellationError { return }
                let mapped = DroverError.from(error)
                out.yield(.disconnected(mapped))
                if case .missingToken = mapped { return }
            }
            let base = min(60.0, pow(2.0, Double(attempt)))
            attempt += 1
            let delay = base * (1 + Double.random(in: 0...0.2))
            do { try await sleep(.seconds(delay)) } catch { return }
        }
    }
}
