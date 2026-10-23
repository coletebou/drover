import Foundation

/// Production transport. Ephemeral sessions: no cookies, no URL cache, nothing written to disk.
struct URLSessionTransport: HTTPTransport {
    private let dataSession: URLSession
    /// For the rare request that asks for more than the default (`URLRequest.timeoutInterval` above 60 s).
    private let longSession: URLSession
    private let streamSession: URLSession

    init() {
        let data = URLSessionConfiguration.ephemeral
        data.httpCookieStorage = nil
        data.httpShouldSetCookies = false
        data.urlCache = nil
        data.requestCachePolicy = .reloadIgnoringLocalCacheData
        data.timeoutIntervalForRequest = 30
        dataSession = URLSession(configuration: data)

        let long = URLSessionConfiguration.ephemeral
        long.httpCookieStorage = nil
        long.httpShouldSetCookies = false
        long.urlCache = nil
        long.requestCachePolicy = .reloadIgnoringLocalCacheData
        long.timeoutIntervalForRequest = 960
        longSession = URLSession(configuration: long)

        let stream = URLSessionConfiguration.ephemeral
        stream.httpCookieStorage = nil
        stream.httpShouldSetCookies = false
        stream.urlCache = nil
        stream.requestCachePolicy = .reloadIgnoringLocalCacheData
        // The server pings every 20 s, so 90 s of silence means the connection is dead.
        stream.timeoutIntervalForRequest = 90
        stream.timeoutIntervalForResource = .infinity
        streamSession = URLSession(configuration: stream)
    }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let session = request.timeoutInterval > 60 ? longSession : dataSession
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw DroverError.transport("Cannot reach the server.") }
        return (data, http)
    }

    func lines(for request: URLRequest) async throws -> (AsyncThrowingStream<String, Error>, HTTPURLResponse) {
        let (bytes, response) = try await streamSession.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw DroverError.transport("Cannot reach the server.") }
        guard (200..<300).contains(http.statusCode) else {
            return (AsyncThrowingStream { $0.finish() }, http)
        }
        let stream = AsyncThrowingStream<String, Error> { continuation in
            let task = Task {
                var splitter = LineSplitter()
                do {
                    for try await byte in bytes {
                        if let line = splitter.feed(byte) { continuation.yield(line) }
                    }
                    if let rest = splitter.finish() { continuation.yield(rest) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
        return (stream, http)
    }
}

/// Splits bytes on `\n`, strips a trailing `\r`, and keeps blank lines (SSE needs them).
struct LineSplitter {
    private var buffer: [UInt8] = []

    mutating func feed(_ byte: UInt8) -> String? {
        guard byte == 0x0A else {
            buffer.append(byte)
            return nil
        }
        if buffer.last == 0x0D { buffer.removeLast() }
        defer { buffer.removeAll(keepingCapacity: true) }
        return String(decoding: buffer, as: UTF8.self)
    }

    mutating func finish() -> String? {
        guard !buffer.isEmpty else { return nil }
        if buffer.last == 0x0D { buffer.removeLast() }
        defer { buffer.removeAll() }
        return String(decoding: buffer, as: UTF8.self)
    }
}
