import Foundation

/// Pure mapping from a NotifyItem to notification content fields (testable without UserNotifications).
///
/// A dialog alert (`hash` and `keys` from native.notifications) gets one action per key: the options by number and
/// label, Approve (Enter) and Deny (Esc) for a prompt with no options, Deliver and Drop for a held message, plus Reply
/// and Open. Its category is built per action set (`drover.dialog.<signature>`), registered before it is posted.
enum NotificationContentBuilder {
    struct Content: Equatable {
        var title: String
        var body: String
        var threadId: String
        var categoryId: String
        var userInfo: [String: String]
        /// Answer actions in display order (empty: the fixed `drover.session` / `drover.info` categories).
        var actions: [Action] = []
        /// "Asked by Alpha, a Grok bot" on a bot's approval request: who wrote the words below it.
        var subtitle: String? = nil
        /// The actions answer a Grok bot's approval request by its id: they come with Open, never with Reply.
        var answersApproval = false
    }

    struct Action: Equatable, Hashable {
        /// `key:<tmux key>`.
        var id: String
        var title: String
        var destructive = false
    }

    static let keyPrefix = "key:"
    static let approvalPrefix = "approval:"

    static func content(for item: NotifyItem) -> Content {
        if let approval = item.approval { return approvalContent(item, approval) }
        // An approval request whose payload did not decode is still one: Open only, never Reply (a message to the
        // bot would answer nothing) and no dialog keys.
        let isApproval = item.answerMode == .approval
        var info: [String: String] = ["category": item.category.rawValue]
        if let v = item.sessionId { info["sessionId"] = v }
        if let v = item.host { info["host"] = v }
        if let v = item.tmuxTarget { info["target"] = v }
        let actions = isApproval ? [] : answerActions(for: item)
        if !actions.isEmpty, let hash = item.hash {
            info["hash"] = hash
            if item.held { info["held"] = "1" }
        }
        let category = actions.isEmpty ? (item.sessionId != nil && !isApproval ? "drover.session" : "drover.info") : dialogCategory(actions)
        return Content(
            title: item.title,
            body: dialogBody(item),
            threadId: item.sessionId ?? item.category.rawValue,
            categoryId: category,
            userInfo: info,
            actions: actions
        )
    }

    /// Only for a dialog with a screen hash and a session or window to press it on.
    static func answerActions(for item: NotifyItem) -> [Action] {
        guard item.hash != nil, item.sessionId != nil || item.tmuxTarget != nil, item.answerMode != .reply, !item.keys.isEmpty else { return [] }
        return DialogKeys.buttons(dialog: item.dialog, keys: item.keys, held: item.held, notification: true).map { b in
            let title = b.label.count > 48 ? String(b.label.prefix(47)) + "…" : b.label
            return Action(id: keyPrefix + b.key, title: title, destructive: b.kind == .cancel)
        }
    }

    /// One category per distinct action list, so a dialog's own options show on its banner.
    static func dialogCategory(_ actions: [Action]) -> String {
        let sig = actions.map { "\($0.id)=\($0.title)" }.joined(separator: "|")
        return "drover.dialog.\(TranscriptMapper.fnv(sig))"
    }

    /// The body, with the question when the daemon's body does not already say it.
    static func dialogBody(_ item: NotifyItem) -> String {
        guard let q = item.dialog?.question, !q.isEmpty, !item.body.contains(q) else { return item.body }
        return item.body.isEmpty ? q : "\(item.body)\n\(q)"
    }

    /// `key:2` -> `2`.
    static func key(fromAction id: String) -> String? {
        id.hasPrefix(keyPrefix) ? String(id.dropFirst(keyPrefix.count)) : nil
    }

    /// A Grok bot's approval request: who asks, its question and details, and one action per option (at most four, each
    /// label whole) only for words a banner shows whole (ApprovalFormat.answersInNotification). Anything else, and a
    /// request another host keeps, is Open only: the session opens, where the card reviews the whole request. Never
    /// Reply: a message would go to the bot instead of answering.
    static func approvalContent(_ item: NotifyItem, _ approval: ApprovalInfo) -> Content {
        var info: [String: String] = ["category": item.category.rawValue]
        if let v = item.sessionId { info["sessionId"] = v }
        if let v = item.host { info["host"] = v }
        let bot = ApprovalFormat.botName(bot: approval.bot)
        let oneClick = ApprovalFormat.isAnswerable(host: item.host) && ApprovalFormat.answersInNotification(approval)
        let actions = oneClick ? approval.options.prefix(4).map { o -> Action in
            let title = ApprovalFormat.title(o)
            return Action(id: approvalPrefix + String(o.n), title: title, destructive: ApprovalFormat.isNegative(title))
        } : []
        if !actions.isEmpty {
            info["approvalId"] = approval.id
            if let bot { info["approvalBot"] = bot }
        }
        let question = approval.question.isEmpty ? item.body : approval.question
        // The category's id is the actions themselves, encoded one to one, not a hash: two option sets never share a category, so a bot that found colliding labels could not put one request's buttons on another's banner.
        let parts = actions.map { [$0.id, $0.title, $0.destructive ? "1" : "0"] }
        let category = actions.isEmpty ? "drover.info" : "drover.approval." + ((try? JSONEncoder().encode(parts)).map { $0.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") } ?? "")
        return Content(
            title: item.title,
            body: approval.details.map { "\(question)\n\($0)" } ?? question,
            threadId: item.sessionId ?? item.category.rawValue,
            categoryId: category,
            userInfo: info,
            actions: actions,
            subtitle: "Asked by \(ApprovalFormat.askedBy(bot))",
            answersApproval: !actions.isEmpty)
    }

    /// `approval:2` -> 2.
    static func approvalChoice(fromAction id: String) -> Int? {
        guard id.hasPrefix(approvalPrefix), let n = Int(id.dropFirst(approvalPrefix.count)), n >= 1 else { return nil }
        return n
    }
}
