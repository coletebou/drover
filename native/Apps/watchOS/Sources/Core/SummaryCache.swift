import Foundation

/// The last `native.summary` result, stored as the server's raw JSON at
/// `<App Group container>/summary.json` (CONTRACT.md). On the watch the App Group
/// container is the watch's own (it is not shared with the iPhone); the watch app writes
/// it and the watch complications (Widgets window) read it.
struct SummaryCache: Sendable {
    let fileURL: URL

    init(fileURL: URL) { self.fileURL = fileURL }

    /// App Group container if entitled, else the app's Application Support directory.
    static func standard() -> SummaryCache {
        let fm = FileManager.default
        let dir = fm.containerURL(forSecurityApplicationGroupIdentifier: DroverIdentifiers.appGroup)
            ?? (try? fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? fm.temporaryDirectory
        return SummaryCache(fileURL: dir.appending(path: DroverIdentifiers.summaryFileName))
    }

    func load() -> NativeSummary? {
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        return try? JSONDecoder().decode(NativeSummary.self, from: data)
    }

    func save(raw data: Data) {
        try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func clear() { try? FileManager.default.removeItem(at: fileURL) }
}

/// Which waiting items the watch has already buzzed for. Persisted so background
/// refreshes only buzz for items that are new since the last check.
struct SeenWaitingStore: Sendable {
    static let key = "drover.watch.seenWaiting"
    let defaults: UserDefaults

    init(defaults: UserDefaults = UserDefaults(suiteName: DroverIdentifiers.appGroup) ?? .standard) {
        self.defaults = defaults
    }

    var seen: Set<String> {
        get { Set(defaults.stringArray(forKey: Self.key) ?? []) }
        nonmutating set { defaults.set(Array(newValue).sorted(), forKey: Self.key) }
    }

    /// Returns items in `summary.waiting` not seen before, then records the current set
    /// as seen (items that stopped waiting are forgotten so they buzz again next time).
    func consumeNew(in summary: NativeSummary) -> [WaitingItem] {
        let (fresh, nowSeen) = WaitingDiff.newItems(seen: seen, current: summary.waiting)
        seen = nowSeen
        return fresh
    }
}

enum WaitingDiff {
    /// Pure diff: new items (in server order) and the next seen set.
    static func newItems(seen: Set<String>, current: [WaitingItem]) -> ([WaitingItem], Set<String>) {
        let fresh = current.filter { !seen.contains($0.key) }
        return (fresh, Set(current.map(\.key)))
    }
}
