import CryptoKit
import Foundation

/// One answer button: a key the dialog takes, labelled for people.
struct AnswerButton: Hashable, Sendable, Identifiable {
    enum Kind: Sendable { case option, confirm, cancel, other }
    var key: String
    var label: String
    var kind: Kind
    /// The option the dialog has highlighted (Enter picks it).
    var selected = false
    /// "Type something": picking it opens the dialog's text field, for an answer of your own.
    var freeText = false
    var id: String { key }
}

/// Dialog keys -> buttons, and the keys a dialog takes when the daemon does not say. Pure.
enum DialogKeys {
    /// Option digits, then Enter and Escape: what any Claude Code dialog takes since 2.1.280 (`tmux.keyFitsDialog`).
    static func defaultKeys(_ dialog: DialogInfo?) -> [String] {
        var seen = Set<Int>()
        let digits = (dialog?.options ?? []).map(\.n).filter { (1...9).contains($0) && seen.insert($0).inserted }.map(String.init)
        return digits + ["Enter", "Escape"]
    }

    /// One button per key, in the dialog's order. `notification`: Approve / Deny wording for a prompt with no options.
    static func buttons(dialog: DialogInfo?, keys: [String], held: Bool, notification: Bool = false) -> [AnswerButton] {
        let options = dialog?.options ?? []
        let keys = keys.isEmpty ? defaultKeys(dialog) : keys
        var seen = Set<String>()
        return keys.compactMap { key in
            guard seen.insert(key).inserted else { return nil }
            if let n = Int(key), (1...9).contains(n) {
                let o = options.first { $0.n == n }
                let free = o.map { $0.label.range(of: #"^(type something|other\b)"#, options: [.regularExpression, .caseInsensitive]) != nil } ?? false
                return AnswerButton(key: key, label: o.map { "\(n). \($0.label)" } ?? key, kind: .option,
                                    selected: o?.selected ?? false, freeText: free)
            }
            switch key {
            case "Enter":
                let label = held ? "Deliver (Enter)" : (options.isEmpty && notification ? "Approve (Enter)" : "Enter")
                return AnswerButton(key: key, label: label, kind: .confirm)
            case "Escape":
                let label = held ? "Drop (Esc)" : (options.isEmpty && notification ? "Deny (Esc)" : "Esc")
                return AnswerButton(key: key, label: label, kind: .cancel)
            case "y": return AnswerButton(key: key, label: "y", kind: .confirm)
            case "n": return AnswerButton(key: key, label: "n", kind: .cancel)
            // Multi-select questions: Space ticks the highlighted option, Enter submits.
            case "Space": return AnswerButton(key: key, label: "Space (tick)", kind: .other)
            default: return AnswerButton(key: key, label: PaneKey(key).label, kind: .other)
            }
        }
    }

    /// Words for a press, for toasts: "approved", "picked 2".
    static func pastTense(_ key: String, held: Bool) -> String {
        switch key {
        case "Enter": held ? "delivered" : "pressed Enter"
        case "Escape": held ? "dropped" : "cancelled"
        default: Int(key) != nil ? "picked \(key)" : "pressed \(PaneKey(key).label)"
        }
    }
}

/// The daemon's screen reading (core/tmux.js classifyScreen, dialogSummary, screenHash, keyFitsDialog), so Screen can
/// answer a dialog the moment its capture shows one instead of waiting for the next board. `hash` matches the one
/// `sessions.answer` / `tmux.answer` compute, so `expect` still refuses a press on a screen that changed.
enum ScreenDialog {
    struct Reading: Equatable, Sendable {
        var dialog: DialogInfo
        var hash: String
        var keys: [String]
        var held: Bool
    }

    /// nil when no dialog and no held message is on screen.
    static func read(_ text: String) -> Reading? {
        let tail = lastLines(text, 40)
        let held = isHeld(tail)
        guard held || isDialog(tail) else { return nil }
        return reading(text, tail: tail, held: held)
    }

    /// A capture, as the daemon classified it (its `screen.state`): its own dialog fields when it sent them, else the
    /// summary, hash and keys read here. The daemon's classification decides what is a dialog, so a screen it learns
    /// to read (a review screen) counts here too.
    static func read(capture c: ScreenCapture) -> Reading? {
        let tail = lastLines(c.text, 40)
        let held = isHeld(tail)
        if let d = c.dialog, let h = c.hash {
            return Reading(dialog: d, hash: h, keys: c.keys.isEmpty ? (held ? ["Enter", "Escape"] : DialogKeys.defaultKeys(d)) : c.keys, held: held)
        }
        // The daemon's classification, and the same reading here (defense in depth for daemons from before dcf28bf).
        guard held || (c.state == .dialog && isDialog(tail)) else { return nil }
        return reading(c.text, tail: tail, held: held)
    }

    /// What an agent shows at the bottom when no dialog is up: Claude's footer, its spinner, an empty prompt (Claude Code
    /// 2.1.3xx's bare ❯ between rules, an older │ > │ box, Codex's ›).
    static func isLivePrompt(_ line: String) -> Bool {
        let t = line.trimmingCharacters(in: .whitespaces)
        return matches(line, "\\? for shortcuts|bypass permissions on|accept edits on|plan mode on|esc to interrupt")
            || matches(t, "^[›>❯]\\s*$", caseless: false) || matches(t, "^│\\s*[>❯]\\s", caseless: false)
    }

    static func isDialogLine(_ line: String) -> Bool {
        question(line) || matches(line, optionLine, caseless: false) || matches(line, "Esc to cancel|Enter to (select|confirm)")
    }

    /// A numbered option line (core/tmux.js, 44e88af). Blanks after the marker only when there is one, so a captured
    /// line of 100K blanks (a capture is joined with -J) costs one pass: two blank runs around an optional marker cost
    /// a square of its length.
    private static let optionLine = "^\\s*(?:[❯>›]\\s*)?\\d\\.\\s+\\S"

    /// The screen is what is lowest (core/tmux.js, dcf28bf): a prompt or spinner below the last dialog line means the
    /// dialog was answered and is only scrollback (a cleared screen scrolls into the history a capture reads).
    static func liveTail(_ tail: String) -> String {
        let lines = tail.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        guard let lastDialog = lines.lastIndex(where: isDialogLine),
              let lastLive = lines.lastIndex(where: isLivePrompt), lastLive > lastDialog else { return tail }
        return lines[(lastDialog + 1)...].joined(separator: "\n")
    }

    private static func reading(_ text: String, tail: String, held: Bool) -> Reading {
        let dialog = summary(text)
        var keys = held ? ["Enter", "Escape"] : DialogKeys.defaultKeys(dialog)
        if !held {
            if fits("y", tail) { keys.insert("y", at: max(0, keys.count - 2)) }
            if fits("n", tail) { keys.insert("n", at: max(0, keys.count - 2)) }
        }
        return Reading(dialog: dialog, hash: hash(text), keys: keys, held: held)
    }

    private static let dialogPatterns = [
        "Do you want to (proceed|allow|run|make this edit|create|continue)", "Run a dynamic workflow\\?",
        "Allow .{1,80} to (run|read|write|edit)", "\\(y/n\\)", "Enter to confirm", "Select an option",
        "Press Enter to continue", "Would you like to",
        // AskUserQuestion with several questions ends on a review screen: "Review your answers", 1. Submit answers.
        "Ready to submit your answers\\?", "Review your answers",
    ]
    private static let caseSensitive = ["\\[Y/n\\]", "\\[y/N\\]"]

    private static func lastLines(_ text: String, _ n: Int) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false).suffix(n).joined(separator: "\n")
    }

    private static func matches(_ s: String, _ pattern: String, caseless: Bool = true) -> Bool {
        s.range(of: pattern, options: caseless ? [.regularExpression, .caseInsensitive] : .regularExpression) != nil
    }

    private static func question(_ s: String) -> Bool {
        dialogPatterns.contains { matches(s, $0) } || caseSensitive.contains { matches(s, $0, caseless: false) }
    }

    static func isDialog(_ whole: String) -> Bool {
        let tail = liveTail(whole)
        let yn = matches(tail, "\\(y/n\\)|\\[Y/n\\]|\\[y/N\\]")
        let lines = tail.split(separator: "\n").map(String.init)
        let optionList = lines.contains { matches($0, optionLine, caseless: false) }
        let options = optionList && matches(tail, "❯|Esc to cancel|Enter to (select|confirm)")
        return yn || (question(tail) && options) || (options && matches(tail, "Esc to cancel"))
    }

    static func isHeld(_ tail: String) -> Bool {
        let lines = tail.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        guard let held = lines.lastIndex(where: { matches($0, "Held message from another session|Another Claude session sent a message") }) else { return false }
        // As the daemon: a live prompt below it means the message was delivered or dropped already.
        return !(lines.lastIndex(where: isLivePrompt).map { $0 > held } ?? false)
    }

    private static func fits(_ key: String, _ tail: String) -> Bool {
        matches(tail, "\\(y/n\\)|\\[Y/n\\]|\\[y/N\\]") || matches(tail, "\\(\(key)\\)")
    }

    /// The last line that reads like a question, then the numbered options after it.
    static func summary(_ text: String) -> DialogInfo {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map { line in
            String(line).replacingOccurrences(of: "[│╭╮╰╯]", with: "", options: .regularExpression).trimmingTrailing()
        }.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        let tail = Array(lines.suffix(30))
        var qi = -1
        for i in stride(from: tail.count - 1, through: 0, by: -1) where question(tail[i]) || matches(tail[i], "\\?\\s*$") {
            qi = i; break
        }
        let q = qi >= 0 ? String(tail[qi].trimmingCharacters(in: .whitespaces).prefix(300)) : nil
        var options: [DialogOption] = []
        for line in tail[(qi + 1)...] {
            guard let r = line.range(of: "^\\s*(?:[❯>›]\\s*)?(\\d)\\.\\s+(.{1,120})$", options: .regularExpression) else { continue }
            let m = String(line[r])
            guard let digit = m.first(where: \.isNumber), let n = Int(String(digit)),
                  let dot = m.range(of: "\\d\\.\\s+", options: .regularExpression) else { continue }
            let prefix = m[m.startIndex..<dot.lowerBound]
            // A number that comes round again is the dialog drawn again (scrollback keeps the earlier drawing).
            if options.contains(where: { $0.n == n }) { options.removeAll() }
            options.append(DialogOption(n: n, label: String(m[dot.upperBound...]).trimmingCharacters(in: .whitespaces),
                                        selected: prefix.contains("❯") || prefix.contains("›")))
        }
        return DialogInfo(question: q, options: options)
    }

    /// sha1 of the last 20 non-blank lines (right-trimmed), first 16 hex digits.
    static func hash(_ text: String) -> String {
        let trimmed = text.trimmingTrailing()
        let lines = trimmed.split(separator: "\n", omittingEmptySubsequences: false).map { String($0).trimmingTrailing() }
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.suffix(20)
        let digest = Insecure.SHA1.hash(data: Data(lines.joined(separator: "\n").utf8))
        return String(digest.map { String(format: "%02x", $0) }.joined().prefix(16))
    }
}

extension String {
    /// Without trailing whitespace (JS `replace(/\s+$/, '')`).
    func trimmingTrailing() -> String {
        var s = Substring(self)
        while let last = s.last, last.isWhitespace { s = s.dropLast() }
        return String(s)
    }
}
