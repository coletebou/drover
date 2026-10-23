import Foundation
import Testing
@testable import MenuBarCore

struct NotificationPlannerTests {
    let now = Date(timeIntervalSince1970: 1_000_000)

    func item(_ id: String, kind: String = "decision", title: String = "T", body: String? = "B",
              session: String? = "s1") -> NotificationItem {
        NotificationItem(id: id, at: "", kind: kind, title: title, body: body, sessionId: session,
                         host: "local", category: nil, test: nil)
    }

    func plan(_ items: [NotificationItem], prefs: MenuBarPreferences = .default, muted: Date? = nil,
              posted: Set<String> = [], max: Int = 3) -> [PlannedNotification] {
        NotificationPlanner.plan(items, preferences: prefs, mutedUntil: muted, now: now,
                                 alreadyPosted: posted, maxIndividual: max)
    }

    @Test func disabledAndMuted() {
        var prefs = MenuBarPreferences.default
        prefs.notifyOnWaiting = false
        #expect(plan([item("1")], prefs: prefs).isEmpty)
        #expect(plan([item("1")], muted: now.addingTimeInterval(60)).isEmpty)
        #expect(plan([item("1")], muted: now.addingTimeInterval(-60)).count == 1)
    }

    @Test func kindFilter() {
        let items = ["mr", "launch", "manager", "finished", "error", "decision", "question"].map { item($0, kind: $0) }
        #expect(plan(items, max: 10).map(\.identifier) ==
                ["finished", "error", "decision", "question"].map { "drover.notify.\($0)" })
    }

    @Test func dedupe() {
        #expect(plan([item("1"), item("2")], posted: ["1"]).map(\.identifier) == ["drover.notify.2"])
    }

    @Test func truncation() {
        let p = plan([item("1", title: String(repeating: "a", count: 200), body: String(repeating: "b", count: 500))])[0]
        #expect(p.title.count == 80 && p.title.hasSuffix("…"))
        #expect(p.body.count == 240 && p.body.hasSuffix("…"))
        #expect(plan([item("2", body: nil)])[0].body == "")
    }

    @Test func replyAndSound() {
        let decision = plan([item("1")])[0]
        #expect(decision.canReply && decision.playSound && decision.threadID == "s1")
        let noSession = plan([item("2", session: nil)])[0]
        #expect(!noSession.canReply && noSession.threadID == "drover")
        let finished = plan([item("3", kind: "finished")])[0]
        #expect(!finished.canReply && !finished.playSound)
        var prefs = MenuBarPreferences.default
        prefs.notificationSound = false
        #expect(!plan([item("4")], prefs: prefs)[0].playSound)
    }

    @Test func collapse() {
        let items = (1...5).map { item("\($0)", title: "t\($0)") }
        let out = plan(items)
        #expect(out.count == 3)
        #expect(out[0].identifier == "drover.notify.4")
        #expect(out[1].identifier == "drover.notify.5")
        #expect(out[2].identifier == "drover.notify.summary.5")
        #expect(out[2].title == "3 more sessions need you")
        #expect(out[2].body == "t1, t2, t3")
        #expect(out[2].threadID == "drover" && !out[2].canReply && out[2].sessionId == nil)
        #expect(plan(Array(items.prefix(3))).count == 3)
    }
}
