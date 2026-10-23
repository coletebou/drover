import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Serves `http://drover.mock` from `Fixtures` (or per-session overrides), mimicking the daemon's auth rules.
/// Used by tests and SwiftUI previews; never touches the network.
public final class MockURLProtocol: URLProtocol, @unchecked Sendable {
    public static let sessionHeader = "X-Drover-Mock"
    public static let mainToken = "mock-token"
    public static let widgetToken = "mock-widget-token"

    /// What the mock saw last (for assertions).
    public struct Recorded: Sendable {
        public let method: String
        public let url: URL
        public let headers: [String: String]
        public let body: Data?
        public let timeout: TimeInterval
        public var bodyJSON: JSONValue? { body.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) } }
        public func header(_ name: String) -> String? {
            headers.first { $0.key.caseInsensitiveCompare(name) == .orderedSame }?.value
        }
    }

    private struct State {
        var overrides: [String: [String: String]] = [:]
        var last: [String: Recorded] = [:]
    }
    private static let lock = NSLock()
    nonisolated(unsafe) private static var state = State()

    static func register(id: String, overrides: [String: String]) {
        lock.lock(); defer { lock.unlock() }
        state.overrides[id] = overrides
    }

    /// The registry id carried by a mock session (its `X-Drover-Mock` header).
    public static func sessionID(of session: URLSession) -> String? {
        session.configuration.httpAdditionalHeaders?[sessionHeader] as? String
    }

    /// Last request that reached the mock through `session`.
    public static func lastRequest(in session: URLSession) -> Recorded? {
        guard let id = sessionID(of: session) else { return nil }
        lock.lock(); defer { lock.unlock() }
        return state.last[id]
    }

    public override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "drover.mock" }
    public override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    public override func startLoading() {
        guard let url = request.url, let client else { return }
        let id = request.value(forHTTPHeaderField: Self.sessionHeader) ?? ""
        let body = Self.readBody(request)
        var headers: [String: String] = request.allHTTPHeaderFields ?? [:]
        headers.removeValue(forKey: Self.sessionHeader)
        let recorded = Recorded(method: request.httpMethod ?? "GET", url: url, headers: headers, body: body, timeout: request.timeoutInterval)
        Self.lock.lock()
        Self.state.last[id] = recorded
        let overrides = Self.state.overrides[id] ?? [:]
        Self.lock.unlock()

        let (status, contentType, payload) = Self.respond(url: url, auth: request.value(forHTTPHeaderField: "Authorization"), overrides: overrides)
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": contentType])!
        client.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client.urlProtocol(self, didLoad: Data(payload.utf8))
        client.urlProtocolDidFinishLoading(self)
    }

    public override func stopLoading() {}

    private static func readBody(_ request: URLRequest) -> Data? {
        if let b = request.httpBody { return b }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open(); defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }

    private static let json = "application/json"

    private static func respond(url: URL, auth: String?, overrides: [String: String]) -> (Int, String, String) {
        let bearer: String? = auth.flatMap { $0.hasPrefix("Bearer ") ? String($0.dropFirst(7)) : nil }
        let path = url.path
        let isStream = path.hasSuffix("/api/stream")
        guard let bearer, bearer == mainToken || bearer == widgetToken else {
            return (401, json, Fixtures.all["error.unauthorized.json"] ?? #"{"error":"unauthorized"}"#)
        }
        // Like the daemon: the widget token reaches only the two native ops (not the stream).
        let widgetOK = path.hasSuffix("/api/op/native.summary") || path.hasSuffix("/api/op/native.notifications")
        if bearer == widgetToken, !widgetOK {
            return (403, json, #"{"ok":false,"error":"widget token: read-only scope"}"#)
        }
        if isStream { return (200, "text/event-stream", Fixtures.all["events.sse.txt"] ?? "") }
        guard let range = path.range(of: "/api/op/") else {
            return (404, json, #"{"ok":false,"error":"not found"}"#)
        }
        let op = String(path[range.upperBound...])
        if bearer == widgetToken, op != "native.summary", op != "native.notifications" {
            return (403, json, #"{"ok":false,"error":"widget token: read-only scope"}"#)
        }
        if let o = overrides[op] { return (200, json, o) }
        let fixture: String
        switch op {
        case "tmux.keys", "tmux.answer": fixture = "tmux.send.json"
        case "sessions.lastReply":
            return (200, json, #"{"ok":true,"ms":5,"cache":null,"result":{"id":"demo-build","text":"Done. The build passes."}}"#)
        default: fixture = "\(op).json"
        }
        guard let body = Fixtures.all[fixture] else {
            return (400, json, #"{"ok":false,"error":"unknown op \#(op)"}"#)
        }
        return (200, json, body)
    }
}

public enum MockServer {
    public static let baseURL = URL(string: "http://drover.mock")!

    /// op -> raw JSON body that replaces the fixture for that op.
    public static func session(overrides: [String: String] = [:]) -> URLSession {
        let id = UUID().uuidString
        MockURLProtocol.register(id: id, overrides: overrides)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        config.httpAdditionalHeaders = [MockURLProtocol.sessionHeader: id]
        return URLSession(configuration: config)
    }

    /// A client for the mock; the store holds "mock-token" (main) and "mock-widget-token" (widget).
    public static func client(scope: TokenScope = .main) -> DroverClient {
        client(scope: scope, session: session())
    }

    public static func client(scope: TokenScope, session: URLSession) -> DroverClient {
        let store = InMemoryTokenStore([.main: MockURLProtocol.mainToken, .widget: MockURLProtocol.widgetToken])
        return DroverClient(baseURL: baseURL, tokens: store, scope: scope, session: session)
    }

    // Decoded fixtures for SwiftUI previews. FixturesInSync/ModelDecodingTests prove every fixture decodes.
    public static var summary: NativeSummary { decodeBare("native-summary.json") }
    public static var notifications: NativeNotifications { unwrap("native.notifications.json") }
    public static var sessions: SessionList { unwrap("sessions.list.json") }
    public static var transcript: Transcript { unwrap("sessions.transcript.json") }

    private static func decodeBare<T: Decodable>(_ name: String) -> T {
        // swiftlint:disable:next force_try
        try! JSONDecoder().decode(T.self, from: Fixtures.data(name)!)
    }

    private static func unwrap<T: Decodable & Sendable>(_ name: String) -> T {
        // swiftlint:disable:next force_try
        try! JSONDecoder().decode(OpEnvelope<T>.self, from: Fixtures.data(name)!).result!
    }
}
