import Foundation
import Testing
@testable import DroverKit

actor SinceLog {
    private(set) var values: [String?] = []
    func add(_ s: String?) { values.append(s) }
}

struct NotificationFeedTests {
    /// A fresh suite name; the feed gets its own UserDefaults instance, the test inspects another one.
    static func suite() -> (name: String, inspect: UserDefaults) {
        let name = "droverkit-test-\(UUID().uuidString)"
        return (name, UserDefaults(suiteName: name)!)
    }

    @Test func firstPollReturnsNothingThenItems() async throws {
        let (name, defaults) = Self.suite()
        defer { defaults.removePersistentDomain(forName: name) }
        let result = try TestFixtures.notifications()
        let log = SinceLog()
        let feed = NotificationFeed(fetch: { since in await log.add(since); return result }, defaults: UserDefaults(suiteName: name))
        #expect(try await feed.poll().isEmpty)
        #expect(defaults.string(forKey: "drover.notifications.cursor") == result.cursor)

        let later = NativeNotifications(cursor: "next", items: [result.items[0]])
        let feed2 = NotificationFeed(fetch: { since in await log.add(since); return since == nil ? result : later }, defaults: UserDefaults(suiteName: name))
        let items = try await feed2.poll()
        #expect(items.map(\.id) == ["ev-demo-0001"])
        #expect(await log.values == [nil, result.cursor])
        #expect(defaults.string(forKey: "drover.notifications.cursor") == "next")
    }

    @Test func dedupes() async throws {
        let result = try TestFixtures.notifications()
        let feed = NotificationFeed(fetch: { _ in result }, defaults: nil)
        #expect(try await feed.poll().isEmpty)
        let first = try await feed.poll()
        // Seen ids from the first (silent) poll are not re-delivered.
        #expect(first.isEmpty)
    }

    @Test func dedupesAcrossPolls() async throws {
        let result = try TestFixtures.notifications()
        let empty = NativeNotifications(cursor: "c0", items: [])
        let feed = NotificationFeed(fetch: { since in since == nil ? empty : result }, defaults: nil)
        #expect(try await feed.poll().isEmpty)
        #expect(try await feed.poll().count == result.items.count)
        #expect(try await feed.poll().isEmpty)
    }

    @Test func resetClearsCursorAndSeen() async throws {
        let (name, defaults) = Self.suite()
        defer { defaults.removePersistentDomain(forName: name) }
        let result = try TestFixtures.notifications()
        let empty = NativeNotifications(cursor: "c0", items: [])
        let feed = NotificationFeed(fetch: { since in since == nil ? empty : result }, defaults: UserDefaults(suiteName: name))
        _ = try await feed.poll()
        #expect(try await feed.poll().count == 4)
        await feed.reset()
        #expect(defaults.string(forKey: "drover.notifications.cursor") == nil)
        #expect(try await feed.poll().isEmpty)
        #expect(try await feed.poll().count == 4)
    }

    @Test func errorKeepsCursor() async throws {
        let feed = NotificationFeed(fetch: { since in
            if since == nil { return NativeNotifications(cursor: "c1", items: []) }
            throw DroverError.transport("down")
        }, defaults: nil)
        _ = try await feed.poll()
        await #expect(throws: DroverError.self) { try await feed.poll() }
    }
}

@Suite("NotificationFeed concurrency")
struct NotificationFeedConcurrencyTests {
    actor Server {
        var calls: [String?] = []
        func answer(_ since: String?) async throws -> NativeNotifications {
            calls.append(since)
            try await Task.sleep(for: .milliseconds(20))
            let n = calls.count
            let item = NotificationItem(id: "ev-demo-\(n)", at: DroverTimestamp(Date(timeIntervalSince1970: 1_791_757_200 + Double(n))), kind: .finished, title: "demo-\(n) finished")
            return NativeNotifications(cursor: "c\(n)", items: since == nil ? [] : [item])
        }
    }

    @Test func parallelPollsAreSerialized() async throws {
        let server = Server()
        let feed = NotificationFeed(fetch: { try await server.answer($0) }, defaults: nil)
        async let a = feed.poll()
        async let b = feed.poll()
        let (ra, rb) = try await (a, b)
        let calls = await server.calls
        #expect(calls.count == 2)
        #expect(calls.filter { $0 == nil }.count == 1)   // only one baseline poll
        #expect((ra + rb).count == 1)                    // the second poll delivers the new item
    }
}
