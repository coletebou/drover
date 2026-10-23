import Foundation

// Dialog keys -> buttons, Screen's own reading of a capture (its hash must equal the daemon's), and answering.
@MainActor
enum DialogTests {
    // Synthetic screens. The expected values were produced by the daemon's own code (web/core/tmux.js classifyScreen,
    // dialogSummary, screenHash, keyFitsDialog) on these exact strings.
    static let question = "Should the review cover the test fixtures too?\n\n❯ 1. Yes, all of them (Recommended)\n  2. Only the new ones\n  3. No, skip fixtures\n  4. Type something.\n\nEnter to select · ↑/↓ to navigate · Esc to cancel"
    static let yn = "Overwrite demo.txt? (y/n)"
    static let held = "Held message from another session\nAnother Claude session sent a message: from demo-peer\nEnter to deliver · Esc to drop"
    nonisolated static let idle = "> \n? for shortcuts"
    static let boxed = "● Bash(npm test)\n  ⎿  Running…\n\n╭────────────╮\n│ Do you want to proceed?    │\n│ ❯ 1. Yes                   │\n│   2. No (esc)              │\n╰────────────╯   "
    /// `question` once "Type something." was picked: Claude Code 2.1.304 draws that option as an input in the same list,
    /// highlighted while it has the focus.
    nonisolated static let typing = "Should the review cover the test fixtures too?\n\n  1. Yes, all of them (Recommended)\n  2. Only the new ones\n  3. No, skip fixtures\n❯ 4. Type something.\n\nEnter to select · ↑/↓ to navigate · Esc to cancel"
    static let permission = " Do you want to proceed?\n ❯ 1. Yes\n   2. No (esc)\n\n Esc to cancel"

    static func run() async {
        await T.suite("DialogKeys.buttons") {
            let dialog = DialogInfo(question: "Do you want to proceed?", options: [
                DialogOption(n: 1, label: "Yes", selected: true), DialogOption(n: 2, label: "Yes, and don't ask again"), DialogOption(n: 3, label: "No"),
            ])
            let b = DialogKeys.buttons(dialog: dialog, keys: ["1", "2", "3", "Enter", "Escape"], held: false)
            T.eq(b.map(\.label), ["1. Yes", "2. Yes, and don't ask again", "3. No", "Enter", "Esc"])
            T.eq(b.map(\.key), ["1", "2", "3", "Enter", "Escape"])
            T.eq(b.filter(\.selected).map(\.key), ["1"], "the highlighted option")
            T.eq(b.map(\.kind), [.option, .option, .option, .confirm, .cancel])
            T.eq(DialogKeys.buttons(dialog: dialog, keys: [], held: false).map(\.key), ["1", "2", "3", "Enter", "Escape"], "no keys: the default ones")
            let heldB = DialogKeys.buttons(dialog: nil, keys: ["Enter", "Escape"], held: true)
            T.eq(heldB.map(\.label), ["Deliver (Enter)", "Drop (Esc)"])
            let prompt = DialogKeys.buttons(dialog: DialogInfo(question: "Continue?", options: []), keys: ["y", "n", "Enter", "Escape"], held: false, notification: true)
            T.eq(prompt.map(\.label), ["y", "n", "Approve (Enter)", "Deny (Esc)"], "a prompt with no options, on a notification")
            T.eq(DialogKeys.buttons(dialog: dialog, keys: ["9", "Up"], held: false).map(\.label), ["9", "↑"], "a digit with no option, an arrow")
            T.eq(DialogKeys.buttons(dialog: dialog, keys: ["1", "1"], held: false).count, 1, "duplicates dropped")
            T.eq(DialogKeys.defaultKeys(DialogInfo(question: nil, options: [DialogOption(n: 2, label: "b"), DialogOption(n: 12, label: "x")])), ["2", "Enter", "Escape"])
            T.eq(DialogKeys.pastTense("2", held: false), "picked 2"); T.eq(DialogKeys.pastTense("Enter", held: true), "delivered")
        }
        await T.suite("ScreenDialog reads a capture like the daemon") {
            guard let q = ScreenDialog.read(question) else { return T.fail("question dialog") }
            T.eq(q.hash, "57e27fadc3046458", "the daemon's screenHash")
            T.eq(q.dialog.question, "Should the review cover the test fixtures too?")
            T.eq(q.dialog.options.map(\.label), ["Yes, all of them (Recommended)", "Only the new ones", "No, skip fixtures", "Type something."])
            T.eq(q.dialog.options.map(\.selected), [true, false, false, false])
            T.eq(q.keys, ["1", "2", "3", "4", "Enter", "Escape"], "no y/n on a Claude Code dialog")
            guard let y = ScreenDialog.read(yn) else { return T.fail("y/n prompt") }
            T.eq(y.hash, "c32c405145c6be84"); T.eq(y.keys, ["y", "n", "Enter", "Escape"], "a (y/n) prompt takes the letters")
            guard let h = ScreenDialog.read(held) else { return T.fail("held message") }
            T.check(h.held); T.eq(h.hash, "3b160bf9d27ffa92"); T.eq(h.keys, ["Enter", "Escape"])
            T.check(ScreenDialog.read(idle) == nil, "an idle prompt is no dialog")
            T.check(ScreenDialog.read(boxed) == nil, "options inside a box are not an option list to the daemon either")
            T.eq(ScreenDialog.hash("a\n\nb   \n  "), ScreenDialog.hash("a\nb"), "blank lines and trailing spaces do not count")
        }
        await T.suite("AppModel.answer: one press, then the card follows the screen") {
            let mock = MockDroverService()
            let m = AppModel(settings: AppSettings(defaults: UserDefaults(suiteName: "harness-\(UUID())")!, group: nil),
                             tokens: MemoryTokenStore("x"), service: mock)
            await m.refresh()
            guard let build = m.board.sessions.first(where: { $0.name == "demo-build" }) else { return T.fail("demo-build") }
            T.check(m.showsAnswerCard(build), "card up")
            await m.answer(build, key: "1")
            T.check(mock.messagesSent.contains("answer 11111111-demo-build 1 expect \(MockDroverService.buildHash)"), "sessions.answer with the card's hash")
            T.check(!m.showsAnswerCard(build), "the pane was read again: no dialog, no card (the board still says one)")
            T.eq(m.liveDialogs[build.key]?.reading, nil)
            T.eq(m.answerNotice[build.key], nil)
            T.eq(m.toast?.text, "demo-build: picked 1")

            // The screen moved on before the press: the refusal brings the dialog now up, which the card shows.
            let other = MockDroverService()
            let m2 = AppModel(settings: AppSettings(defaults: UserDefaults(suiteName: "harness-\(UUID())")!, group: nil),
                              tokens: MemoryTokenStore("x"), service: other)
            await m2.refresh()
            await m2.answer(build, key: "2", expect: "moved")
            let now = m2.dialogState(build)
            T.eq(now?.dialog?.question, "Which fixtures?"); T.eq(now?.hash, "next-hash"); T.eq(now?.keys, ["1", "2", "Enter", "Escape"])
            T.eq(m2.answerNotice[build.key]?.isError, false, "not an error: the new dialog, ready to answer")
            var stale = build
            stale.hash = "stale"
            stale.id = "other"
            m2.liveDialogs[stale.key] = nil
            await m2.answer(stale, key: "2", expect: "stale")
            T.eq(m2.answerNotice[stale.key], AnswerNote(text: "Not sent: the screen changed since you read it; read it again", isError: true),
                 "a refusal without a dialog says why")
        }
        await T.suite("DialogResolver: a direct reading wins over the board until they agree") {
            let board = MockDroverService.sessions[0]   // demo-build, dialog with buildHash
            let t0 = Date(timeIntervalSince1970: 1_800_000_000)
            let next = ScreenDialog.Reading(dialog: MockDroverService.nextQuestion, hash: "next-hash", keys: ["1", "2", "Enter", "Escape"], held: false)
            T.eq(DialogResolver.state(board: board, live: nil, now: t0)?.hash, MockDroverService.buildHash, "no reading: the board")
            T.eq(DialogResolver.state(board: board, live: LiveDialog(reading: next, at: t0), now: t0.addingTimeInterval(1))?.hash, "next-hash", "a reading wins")
            T.check(DialogResolver.state(board: board, live: LiveDialog(reading: nil, at: t0), now: t0.addingTimeInterval(1)) == nil, "a reading of no dialog hides the card")
            let pressedLive = LiveDialog(reading: ScreenDialog.Reading(dialog: board.dialog!, hash: board.hash!, keys: board.keys, held: false), at: t0, pressed: board.hash)
            T.check(DialogResolver.state(board: board, live: pressedLive, now: t0.addingTimeInterval(1)) == nil, "the screen just answered is hidden")
            T.eq(DialogResolver.state(board: board, live: LiveDialog(reading: next, at: t0), now: t0.addingTimeInterval(30))?.hash, MockDroverService.buildHash, "an old reading gives way")
            T.check(DialogResolver.state(board: board, live: LiveDialog(reading: nil, at: t0, pressed: board.hash), now: t0.addingTimeInterval(30)) == nil,
                    "an expired press still hides the board's copy of the answered screen")

            var agree = board; agree.hash = "next-hash"
            T.check(!DialogResolver.keep(LiveDialog(reading: next, at: t0), board: agree, now: t0.addingTimeInterval(1)), "the board caught up: drop")
            T.check(DialogResolver.keep(LiveDialog(reading: next, at: t0), board: board, now: t0.addingTimeInterval(1)), "the board lags: keep")
            var none = board; none.dialog = nil; none.keys = []; none.hash = nil; none.answerMode = nil
            T.check(!DialogResolver.keep(LiveDialog(reading: nil, at: t0), board: none, now: t0.addingTimeInterval(1)), "both say no dialog")
            T.check(DialogResolver.keep(LiveDialog(reading: nil, at: t0), board: board, now: t0.addingTimeInterval(1)), "the board still shows the answered dialog")
            T.check(!DialogResolver.keep(LiveDialog(reading: next, at: t0), board: board, now: t0.addingTimeInterval(25)), "old: drop")

            let refusal = AnswerResult(ok: false, refused: true, reason: "the screen changed", hash: "h2", dialog: MockDroverService.nextQuestion)
            T.eq(DialogResolver.reading(fromRefusal: refusal)?.keys, ["1", "2", "Enter", "Escape"])
            T.eq(DialogResolver.reading(fromRefusal: AnswerResult(ok: false, refused: true, reason: "no dialog is on screen any more", hash: "h3")), nil)
        }
        await T.suite("ScreenDialog.read(capture:) goes by the daemon's classification") {
            let c = ScreenCapture(target: "t", text: question, state: .dialog, reason: nil)
            T.eq(ScreenDialog.read(capture: c)?.hash, "57e27fadc3046458")
            T.check(ScreenDialog.read(capture: ScreenCapture(target: "t", text: question, state: .unknown, reason: nil)) == nil, "the daemon says no dialog")
            T.check(ScreenDialog.read(capture: ScreenCapture(target: "t", text: held, state: .unknown, reason: nil))?.held == true, "a held message counts")
            let given = ScreenCapture(target: "t", text: "x", state: .dialog, reason: nil, dialog: MockDroverService.nextQuestion, hash: "dh", keys: ["1", "Enter"])
            T.eq(ScreenDialog.read(capture: given), ScreenDialog.Reading(dialog: MockDroverService.nextQuestion, hash: "dh", keys: ["1", "Enter"], held: false), "the daemon's own fields when it sends them")
            let review = "Review your answers\n\n ● Fixtures → Only the new ones\n\nReady to submit your answers?\n\n❯ 1. Submit answers\n  2. Cancel\n\nEnter to select · Esc to cancel"
            let r = ScreenDialog.read(review)
            T.eq(r?.dialog.question, "Ready to submit your answers?", "AskUserQuestion's review screen is a dialog")
            T.eq(r?.dialog.options.map(\.label), ["Submit answers", "Cancel"])
            let twice = "Pick one?\n❯ 1. A\n  2. B\nEnter to select · Esc to cancel\nPick one? (again)\n❯ 1. A2\n  2. B2\nEnter to select · Esc to cancel"
            T.eq(ScreenDialog.summary(twice).options.map(\.label), ["A2", "B2"], "a dialog drawn twice lists its latest drawing")
        }
        await T.suite("ScreenDialog agrees with the daemon on what is lowest (dcf28bf)") {
            // Expected values from the daemon's classifyScreen and heldMessage on these strings.
            let answeredBox = "Should the review cover the test fixtures too?\n\n❯ 1. Yes, all of them (Recommended)\n  2. Only the new ones\n  3. No, skip fixtures\n  4. Type something.\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n\n⏺ demo: working\n\nDone.\n\n╭────────╮\n│ >      │\n╰────────╯\n  ? for shortcuts      bypass permissions on"
            T.check((ScreenDialog.read(answeredBox) != nil) == false, "answeredBox: daemon says idle")
            let answeredBare = "Should the review cover the test fixtures too?\n\n❯ 1. Yes, all of them (Recommended)\n  2. Only the new ones\n  3. No, skip fixtures\n  4. Type something.\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n\nDone.\n────────────────────────────────────────\n❯ \n────────────────────────────────────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)"
            T.check((ScreenDialog.read(answeredBare) != nil) == false, "answeredBare: daemon says idle")
            let dialogAfterPrompt = "╭────────╮\n│ >      │\n╰────────╯\n  ? for shortcuts\nShould the review cover the test fixtures too?\n\n❯ 1. Yes, all of them (Recommended)\n  2. Only the new ones\n  3. No, skip fixtures\n  4. Type something.\n\nEnter to select · ↑/↓ to navigate · Esc to cancel"
            T.check((ScreenDialog.read(dialogAfterPrompt) != nil) == true, "dialogAfterPrompt: daemon says dialog")
            let heldThenPrompt = "Held message from another session\nAnother Claude session sent a message: from demo-peer\nEnter to deliver · Esc to drop\n\n> \n? for shortcuts"
            T.check((ScreenDialog.read(heldThenPrompt) != nil) == false, "heldThenPrompt: daemon says idle")
            let heldUp = "Done.\n? for shortcuts\nHeld message from another session\nAnother Claude session sent a message: from demo-peer\nEnter to deliver · Esc to drop"
            T.check((ScreenDialog.read(heldUp) != nil) == true, "heldUp: daemon says idle, held")
            T.check(ScreenDialog.read(heldUp)?.held == true, "heldUp is a held message")
            let busyBelow = "Should the review cover the test fixtures too?\n\n❯ 1. Yes, all of them (Recommended)\n  2. Only the new ones\n  3. No, skip fixtures\n  4. Type something.\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n\n✻ Compiling… (12s · esc to interrupt)"
            T.check((ScreenDialog.read(busyBelow) != nil) == false, "busyBelow: daemon says busy")
        }
        await T.suite("ScreenDialog reads one huge line in linear time (a capture is joined with -J)") {
            // As the daemon's own test (web/test/tmux.test.js, 44e88af): a run of 100K under a dialog, with no dialog,
            // and between an answered dialog and the prompt.
            let dialog = permission
            @MainActor func read(_ label: String, _ text: String) -> ScreenDialog.Reading? {
                let t0 = Date()
                let r = ScreenDialog.read(text)
                let ms = Int(Date().timeIntervalSince(t0) * 1000)
                T.check(ms < 1500, "\(label): took \(ms) ms")
                return r
            }
            for (name, run) in [("blanks", " "), ("tabs and blanks", " \t"), ("carriage returns", "\r"), ("line separators", "\u{2028}"),
                                ("paragraph separators", "\u{2029}")] {
                let long = String(repeating: run, count: 100_000 / run.unicodeScalars.count) + "x"
                T.eq(read(name, long + "\n" + dialog)?.dialog.options.map(\.n), [1, 2], "\(name): the dialog under the run")
                T.check(read(name, long) == nil, "\(name): no dialog")
                T.check(read(name, dialog + "\n" + long + "\n? for shortcuts") == nil, "\(name): answered, the prompt below it")
            }
        }
        await T.suite("A dialog above the idle prompt is history") {
            let answered = question + "\n\n⏺ demo-review: working in ~/work\n\nDone. The parser builds.\n\n╭────────╮\n│ >      │\n╰────────╯\n  ? for shortcuts      bypass permissions on"
            T.check(ScreenDialog.read(answered) == nil, "answered, scrolled up: no dialog")
            T.check(ScreenDialog.read(capture: ScreenCapture(target: "t", text: answered, state: .dialog, reason: nil)) == nil,
                    "even where the daemon counts it")
            T.check(ScreenDialog.read(answered + "\n" + question) != nil, "a dialog drawn after the prompt is up")
        }
        await T.suite("Free text options and multi-select keys") {
            let d = DialogInfo(question: "Which?", options: [DialogOption(n: 1, label: "A"), DialogOption(n: 4, label: "Type something.")])
            let b = DialogKeys.buttons(dialog: d, keys: ["1", "4", "Space", "Enter", "Escape"], held: false)
            T.eq(b.filter(\.freeText).map(\.key), ["4"], "Type something opens a field")
            T.eq(b.first { $0.key == "Space" }?.label, "Space (tick)")
            let st = DialogState(dialog: ScreenDialog.read(question)?.dialog, hash: "h", keys: ["1", "2", "3", "4", "Enter", "Escape"], held: false)
            T.eq(FreeTextField(picking: "4", on: st), FreeTextField(question: "Should the review cover the test fixtures too?", option: 4))
            T.eq(FreeTextField(picking: "1", on: st), nil, "another option opens no field")
            T.eq(FreeTextField(picking: "Enter", on: st), nil)
        }
        await T.suite("A Type something field opens once its press took, and its text goes only to that question") {
            @MainActor func model(_ ask: AskService) async -> (AppModel, SessionItem) {
                let m = AppModel(settings: AppSettings(defaults: UserDefaults(suiteName: "harness-\(UUID())")!, group: nil),
                                 tokens: MemoryTokenStore("x"), service: ask)
                await m.refresh()
                return (m, m.board.sessions[0])
            }
            /// The field open on `question`, the pane now showing it.
            @MainActor func opened() async -> (AskService, AppModel, SessionItem) {
                let ask = AskService(screen: question)
                let (m, s) = await model(ask)
                await m.answer(s, key: "4")
                return (ask, m, s)
            }

            let refusing = AskService(screen: question)
            let (m1, s1) = await model(refusing)
            refusing.screen = permission   // the screen moved on before the press
            await m1.answer(s1, key: "4")
            T.eq(m1.typingAnswer[s1.key], nil, "a refused press opens no field")
            T.eq(m1.dialogState(s1)?.dialog?.question, "Do you want to proceed?", "the card shows the dialog up now")

            let (ask, m, s) = await opened()
            T.eq(m.typingAnswer[s.key], FreeTextField(question: "Should the review cover the test fixtures too?", option: 4), "the press took: the field opens")
            T.check(m.showsAnswerCard(s), "the card stays for it")
            await m.sendFreeText(s, text: "Only the parser fixtures")
            T.eq(ask.pastes, ["work:6: Only the parser fixtures, Enter, forced"], "the text goes into the question's own field")
            T.eq(m.typingAnswer[s.key], nil, "and the field closes")

            let (other, mo, so) = await opened()
            other.screen = permission
            await mo.sendFreeText(so, text: "2 of them")
            T.eq(other.pastes, [], "another dialog is up: nothing goes (its digits and Enter would answer it)")
            T.eq(mo.toast?.text, "demo-ask: not sent, that question is no longer on screen")
            T.eq(mo.typingAnswer[so.key], nil)
            T.eq(mo.dialogState(so)?.dialog?.question, "Do you want to proceed?", "the card shows what is up instead")

            let (gone, mg, sg) = await opened()
            gone.screen = idle
            await mg.sendFreeText(sg, text: "rm -rf build")
            T.eq(gone.pastes, [], "no dialog (a prompt, a shell): nothing goes")

            let (again, ma, sa) = await opened()
            again.screen = question
            await ma.sendFreeText(sa, text: "only new")
            T.eq(again.pastes, [], "the same question drawn afresh highlights its first option, not the field: nothing goes")

            let (long, ml, sl) = await opened()
            long.screen = question.replacingOccurrences(of: "1. Yes, all of them (Recommended)", with: "1. Yes, " + String(repeating: "all of them ", count: 12))
            T.check(ScreenDialog.read(long.screen)?.dialog.options.contains { $0.selected } == false, "the highlighted row is too long to parse")
            await ml.sendFreeText(sl, text: "2 of them")
            T.eq(long.pastes, [], "a fresh drawing whose highlighted row is not parsed: the field is not seen highlighted, nothing goes")

            let (_, mn, sn) = await opened()
            mn.note(reading: ScreenDialog.read(typing), for: sn)
            T.check(mn.typingAnswer[sn.key] != nil, "a reading of the question keeps the field")
            mn.note(reading: ScreenDialog.read(permission), for: sn)
            T.eq(mn.typingAnswer[sn.key], nil, "a reading of another question closes it")
            let (_, mh, sh) = await opened()
            mh.note(reading: nil, for: sh)
            T.eq(mh.typingAnswer[sh.key], nil, "so does a reading of no dialog")

            let (_, mp, sp) = await opened()
            await mp.answer(sp, key: "2")
            T.eq(mp.typingAnswer[sp.key], nil, "pressing another option closes the field")
        }
    }
}

/// A pane with AskUserQuestion on it (MockDroverService has none): the test sets what it shows, answers press only on
/// the screen they were read from (the field opens on "4"), and pastes are recorded; a paste answers the question.
final class AskService: DroverService, @unchecked Sendable {
    private let lock = NSLock()
    private var shown: String
    private var sent: [String] = []

    init(screen: String) { shown = screen }

    var screen: String {
        get { lock.withLock { shown } }
        set { lock.withLock { shown = newValue } }
    }
    var pastes: [String] { lock.withLock { sent } }

    func board() async throws -> BoardSnapshot {
        var s = SessionItem(id: "66666666-demo-ask", name: "demo-ask", host: "studio", engine: "claude", status: "idle", cwd: "~/code/demo",
                            tmuxTarget: "work:6", live: true, updatedAt: Date(), lane: .waiting, waitKind: .question, headline: nil)
        if let r = ScreenDialog.read(screen) { s.screen = .dialog; s.dialog = r.dialog; s.hash = r.hash; s.keys = r.keys; s.answerMode = .keys }
        return BoardSnapshot(generatedAt: Date(), hosts: [HostItem(name: "studio", up: true, waiting: 1, working: 0, idle: 0)], sessions: [s],
                             usedNativeSummary: true, source: .mock)
    }

    func capture(target: String, host: String, lines: Int) async throws -> ScreenCapture {
        let text = screen
        return ScreenCapture(target: target, text: text, state: ScreenDialog.read(text) != nil ? .dialog : .idle, reason: nil)
    }

    func answer(id: String, host: String, target: String?, key: String, expect: String?) async throws -> AnswerResult {
        guard let now = ScreenDialog.read(screen) else { return AnswerResult(ok: false, refused: true, reason: "no dialog is on screen any more") }
        if let expect, expect != now.hash {
            return AnswerResult(ok: false, refused: true, reason: "the screen changed since you read it; read it again", hash: now.hash, dialog: now.dialog)
        }
        if key == "4" { screen = DialogTests.typing }
        return AnswerResult(ok: true, refused: false, reason: nil, hash: now.hash)
    }

    func sendToPane(target: String, host: String, text: String, enter: Bool, force: Bool) async throws -> PaneSendResult {
        lock.withLock {
            sent.append("\(target): \(text)\(enter ? ", Enter" : "")\(force ? ", forced" : "")")
            shown = DialogTests.idle
        }
        return PaneSendResult(refused: false, reason: nil)
    }

    func transcript(of session: SessionItem, since: Int?, limit: Int?) async throws -> TranscriptPage { TranscriptPage(turns: [], offset: nil) }
    func sendMessage(to session: SessionItem, text: String) async throws -> MessageResult { MessageResult(queuedBehindTurn: false, reply: nil) }
    func sendKeys(target: String, host: String, keys: [PaneKey]) async throws {}
    func supportsUploads() async -> Bool { false }
    func upload(for session: SessionItem, fileName: String, mime: String, data: Data) async throws -> String { throw DroverError.unsupported("Uploads") }
    func events(onState: @escaping @Sendable (ConnectionState) -> Void) -> AsyncStream<ServerEvent> { AsyncStream { _ in } }
    func notifications(since cursor: String?, wait: Int) async throws -> NotificationPage { throw DroverError.unsupported("native.notifications") }
    func ping() async throws -> String { "studio" }
}
