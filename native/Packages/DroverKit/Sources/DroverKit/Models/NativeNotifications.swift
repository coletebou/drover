import Foundation

/// `native.notifications`: alerts newer than a cursor, oldest first.
public struct NativeNotifications: Sendable, Hashable, Codable {
    /// Opaque; pass back as `since`.
    public var cursor: String?
    public var items: [NotificationItem]
    public init(cursor: String?, items: [NotificationItem]) { self.cursor = cursor; self.items = items }
}

public struct NotificationItem: Sendable, Hashable, Codable, Identifiable {
    public var id: String
    public var at: DroverTimestamp
    public var kind: NotificationKind
    public var category: NotificationCategory?
    public var title: String
    public var body: String?
    public var sessionId: String?
    public var host: String?
    /// True for `notify.test` alerts.
    public var test: Bool?

    public init(id: String, at: DroverTimestamp, kind: NotificationKind, category: NotificationCategory? = nil, title: String, body: String? = nil, sessionId: String? = nil, host: String? = nil, test: Bool? = nil) {
        self.id = id; self.at = at; self.kind = kind; self.category = category; self.title = title; self.body = body; self.sessionId = sessionId; self.host = host; self.test = test
    }
}
