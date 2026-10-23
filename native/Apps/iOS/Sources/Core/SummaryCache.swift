import Foundation
#if canImport(WidgetKit)
import WidgetKit
#endif

/// The last `native.summary` in the App Group container, as the bare result object (no envelope),
/// written atomically so widgets never read a torn file. Contract: CONTRACT.md "Apple identifiers".
enum SummaryCache {
    static var fileURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: DroverIDs.appGroup)?
            .appending(path: DroverIDs.summaryFileName)
    }

    static func load() -> NativeSummary? {
        guard let url = fileURL, let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(NativeSummary.self, from: data)
    }

    /// Writes the summary (always, so the file date is the fetch time), asks WidgetKit to reload timelines
    /// when the content changed, and to refresh its host-filter recommendations when the host list changed.
    static func store(_ summary: NativeSummary) {
        guard let url = fileURL, let data = try? JSONEncoder().encode(summary) else { return }
        let oldData = try? Data(contentsOf: url)
        let oldHosts = oldData.flatMap { try? JSONDecoder().decode(NativeSummary.self, from: $0) }?.hosts.map(\.name)
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #if canImport(WidgetKit)
        if oldData != data { WidgetCenter.shared.reloadAllTimelines() }
        if oldHosts != summary.hosts.map(\.name) { WidgetCenter.shared.invalidateConfigurationRecommendations() }
        #endif
    }
}
