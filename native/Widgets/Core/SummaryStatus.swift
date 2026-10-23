import Foundation

/// Where the entry's data came from, so views can show a quiet footnote instead of stale numbers as if live.
enum SummaryStatus: Equatable, Sendable {
    /// Fetched just now.
    case live
    /// Network failed; showing the App Group cache fetched at this date.
    case cached(fetchedAt: Date)
    /// No base URL or no widget token yet (open the app to set up).
    case notConfigured
    /// Server answered 401/403: the widget token is wrong or lacks scope.
    case unauthorized
    /// Network failed and there is no cache.
    case unreachable
}
