import Foundation

/// One SSE connection, read in chunks by a URLSession data delegate on its own serial queue (never the main actor).
///
/// It replaces `URLSession.bytes` + `for try await byte in bytes`: one async step per byte cost about a second of CPU per
/// megabyte, and an older daemon sends a 1.3 MB `fleet` event every 20 s. Lines are cut with memchr-speed searches over
/// each chunk, the data lines of events the app never reads are dropped undecoded, and every message is mapped (JSON
/// decoded) here before it reaches the app.
final class SSEConnection: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    enum Failure: LocalizedError {
        case status(Int)
        var errorDescription: String? { if case .status(let c) = self { "HTTP \(c)" } else { nil } }
    }

    // Touched only on `queue` (the delegate queue), which is what makes the @unchecked Sendable sound.
    private let queue: OperationQueue = {
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        q.name = "dev.drover.sse"
        q.qualityOfService = .utility
        return q
    }()
    private var parser: SSEParser
    private var buffer = Data()
    private var scanned = 0
    /// Dropping the rest of a skipped event's data line that has not ended yet.
    private var skippingLine = false
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var continuation: CheckedContinuation<Void, Error>?
    private var cancelled = false
    private let onOpen: @Sendable () -> Void
    private let onMessage: @Sendable (SSEParser.Message) -> Void

    init(skipData: Set<String>, onOpen: @escaping @Sendable () -> Void, onMessage: @escaping @Sendable (SSEParser.Message) -> Void) {
        parser = SSEParser(skipData: skipData)
        self.onOpen = onOpen
        self.onMessage = onMessage
    }

    /// Runs until the server closes the stream, the request fails (throws), or the calling task is cancelled.
    func run(_ request: URLRequest, idleTimeout: TimeInterval) async throws {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                queue.addOperation {
                    if self.cancelled { cont.resume(throwing: CancellationError()); return }
                    self.continuation = cont
                    let config = URLSessionConfiguration.ephemeral
                    // The daemon pings every 20 s: silence for longer than this is a dead connection.
                    config.timeoutIntervalForRequest = idleTimeout
                    config.timeoutIntervalForResource = 7 * 24 * 3600
                    config.requestCachePolicy = .reloadIgnoringLocalCacheData
                    let session = URLSession(configuration: config, delegate: self, delegateQueue: self.queue)
                    self.session = session
                    let task = session.dataTask(with: request)
                    self.task = task
                    task.resume()
                }
            }
        } onCancel: {
            queue.addOperation {
                self.cancelled = true
                self.task?.cancel()
            }
        }
    }

    private func finish(_ error: Error?) {
        session?.finishTasksAndInvalidate()
        session = nil
        task = nil
        guard let c = continuation else { return }
        continuation = nil
        if cancelled { c.resume(throwing: CancellationError()) }
        else if let error { c.resume(throwing: error) }
        else { c.resume() }
    }

    // MARK: URLSessionDataDelegate (on `queue`)

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void) {
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            completionHandler(.cancel)
            finish(code == 401 ? DroverError.unauthorized : Failure.status(code))
            return
        }
        onOpen()
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        consume(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        // A cancelled task after a non-2xx response already finished with the status.
        if let e = error as? URLError, e.code == .cancelled, continuation == nil { return }
        finish(error)
    }

    /// Split into lines and feed the parser. Visible for the harness (`feedForTesting`).
    private func consume(_ chunk: Data) {
        var chunk = chunk[...]
        if skippingLine {
            guard let nl = chunk.firstIndex(of: 0x0A) else { return }
            skippingLine = false
            parser.skippedDataLine()
            chunk = chunk[(nl + 1)...]
        }
        buffer.append(contentsOf: chunk)
        var start = buffer.startIndex
        // Bytes before `scanned` held no newline last time: a long line arriving in many chunks is searched once.
        var from = buffer.startIndex + scanned
        while let nl = buffer[from...].firstIndex(of: 0x0A) {
            let line = buffer[start..<nl]
            if parser.isSkipping && line.starts(with: Self.dataPrefix) {
                parser.skippedDataLine()
            } else if let m = parser.feed(line: String(decoding: line, as: UTF8.self)) {
                onMessage(m)
            }
            start = nl + 1
            from = start
        }
        if start > buffer.startIndex { buffer.removeSubrange(buffer.startIndex..<start) }
        scanned = buffer.count
        // A skipped event's data line still arriving: drop what came so far instead of buffering a megabyte of it.
        if parser.isSkipping && buffer.starts(with: Self.dataPrefix) {
            buffer.removeAll(keepingCapacity: true)
            scanned = 0
            skippingLine = true
        }
    }

    private static let dataPrefix = Data("data:".utf8)

    /// The harness drives the line splitting with chunks cut anywhere.
    func feedForTesting(_ chunks: [Data]) {
        for c in chunks { consume(c) }
    }
}
