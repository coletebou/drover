import Foundation

// Logic tests of the background slice.
extension Suites {
    static var backgroundSuites: [(String, () async throws -> Void)] { [("background", background)] }

    static func feed(_ cursor: String?, _ items: [NotificationFeed.Item]) -> NotificationFeed {
        NotificationFeed(cursor: cursor.map { LooseString($0) }, items: items)
    }

    static func item(_ id: String, kind: String? = "finished", category: String? = nil, test: Bool? = nil,
                     body: String? = "b", sessionId: String? = "s1", host: String? = "Mb") -> NotificationFeed.Item {
        NotificationFeed.Item(id: id, at: nil, kind: kind, category: category, test: test, title: "t \(id)",
                              body: body, sessionId: sessionId, host: host)
    }

    static func background() throws {
        // first run: adopt cursor, post nothing
        let first = NotificationPlan.make(feed: feed("9", [item("a")]), storedCursor: nil, mutedKinds: [], postedRing: [])
        expect(first.notifications.isEmpty && first.cursor == "9" && first.postedRing.isEmpty, "first run posts nothing")

        // normal run
        let p = NotificationPlan.make(feed: feed("10", [item("a", kind: "decision"), item("b")]), storedCursor: "9",
                                      mutedKinds: [], postedRing: [])
        expect(p.notifications.map(\.id) == ["a", "b"] && p.cursor == "10", "posts items and advances cursor")
        expect(p.notifications[0].playsSound && !p.notifications[1].playsSound, "sound by kind")
        let keep = NotificationPlan.make(feed: feed(nil, []), storedCursor: "9", mutedKinds: [], postedRing: [])
        expect(keep.cursor == "9", "keeps cursor when none returned")

        // mute by kind and category, test items
        let m = NotificationPlan.make(
            feed: feed("11", [item("k", kind: "mr"), item("c", kind: "finished", category: "held"), item("t", test: true), item("ok")]),
            storedCursor: "9", mutedKinds: ["mr", "held"], postedRing: [])
        expect(m.notifications.map(\.id) == ["ok"], "mute by kind and category, drop tests")

        // dedupe and ring capacity
        let ring = (0..<200).map { "old\($0)" }
        let d = NotificationPlan.make(feed: feed("12", [item("old5"), item("new1"), item("new1"), item("new2")]),
                                      storedCursor: "9", mutedKinds: [], postedRing: ring)
        expect(d.notifications.map(\.id) == ["new1", "new2"], "dedupe against ring and within feed")
        expect(d.postedRing.count == 200 && d.postedRing.first == "old2" && d.postedRing.last == "new2", "ring capacity and order")

        // truncation
        let long = String(repeating: "x", count: 500)
        let tr = NotificationPlan.make(feed: feed("13", [item("l", body: long), item("n", body: nil)]),
                                       storedCursor: "9", mutedKinds: [], postedRing: [])
        expect(tr.notifications[0].body.count == 300, "body truncated to 300")
        expect(tr.notifications[1].body.isEmpty, "nil body is empty")
        expect(NotificationPlan.truncated("short") == "short", "short body untouched")

        // thread and category
        let t = NotificationPlan.make(feed: feed("14", [item("s"), item("i", kind: "manager", sessionId: nil, host: nil)]),
                                      storedCursor: "9", mutedKinds: [], postedRing: [])
        expect(t.notifications[0].threadID == "Mb/s1" && t.notifications[0].categoryID == "drover.session", "session thread and category")
        expect(t.notifications[1].threadID == "manager" && t.notifications[1].categoryID == "drover.info", "info thread and category")
        expect(t.notifications[1].sessionId == nil, "no session id for info")
    }
}
