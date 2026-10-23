import Foundation
import Testing
@testable import MenuBarCore

// Dialog answers (UX overhaul contract): the new summary fields, the key buttons, and sessions.answer with its
// refusals. Fixtures are synthetic.

@Suite struct DialogFieldDecodingTests {
    @Test func summaryWithDialogFieldsDecodes() throws {
        let s = try JSONDecoder().decode(Summary.self, from: Fixtures.data("summary-dialog"))
        #expect(s.waiting.count == 3)
        let build = s.waiting[0]
        #expect(build.dialog?.question == "Do you want to proceed?")
        #expect(build.dialog?.options.map(\.n) == [1, 2, 3])
        #expect(build.dialog?.selectedOption?.n == 1)
        #expect(build.hash == "3f2a9c1e5b7d2a46")
        #expect(build.keys == ["1", "2", "3", "Enter", "Escape"])
        #expect(build.answer == .keys)
        #expect(s.waiting[1].answer == .reply)
        #expect(s.waiting[1].dialog == nil && s.waiting[1].keys == nil)
        // Malformed options are dropped, the item and the summary survive.
        #expect(s.waiting[2].dialog?.options.isEmpty == true)
        #expect(s.waiting[2].dialog?.question == nil)
        #expect(s.manager?.host == "local")
        #expect(s.manager?.opHost == nil)
    }

    @Test func oldSummaryHasNoAnswerFields() throws {
        let s = try Fixtures.summary()
        #expect(s.waiting.allSatisfy { $0.dialog == nil && $0.keys == nil && $0.answer == nil && $0.hash == nil })
        #expect(s.manager?.host == nil)
    }

    @Test func badFieldTypesAreIgnoredNotFatal() throws {
        let json = #"{"id":"a","name":"demo","host":"local","engine":"claude","kind":"decision","headline":"h","dialog":"oops","keys":"1","answer":"later","hash":7}"#
        let item = try JSONDecoder().decode(WaitingItem.self, from: Data(json.utf8))
        #expect(item.dialog == nil && item.keys == nil && item.hash == nil)
        #expect(item.answer == .unknown)
    }

    @Test func stringOptionNumbersDecode() throws {
        let json = #"{"question":"Pick one","options":[{"n":"2","label":"Second"},{"n":1,"label":"First","selected":false}]}"#
        let d = try JSONDecoder().decode(DialogInfo.self, from: Data(json.utf8))
        #expect(d.options.map(\.n) == [2, 1])
        #expect(d.selectedOption == nil)
    }

    @Test func remoteManagerHost() throws {
        let m = try JSONDecoder().decode(ManagerState.self, from: Data(#"{"up":true,"lastNoteAt":null,"host":"demo-box"}"#.utf8))
        #expect(m.opHost == "demo-box")
    }

    @Test func notificationDialogFields() throws {
        let json = #"""
        {"id":"n-1","at":"2026-10-20T18:00:00.000Z","kind":"decision","category":"needs-you","title":"demo-build needs a decision",
         "body":"Do you want to proceed?","sessionId":null,"host":"local","target":"work:3",
         "dialog":{"question":"Do you want to proceed?","options":[{"n":1,"label":"Yes","selected":true},{"n":2,"label":"No"}]},
         "hash":"abc123","keys":["1","2","Enter","Escape"],"answer":"keys"}
        """#
        let n = try JSONDecoder().decode(NotificationItem.self, from: Data(json.utf8))
        #expect(n.answerID == "work:3")
        #expect(n.hash == "abc123")
        #expect(n.keys?.count == 4)
        #expect(n.dialog?.options.count == 2)
    }

    @Test func roundTripKeepsFieldsForTheWidgetCache() throws {
        let s = Summary.preview
        let again = try JSONDecoder().decode(Summary.self, from: JSONEncoder().encode(s))
        #expect(again == s)
        #expect(again.waiting[0].keys == ["1", "2", "3", "Enter", "Escape"])
    }
}

@Suite struct AnswerModelTests {
    private func item(_ name: String) throws -> WaitingItem {
        let s = try JSONDecoder().decode(Summary.self, from: Fixtures.data("summary-dialog"))
        return try #require(s.waiting.first { $0.name == name })
    }

    @Test func permissionDialogButtons() throws {
        let plan = AnswerModel.plan(for: try item("demo-build"))
        guard case .keys(let question, let buttons) = plan else { Issue.record("expected keys"); return }
        #expect(question == "Do you want to proceed?")
        #expect(buttons.map(\.key) == ["1", "2", "3", "Enter", "Escape"])
        #expect(buttons.map(\.title) == ["1 Yes", "2 Yes, don't ask again", "3 No", "Enter", "Esc"])
        #expect(buttons.map(\.selected) == [true, false, false, false, false])
        #expect(buttons[1].help == "2. Yes, and don't ask again for npm test commands in ~/code/demo")
        #expect(buttons[2].help == "3. No, and tell Claude what to do differently (esc)")
        #expect(buttons[3].help == "Press Enter: 1. Yes")
        #expect(buttons.map(\.role) == [.option, .option, .option, .enter, .escape])
        #expect(buttons[0].accessibilityLabel == "Answer 1, Yes")
    }

    @Test func replyQuestionHasNoKeys() throws {
        #expect(AnswerModel.plan(for: try item("demo-review")) == .reply)
    }

    @Test func heldMessageKeepsOnlyPressableKeys() throws {
        let plan = AnswerModel.plan(for: try item("demo-peer"))
        #expect(plan.buttons.map(\.key) == ["Enter", "Escape"])
        #expect(plan.buttons.map(\.title) == ["Enter", "Esc"])
    }

    @Test func multiSelectOffersSpaceToTick() {
        let dialog = DialogInfo(question: "Which fixtures?", options: [DialogOption(n: 1, label: "[ ] Unit", selected: true),
                                                                       DialogOption(n: 2, label: "[x] End to end")])
        let plan = AnswerModel.plan(dialog: dialog, keys: ["1", "2", "Space", "Enter", "Escape"], answer: .keys, hash: "h1")
        #expect(plan.buttons.map(\.key) == ["1", "2", "Space", "Enter", "Escape"])
        let space = plan.buttons.first { $0.key == "Space" }
        #expect(space?.title == "Space (tick)")
        #expect(space?.role == .other)
    }

    @Test func olderDaemonOffersNothingToPress() {
        // No fixed 1/2/y/n chips: without keys from the daemon there is nothing to press.
        let legacy = WaitingItem(id: "s", name: "s", host: "local", engine: "claude", since: nil, kind: .decision, headline: "1 Yes 2 No")
        #expect(AnswerModel.plan(for: legacy) == .none)
        #expect(AnswerModel.plan(dialog: nil, keys: [], answer: .keys, hash: "h") == .none)
        #expect(AnswerModel.plan(dialog: nil, keys: ["F1", "q"], answer: nil, hash: "h") == .none)
    }

    @Test func noScreenHashMeansNothingToPress() throws {
        // Keys without the hash they were listed for: a press could land on another dialog.
        var item = try self.item("demo-build")
        #expect(!AnswerModel.plan(for: item).buttons.isEmpty)
        item.hash = nil
        #expect(AnswerModel.plan(for: item) == .none)
        item.hash = ""
        #expect(AnswerModel.plan(for: item) == .none)
        // A question asked in text needs no hash: it is a reply.
        #expect(AnswerModel.plan(dialog: nil, keys: nil, answer: .reply, hash: nil) == .reply)
    }

    @Test func lettersOnlyWhenListed() {
        let yn = AnswerModel.plan(dialog: DialogInfo(question: "Continue? (y/n)", options: []), keys: ["y", "n", "Enter", "Escape", "y"], answer: .keys, hash: "h")
        #expect(yn.buttons.map(\.key) == ["y", "n", "Enter", "Escape"])
        #expect(yn.buttons[0].accessibilityLabel == "Answer yes")
        let digitsOnly = AnswerModel.plan(dialog: DialogInfo(question: "Pick", options: [DialogOption(n: 1, label: "A")]), keys: ["1", "2"], answer: .keys, hash: "h")
        #expect(digitsOnly.buttons.map(\.title) == ["1 A", "2"])
    }

    @Test(arguments: [
        ("Yes", "Yes"),
        ("Yes, and don't ask again for npm test commands in ~/code/demo", "Yes, don't ask again"),
        ("No, and tell Claude what to do differently (esc)", "No"),
        ("Yes, allow all edits during this session (shift+tab)", "Yes, allow all edits…"),
        ("Use the in-memory map (Recommended)", "Use the in-memory map"),
        ("No, keep planning", "No, keep planning"),
        ("(esc)", "(esc)"),
        ("Supercalifragilisticexpialidociousness-everywhere", "Supercalifragilisticexpia…"),
    ])
    func shortLabels(input: String, expected: String) {
        #expect(AnswerModel.shortLabel(input) == expected)
        #expect(AnswerModel.shortLabel(input).count <= 26)
    }
}

@MainActor
@Suite struct StoreAnswerTests {
    /// Answers sessions.answer with `answer` and native.summary with the dialog fixture.
    private func makeStore(answer: @escaping @Sendable () -> (Int, Data)) throws -> (MenuBarStore, FakeTransport) {
        let summary = try envelopeOf(Fixtures.data("summary-dialog"))
        let t = FakeTransport(data: { r in
            switch r.url?.path {
            case "/api/op/native.summary": return (200, summary)
            case "/api/op/sessions.answer": return answer()
            default: return (404, Data())
            }
        })
        let store = MenuBarStore(preferences: { .default }, tokens: StaticTokens([.main: secret]), transport: t)
        store.sleep = { _ in }
        return (store, t)
    }

    private func envelopeOf(_ result: Data) -> Data {
        okBody(String(decoding: result, as: UTF8.self))
    }

    private func firstDialog(_ store: MenuBarStore) throws -> WaitingItem {
        try #require(store.summary?.waiting.first { $0.answer == .keys && $0.dialog?.options.isEmpty == false })
    }

    @Test func sentAnswerCarriesTheScreenHash() async throws {
        let (store, t) = try makeStore { (200, okBody(#"{"ok":true,"key":"1","target":"work:3","hash":"3f2a9c1e5b7d2a46"}"#)) }
        await store.refresh()
        let item = try firstDialog(store)
        await store.answer(item, key: "1")
        let req = try #require(t.requests(path: "/api/op/sessions.answer").first)
        let json = try bodyJSON(req.httpBody)
        #expect(json["id"] as? String == "s-demo-build")
        #expect(json["host"] as? String == "local")
        #expect(json["key"] as? String == "1")
        #expect(json["expect"] as? String == "3f2a9c1e5b7d2a46")
        #expect(json["actor"] as? String == AppIdentifiers.actor)
        #expect(req.value(forHTTPHeaderField: "Authorization") == "Bearer " + secret)
        let st = try #require(store.answerState(for: item))
        #expect(st.message == "Sent 1." && !st.isError && st.pressing == nil)
        // The summary still shows the old screen: the row holds its buttons back.
        #expect(store.isAwaitingScreen(item))
    }

    @Test func refusalShowsTheReasonAndRefreshes() async throws {
        let (store, t) = try makeStore {
            (200, okBody(#"{"ok":false,"refused":true,"reason":"the screen changed since you read it; read it again","hash":"ffff"}"#))
        }
        await store.refresh()
        let before = t.requests(path: "/api/op/native.summary").count
        let item = try firstDialog(store)
        await store.answer(item, key: "Escape")
        let st = try #require(store.answerState(for: item))
        #expect(st.isError)
        #expect(st.message == "Not sent: the screen changed since you read it; read it again.")
        #expect(!store.isAwaitingScreen(item))
        #expect(t.requests(path: "/api/op/native.summary").count == before + 1)
    }

    @Test func unknownOpTurnsAnswersOff() async throws {
        let (store, _) = try makeStore { (400, Data(#"{"ok":false,"error":"unknown op sessions.answer"}"#.utf8)) }
        await store.refresh()
        let item = try firstDialog(store)
        #expect(!store.answerPlan(for: item).buttons.isEmpty)
        await store.answer(item, key: "1")
        #expect(store.answersSupported == false)
        #expect(store.answerState(for: item)?.message == AnswerOutcome.unsupported.message)
        #expect(store.answerPlan(for: item) == .none)
    }

    @Test func noTmuxPaneIsAnError() async throws {
        let (store, _) = try makeStore { (400, Data(#"{"ok":false,"error":"this session has no tmux pane (reply with a message instead)"}"#.utf8)) }
        await store.refresh()
        let item = try firstDialog(store)
        await store.answer(item, key: "2")
        let st = try #require(store.answerState(for: item))
        #expect(st.isError && st.message == "this session has no tmux pane (reply with a message instead)")
    }

    @Test func keysTheDaemonDidNotListAreNeverSent() async throws {
        let (store, t) = try makeStore { (200, okBody(#"{"ok":true}"#)) }
        await store.refresh()
        let item = try firstDialog(store)
        await store.answer(item, key: "y")
        await store.answer(item, key: "9")
        #expect(t.requests(path: "/api/op/sessions.answer").isEmpty)
        let reply = try #require(store.summary?.waiting.first { $0.answer == .reply })
        await store.answer(reply, key: "1")
        #expect(t.requests(path: "/api/op/sessions.answer").isEmpty)
    }

    @Test func aRowWithoutAHashSendsNothing() async throws {
        var s = try JSONDecoder().decode(Summary.self, from: Fixtures.data("summary-dialog"))
        s.waiting[0].hash = nil
        let body = okBody(String(decoding: try JSONEncoder().encode(s), as: UTF8.self))
        let t = FakeTransport(data: { r in r.url?.path == "/api/op/native.summary" ? (200, body) : (200, okBody(#"{"ok":true}"#)) })
        let store = MenuBarStore(preferences: { .default }, tokens: StaticTokens([.main: secret]), transport: t)
        await store.refresh()
        let item = try #require(store.summary?.waiting.first)
        #expect(store.answerPlan(for: item) == .none, "Open and Reply only")
        await store.answer(item, key: "1")
        // The notification path refuses too, before any request.
        let out = try await store.answer(id: item.id, host: item.host, key: "1", expect: nil)
        #expect(out == .refused(reason: "there is no screen hash to check the dialog against; open the session"))
        #expect(try await store.answer(id: item.id, host: item.host, key: "1", expect: "").isSent == false)
        #expect(t.requests(path: "/api/op/sessions.answer").isEmpty)
    }

    @Test func widgetTokenOnlyCannotAnswer() async throws {
        let summary = okBody(String(decoding: try Fixtures.data("summary-dialog"), as: UTF8.self))
        let t = FakeTransport(data: { r in r.url?.path == "/api/op/native.summary" ? (200, summary) : (200, okBody("{}")) })
        let store = MenuBarStore(preferences: { .default }, tokens: StaticTokens([.widget: "w"]), transport: t)
        await store.refresh()
        let item = try firstDialog(store)
        await store.answer(item, key: "1")
        #expect(store.answerState(for: item)?.message == DroverError.missingToken(.main).userMessage)
        #expect(t.requests(path: "/api/op/sessions.answer").isEmpty)
    }

    @Test func outcomeMessages() {
        #expect(AnswerOutcome(AnswerResult(ok: true), key: "Escape").message == "Sent Esc.")
        #expect(AnswerOutcome(AnswerResult(ok: false, refused: true, reason: "no dialog is on screen any more"), key: "1").message
                == "Not sent: no dialog is on screen any more.")
        #expect(AnswerOutcome(AnswerResult(ok: false, refused: true), key: "1").message == "Not sent: the dialog changed, look again.")
    }
}
