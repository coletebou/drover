import Foundation

enum WatchClientError: Error, Equatable, Sendable {
    case notConfigured
    case missingToken(TokenKind)
    case unauthorized
    case http(Int)
    case server(String)
    case decoding
    case transport(String)
    /// The server or token changed while the request was in flight; the response was dropped.
    case superseded

    /// Short, user-facing, sentence case, never contains a token.
    var message: String {
        switch self {
        case .notConfigured: return "Set the server on your iPhone"
        case .missingToken(.main): return "Pair with iPhone to reply"
        case .missingToken(.widget): return "Pair with iPhone to see updates"
        case .unauthorized: return "Token rejected, pair again"
        case .http(let code): return "Server error \(code)"
        case .server(let m): return m.isEmpty ? "Server error" : String(m.prefix(120))
        case .decoding: return "Unexpected reply from server"
        case .transport(let m): return m.isEmpty ? "Server unreachable" : String(m.prefix(120))
        case .superseded: return ""
        }
    }
}

/// Minimal Drover client for the watch. `POST /api/op/<op>` with a JSON body, bearer auth,
/// `{ok, result, error}` envelope (CONTRACT.md). The token is passed per call and only ever
/// placed in the Authorization header: never in a URL, a log line or an error.
struct WatchClient: Sendable {
    let baseURL: URL
    var session: URLSession = .shared
    var timeout: TimeInterval = 15

    /// Sends an op and returns the raw JSON bytes of `result` (exactly as the server sent it).
    func opData(_ op: String, args: [String: String] = [:], token: String) async throws -> Data {
        var req = URLRequest(url: baseURL.appending(path: "api/op/\(op)"), timeoutInterval: timeout)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.httpBody = try JSONSerialization.data(withJSONObject: args, options: [.sortedKeys])

        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await session.data(for: req)
        } catch let e as URLError {
            throw WatchClientError.transport(e.code == .timedOut ? "Server timed out" : "Server unreachable")
        } catch {
            throw WatchClientError.transport("Server unreachable")
        }
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 || status == 403 { throw WatchClientError.unauthorized }
        return try WatchClient.unwrap(data, status: status, redacting: token)
    }

    /// `GET /api/op/native.summary` for a background download task (background sessions
    /// cannot carry a POST body from memory; read ops accept GET per CONTRACT.md).
    func summaryRequest(token: String) -> URLRequest {
        var req = URLRequest(url: baseURL.appending(path: "api/op/native.summary"), timeoutInterval: 60)
        req.httpMethod = "GET"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return req
    }

    /// Parses the `{ok, result, error}` envelope. Server error text is shown to the user, so
    /// any occurrence of `redacting` (the token used for the call) is replaced first.
    static func unwrap(_ data: Data, status: Int, redacting token: String? = nil) throws -> Data {
        do {
            return try unwrapRaw(data, status: status)
        } catch WatchClientError.server(let m) {
            // Real tokens are long random strings; a short one would only mangle ordinary words.
            guard let token, token.count >= 8 else { throw WatchClientError.server(m) }
            throw WatchClientError.server(m.replacingOccurrences(of: token, with: "[redacted]"))
        }
    }

    private static func unwrapRaw(_ data: Data, status: Int) throws -> Data {
        guard let obj = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
              let env = obj as? [String: Any] else {
            if !(200..<300).contains(status) { throw WatchClientError.http(status) }
            throw WatchClientError.decoding
        }
        if (env["ok"] as? Bool) != true {
            let err = env["error"]
            let msg = (err as? String) ?? ((err as? [String: Any])?["message"] as? String) ?? ""
            if msg.isEmpty, !(200..<300).contains(status) { throw WatchClientError.http(status) }
            throw WatchClientError.server(msg)
        }
        let result = env["result"] ?? NSNull()
        return try JSONSerialization.data(withJSONObject: result, options: [.fragmentsAllowed])
    }

    func op<T: Decodable>(_ op: String, args: [String: String] = [:], token: String, as: T.Type = T.self) async throws -> T {
        let data = try await opData(op, args: args, token: token)
        do { return try JSONDecoder().decode(T.self, from: data) } catch { throw WatchClientError.decoding }
    }

    // MARK: ops

    /// `native.summary` (widget token is enough). Returns the decoded summary and the raw
    /// result bytes so callers can cache exactly what the server sent.
    func summary(token: String) async throws -> (NativeSummary, Data) {
        let data = try await opData("native.summary", token: token)
        do { return (try JSONDecoder().decode(NativeSummary.self, from: data), data) } catch { throw WatchClientError.decoding }
    }

    /// `sessions.lastReply` (main token). nil when the server returns null.
    func lastReply(id: String, host: String?, token: String) async throws -> LastReply? {
        try await op("sessions.lastReply", args: WatchClient.args(id: id, host: host), token: token, as: LastReply?.self)
    }

    /// `sessions.message` (main token). `actor` is recorded in the WAL.
    func sendMessage(id: String, host: String?, text: String, token: String) async throws {
        var a = WatchClient.args(id: id, host: host)
        a["text"] = text
        a["actor"] = "watch"
        _ = try await op("sessions.message", args: a, token: token, as: IgnoredResult.self)
    }

    static func args(id: String, host: String?) -> [String: String] {
        var a = ["id": id]
        if let host, !host.isEmpty, host != "local" { a["host"] = host }
        return a
    }

    // MARK: approvals

    /// `POST /api/approvals/answer {id, choice, via: "watch"}` with the main token: a Grok bot's approval request,
    /// answered by its id. Not an op (no `/api/op/` path). 409 (answered already, withdrawn, expired) is a result.
    func answerApproval(id: String, choice: Int, token: String) async throws -> ApprovalAnswerResult {
        let req = try approvalRequest(id: id, choice: choice, token: token)
        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await session.data(for: req)
        } catch let e as URLError {
            throw WatchClientError.transport(e.code == .timedOut ? "Server timed out" : "Server unreachable")
        } catch {
            throw WatchClientError.transport("Server unreachable")
        }
        return try WatchClient.approvalResult(data, status: (resp as? HTTPURLResponse)?.statusCode ?? 0, redacting: token)
    }

    /// `GET /api/approvals?id=<id>` with the main token: the whole request (its words unshortened, its status). nil
    /// when this daemon keeps no such request.
    func approval(id: String, token: String) async throws -> ApprovalRequest? {
        var url = baseURL.appending(path: "api/approvals")
        url.append(queryItems: [URLQueryItem(name: "id", value: id)])
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.httpMethod = "GET"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await session.data(for: req)
        } catch let e as URLError {
            throw WatchClientError.transport(e.code == .timedOut ? "Server timed out" : "Server unreachable")
        } catch {
            throw WatchClientError.transport("Server unreachable")
        }
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 || status == 403 { throw WatchClientError.unauthorized }
        let result = try WatchClient.unwrap(data, status: status, redacting: token)
        struct Lookup: Decodable {
            var items: [ApprovalRequest]
            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                items = ((try? c.decodeIfPresent([Lossy].self, forKey: .items)) ?? []).compactMap(\.value)
            }
            enum CodingKeys: String, CodingKey { case items }
            struct Lossy: Decodable {
                let value: ApprovalRequest?
                init(from decoder: Decoder) throws { value = try? ApprovalRequest(from: decoder) }
            }
        }
        let lookup: Lookup
        do { lookup = try JSONDecoder().decode(Lookup.self, from: result) } catch { throw WatchClientError.decoding }
        return lookup.items.first { $0.id == id }
    }

    func approvalRequest(id: String, choice: Int, token: String) throws -> URLRequest {
        var req = URLRequest(url: baseURL.appending(path: "api/approvals/answer"), timeoutInterval: timeout)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let body: [String: Any] = ["id": id, "choice": choice, "via": "watch"]
        req.httpBody = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        return req
    }

    /// 200 decided, 409 closed (with the daemon's words), 401/403 rejected token, 400/404 the daemon's error.
    static func approvalResult(_ data: Data, status: Int, redacting token: String? = nil) throws -> ApprovalAnswerResult {
        if status == 401 || status == 403 { throw WatchClientError.unauthorized }
        if status == 409 {
            let env = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            var message = (env?["error"] as? String) ?? "This request is no longer waiting for an answer"
            if let token, token.count >= 8 { message = message.replacingOccurrences(of: token, with: "[redacted]") }
            return .closed(message: String(message.prefix(200)))
        }
        let result = try unwrap(data, status: status, redacting: token)
        let r = (try? JSONSerialization.jsonObject(with: result, options: [.fragmentsAllowed])) as? [String: Any]
        let decision = r?["decision"] as? [String: Any]
        let delivery = r?["delivery"] as? [String: Any]
        return .decided(label: decision?["label"] as? String ?? "", told: (delivery?["ok"] as? Bool) != false,
                        queued: (delivery?["queued"] as? Bool) == true)
    }
}
