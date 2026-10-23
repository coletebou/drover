import Foundation

// Dialog alerts become notifications with one action per key; responses route to an answer, a reply or the window.
@MainActor
enum NotificationTests {
    static func item(dialog: DialogInfo?, keys: [String], hash: String? = "h1", held: Bool = false, answer: AnswerMode? = .keys,
                     session: String? = "s1") -> NotifyItem {
        NotifyItem(id: "n1", at: Date(), category: held ? .held : .needsYou, kind: "dialog", title: "demo-build needs a decision",
                   body: "Bash(npm test)", sessionId: session, host: "studio", tmuxTarget: "work:1",
                   dialog: dialog, hash: hash, keys: keys, answerMode: answer, held: held)
    }

    static func run() async {
        await T.suite("NotificationContentBuilder: dialog actions") {
            let options = DialogInfo(question: "Do you want to proceed?", options: [
                DialogOption(n: 1, label: "Yes", selected: true),
                DialogOption(n: 2, label: "Yes, and don't ask again for npm test commands in this project"),
                DialogOption(n: 3, label: "No"),
            ])
            let c = NotificationContentBuilder.content(for: item(dialog: options, keys: ["1", "2", "3", "Enter", "Escape"]))
            T.eq(c.actions.map(\.id), ["key:1", "key:2", "key:3", "key:Enter", "key:Escape"])
            T.eq(c.actions.map(\.title), ["1. Yes", "2. Yes, and don't ask again for npm test comman…", "3. No", "Enter", "Esc"], "labels cut to fit a menu")
            T.eq(c.actions.filter(\.destructive).map(\.id), ["key:Escape"])
            T.check(c.categoryId.hasPrefix("drover.dialog."), "a category of its own")
            T.eq(c.userInfo["hash"], "h1"); T.eq(c.userInfo["sessionId"], "s1"); T.eq(c.userInfo["target"], "work:1")
            T.eq(c.body, "Bash(npm test)\nDo you want to proceed?", "the question joins the body")
            let again = NotificationContentBuilder.content(for: item(dialog: options, keys: ["1", "2", "3", "Enter", "Escape"]))
            T.eq(again.categoryId, c.categoryId, "the same actions share a category")

            let prompt = NotificationContentBuilder.content(for: item(dialog: DialogInfo(question: "Continue?", options: []), keys: ["Enter", "Escape"]))
            T.eq(prompt.actions.map(\.title), ["Approve (Enter)", "Deny (Esc)"])
            T.check(prompt.categoryId != c.categoryId)
            let heldC = NotificationContentBuilder.content(for: item(dialog: nil, keys: ["Enter", "Escape"], held: true))
            T.eq(heldC.actions.map(\.title), ["Deliver (Enter)", "Drop (Esc)"]); T.eq(heldC.userInfo["held"], "1")

            T.eq(NotificationContentBuilder.content(for: item(dialog: options, keys: [], answer: .reply)).categoryId, "drover.session", "a question: Reply only")
            T.eq(NotificationContentBuilder.content(for: item(dialog: options, keys: ["1"], hash: nil)).categoryId, "drover.session", "no hash, no answer buttons")
            T.eq(NotificationContentBuilder.content(for: item(dialog: nil, keys: [], session: nil)).categoryId, "drover.info")
            T.eq(NotificationContentBuilder.key(fromAction: "key:Escape"), "Escape"); T.eq(NotificationContentBuilder.key(fromAction: "reply"), nil)
        }
        await T.suite("native.notifications items carry dialog fields") {
            let n = ServerEventMapper.notifyItem(T.json(#"""
            {"id":"a1","at":"2026-10-20T19:00:00.000Z","kind":"decision","category":"needs-you","title":"demo-build needs a decision",
             "body":"Do you want to proceed?","sessionId":"s1","host":"local","answer":"keys","hash":"h9",
             "dialog":{"question":"Do you want to proceed?","options":[{"n":1,"label":"Yes","selected":true},{"n":2,"label":"No"}]},
             "keys":["1","2","Enter","Escape"]}
            """#))
            T.eq(n?.keys, ["1", "2", "Enter", "Escape"]); T.eq(n?.hash, "h9"); T.eq(n?.answerMode, .keys); T.eq(n?.dialog?.options.count, 2)
            let old = ServerEventMapper.notifyItem(T.json(#"{"id":"a2","title":"t","category":"held","sessionId":"s1","hash":"h"}"#))
            T.eq(old?.keys, ["Enter", "Escape"], "a held alert from a daemon without keys"); T.check(old?.held == true)
            let plain = ServerEventMapper.notifyItem(T.json(#"{"id":"a3","title":"t","category":"finished","sessionId":"s1"}"#))
            T.eq(plain?.keys, []); T.eq(plain?.answerMode, nil)
        }
        await T.suite("NotificationResponseRoute") {
            let info = NotificationAction(sessionId: "s1", host: "studio", target: "work:1", hash: "h1", server: "http://a")
            T.eq(NotificationResponseRoute.decide(action: "key:2", info: info, text: nil, activeServer: "http://a"), .answer(key: "2"))
            T.eq(NotificationResponseRoute.decide(action: "key:2", info: info, text: nil, activeServer: "http://b"), .refuse, "an alert from another server")
            T.eq(NotificationResponseRoute.decide(action: "reply", info: info, text: "ok", activeServer: "http://a"), .reply(sessionId: "s1", text: "ok"))
            T.eq(NotificationResponseRoute.decide(action: "reply", info: info, text: "", activeServer: "http://a"), .ignore)
            T.eq(NotificationResponseRoute.decide(action: "reply", info: info, text: "x", activeServer: "http://b"), .refuse)
            T.eq(NotificationResponseRoute.decide(action: "open", info: info, text: nil, activeServer: "http://b"), .open, "opening is always fine")
            var noHash = info; noHash.hash = nil
            T.eq(NotificationResponseRoute.decide(action: "key:1", info: noHash, text: nil, activeServer: "http://a"), .open, "never a key without the screen it was for")
        }
    }
}
