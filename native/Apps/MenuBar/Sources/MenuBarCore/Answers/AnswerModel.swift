import Foundation

/// A key the menu bar can press on a dialog, as one button.
struct AnswerButton: Sendable, Hashable, Identifiable {
    enum Role: Sendable, Hashable { case option, enter, escape, letter, other }

    /// What `sessions.answer` gets: `1`..`9`, `Enter`, `Escape`, `Up`, `Down`, `Tab`, `Space`, `y`, `n`.
    var key: String
    /// Button text, short: `1 Yes`, `2 Yes, don't ask again`, `Enter`, `Esc`.
    var title: String
    /// Tooltip: the full option label, or what the key does.
    var help: String
    var accessibilityLabel: String
    /// The highlighted option (Enter picks it).
    var selected: Bool
    var role: Role

    var id: String { key }
}

/// What a waiting row or an alert offers.
enum AnswerPlan: Sendable, Equatable {
    /// A dialog: press one of `buttons` (in the daemon's display order).
    case keys(question: String?, buttons: [AnswerButton])
    /// The agent asked in text: reply with a message.
    case reply
    /// Nothing to press: a daemon from before dialog keys, or a dialog without usable keys. Open and Reply only.
    case none

    var buttons: [AnswerButton] {
        if case .keys(_, let b) = self { return b }
        return []
    }
}

/// Turns the dialog fields of a waiting item or alert into buttons. Pure; never invents a key the daemon did
/// not list (Claude Code dialogs ignore y and n since 2.1.280, so fixed chips would press nothing).
enum AnswerModel {
    static let pressable: Set<String> = ["Enter", "Escape", "Up", "Down", "Tab", "Space", "y", "n", "1", "2", "3", "4", "5", "6", "7", "8", "9"]

    /// `hash` is the screen hash the keys were listed for. Without one there is nothing to check a press against
    /// (a key could land on a different dialog), so nothing is offered: Open and Reply only.
    static func plan(dialog: DialogInfo?, keys: [String]?, answer: AnswerMode?, hash: String?, maxLabel: Int = 26) -> AnswerPlan {
        if answer == .reply { return .reply }
        guard let hash, !hash.isEmpty else { return .none }
        var seen = Set<String>()
        let usable = (keys ?? []).filter { pressable.contains($0) && seen.insert($0).inserted }
        guard !usable.isEmpty else { return .none }
        let buttons = usable.map { button(for: $0, dialog: dialog, maxLabel: maxLabel) }
        return .keys(question: dialog?.question.flatMap { $0.isEmpty ? nil : $0 }, buttons: buttons)
    }

    static func plan(for item: WaitingItem, maxLabel: Int = 26) -> AnswerPlan {
        plan(dialog: item.dialog, keys: item.keys, answer: item.answer, hash: item.hash, maxLabel: maxLabel)
    }

    static func button(for key: String, dialog: DialogInfo?, maxLabel: Int = 26) -> AnswerButton {
        if let n = Int(key), (1...9).contains(n) {
            if let option = dialog?.options.first(where: { $0.n == n }) {
                let full = option.label.trimmingCharacters(in: .whitespacesAndNewlines)
                let short = shortLabel(full, max: maxLabel)
                return AnswerButton(
                    key: key, title: short.isEmpty ? key : "\(n) \(short)", help: full.isEmpty ? "Press \(n)" : "\(n). \(full)",
                    accessibilityLabel: full.isEmpty ? "Answer \(n)" : "Answer \(n), \(full)",
                    selected: option.selected == true, role: .option)
            }
            return AnswerButton(key: key, title: key, help: "Press \(n)", accessibilityLabel: "Answer \(n)", selected: false, role: .option)
        }
        switch key {
        case "Enter":
            let help = dialog?.selectedOption.map { "Press Enter: \($0.n). \($0.label)" } ?? "Press Enter on this dialog"
            return AnswerButton(key: key, title: "Enter", help: help, accessibilityLabel: "Press Enter", selected: false, role: .enter)
        case "Escape":
            return AnswerButton(key: key, title: "Esc", help: "Press Escape: cancel the dialog", accessibilityLabel: "Press Escape", selected: false, role: .escape)
        case "y", "n":
            return AnswerButton(key: key, title: key, help: "Press \(key)", accessibilityLabel: "Answer \(key == "y" ? "yes" : "no")", selected: false, role: .letter)
        case "Space":
            // A multi-select question (its options are boxes): Space ticks the highlighted one, Enter submits.
            return AnswerButton(key: key, title: "Space (tick)", help: "Press Space: tick the highlighted option",
                                accessibilityLabel: "Press Space to tick the highlighted option", selected: false, role: .other)
        case "Up":
            return AnswerButton(key: key, title: "\u{2191}", help: "Press Up", accessibilityLabel: "Press Up", selected: false, role: .other)
        case "Down":
            return AnswerButton(key: key, title: "\u{2193}", help: "Press Down", accessibilityLabel: "Press Down", selected: false, role: .other)
        default:
            return AnswerButton(key: key, title: key, help: "Press \(key)", accessibilityLabel: "Press \(key)", selected: false, role: .other)
        }
    }

    /// A button-sized option label; the tooltip keeps the full one. Drops keyboard hints and notes in
    /// parentheses, Claude Code's "and tell Claude what to do differently" tail and a trailing "for ..." scope,
    /// then cuts on a word boundary: "Yes, and don't ask again for npm test commands in ~/x" is
    /// "Yes, don't ask again", "No, and tell Claude what to do differently (esc)" is "No".
    static func shortLabel(_ raw: String, max: Int = 26) -> String {
        let original = raw.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        var s = original.replacingOccurrences(of: "\\s*\\([^)]*\\)", with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: ",?\\s*(and )?tell Claude what to do differently", with: "",
                                   options: [.regularExpression, .caseInsensitive])
        s = s.replacingOccurrences(of: ", and ", with: ", ")
        if let r = s.range(of: " for ", options: .caseInsensitive), r.lowerBound > s.startIndex {
            s = String(s[..<r.lowerBound])
        }
        s = s.trimmingCharacters(in: CharacterSet(charactersIn: " ,.;:"))
        if s.isEmpty { s = original }
        return truncate(s, max: max)
    }

    /// Cut to `max` characters on a word boundary when one is near, with an ellipsis.
    static func truncate(_ s: String, max: Int) -> String {
        guard max > 1, s.count > max else { return s }
        let cut = String(s.prefix(max - 1))
        if let space = cut.lastIndex(of: " "), cut.distance(from: cut.startIndex, to: space) > max / 2 {
            return String(cut[..<space]).trimmingCharacters(in: CharacterSet(charactersIn: " ,.;:")) + "\u{2026}"
        }
        return cut + "\u{2026}"
    }
}

/// `sessions.answer` result: `{ok: true, key, target, dialog, hash, screen}` or `{ok: false, refused: true,
/// reason, hash, dialog?, preview?}`. A refusal is a normal answer, not an error.
struct AnswerResult: Decodable, Sendable, Equatable {
    var ok: Bool
    var refused: Bool?
    var reason: String?
    var key: String?
    var hash: String?

    init(ok: Bool, refused: Bool? = nil, reason: String? = nil, key: String? = nil, hash: String? = nil) {
        self.ok = ok
        self.refused = refused
        self.reason = reason
        self.key = key
        self.hash = hash
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = (try? c.decode(Bool.self, forKey: .ok)) ?? false
        refused = try? c.decodeIfPresent(Bool.self, forKey: .refused)
        reason = try? c.decodeIfPresent(String.self, forKey: .reason)
        key = try? c.decodeIfPresent(String.self, forKey: .key)
        hash = try? c.decodeIfPresent(String.self, forKey: .hash)
    }

    private enum CodingKeys: String, CodingKey { case ok, refused, reason, key, hash }
}

/// What pressing a key came to, as the row shows it.
enum AnswerOutcome: Sendable, Equatable {
    case sent(key: String)
    /// The daemon refused (the screen changed, no dialog any more, a key the dialog does not take).
    case refused(reason: String)
    /// The daemon predates `sessions.answer`.
    case unsupported

    var message: String {
        switch self {
        case .sent(let key): "Sent \(AnswerOutcome.keyName(key))."
        case .refused(let reason): "Not sent: \(reason)."
        case .unsupported: "This Drover cannot answer dialogs yet. Open the session to answer."
        }
    }

    var isSent: Bool { if case .sent = self { true } else { false } }

    static func keyName(_ key: String) -> String {
        switch key {
        case "Escape": "Esc"
        default: key
        }
    }

    init(_ result: AnswerResult, key: String) {
        if result.ok {
            self = .sent(key: result.key ?? key)
        } else {
            let reason = (result.reason ?? "the dialog changed, look again")
                .trimmingCharacters(in: CharacterSet(charactersIn: " ."))
            self = .refused(reason: reason.isEmpty ? "the dialog changed, look again" : reason)
        }
    }
}
