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
    }

    struct Action: Equatable, Hashable {
        /// `key:<tmux key>`.
        var id: String
        var title: String
        var destructive = false
    }

    static let keyPrefix = "key:"

    static func content(for item: NotifyItem) -> Content {
        var info: [String: String] = ["category": item.category.rawValue]
        if let v = item.sessionId { info["sessionId"] = v }
        if let v = item.host { info["host"] = v }
        if let v = item.tmuxTarget { info["target"] = v }
        let actions = answerActions(for: item)
        if !actions.isEmpty, let hash = item.hash {
            info["hash"] = hash
            if item.held { info["held"] = "1" }
        }
        let category = actions.isEmpty ? (item.sessionId != nil ? "drover.session" : "drover.info") : dialogCategory(actions)
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
}
