import Foundation

/// Pure dispatch for native messages. All I/O goes through the injected protocols.
struct NativeRouter: Sendable {
    let credentials: any CredentialReading
    let notifier: any NotificationPosting
    let http: any HTTPPerforming
    let platform: String
    let version: String

    init(credentials: any CredentialReading, notifier: any NotificationPosting,
         http: any HTTPPerforming, platform: String, version: String) {
        self.credentials = credentials
        self.notifier = notifier
        self.http = http
        self.platform = platform
        self.version = version
    }

    func handle(_ message: Any?) async -> NativeResponse {
        await handle(parsed: NativeRequest.parse(message))
    }

    /// Entry point for callers that already parsed the raw message. The parsed value is Sendable, so it can
    /// cross into a Task without carrying the non-Sendable `Any?` payload along.
    func handle(parsed: Result<NativeRequest, NativeError>) async -> NativeResponse {
        switch parsed {
        case .failure(let error):
            return .failure(error)
        case .success(let request):
            return await dispatch(request)
        }
    }

    private func dispatch(_ request: NativeRequest) async -> NativeResponse {
        switch request {
        case .ping:
            return .success(.object([
                "protocol": .number(1),
                "platform": .string(platform),
                "version": .string(version),
            ]))
        case .config:
            var base = credentials.baseURL()?.absoluteString
            while let b = base, b.hasSuffix("/") { base = String(b.dropLast()) }
            return .success(.object([
                "baseURL": base.map { JSONValue.string($0) } ?? .null,
                "token": credentials.token().map { JSONValue.string($0) } ?? .null,
            ]))
        case .notify(let payload):
            do {
                try await notifier.post(payload)
                return .success(.object(["posted": .bool(true)]))
            } catch {
                return .failure(error)
            }
        case .clearNotification(let id):
            await notifier.clear(id: id)
            return .success(.object(["cleared": .bool(true)]))
        case .op(let payload):
            return await perform(payload)
        }
    }

    /// Web-style origin (`scheme://host[:port]`, lowercased, default port omitted) to compare with JS `URL.origin`.
    static func origin(of url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased(), !host.isEmpty else { return nil }
        let shownHost = host.contains(":") ? "[\(host)]" : host
        if let port = url.port, !(scheme == "http" && port == 80), !(scheme == "https" && port == 443) {
            return "\(scheme)://\(shownHost):\(port)"
        }
        return "\(scheme)://\(shownHost)"
    }

    private func perform(_ payload: OpPayload) async -> NativeResponse {
        guard let base = credentials.baseURL(), let token = payload.token ?? credentials.token() else {
            return .failure(.notConfigured)
        }
        if let expected = payload.origin, expected != Self.origin(of: base) {
            return .failure(.notConfigured)
        }
        let request: URLRequest
        do {
            request = try OpRequestBuilder.make(
                base: base, token: token, op: payload.op, method: payload.method, args: payload.args)
        } catch {
            return .failure(error)
        }
        do {
            let (data, response) = try await http.perform(request)
            guard let body = String(data: data, encoding: .utf8) else { return .failure(.network) }
            return .success(.object([
                "status": .number(Double(response.statusCode)),
                "body": .string(body),
            ]))
        } catch {
            return .failure(.network)
        }
    }
}
