import Foundation

private func item(_ id: String, name: String = "Alpha", host: String? = "box1", headline: String = "Need a decision") -> WaitingItem {
    WaitingItem(id: id, name: name, host: host, headline: headline)
}

private func noEmDash(_ p: NotificationContent.Payload) -> Bool {
    ![p.identifier, p.title, p.body].contains { $0.contains("\u{2014}") }
}

let backgroundTests: [TestCase] = [
    TestCase("policy: success uses base interval") {
        try expectEqual(RefreshPolicy.nextInterval(succeeded: true, consecutiveFailures: 0), 900)
        try expectEqual(RefreshPolicy.nextInterval(succeeded: true, consecutiveFailures: 5), 900)
    },
    TestCase("policy: failures back off 30m, 60m, 120m") {
        try expectEqual(RefreshPolicy.nextInterval(succeeded: false, consecutiveFailures: 1), 1800)
        try expectEqual(RefreshPolicy.nextInterval(succeeded: false, consecutiveFailures: 2), 3600)
        try expectEqual(RefreshPolicy.nextInterval(succeeded: false, consecutiveFailures: 3), 7200)
    },
    TestCase("policy: failure backoff is capped at 2 hours") {
        try expectEqual(RefreshPolicy.nextInterval(succeeded: false, consecutiveFailures: 10), 7200)
        try expectEqual(RefreshPolicy.nextInterval(succeeded: false, consecutiveFailures: 1000), 7200)
    },
    TestCase("policy: never below minimum") {
        try expectEqual(RefreshPolicy.nextInterval(succeeded: false, consecutiveFailures: 0), 1800)
        try expectEqual(RefreshPolicy.nextInterval(succeeded: false, consecutiveFailures: -3), 1800)
        try expect(RefreshPolicy.nextInterval(succeeded: true, consecutiveFailures: 0) >= RefreshPolicy.minimum)
    },
    TestCase("failure counter: counts, persists and resets") {
        let d = scratchDefaults()
        let c = RefreshFailureCounter(defaults: d)
        try expectEqual(c.count, 0)
        try expectEqual(c.recordFailure(), 1)
        try expectEqual(c.recordFailure(), 2)
        try expectEqual(RefreshFailureCounter(defaults: d).count, 2)
        try expectEqual(d.integer(forKey: RefreshFailureCounter.key), 2)
        c.recordSuccess()
        try expectEqual(c.count, 0)
        c.count = 7
        try expectEqual(c.count, 7)
    },
    TestCase("notification: no items gives nil") {
        try expect(NotificationContent.make(for: []) == nil)
    },
    TestCase("notification: one item") {
        let it = item("s1")
        let p = try { () throws -> NotificationContent.Payload in
            guard let p = NotificationContent.make(for: [it]) else { throw TestFailure(description: "nil payload") }
            return p
        }()
        try expectEqual(p.identifier, "drover.waiting.box1/s1")
        try expectEqual(p.title, "Alpha")
        try expectEqual(p.body, "Need a decision")
        try expectEqual(p.threadIdentifier, "drover.waiting")
        try expectEqual(p.link.absoluteString, "drover://session/s1?host=box1")
        try expectEqual(DeepLink(url: p.link), DeepLink.session(id: "s1", host: "box1"))
    },
    TestCase("notification: one item without host") {
        guard let p = NotificationContent.make(for: [item("s2", host: nil)]) else { throw TestFailure(description: "nil") }
        try expectEqual(DeepLink(url: p.link), DeepLink.session(id: "s2", host: nil))
    },
    TestCase("notification: empty headline falls back") {
        guard let p = NotificationContent.make(for: [item("s1", headline: "")]) else { throw TestFailure(description: "nil") }
        try expectEqual(p.body, "Waiting on you")
    },
    TestCase("notification: long headline truncated to 180 plus ellipsis") {
        guard let p = NotificationContent.make(for: [item("s1", headline: String(repeating: "a", count: 200))]) else { throw TestFailure(description: "nil") }
        try expectEqual(p.body, String(repeating: "a", count: 180) + "…")
        guard let q = NotificationContent.make(for: [item("s1", headline: String(repeating: "b", count: 180))]) else { throw TestFailure(description: "nil") }
        try expectEqual(q.body, String(repeating: "b", count: 180))
    },
    TestCase("notification: several items batch to board") {
        let items = [item("a", name: "Alpha"), item("b", name: "Beta"), item("c", name: "Gamma")]
        guard let p = NotificationContent.make(for: items) else { throw TestFailure(description: "nil") }
        try expectEqual(p.identifier, "drover.waiting.batch")
        try expectEqual(p.title, "3 sessions waiting on you")
        try expectEqual(p.body, "Alpha, Beta, Gamma")
        try expectEqual(DeepLink(url: p.link), DeepLink.board)
        try expectEqual(p.threadIdentifier, "drover.waiting")
    },
    TestCase("notification: batch body truncated") {
        let items = (0..<30).map { item("i\($0)", name: "Session number \($0)") }
        guard let p = NotificationContent.make(for: items) else { throw TestFailure(description: "nil") }
        try expectEqual(p.body.count, 181)
        try expect(p.body.hasSuffix("…"))
    },
    TestCase("notification: link key and no em dash") {
        try expectEqual(NotificationContent.linkKey, "drover.link")
        let one = NotificationContent.make(for: [item("s1", headline: "")])
        let many = NotificationContent.make(for: [item("a"), item("b")])
        try expect(one.map(noEmDash) ?? false)
        try expect(many.map(noEmDash) ?? false)
    },
]
