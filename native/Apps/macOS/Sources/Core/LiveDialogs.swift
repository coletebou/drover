import Foundation

/// What an answer card shows: the dialog, the screen hash a press must match, the keys, a held message or not.
struct DialogState: Equatable, Sendable {
    var dialog: DialogInfo?
    var hash: String?
    var keys: [String]
    var held: Bool
}

/// A "Type something" field open on a card (`AppModel.typingAnswer`): the question its option was picked on, and the
/// option's number. It opens only once that press took, and its text goes only while the question is still up with
/// it: the text is pasted past the daemon's dialog guard and ends with Enter, so on any other screen (another dialog,
/// whose options take digits, a prompt, a shell) it would answer something nobody read.
struct FreeTextField: Equatable, Sendable {
    var question: String?
    var option: Int

    /// A reading still shows the question (checked on every reading: another question, a held message or no dialog
    /// closes the field).
    func asks(_ r: ScreenDialog.Reading?) -> Bool {
        guard let r, !r.held else { return false }
        return r.dialog.question == question
    }

    /// Right before the text goes: the question with this field highlighted and no other option (a fresh drawing of the
    /// same question highlights its first option; the field highlights its own). The field must be seen highlighted, not
    /// merely nothing else: a highlighted row too long to parse (over 120 characters) leaves no option selected.
    func isUp(on r: ScreenDialog.Reading) -> Bool {
        asks(r) && r.dialog.options.contains { $0.n == option && $0.selected }
            && !r.dialog.options.contains { $0.selected && $0.n != option }
    }
}

extension FreeTextField {
    /// The field `key` opens on `state`'s dialog: nil unless `key` is its "Type something" option.
    init?(picking key: String, on state: DialogState?) {
        guard let state, let n = Int(key),
              DialogKeys.buttons(dialog: state.dialog, keys: state.keys, held: state.held).contains(where: { $0.key == key && $0.freeText })
        else { return nil }
        self.init(question: state.dialog?.question, option: n)
    }
}

/// A direct reading of a session's screen (a capture, or the dialog a refusal carried), newer than the board's.
struct LiveDialog: Equatable, Sendable {
    /// nil: no dialog on screen.
    var reading: ScreenDialog.Reading?
    var at: Date
    /// The hash just answered: that screen stays hidden while the agent redraws.
    var pressed: String? = nil
}

/// The card follows the screen (a 2026-10-20 report: "it is not putting away the card"). After a press the app reads the
/// pane again at once, and a refusal brings the dialog now on screen; those readings win over the board, which can lag
/// a warm cycle behind (an older daemon's by 20 s), until the board agrees with them or they are 20 s old. Pure.
enum DialogResolver {
    static let liveFor: TimeInterval = 20

    static func state(board s: SessionItem, live: LiveDialog?, now: Date = Date()) -> DialogState? {
        if let live, now.timeIntervalSince(live.at) < liveFor {
            guard let r = live.reading else { return nil }
            if let p = live.pressed, p == r.hash { return nil }
            return DialogState(dialog: r.dialog, hash: r.hash, keys: r.keys, held: r.held)
        }
        guard s.answersWithKeys else { return nil }
        if let p = live?.pressed, p == s.hash { return nil }
        return DialogState(dialog: s.dialog, hash: s.hash, keys: s.keys.isEmpty ? DialogKeys.defaultKeys(s.dialog) : s.keys, held: s.held)
    }

    /// After a new board: whether a live reading still says more than the board.
    static func keep(_ live: LiveDialog, board s: SessionItem?, now: Date = Date()) -> Bool {
        guard now.timeIntervalSince(live.at) < liveFor else { return false }
        let boardHash = s.flatMap { $0.answersWithKeys ? ($0.hash ?? "") : nil }
        guard let r = live.reading else { return boardHash != nil }   // both say no dialog: the board has caught up
        if r.hash == boardHash && r.hash != live.pressed { return false }
        return true
    }

    /// A refusal that brought the dialog now on screen (`tmux.answer`: "the screen changed since you read it").
    static func reading(fromRefusal r: AnswerResult) -> ScreenDialog.Reading? {
        guard let hash = r.hash, let d = r.dialog, d.question != nil || !d.options.isEmpty else { return nil }
        return ScreenDialog.Reading(dialog: d, hash: hash, keys: r.keys.isEmpty ? DialogKeys.defaultKeys(d) : r.keys, held: false)
    }
}

extension AppModel {
    /// The card's dialog for `s`: the freshest of a direct screen reading and the board.
    func dialogState(_ s: SessionItem) -> DialogState? {
        DialogResolver.state(board: s, live: liveDialogs[s.key])
    }

    /// A new reading of `s`'s screen (Screen's poll, the Chat watcher, after a press). A pending press stays marked.
    func note(reading: ScreenDialog.Reading?, for s: SessionItem, now: Date = Date()) {
        let old = liveDialogs[s.key]
        let pressed = old.flatMap { now.timeIntervalSince($0.at) < DialogResolver.liveFor ? $0.pressed : nil }
        let next = LiveDialog(reading: reading, at: now, pressed: pressed)
        // A new screen: what the last press had to say no longer applies.
        if let old, old.reading?.hash != reading?.hash, answerNotice[s.key] != nil { answerNotice[s.key] = nil }
        if let field = typingAnswer[s.key], !field.asks(reading) { typingAnswer[s.key] = nil }
        if old?.reading != next.reading || old?.pressed != next.pressed || (old.map { now.timeIntervalSince($0.at) > 2 } ?? true) {
            liveDialogs[s.key] = next
        }
    }

    /// Capture `s`'s pane and read the dialog on it the way the daemon does.
    func readScreen(_ s: SessionItem) async {
        guard let target = s.tmuxTarget else { return }
        guard let c = try? await service.capture(target: target, host: s.host, lines: 60) else { return }
        note(reading: ScreenDialog.read(capture: c), for: s)
    }

    /// After a press: read the screen again until it moved on (the next question, a review screen, nothing); if it
    /// never does, the press did not take and the card comes back.
    func followScreen(_ s: SessionItem, pressed: String?) async {
        for delay in [0.15, 0.4, 0.8, 1.5] {
            try? await Task.sleep(for: .seconds(delay))
            await readScreen(s)
            guard let l = liveDialogs[s.key] else { return }
            if l.reading?.hash != pressed { return }
        }
        if var l = liveDialogs[s.key], l.reading?.hash == pressed {
            l.pressed = nil
            liveDialogs[s.key] = l
        }
    }

    /// Drop readings the board has caught up with (called with every new board).
    func pruneLiveDialogs(_ snap: BoardSnapshot) {
        guard !liveDialogs.isEmpty else { return }
        let now = Date()
        let byKey = Dictionary(snap.sessions.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
        let kept = liveDialogs.filter { DialogResolver.keep($0.value, board: byKey[$0.key], now: now) }
        if kept.count != liveDialogs.count { liveDialogs = kept }
    }
}
