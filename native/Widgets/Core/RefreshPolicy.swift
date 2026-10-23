import Foundation

/// When to ask WidgetKit for the next timeline reload.
enum RefreshPolicy {
    /// Sooner when sessions wait on the user. WidgetKit budgets refreshes, so this is a request, not a guarantee.
    static func nextRefresh(after now: Date, summary: NativeSummary?, status: SummaryStatus) -> Date {
        let minutes: Double
        switch status {
        case .live, .cached:
            if let summary, summary.totals.waiting > 0 { minutes = 5 }
            else if let summary, summary.totals.working > 0 { minutes = 10 }
            else { minutes = 15 }
        case .notConfigured, .unauthorized, .unreachable:
            minutes = 15
        }
        return now.addingTimeInterval(minutes * 60)
    }
}
