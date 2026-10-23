import Foundation

/// Why a `native.summary` fetch failed. Carries no request details, so it is safe to log.
enum SummaryFetchError: Error, Equatable, Sendable {
    case unauthorized
    case http(Int)
    case server(String)
    case decoding
    case transport
}

/// A decoded summary plus the bare `result` bytes (the cache file format).
struct FetchResult: Sendable {
    var summary: NativeSummary
    var resultJSON: Data
}

/// Fetches `native.summary` with the widget token.
struct SummaryFetcher: Sendable {
    var session: URLSession

    init(session: URLSession = SummaryFetcher.makeSession()) { self.session = session }

    /// Short-lived ephemeral session: widgets have little time and must not persist responses.
    static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 20
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }

    /// `GET <baseURL>/api/op/native.summary` with the bearer token.
    static func request(for creds: WidgetCredentials) -> URLRequest {
        let url = creds.baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("op")
            .appendingPathComponent(SharedConfig.summaryOp)
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.setValue("Bearer \(creds.token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        return req
    }

    /// Maps an HTTP status and body to a result or a typed error.
    static func parse(data: Data, statusCode: Int) throws(SummaryFetchError) -> FetchResult {
        if statusCode == 401 || statusCode == 403 { throw .unauthorized }
        let object = try? JSONSerialization.jsonObject(with: data)
        let envelope = object as? [String: Any]
        guard (200..<300).contains(statusCode) else {
            if envelope?["ok"] as? Bool == false, let message = envelope?["error"] as? String { throw .server(message) }
            throw .http(statusCode)
        }
        guard let envelope else { throw .decoding }
        if envelope["ok"] as? Bool == false { throw .server((envelope["error"] as? String) ?? "unknown error") }
        guard envelope["ok"] as? Bool == true, let result = envelope["result"] as? [String: Any],
              let resultJSON = try? JSONSerialization.data(withJSONObject: result),
              let summary = try? JSONDecoder().decode(NativeSummary.self, from: resultJSON) else { throw .decoding }
        return FetchResult(summary: summary, resultJSON: resultJSON)
    }

    /// Performs the request; any network failure is reported as `.transport`.
    func fetch(_ creds: WidgetCredentials) async throws(SummaryFetchError) -> FetchResult {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: Self.request(for: creds), delegate: NoRedirects.shared)
        } catch {
            throw .transport
        }
        guard let http = response as? HTTPURLResponse else { throw .transport }
        return try Self.parse(data: data, statusCode: http.statusCode)
    }
}

/// Refuses HTTP redirects: the daemon never redirects `/api/op`, and following one could send the bearer token to
/// another origin. A 3xx then surfaces as `.http(code)`.
private final class NoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    static let shared = NoRedirects()

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest) async -> URLRequest? { nil }
}
