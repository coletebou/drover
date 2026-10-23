import Foundation

public actor NotificationFeed {
    private let fetch: @Sendable (_ since: String?) async throws -> NativeNotifications
    private let defaults: UserDefaults?
    private let cursorKey: String
    private var memoryCursor: String?
    private var seenOrder: [String] = []
    private var seen: Set<String> = []
    private static let seenLimit = 200
    /// Polls run one at a time (actor methods interleave at every await); reset() bumps the generation so a
    /// response that was in flight during a reset is dropped instead of restoring the old cursor.
    private var tail: Task<Void, Never>?
    private var generation = 0

    public init(fetch: @escaping @Sendable (_ since: String?) async throws -> NativeNotifications,
                defaults: UserDefaults? = UserDefaults(suiteName: DroverIdentifiers.appGroup),
                cursorKey: String = "drover.notifications.cursor") {
        self.fetch = fetch
        self.defaults = defaults
        self.cursorKey = cursorKey
    }

    private var cursor: String? {
        get { defaults?.string(forKey: cursorKey) ?? memoryCursor }
        set {
            if let defaults {
                if let newValue { defaults.set(newValue, forKey: cursorKey) } else { defaults.removeObject(forKey: cursorKey) }
            } else {
                memoryCursor = newValue
            }
        }
    }

    /// New items since the stored cursor. First call ever: returns [] and stores the cursor.
    /// Concurrent calls are serialized, so no item is swallowed by a parallel baseline poll.
    public func poll() async throws -> [NotificationItem] {
        let previous = tail
        let task = Task { () async throws -> [NotificationItem] in
            await previous?.value
            return try await self.pollNow()
        }
        tail = Task { _ = try? await task.value }
        return try await task.value
    }

    private func pollNow() async throws -> [NotificationItem] {
        let gen = generation
        guard let stored = cursor else {
            let first = try await fetch(nil)
            guard gen == generation else { return [] }
            if let c = first.cursor { cursor = c }
            for item in first.items { remember(item.id) }
            return []
        }
        let result = try await fetch(stored)
        guard gen == generation else { return [] }
        if let c = result.cursor { cursor = c }
        var fresh: [NotificationItem] = []
        for item in result.items where !seen.contains(item.id) {
            remember(item.id)
            fresh.append(item)
        }
        return fresh
    }

    public func reset() {
        generation += 1
        cursor = nil
        seen.removeAll()
        seenOrder.removeAll()
    }

    private func remember(_ id: String) {
        guard seen.insert(id).inserted else { return }
        seenOrder.append(id)
        if seenOrder.count > Self.seenLimit {
            seen.remove(seenOrder.removeFirst())
        }
    }
}
