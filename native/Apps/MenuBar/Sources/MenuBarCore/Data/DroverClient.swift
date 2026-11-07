import Foundation

/// JSON argument values for ops. Literals make call sites read naturally: `["id": "s-1"]`.
enum JSONValue: Encodable, Sendable, Equatable, ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByBooleanLiteral {
    case string(String)
    case int(Int)
    case bool(Bool)

    init(stringLiteral value: String) { self = .string(value) }
    init(integerLiteral value: Int) { self = .int(value) }
    init(booleanLiteral value: Bool) { self = .bool(value) }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .int(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        }
    }
}

extension DroverError {
    /// Maps any thrown error to a short, safe error: no URL, no token.
    static func from(_ error: Error) -> DroverError {
        if let e = error as? DroverError { return e }
        if let e = error as? URLError {
            switch e.code {
            case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed:
                return .transport("No network connection.")
            case .timedOut:
                return .transport("The server took too long to answer.")
            case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
                 .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid, .clientCertificateRejected:
                return .transport("The secure connection failed.")
            default:
                return .transport("Cannot reach the server.")
            }
        }
        return .transport("Cannot reach the server.")
    }

    /// The daemon answered "unknown op <op>": it predates that op.
    func isUnknownOp(_ op: String) -> Bool {
        if case .server(let message) = self { return message.hasPrefix("unknown op \(op)") }
        return false
    }
}

struct DroverClient: Sendable {
    let baseURL: URL
    let tokens: any TokenProviding
    let transport: any HTTPTransport

    init(baseURL: URL, tokens: any TokenProviding, transport: any HTTPTransport) {
        self.baseURL = baseURL
        self.tokens = tokens
        self.transport = transport
    }

    /// `timeout` (seconds) is for the rare call that may legitimately take minutes (a manager message to a
    /// daemon from before `wait: false`); the transport then uses its long-request session.
    func call<T: Decodable & Sendable>(
        _ op: String,
        args: [String: JSONValue] = [:],
        token kind: TokenKind,
        timeout: TimeInterval? = nil,
        as: T.Type = T.self
    ) async throws -> T {
        guard let token = tokens.token(kind), !token.isEmpty else { throw DroverError.missingToken(kind) }
        var request = URLRequest(url: baseURL.appendingPathComponent("api/op/\(op)"))
        if let timeout { request.timeoutInterval = timeout }
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        do {
            request.httpBody = try JSONEncoder().encode(args)
        } catch {
            throw DroverError.decoding("Could not encode the request.")
        }

        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await transport.data(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch let e as URLError where e.code == .cancelled {
            throw CancellationError()
        } catch {
            throw DroverError.from(error)
        }

        let status = response.statusCode
        if status == 401 || status == 403 { throw DroverError.unauthorized }
        guard (200..<300).contains(status) else {
            if let env = try? JSONDecoder().decode(OpEnvelope<AnyResult>.self, from: data),
               !env.ok, let message = env.error {
                throw DroverError.server(message)
            }
            throw DroverError.http(status)
        }
        let envelope: OpEnvelope<T>
        do {
            envelope = try JSONDecoder().decode(OpEnvelope<T>.self, from: data)
        } catch {
            throw DroverError.decoding(String(describing: error))
        }
        guard envelope.ok else { throw DroverError.server(envelope.error ?? "Request failed.") }
        if let result = envelope.result { return result }
        if let empty = AnyResult() as? T { return empty }
        throw DroverError.decoding("The response had no result.")
    }

    // MARK: Conveniences

    func summary(token: TokenKind) async throws -> Summary {
        try await call("native.summary", token: token, as: Summary.self)
    }

    func notifications(since: String?, wait: Int?, limit: Int?, token: TokenKind) async throws -> NotificationsPage {
        var args: [String: JSONValue] = [:]
        if let since { args["since"] = .string(since) }
        if let wait { args["wait"] = .int(wait) }
        if let limit { args["limit"] = .int(limit) }
        return try await call("native.notifications", args: args, token: token, as: NotificationsPage.self)
    }

    func sendMessage(id: String, host: String, text: String) async throws {
        var args: [String: JSONValue] = ["id": .string(id), "text": .string(text), "actor": .string(AppIdentifiers.actor)]
        if !host.isEmpty { args["host"] = .string(host) }
        _ = try await call("sessions.message", args: args, token: .main, as: AnyResult.self)
    }

    func sweep(host: String? = nil) async throws {
        var args: [String: JSONValue] = ["actor": .string(AppIdentifiers.actor)]
        if let host, !host.isEmpty { args["host"] = .string(host) }
        _ = try await call("openclaw.sweep", args: args, token: .main, as: AnyResult.self)
    }

    /// `sessions.answer {id, host, key, expect, actor}`: press one key on the dialog a session shows, only if
    /// the screen still hashes to `expect`. A refusal comes back as a result (`ok: false, refused: true`).
    func answer(id: String, host: String, key: String, expect: String?) async throws -> AnswerResult {
        var args: [String: JSONValue] = ["id": .string(id), "key": .string(key), "actor": .string(AppIdentifiers.actor)]
        if !host.isEmpty { args["host"] = .string(host) }
        if let expect, !expect.isEmpty { args["expect"] = .string(expect) }
        return try await call("sessions.answer", args: args, token: .main, as: AnswerResult.self)
    }

    /// `via` of every approval this app answers (its rows and its notification actions).
    static let approvalVia = "menubar"

    /// `POST /api/approvals/answer {id, choice, via}` with the main token: a Grok bot's approval request, answered by
    /// its id. Not an op (`/api/op/...` cannot answer it). 409 (answered already, withdrawn, expired) is a result.
    func answerApproval(id: String, choice: Int) async throws -> ApprovalAnswerResult {
        guard let token = tokens.token(.main), !token.isEmpty else { throw DroverError.missingToken(.main) }
        var request = URLRequest(url: baseURL.appendingPathComponent("api/approvals/answer"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let body: [String: JSONValue] = ["id": .string(id), "choice": .int(choice), "via": .string(Self.approvalVia)]
        do {
            request.httpBody = try JSONEncoder().encode(body)
        } catch {
            throw DroverError.decoding("Could not encode the request.")
        }
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await transport.data(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch let e as URLError where e.code == .cancelled {
            throw CancellationError()
        } catch {
            throw DroverError.from(error)
        }
        return try Self.approvalResult(data, status: response.statusCode)
    }

    /// `GET /api/approvals?id=<id>` with the main token: the whole request (its words unshortened, its status). nil when
    /// this daemon keeps no such request.
    func approval(id: String) async throws -> ApprovalInfo? {
        guard let token = tokens.token(.main), !token.isEmpty else { throw DroverError.missingToken(.main) }
        var c = URLComponents(url: baseURL.appendingPathComponent("api/approvals"), resolvingAgainstBaseURL: false)
        c?.queryItems = [URLQueryItem(name: "id", value: id)]
        guard let url = c?.url else { throw DroverError.notConfigured }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await transport.data(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch let e as URLError where e.code == .cancelled {
            throw CancellationError()
        } catch {
            throw DroverError.from(error)
        }
        let status = response.statusCode
        if status == 401 || status == 403 { throw DroverError.unauthorized }
        guard (200..<300).contains(status) else {
            if let env = try? JSONDecoder().decode(OpEnvelope<AnyResult>.self, from: data), !env.ok, let message = env.error {
                throw DroverError.server(message)
            }
            throw DroverError.http(status)
        }
        let envelope: OpEnvelope<ApprovalLookup>
        do {
            envelope = try JSONDecoder().decode(OpEnvelope<ApprovalLookup>.self, from: data)
        } catch {
            throw DroverError.decoding(String(describing: error))
        }
        guard envelope.ok else { throw DroverError.server(envelope.error ?? "Request failed.") }
        return envelope.result?.items.first { $0.id == id }
    }

    /// 200 decided; 409 closed with the daemon's words; 401 and 403 (the widget token) rejected; 400 and 404 the
    /// daemon's error.
    static func approvalResult(_ data: Data, status: Int) throws -> ApprovalAnswerResult {
        if status == 401 || status == 403 { throw DroverError.unauthorized }
        let message = (try? JSONDecoder().decode(OpEnvelope<AnyResult>.self, from: data))?.error
        if status == 409 { return .closed(message: message ?? "This request is no longer waiting for an answer.") }
        guard (200..<300).contains(status) else {
            if let message { throw DroverError.server(message) }
            throw DroverError.http(status)
        }
        let envelope: OpEnvelope<ApprovalAnswerPayload>
        do {
            envelope = try JSONDecoder().decode(OpEnvelope<ApprovalAnswerPayload>.self, from: data)
        } catch {
            throw DroverError.decoding(String(describing: error))
        }
        guard envelope.ok else { throw DroverError.server(envelope.error ?? "Request failed.") }
        return .decided(label: envelope.result?.decision?.label ?? "", delivery: envelope.result?.delivery ?? ApprovalDelivery())
    }

    /// `sessions.message {id: "manager", text, wait: false}`. A daemon from before `wait: false` holds the call
    /// until the reply, so this one may take minutes.
    func messageManager(_ text: String, host: String?) async throws -> ManagerSendResult {
        var args: [String: JSONValue] = [
            "id": .string(AppIdentifiers.managerID), "text": .string(text), "wait": false, "actor": .string(AppIdentifiers.actor),
        ]
        if let host, !host.isEmpty { args["host"] = .string(host) }
        return try await call("sessions.message", args: args, token: .main, timeout: 900, as: ManagerSendResult.self)
    }

    /// Where the manager runs, from `native.board` (main token; `native.summary` names no host). Nil: the daemon's
    /// own machine, or no manager.
    func managerHost() async throws -> String? {
        struct Manager: Decodable { var host: String? }
        struct Board: Decodable { var manager: Manager? }
        let host = try await call("native.board", token: .main, as: Board.self).manager?.host
        guard let host, !host.isEmpty, host != "local" else { return nil }
        return host
    }

    /// The manager conversation's newest turns (main thread).
    func managerTranscript(host: String?, limit: Int) async throws -> TranscriptPage {
        var args: [String: JSONValue] = ["id": .string(AppIdentifiers.managerID), "limit": .int(limit)]
        if let host, !host.isEmpty { args["host"] = .string(host) }
        return try await call("sessions.transcript", args: args, token: .main, as: TranscriptPage.self)
    }

    func mute(category: String, minutes: Int) async throws {
        let args: [String: JSONValue] = [
            "scope": "category", "target": .string(category), "minutes": .int(minutes),
            "label": "menu bar mute", "actor": .string(AppIdentifiers.actor),
        ]
        _ = try await call("notify.mute", args: args, token: .main, as: AnyResult.self)
    }

    /// SSE request: bearer header with the main token, never `?token=`. `topics` asks the daemon for only those
    /// events (`?topics=a,b`); a daemon from before topics ignores it and sends everything.
    func streamRequest(topics: [String] = []) throws -> URLRequest {
        guard let token = tokens.token(.main), !token.isEmpty else { throw DroverError.missingToken(.main) }
        var url = baseURL.appendingPathComponent(AppIdentifiers.ssePath)
        if !topics.isEmpty, var c = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            c.queryItems = [URLQueryItem(name: "topics", value: topics.joined(separator: ","))]
            url = c.url ?? url
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 90
        return request
    }
}
