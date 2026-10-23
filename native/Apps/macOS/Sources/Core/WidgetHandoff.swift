import Foundation
#if canImport(WidgetKit)
import WidgetKit
#endif

/// Feeds the macOS widgets (CONTRACT.md "Widget data handoff"): bare `native.summary` result written
/// atomically to `<App Group container>/summary.json`, then a timeline reload.
enum WidgetHandoff {
    nonisolated(unsafe) private static var lastHosts: [String]?

    /// Hosts feed the widgets' host-filter recommendations; refresh those when the list changes.
    @MainActor static func hostsChanged(_ hosts: [String]) {
        guard hosts != lastHosts else { return }
        lastHosts = hosts
        #if canImport(WidgetKit)
        WidgetCenter.shared.invalidateConfigurationRecommendations()
        #endif
    }

    static func write(summaryJSON: Data) {
        guard let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: AppSettings.appGroup) else { return }
        do {
            try summaryJSON.write(to: dir.appending(path: "summary.json"), options: .atomic)
            #if canImport(WidgetKit)
            WidgetCenter.shared.reloadAllTimelines()
            #endif
        } catch {
            // Widgets keep their previous cache; nothing to surface to the user.
        }
    }
}
