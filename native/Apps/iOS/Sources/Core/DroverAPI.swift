import Foundation

/// Everything the iOS app asks of Drover. `HTTPDroverAPI` is the live implementation, `MockDroverAPI` serves
/// previews and logic tests. Views never build URLs themselves.
protocol DroverAPI: Sendable {
    func summary() async throws -> NativeSummary
    /// Items newer than `cursor`, oldest first. `wait` (seconds, max 25) long-polls on the daemon.
    func notifications(since cursor: String?, wait: Int?) async throws -> NotificationFeed
    func sessions(host: String?) async throws -> [SessionInfo]
    func transcript(_ ref: SessionRef, since: Int?, limit: Int) async throws -> TranscriptPage
    func lastReply(_ ref: SessionRef) async throws -> LastReply
    func message(_ ref: SessionRef, text: String) async throws -> MessageResult
    func capture(host: String?, target: String, lines: Int) async throws -> ScreenCapture
    func sendKeys(host: String?, target: String, keys: [PaneKey]) async throws -> PaneSendResult
    func sendToPane(host: String?, target: String, text: String, enter: Bool) async throws -> PaneSendResult
    /// Writes `data` into the session's upload inbox on its host and returns the absolute path.
    func upload(_ ref: SessionRef, name: String, mime: String, data: Data) async throws -> UploadResult
    func managerStatus(host: String?) async throws -> JSONValue
    func managerFeed(host: String?, limit: Int) async throws -> JSONValue
    func managerSweep(host: String?) async throws -> JSONValue
    /// Live server events (SSE). The stream ends on disconnect; callers reconnect with backoff.
    func events() -> AsyncThrowingStream<ServerEvent, Error>
}

enum DroverError: LocalizedError, Equatable, Sendable {
    case notConfigured
    case unauthorized
    /// The token is the read-only widget token and the op needs the main token.
    case forbidden
    case server(String)
    case http(Int)
    case decoding(String)
    case transport(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured: "Set the server address and token in Settings."
        case .unauthorized: "The server rejected the token. Check it in Settings."
        case .forbidden: "This token is read-only. Add the main token in Settings to do this."
        case .server(let m): m
        case .http(let code): "The server answered HTTP \(code)."
        case .decoding(let m): "Unexpected server response (\(m))."
        case .transport(let m): m
        }
    }
}

/// Talks to the daemon: `POST /api/op/<op>` with a JSON body, `GET /api/stream` for SSE.
struct HTTPDroverAPI: DroverAPI {
    let baseURL: URL
    /// Read on every request so a token change in Settings applies without rebuilding the client.
    let token: @Sendable () -> String?
    var session: URLSession = .shared

    init(baseURL: URL, token: @escaping @Sendable () -> String?, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
    }

    // MARK: generic op call

    private struct Envelope<R: Decodable>: Decodable {
        var ok: Bool?
        var result: R?
        var error: String?
    }

    private struct ErrorEnvelope: Decodable { var error: String? }

    func op<R: Decodable & Sendable>(_ name: String, _ args: [String: JSONValue] = [:], as _: R.Type = R.self,
                                     timeout: TimeInterval = 30) async throws -> R {
        guard let token = token(), !token.isEmpty else { throw DroverError.notConfigured }
        var req = URLRequest(url: baseURL.appending(path: "api/op/\(name)"))
        req.httpMethod = "POST"
        req.timeoutInterval = timeout
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.httpBody = try JSONEncoder().encode(args.filter { $0.value != .null })

        let data: Data
        let response: URLResponse
        do { (data, response) = try await session.data(for: req) }
        catch { throw DroverError.transport(error.localizedDescription) }

        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401 { throw DroverError.unauthorized }
        if code == 403 { throw DroverError.forbidden }
        guard (200..<300).contains(code) else {
            if let msg = try? JSONDecoder().decode(ErrorEnvelope.self, from: data).error { throw DroverError.server(msg) }
            throw DroverError.http(code)
        }
        return try Self.decodeResult(data, op: name)
    }

    /// Unwraps a `{ ok, result, error }` envelope (also used by the fixture tests).
    static func decodeResult<R: Decodable>(_ data: Data, op name: String, as _: R.Type = R.self) throws -> R {
        let env: Envelope<R>
        do { env = try JSONDecoder().decode(Envelope<R>.self, from: data) }
        catch { throw DroverError.decoding("\(name): \(error)") }
        if env.ok == false { throw DroverError.server(env.error ?? "\(name) failed") }
        guard let result = env.result else { throw DroverError.decoding("\(name): no result") }
        return result
    }

    private static func hostArgs(_ host: String?) -> [String: JSONValue] {
        guard let h = host, !h.isEmpty, h != localHostName else { return [:] }
        return ["host": .string(h)]
    }

    private static func merge(_ a: [String: JSONValue], _ b: [String: JSONValue]) -> [String: JSONValue] {
        a.merging(b) { _, new in new }
    }

    // MARK: ops

    func summary() async throws -> NativeSummary { try await op("native.summary") }

    func notifications(since cursor: String?, wait: Int?) async throws -> NotificationFeed {
        var args: [String: JSONValue] = ["limit": .number(50)]
        if let cursor { args["since"] = .string(cursor) }
        if let wait { args["wait"] = .number(Double(min(max(wait, 0), 25))) }
        return try await op("native.notifications", args, timeout: TimeInterval((wait ?? 0) + 30))
    }

    func sessions(host: String?) async throws -> [SessionInfo] {
        let list: SessionList = try await op("sessions.list",
                                             Self.merge(Self.hostArgs(host), ["includeRecent": .bool(false)]))
        let tag = host ?? localHostName
        return list.sessions.map { var s = $0; s.host = tag; return s }
    }

    func transcript(_ ref: SessionRef, since: Int?, limit: Int) async throws -> TranscriptPage {
        var args = Self.merge(Self.hostArgs(ref.hostArg), ["id": .string(ref.id), "limit": .number(Double(limit))])
        if let since { args["since"] = .number(Double(since)) }
        return try await op("sessions.transcript", args)
    }

    func lastReply(_ ref: SessionRef) async throws -> LastReply {
        try await op("sessions.lastReply", Self.merge(Self.hostArgs(ref.hostArg), ["id": .string(ref.id)]))
    }

    func message(_ ref: SessionRef, text: String) async throws -> MessageResult {
        // The manager answers inline and can take minutes; ordinary sessions return on delivery.
        try await op("sessions.message",
                     Self.merge(Self.hostArgs(ref.hostArg),
                                ["id": .string(ref.id), "text": .string(text), "actor": .string(DroverIDs.actor)]),
                     timeout: ref.id == SessionRef.manager.id ? 900 : 60)
    }

    func capture(host: String?, target: String, lines: Int) async throws -> ScreenCapture {
        try await op("tmux.capture",
                     Self.merge(Self.hostArgs(host), ["target": .string(target), "lines": .number(Double(lines))]))
    }

    func sendKeys(host: String?, target: String, keys: [PaneKey]) async throws -> PaneSendResult {
        try await op("tmux.keys",
                     Self.merge(Self.hostArgs(host),
                                ["target": .string(target), "keys": .array(keys.map { .string($0.rawValue) })]))
    }

    func sendToPane(host: String?, target: String, text: String, enter: Bool) async throws -> PaneSendResult {
        try await op("tmux.send",
                     Self.merge(Self.hostArgs(host),
                                ["target": .string(target), "text": .string(text), "enter": .bool(enter),
                                 "actor": .string(DroverIDs.actor)]))
    }

    func upload(_ ref: SessionRef, name: String, mime: String, data: Data) async throws -> UploadResult {
        try await op("uploads.put",
                     Self.merge(Self.hostArgs(ref.hostArg),
                                ["session": .string(ref.id), "name": .string(name), "mime": .string(mime),
                                 "data": .string(data.base64EncodedString()), "actor": .string(DroverIDs.actor)]),
                     timeout: 120)
    }

    func managerStatus(host: String?) async throws -> JSONValue { try await op("openclaw.status", Self.hostArgs(host)) }

    func managerFeed(host: String?, limit: Int) async throws -> JSONValue {
        try await op("openclaw.feed", Self.merge(Self.hostArgs(host), ["limit": .number(Double(limit))]))
    }

    func managerSweep(host: String?) async throws -> JSONValue {
        try await op("openclaw.sweep", Self.merge(Self.hostArgs(host), ["actor": .string(DroverIDs.actor)]))
    }

    // MARK: SSE

    func events() -> AsyncThrowingStream<ServerEvent, Error> {
        let base = baseURL, token = token, session = session
        return AsyncThrowingStream { continuation in
            let task = Task {
                guard let t = token(), !t.isEmpty else { continuation.finish(throwing: DroverError.notConfigured); return }
                var req = URLRequest(url: base.appending(path: "api/stream"))
                req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
                req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                req.timeoutInterval = 3600
                do {
                    let (bytes, response) = try await session.bytes(for: req)
                    let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                    if code == 401 { throw DroverError.unauthorized }
                    if code == 403 { throw DroverError.forbidden }
                    guard (200..<300).contains(code) else { throw DroverError.http(code) }
                    // Split lines by hand: `bytes.lines` skips empty lines, and SSE dispatches on them.
                    var parser = SSEParser()
                    var line = SSELineBuffer()
                    for try await byte in bytes {
                        guard let l = line.feed(byte) else { continue }
                        if let ev = parser.feed(l) { continuation.yield(ev) }
                    }
                    if let ev = parser.flush() { continuation.yield(ev) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

/// Line-oriented Server-Sent Events parser: `event:`, `data:` (multi-line joined with "\n"), `:` comments,
/// dispatch on a blank line. A new `event:` while data is pending also dispatches, to survive a lost blank line.
struct SSEParser: Sendable {
    private var name: String?
    private var data: [String] = []

    mutating func feed(_ rawLine: String) -> ServerEvent? {
        let line = rawLine.hasSuffix("\r") ? String(rawLine.dropLast()) : rawLine
        if line.isEmpty { return flush() }
        if line.hasPrefix(":") { return nil }
        let (field, value) = Self.split(line)
        switch field {
        case "event":
            let pending = data.isEmpty ? nil : flush()
            name = value
            return pending
        case "data":
            data.append(value)
            return nil
        default:
            return nil
        }
    }

    /// Dispatches the pending event. Per the SSE spec, an event without data is dropped.
    mutating func flush() -> ServerEvent? {
        defer { name = nil; data = [] }
        guard !data.isEmpty else { return nil }
        return ServerEvent(name: name ?? "message", data: data.joined(separator: "\n"))
    }

    private static func split(_ line: String) -> (String, String) {
        guard let i = line.firstIndex(of: ":") else { return (line, "") }
        var v = line[line.index(after: i)...]
        if v.first == " " { v = v.dropFirst() }
        return (String(line[..<i]), String(v))
    }
}

/// Collects bytes into UTF-8 lines, keeping empty lines (LF or CRLF terminated). Caps a line at 1 MB.
struct SSELineBuffer: Sendable {
    private var bytes: [UInt8] = []

    mutating func feed(_ byte: UInt8) -> String? {
        if byte == 0x0A {
            defer { bytes.removeAll(keepingCapacity: true) }
            if bytes.last == 0x0D { bytes.removeLast() }
            return String(decoding: bytes, as: UTF8.self)
        }
        if bytes.count < 1 << 20 { bytes.append(byte) }
        return nil
    }
}
