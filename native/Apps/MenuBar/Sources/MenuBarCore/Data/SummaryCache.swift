import Foundation

/// The widget handoff file: bare `native.summary` result in the App Group container.
enum SummaryCache {
    static var containerURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: AppIdentifiers.appGroup)
    }

    static func write(_ summary: Summary, to directory: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(summary)
        try data.write(to: directory.appendingPathComponent(AppIdentifiers.summaryCacheFile), options: .atomic)
    }

    static func read(from directory: URL) -> Summary? {
        let url = directory.appendingPathComponent(AppIdentifiers.summaryCacheFile)
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Summary.self, from: data)
    }
}
