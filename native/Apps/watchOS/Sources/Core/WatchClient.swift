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
}
