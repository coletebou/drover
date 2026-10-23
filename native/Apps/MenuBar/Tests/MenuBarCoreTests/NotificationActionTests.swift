import Foundation
import Testing
@testable import MenuBarCore

// Dialog alerts get buttons that press a key with sessions.answer (and the screen hash), besides Reply and Open.

struct NotificationActionTests {
    let now = Date(timeIntervalSince1970: 1_000_000)

    func dialogItem(id: String = "n-1", category: String = "needs-you", session: String? = "s-1", target: String? = nil,
                    options: [DialogOption] = [DialogOption(n: 1, label: "Yes", selected: true),
                                               DialogOption(n: 2, label: "Yes, and don't ask again for git status commands in ~/code/demo"),
                                               DialogOption(n: 3, label: "No, and tell Claude what to do differently (esc)")],
                    keys: [String]? = ["1", "2", "3", "Enter", "Escape"], hash: String? = "h-1", answer: AnswerMode? = .keys) -> NotificationItem {
        var item = NotificationItem(id: id, at: "", kind: "decision", title: "demo-build needs a decision", body: "Do you want to proceed?",
                                    sessionId: session, host: "local", category: category, test: nil)
        item.dialog = DialogInfo(question: "Do you want to proceed?", options: options)
        item.keys = keys
        item.hash = hash
        item.answer = answer
        item.target = target
        return item
    }

    func plan(_ items: [NotificationItem]) -> [PlannedNotification] {
        NotificationPlanner.plan(items, preferences: .default, mutedUntil: nil, now: now, alreadyPosted: [])
    }

    @Test func optionsBecomeButtons() throws {
        let p = try #require(plan([dialogItem()]).first)
        #expect(p.actions.map(\.identifier) == ["drover.key.1", "drover.key.2", "drover.key.3"])
        #expect(p.actions.map(\.title) == ["1 Yes", "2 Yes, don't ask again", "3 No"])
        #expect(p.actions.map(\.key) == ["1", "2", "3"])
        #expect(p.answerID == "s-1" && p.expect == "h-1")
        #expect(p.canReply, "Reply and Open stay")
        #expect(p.categoryID.hasPrefix("drover.dialog."))
        // The same buttons map to the same category, launch after launch.
        #expect(p.categoryID == plan([dialogItem(id: "n-2")]).first?.categoryID)
        #expect(p.categoryID != plan([dialogItem(id: "n-3", options: [DialogOption(n: 1, label: "Yes"), DialogOption(n: 2, label: "No")],
                                                 keys: ["1", "2"])]).first?.categoryID)
    }

    @Test func approveAndDenyWithoutOptions() throws {
        let p = try #require(plan([dialogItem(options: [], keys: ["Enter", "Escape"])]).first)
        #expect(p.actions.map(\.title) == ["Approve (Enter)", "Deny (Esc)"])
        #expect(p.actions.map(\.key) == ["Enter", "Escape"])
        let held = try #require(plan([dialogItem(category: "held", session: nil, target: "work:4", options: [], keys: ["Enter", "Escape"])]).first)
        #expect(held.actions.map(\.title) == ["Deliver (Enter)", "Drop (Esc)"])
        #expect(held.answerID == "work:4")
        #expect(!held.canReply, "no session to reply to")
        let yn = try #require(plan([dialogItem(options: [], keys: ["y", "n", "Enter", "Escape"])]).first)
        #expect(yn.actions.map(\.title) == ["Yes (y)", "No (n)", "Approve (Enter)", "Deny (Esc)"])
    }

    @Test func noHashOrNoKeysMeansNoButtons() throws {
        for item in [dialogItem(hash: nil), dialogItem(hash: ""), dialogItem(keys: nil), dialogItem(keys: []), dialogItem(answer: .reply),
                     dialogItem(session: nil, target: nil)] {
            let p = try #require(plan([item]).first)
            #expect(p.actions.isEmpty)
            #expect(p.answerID == nil && p.expect == nil)
            #expect(p.categoryID == (p.canReply ? PlannedNotification.waitingCategory : PlannedNotification.infoCategory))
        }
        var finished = dialogItem()
        finished.kind = "finished"
        finished.category = "finished"
        #expect(plan([finished]).first?.actions.isEmpty == true, "only alerts that need you get keys")
    }

    @Test func oldAlertsKeepReplyAndOpen() throws {
        let item = NotificationItem(id: "n-9", at: "", kind: "question", title: "T", body: "B", sessionId: "s-9", host: "local", category: "needs-you", test: nil)
        let p = try #require(plan([item]).first)
        #expect(p.actions.isEmpty && p.canReply && p.categoryID == PlannedNotification.waitingCategory)
    }

    @Test func actionIdentifiersParseOnlyPressableKeys() {
        #expect(PlannedAction.key(fromIdentifier: "drover.key.1") == "1")
        #expect(PlannedAction.key(fromIdentifier: "drover.key.Escape") == "Escape")
        #expect(PlannedAction.key(fromIdentifier: "drover.key.rm -rf") == nil)
        #expect(PlannedAction.key(fromIdentifier: "drover.open") == nil)
        #expect(PlannedAction.key(fromIdentifier: "drover.reply") == nil)
    }

    @Test func digestIsStable() {
        #expect(PlannedNotification.digest("") == "cbf29ce484222325")
        #expect(PlannedNotification.digest("a") == "af63dc4c8601ec8c")
    }
}

/// One click is one deep link: the same URL again within a second (a double click, a notification action racing
/// the popover) is dropped; another URL, or the same one later, goes through.
struct OpenThrottleTests {
    @Test func doubleClickIsOneOpen() {
        var t = OpenThrottle()
        let now = Date(timeIntervalSince1970: 1000)
        let session = Links.appSession("s-1", host: "local")
        let opens = [
            (session, 0.0), (session, 0.3), (Links.appManager, 0.4), (session, 0.5), (session, 1.2), (session, 2.6),
        ].map { url, dt in t.allow(url, now: now.addingTimeInterval(dt)) }
        // A different URL in between resets the pair; a second within a second of the same URL is dropped.
        #expect(opens == [true, false, true, true, false, true])
    }

    @Test func managerLinks() {
        #expect(Links.appManager.absoluteString == "drover://manager")
        #expect(Links.webManager(base: URL(string: "http://127.0.0.1:7337")!).absoluteString == "http://127.0.0.1:7337/#/manager")
    }
}
