import Foundation

/// The App Group cache of the last `native.summary` result (CONTRACT.md "Widget data handoff").
struct SummaryCache: Sendable {
    /// Directory holding `summary.json`; nil when the App Group container is unavailable.
    var directory: URL?

    static var appGroup: SummaryCache {
        SummaryCache(directory: FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: SharedConfig.appGroup))
    }

    /// Location of the cache file; nil when there is no directory.
    var fileURL: URL? { directory?.appendingPathComponent(SharedConfig.summaryCacheFileName) }

    /// The cached summary and its fetch time (file modification date), or nil.
    func read() -> (summary: NativeSummary, fetchedAt: Date)? {
        guard let url = fileURL, let data = try? Data(contentsOf: url),
              let summary = try? JSONDecoder().decode(NativeSummary.self, from: data) else { return nil }
        let modified = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
        return (summary, modified ?? summary.generatedAt ?? .distantPast)
    }

    /// Atomically replaces the cache with the bare `result` JSON bytes. Throws for bytes that are not a summary.
    func write(_ resultJSON: Data) throws {
        guard let dir = directory, let url = fileURL else { throw CocoaError(.fileNoSuchFile) }
        guard (try? JSONDecoder().decode(NativeSummary.self, from: resultJSON)) != nil else {
            throw CocoaError(.coderReadCorrupt)
        }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try resultJSON.write(to: url, options: .atomic)
    }
}
