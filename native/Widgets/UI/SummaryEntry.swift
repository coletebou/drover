import WidgetKit

/// One timeline entry. `summary` is already filtered to `hostFilter`.
struct SummaryEntry: TimelineEntry {
    var date: Date
    var summary: NativeSummary?
    /// Host name the user picked in the widget configuration; nil = all hosts.
    var hostFilter: String?
    var status: SummaryStatus

    static let placeholder = SummaryEntry(date: .now, summary: SummaryFixtures.sample, hostFilter: nil, status: .live)
}
