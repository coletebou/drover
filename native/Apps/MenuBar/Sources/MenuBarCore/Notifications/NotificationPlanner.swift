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

/// A notification button that answers a Grok bot's approval request with one option (`POST /api/approvals/answer`).
struct PlannedApprovalAction: Sendable, Equatable {
    /// `drover.approval.choice.<n>`.
    var identifier: String
    var title: String
    var choice: Int
    /// A clearly negative option (Deny, Not now): shown as destructive.
    var destructive: Bool

    static let prefix = "drover.approval.choice."

    /// The option an action identifier answers, or nil for other actions.
    static func choice(fromIdentifier id: String) -> Int? {
        guard id.hasPrefix(prefix), let n = Int(id.dropFirst(prefix.count)), n >= 1 else { return nil }
        return n
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
    /// "Asked by Alpha, a Grok bot" on a bot's approval request: who wrote the words below it.
    var subtitle: String? = nil
    /// One button per option of an approval request, the request they answer and the bot's name. Never with Reply,
    /// which would message the bot instead of answering.
    var approvalActions: [PlannedApprovalAction] = []
    var approvalID: String? = nil
    var approvalBot: String? = nil

    static let waitingCategory = "drover.waiting"
    static let infoCategory = "drover.info"
    static let approvalCategoryPrefix = "drover.approval."

    /// The notification category: the fixed waiting and info ones, or one per distinct set of dialog buttons
    /// (`drover.dialog.<digest>`) or approval options (`drover.approval.<digest>`), registered on the fly.
    var categoryID: String {
        if !approvalActions.isEmpty {
            // An approval category's id is the actions themselves, encoded one to one, not a hash: two option sets never share a category, so a bot that found colliding labels could not put one request's buttons on another's banner.
            let parts = approvalActions.map { [$0.identifier, $0.title, $0.destructive ? "1" : "0"] }
            return Self.approvalCategoryPrefix + ((try? JSONEncoder().encode(parts)).map { $0.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") } ?? "")
        }
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
            if let approval = item.approval { return approvalNotification(item, approval, sound: preferences.notificationSound) }
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

    /// A Grok bot's approval request: who asks, its question and details, and one button per option (at most four) only
    /// for words the banner shows whole (a complete request without details). Anything else, and a request another
    /// host keeps (this daemon would answer 404), gets Open only: the session opens, where the request is reviewed.
    static func approvalNotification(_ item: NotificationItem, _ approval: ApprovalInfo, sound: Bool) -> PlannedNotification {
        let bot = ApprovalFormat.botName(bot: approval.bot)
        let oneClick = ApprovalFormat.isAnswerable(host: item.host) && ApprovalFormat.answersInNotification(approval)
        let buttons = oneClick ? approvalActions(approval) : []
        let text = approval.details.map { "\(approval.question)\n\($0)" } ?? approval.question
        return PlannedNotification(
            identifier: "drover.notify.\(item.id)",
            title: truncate(item.title, 80),
            body: truncate(approval.question.isEmpty ? (item.body ?? "") : text, 240),
            threadID: item.sessionId ?? "drover",
            sessionId: item.sessionId,
            host: item.host,
            canReply: false,
            playSound: sound,
            subtitle: "Asked by \(ApprovalFormat.askedBy(bot))",
            approvalActions: buttons,
            approvalID: buttons.isEmpty ? nil : approval.id,
            approvalBot: bot)
    }

    /// One button per option, in the request's order, each label whole.
    static func approvalActions(_ approval: ApprovalInfo) -> [PlannedApprovalAction] {
        approval.options.map { o in
            let title = ApprovalFormat.title(o)
            return PlannedApprovalAction(identifier: PlannedApprovalAction.prefix + String(o.n), title: title,
                                         choice: o.n, destructive: ApprovalFormat.isNegative(title))
        }
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
