import Foundation

/// A local notification ready to post. Plain values only, so the decision logic stays testable.
struct PlannedNotification: Sendable, Hashable {
    var id: String
    var title: String
    var body: String
    var threadID: String
    var categoryID: String
    var sessionId: String?
    var host: String?
    var kind: String
    var playsSound: Bool
}

/// Result of deciding what to do with one `native.notifications` response.
struct NotificationPlan: Sendable, Hashable {
    static let sessionCategory = "drover.session"
    static let infoCategory = "drover.info"
    static let ringCapacity = 200
    static let maxBodyLength = 300
    static let soundKinds: Set<String> = ["decision", "question", "error"]

    var notifications: [PlannedNotification]
    /// Cursor to store after posting (the old one when the response carried none).
    var cursor: String?
    /// The dedupe ring after this plan, oldest first, at most `ringCapacity` ids.
    var postedRing: [String]

    /// First-run rule: with no stored cursor, adopt the returned cursor and post nothing.
    static func make(feed: NotificationFeed, storedCursor: String?, mutedKinds: Set<String>, postedRing: [String]) -> NotificationPlan {
        let newCursor = feed.cursor?.value ?? storedCursor
        guard storedCursor != nil else {
            return NotificationPlan(notifications: [], cursor: newCursor, postedRing: postedRing)
        }
        var seen = Set(postedRing)
        var ring = postedRing
        var out: [PlannedNotification] = []
        for item in feed.items {
            if item.test == true { continue }
            if let k = item.kind, mutedKinds.contains(k) { continue }
            if let c = item.category, mutedKinds.contains(c) { continue }
            if seen.contains(item.id) { continue }
            seen.insert(item.id)
            ring.append(item.id)
            out.append(planned(item))
        }
        if ring.count > ringCapacity { ring.removeFirst(ring.count - ringCapacity) }
        return NotificationPlan(notifications: out, cursor: newCursor, postedRing: ring)
    }

    static func planned(_ item: NotificationFeed.Item) -> PlannedNotification {
        let kind = item.kind ?? item.category ?? "info"
        let hasSession = item.sessionId?.isEmpty == false
        let thread: String
        if let ref = item.ref, hasSession { thread = ref.key } else { thread = kind }
        return PlannedNotification(
            id: item.id,
            title: item.title,
            body: truncated(item.body ?? ""),
            threadID: thread,
            categoryID: hasSession ? sessionCategory : infoCategory,
            sessionId: hasSession ? item.sessionId : nil,
            host: item.host,
            kind: kind,
            playsSound: soundKinds.contains(kind))
    }

    static func truncated(_ s: String, limit: Int = maxBodyLength) -> String {
        s.count <= limit ? s : String(s.prefix(limit - 1)) + "\u{2026}"
    }
}
