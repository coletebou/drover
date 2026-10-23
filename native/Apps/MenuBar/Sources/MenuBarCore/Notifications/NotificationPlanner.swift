import Foundation

/// A notification button that presses one key on the dialog the alert was raised for.
struct PlannedAction: Sendable, Equatable {
    /// `drover.key.<key>`; the key is what `sessions.answer` gets.
    var identifier: String
    var title: String
    var key: String

    static let prefix = "drover.key."

    /// The key an action identifier stands for, or nil for other actions.
    static func key(fromIdentifier id: String) -> String? {
        guard id.hasPrefix(prefix) else { return nil }
        let key = String(id.dropFirst(prefix.count))
        return AnswerModel.pressable.contains(key) ? key : nil
    }
}

struct PlannedNotification: Sendable, Equatable {
    var identifier: String
    var title: String
    var body: String
    var threadID: String
    var sessionId: String?
    var host: String?
    var canReply: Bool
    var playSound: Bool
    /// Dialog keys as buttons, in the daemon's display order (empty: Reply and Open only).
    var actions: [PlannedAction] = []
    /// `sessions.answer` id (the session, else the window) and the screen hash the alert was raised for.
    var answerID: String? = nil
    var expect: String? = nil

    static let waitingCategory = "drover.waiting"
    static let infoCategory = "drover.info"

    /// The notification category: the fixed waiting and info ones, or one per distinct set of dialog buttons
    /// (`drover.dialog.<digest>`), registered on the fly.
    var categoryID: String {
        guard !actions.isEmpty else { return canReply ? Self.waitingCategory : Self.infoCategory }
        let signature = actions.map { "\($0.identifier)=\($0.title)" }.joined(separator: "\u{1F}") + (canReply ? "|reply" : "")
        return "drover.dialog.\(Self.digest(signature))"
    }

    /// FNV-1a, 64 bit, hex: stable across launches (Swift's `hashValue` is not).
    static func digest(_ s: String) -> String {
        var h: UInt64 = 0xcbf2_9ce4_8422_2325
        for b in s.utf8 {
            h ^= UInt64(b)
            h = h &* 0x0000_0100_0000_01b3
        }
        return String(h, radix: 16)
    }
}

enum NotificationPlanner {
    static func plan(
        _ items: [NotificationItem],
        preferences: MenuBarPreferences,
        mutedUntil: Date?,
        now: Date,
        alreadyPosted: Set<String>,
        maxIndividual: Int = 3
    ) -> [PlannedNotification] {
        guard preferences.notifyOnWaiting else { return [] }
        if let mutedUntil, mutedUntil > now { return [] }

        let fresh = items.filter { item in
            (item.isNeedsYou || item.kind == "finished" || item.kind == "error")
                && !alreadyPosted.contains(item.id)
        }
        guard !fresh.isEmpty else { return [] }

        func make(_ item: NotificationItem) -> PlannedNotification {
            let actions = item.isNeedsYou ? dialogActions(item) : []
            return PlannedNotification(
                identifier: "drover.notify.\(item.id)",
                title: truncate(item.title, 80),
                body: truncate(item.body ?? "", 240),
                threadID: item.sessionId ?? "drover",
                sessionId: item.sessionId,
                host: item.host,
                canReply: item.isNeedsYou && item.sessionId != nil,
                playSound: preferences.notificationSound && item.isNeedsYou,
                actions: actions,
                answerID: actions.isEmpty ? nil : item.answerID,
                expect: actions.isEmpty ? nil : item.hash)
        }

        let limit = max(maxIndividual, 1)
        if fresh.count <= limit { return fresh.map(make) }

        // Oldest first: the newest `limit - 1` go out individually, the rest collapse into a summary.
        let individualCount = limit - 1
        let rest = Array(fresh.dropLast(individualCount))
        let newest = Array(fresh.suffix(individualCount))
        let summary = PlannedNotification(
            identifier: "drover.notify.summary.\(fresh[fresh.count - 1].id)",
            title: "\(rest.count) more sessions need you",
            body: truncate(rest.map(\.title).joined(separator: ", "), 240),
            threadID: "drover",
            sessionId: nil,
            host: nil,
            canReply: false,
            playSound: preferences.notificationSound && rest.contains(where: \.isNeedsYou))
        return newest.map(make) + [summary]
    }

    /// Buttons for an alert raised by a dialog: one per option when it has options, else Approve (Enter) and
    /// Deny (Esc) (Deliver and Drop for a held peer message), and y / n for a (y/n) prompt. Only keys the
    /// daemon listed, and only with the screen hash, so an answer can only reach the dialog the alert showed.
    static func dialogActions(_ item: NotificationItem) -> [PlannedAction] {
        guard item.answer != .reply, item.answerID != nil, let hash = item.hash, !hash.isEmpty else { return [] }
        let buttons = AnswerModel.plan(dialog: item.dialog, keys: item.keys, answer: item.answer, hash: hash, maxLabel: 40).buttons
        guard !buttons.isEmpty else { return [] }
        let optionKeys = Set((item.dialog?.options ?? []).map { String($0.n) })
        let hasOptions = buttons.contains { $0.role == .option && optionKeys.contains($0.key) }
        var out: [PlannedAction] = []
        for b in buttons {
            switch b.role {
            case .option:
                if optionKeys.contains(b.key) { out.append(PlannedAction(identifier: PlannedAction.prefix + b.key, title: b.title, key: b.key)) }
            case .enter where !hasOptions:
                out.append(PlannedAction(identifier: PlannedAction.prefix + b.key, title: item.isHeld ? "Deliver (Enter)" : "Approve (Enter)", key: b.key))
            case .escape where !hasOptions:
                out.append(PlannedAction(identifier: PlannedAction.prefix + b.key, title: item.isHeld ? "Drop (Esc)" : "Deny (Esc)", key: b.key))
            case .letter:
                out.append(PlannedAction(identifier: PlannedAction.prefix + b.key, title: b.key == "y" ? "Yes (y)" : "No (n)", key: b.key))
            default:
                break
            }
        }
        return Array(out.prefix(6))
    }

    static func truncate(_ s: String, _ limit: Int) -> String {
        guard s.count > limit else { return s }
        return String(s.prefix(limit - 1)) + "…"
    }
}
