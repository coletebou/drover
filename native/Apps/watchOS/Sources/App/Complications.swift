import WidgetKit

/// Watch complications live in the Widgets window's DroverWidgets-watchOS target and read
/// `<App Group container>/summary.json`; the watch app reloads them after each write.
enum Complications {
    /// Also invalidates configuration recommendations: the complication's host choices are
    /// built from the hosts in summary.json.
    static func reload() {
        WidgetCenter.shared.reloadAllTimelines()
        WidgetCenter.shared.invalidateConfigurationRecommendations()
    }
}
