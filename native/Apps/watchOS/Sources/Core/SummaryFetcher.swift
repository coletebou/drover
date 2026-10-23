import Foundation

/// Fetches `native.summary`, writes the cache, and reports which waiting items are new.
/// Shared by the foreground model and the background download (no UI, no WatchKit).
///
/// Coherence: the iPhone sync writes the URL and the tokens on the main actor. Callers take a
/// `Credentials` snapshot and commit on the main actor too, so a request never pairs one
/// server with another server's token and a response from before an unpair or server change
/// is never committed.
struct SummaryFetcher: Sendable {
    var vault: any TokenVault
    var config: WatchConfig
    var cache: SummaryCache
    var seen: SeenWaitingStore
    var session: URLSession = .shared

    struct Outcome: Sendable {
        var summary: NativeSummary
        /// Waiting items not seen by any earlier fetch (foreground or background).
        var newWaiting: [WaitingItem]
    }

    /// One coherent server URL and token pair.
    struct Credentials: Sendable, Equatable {
        let base: URL
        let token: String
    }

    /// Background work passes `allowMainToken: false`: it polls with the read-only widget token
    /// only. The foreground may fall back to the main token when no widget token exists.
    func credentials(allowMainToken: Bool) throws -> Credentials {
        guard let base = config.baseURL else { throw WatchClientError.notConfigured }
        if let w = vault.token(.widget), !w.isEmpty { return Credentials(base: base, token: w) }
        if allowMainToken, let m = vault.token(.main), !m.isEmpty { return Credentials(base: base, token: m) }
        throw WatchClientError.missingToken(.widget)
    }

    /// True while the snapshot still matches the stored server and one of the stored tokens.
    func isCurrent(_ c: Credentials) -> Bool {
        config.baseURL == c.base && (vault.token(.widget) == c.token || vault.token(.main) == c.token)
    }

    /// Network only: nothing is written.
    func download(_ c: Credentials) async throws -> (NativeSummary, Data) {
        try await WatchClient(baseURL: c.base, session: session).summary(token: c.token)
    }

    /// Convenience for callers without actor constraints (tests): snapshot, download, validate, commit.
    func fetch(allowMainToken: Bool) async throws -> Outcome {
        let c = try credentials(allowMainToken: allowMainToken)
        let (summary, raw) = try await download(c)
        guard isCurrent(c) else { throw WatchClientError.superseded }
        return commit(summary, raw: raw)
    }

    /// Writes the cache and updates the seen set together. A snapshot older than the cached one
    /// (a slow background download finishing after a newer foreground refresh) is ignored so it
    /// cannot bring back an answered session.
    func commit(_ summary: NativeSummary, raw: Data) -> Outcome {
        if let old = cache.load(), let o = old.generatedAt, let n = summary.generatedAt, n < o {
            return Outcome(summary: old, newWaiting: [])
        }
        cache.save(raw: raw)
        return Outcome(summary: summary, newWaiting: seen.consumeNew(in: summary))
    }

    /// The background download request: widget token only, nil when not paired for updates.
    func backgroundRequest() -> URLRequest? {
        guard let c = try? credentials(allowMainToken: false) else { return nil }
        return WatchClient(baseURL: c.base, session: session).summaryRequest(token: c.token)
    }

    /// True when a queued background request targets the current server with the current
    /// widget token.
    func matchesCurrent(_ request: URLRequest?) -> Bool {
        guard let base = config.baseURL, let url = request?.url,
              url.absoluteString.hasPrefix(base.absoluteString + "/"),
              let w = vault.token(.widget), !w.isEmpty else { return false }
        return request?.value(forHTTPHeaderField: "Authorization") == "Bearer \(w)"
    }

    /// Commits a finished background download. The request must still match the current
    /// server and widget token, else the response is from before an unpair or server change.
    func ingest(data: Data, status: Int, request: URLRequest?) throws -> Outcome {
        guard matchesCurrent(request), let w = vault.token(.widget) else { throw WatchClientError.superseded }
        if status == 401 || status == 403 { throw WatchClientError.unauthorized }
        let raw = try WatchClient.unwrap(data, status: status, redacting: w)
        guard let summary = try? JSONDecoder().decode(NativeSummary.self, from: raw) else { throw WatchClientError.decoding }
        return commit(summary, raw: raw)
    }
}
