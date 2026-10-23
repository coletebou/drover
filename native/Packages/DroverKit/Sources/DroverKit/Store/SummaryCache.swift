import Foundation

/// The last `native.summary` result as bare JSON in the App Group container (read by widgets).
public struct SummaryCache: Sendable {
    public let fileURL: URL

    public init(directory: URL) {
        self.fileURL = directory.appending(path: DroverIdentifiers.summaryCacheFile)
    }

    /// nil when the container is unavailable (unsigned builds).
    public init?(appGroup: String = DroverIdentifiers.appGroup) {
        #if canImport(Darwin)
        guard let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else { return nil }
        self.init(directory: url)
        #else
        return nil  // App Groups exist only on Apple platforms
        #endif
    }

    public func load() -> (summary: NativeSummary, fetchedAt: Date)? {
        do {
            let data = try Data(contentsOf: fileURL)
            let summary = try JSONDecoder().decode(NativeSummary.self, from: data)
            let values = try fileURL.resourceValues(forKeys: [.contentModificationDateKey])
            guard let date = values.contentModificationDate else { return nil }
            return (summary, date)
        } catch {
            return nil
        }
    }

    public func save(_ summary: NativeSummary) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(summary)
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: fileURL, options: .atomic)
    }
}
