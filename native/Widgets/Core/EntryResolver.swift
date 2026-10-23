import Foundation

/// Decides what a timeline entry shows from the fetch outcome and the cache.
enum EntryResolver {
    /// `fetch == nil` means there were no credentials, so no request was made.
    static func resolve(
        fetch: Result<FetchResult, SummaryFetchError>?,
        cache: (summary: NativeSummary, fetchedAt: Date)?,
        hostFilter: String?
    ) -> (summary: NativeSummary?, status: SummaryStatus) {
        let summary: NativeSummary?
        let status: SummaryStatus
        let cachedStatus = cache.map { SummaryStatus.cached(fetchedAt: $0.fetchedAt) }
        switch fetch {
        case nil:
            summary = cache?.summary
            status = cachedStatus ?? .notConfigured
        case .success(let result)?:
            summary = result.summary
            status = .live
        case .failure(.unauthorized)?:
            summary = cache?.summary
            status = .unauthorized
        case .failure?:
            summary = cache?.summary
            status = cachedStatus ?? .unreachable
        }
        return (summary?.filtered(host: hostFilter), status)
    }
}
