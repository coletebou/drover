import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// HTTP client for Drover's `/api/op/<op>` surface. The token goes in the Authorization header only.
public struct DroverClient: Sendable {
    public let baseURL: URL
    public let scope: TokenScope
    private let tokens: any TokenStore
    let session: URLSession   // internal: EventStream(client:) streams through the same session (mocks included)
    private let actor: String

    /// `actor` is who the truth file records for writes. The default, `owner`, is the generic actor of the owner's
    /// own clients: the daemon records it as its configured owner (`DROVER_OWNER`).
    public init(baseURL: URL, tokens: any TokenStore, scope: TokenScope = .main,
                session: URLSession = .shared, actor: String = "owner") {
        self.baseURL = baseURL
        self.tokens = tokens
        self.scope = scope
        self.session = session
        self.actor = actor
    }

    /// Same daemon and store, other scope (a widget client from an app client).
    public func scoped(_ scope: TokenScope) -> DroverClient {
        DroverClient(baseURL: baseURL, tokens: tokens, scope: scope, session: session, actor: actor)
    }

    // MARK: generic

    public func call<T: Decodable & Sendable>(_ op: String, _ args: [String: JSONValue] = [:], as type: T.Type) async throws -> T {
        var request = try await authorized(opURL(op), timeout: Self.timeout(args))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        do {
            request.httpBody = try JSONEncoder().encode(args)
        } catch {
            throw DroverError.decoding("\(op): cannot encode arguments")
        }
        return try await perform(request, op: op, as: type)
    }

    public func get<T: Decodable & Sendable>(_ op: String, _ query: [String: String] = [:], as type: T.Type) async throws -> T {
        var url = try opURL(op)
        if !query.isEmpty, var comps = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            comps.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
            if let u = comps.url { url = u }
        }
        var request = try await authorized(url, timeout: 30)
        request.httpMethod = "GET"
        return try await perform(request, op: op, as: type)
    }

    /// Authorized GET /api/stream request for EventStream. The server pings every 20 s.
    public func streamRequest() async throws -> URLRequest {
        var request = try await authorized(baseURL.appending(path: "api/stream"), timeout: 90)
        request.httpMethod = "GET"
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        return request
    }

    // MARK: typed ops

    public func summary() async throws -> NativeSummary {
        try await call("native.summary", as: NativeSummary.self)
    }

    public func notifications(since cursor: String?, limit: Int? = nil, wait: Int? = nil) async throws -> NativeNotifications {
        var args: [String: JSONValue] = [:]
        if let cursor { args["since"] = .string(cursor) }
        if let limit { args["limit"] = .number(Double(limit)) }
        if let wait { args["wait"] = .number(Double(wait)) }
        return try await call("native.notifications", args, as: NativeNotifications.self)
    }

    public func hosts() async throws -> [HostEntry] {
        try await call("host.list", as: [HostEntry].self)
    }

    public func sessions(host: String? = nil) async throws -> SessionList {
        var args: [String: JSONValue] = ["includeRecent": .bool(false)]
        Self.put(&args, host: host)
        return try await call("sessions.list", args, as: SessionList.self)
    }

    public func transcript(id: String, host: String? = nil, since: Int? = nil, limit: Int? = nil) async throws -> Transcript {
        var args: [String: JSONValue] = ["id": .string(id)]
        Self.put(&args, host: host)
        if let since { args["since"] = .number(Double(since)) }
        if let limit { args["limit"] = .number(Double(limit)) }
        return try await call("sessions.transcript", args, as: Transcript.self)
    }

    public func lastReply(id: String, host: String? = nil) async throws -> JSONValue {
        var args: [String: JSONValue] = ["id": .string(id)]
        Self.put(&args, host: host)
        return try await call("sessions.lastReply", args, as: JSONValue.self)
    }

    public func sendMessage(id: String, text: String, host: String? = nil) async throws -> MessageDelivery {
        var args: [String: JSONValue] = ["id": .string(id), "text": .string(text), "actor": .string(actor)]
        Self.put(&args, host: host)
        return try await call("sessions.message", args, as: MessageDelivery.self)
    }

    public func capture(target: String, host: String? = nil, lines: Int? = nil) async throws -> PaneCapture {
        var args: [String: JSONValue] = ["target": .string(target)]
        Self.put(&args, host: host)
        if let lines { args["lines"] = .number(Double(lines)) }
        return try await call("tmux.capture", args, as: PaneCapture.self)
    }

    public func sendToPane(target: String, text: String, host: String? = nil, enter: Bool = true, force: Bool = false) async throws -> PaneSendResult {
        var args: [String: JSONValue] = [
            "target": .string(target), "text": .string(text),
            "enter": .bool(enter), "force": .bool(force), "actor": .string(actor),
        ]
        Self.put(&args, host: host)
        return try await call("tmux.send", args, as: PaneSendResult.self)
    }

    public func sendKeys(target: String, keys: [String], host: String? = nil) async throws -> PaneSendResult {
        var args: [String: JSONValue] = ["target": .string(target), "keys": .array(keys.map { .string($0) })]
        Self.put(&args, host: host)
        return try await call("tmux.keys", args, as: PaneSendResult.self)
    }

    public func answer(target: String, key: String, expect: String? = nil, host: String? = nil) async throws -> PaneSendResult {
        var args: [String: JSONValue] = ["target": .string(target), "key": .string(key), "actor": .string(actor)]
        Self.put(&args, host: host)
        if let expect { args["expect"] = .string(expect) }
        return try await call("tmux.answer", args, as: PaneSendResult.self)
    }

    public func fleetSummary() async throws -> JSONValue {
        try await call("fleet.summary", as: JSONValue.self)
    }

    // MARK: internals

    private static func put(_ args: inout [String: JSONValue], host: String?) {
        if let host, !host.isEmpty { args["host"] = .string(host) }
    }

    private static func timeout(_ args: [String: JSONValue]) -> TimeInterval {
        30 + (args["wait"]?.doubleValue ?? 0)
    }

    private func opURL(_ op: String) throws -> URL {
        baseURL.appending(path: "api/op/\(op)")
    }

    private func authorized(_ url: URL, timeout: TimeInterval) async throws -> URLRequest {
        let token: String?
        do {
            token = try await tokens.token(for: scope)
        } catch is CancellationError {
            throw DroverError.cancelled
        } catch {
            throw DroverError.notConfigured
        }
        guard let token, !token.isEmpty else { throw DroverError.notConfigured }
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    private struct ErrorProbe: Decodable {
        var ok: Bool?
        var error: String?
    }

    private func perform<T: Decodable & Sendable>(_ request: URLRequest, op: String, as type: T.Type) async throws -> T {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch is CancellationError {
            throw DroverError.cancelled
        } catch let e as URLError where e.code == .cancelled {
            throw DroverError.cancelled
        } catch {
            throw DroverError.transport(error.localizedDescription)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let probe = try? JSONDecoder().decode(ErrorProbe.self, from: data)
        switch status {
        case 200..<300: break
        case 401: throw DroverError.unauthorized
        case 403: throw DroverError.forbidden(probe?.error)
        default: throw DroverError.server(status: status, message: probe?.error)
        }
        if let probe, probe.ok == false {
            throw DroverError.server(status: status, message: probe.error)
        }
        do {
            let envelope = try JSONDecoder().decode(OpEnvelope<T>.self, from: data)
            guard let result = envelope.result else { throw DroverError.decoding("\(op): empty result") }
            return result
        } catch let e as DroverError {
            throw e
        } catch let e as DecodingError {
            throw DroverError.decoding("\(op): \(Self.describe(e))")
        } catch {
            throw DroverError.decoding("\(op): \(error.localizedDescription)")
        }
    }

    private static func describe(_ error: DecodingError) -> String {
        func path(_ c: DecodingError.Context) -> String {
            c.codingPath.map { $0.intValue.map(String.init) ?? $0.stringValue }.joined(separator: ".")
        }
        switch error {
        case .keyNotFound(let key, let c):
            let p = path(c)
            return "missing \(p.isEmpty ? "" : p + ".")\(key.stringValue)"
        case .typeMismatch(_, let c): return "wrong type at \(path(c)): \(c.debugDescription)"
        case .valueNotFound(_, let c): return "null at \(path(c))"
        case .dataCorrupted(let c): return "bad data at \(path(c)): \(c.debugDescription)"
        @unknown default: return "decoding failed"
        }
    }
}
