import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// Convenience initializers that wire the stream and stores to an DroverClient. The stores themselves take
// closures, so they stay testable without a client.

extension EventStream {
    /// SSE from the client's daemon. Needs the main token: the widget token is refused on /api/stream.
    /// Streams through the client's URLSession, so a MockServer client gets the fixture stream.
    public init(client: DroverClient, backoff: Backoff = .standard) {
        let session = client.session
        self.init(request: { try await client.streamRequest() }, backoff: backoff,
                  connect: { req in try await EventStream.sessionConnect(session, req) })
    }
}

extension SummaryStore {
    /// Polls `native.summary` through the client (the widget scope is enough).
    public convenience init(client: DroverClient, cache: SummaryCache? = nil, onSave: (@MainActor @Sendable () -> Void)? = nil) {
        self.init(fetch: { try await client.summary() }, cache: cache, onSave: onSave)
    }
}

extension NotificationFeed {
    /// `native.notifications` through the client; `wait` (seconds, max 25) long-polls on the daemon.
    public init(client: DroverClient, wait: Int? = nil,
                defaults: UserDefaults? = UserDefaults(suiteName: DroverIdentifiers.appGroup),
                cursorKey: String = "drover.notifications.cursor") {
        self.init(fetch: { since in try await client.notifications(since: since, wait: wait) }, defaults: defaults, cursorKey: cursorKey)
    }
}
