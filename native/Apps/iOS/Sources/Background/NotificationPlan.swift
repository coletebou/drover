import Foundation

/// A local notification ready to post. Plain values only, so the decision logic stays testable.
struct PlannedNotification: Sendable, Hashable {
    var id: String
    var title: String
    var body: String
    var threadID: String
    var categoryID: String
    var sessionId: String?
    var host: String?
    var kind: String
    var playsSound: Bool
    /// "Asked by Alpha, a Grok bot" on a bot's approval request: who wrote the words below it.
    var subtitle: String? = nil
    /// The approval request its buttons answer (`approvalId` in userInfo), and the bot's name for the outcome line.
    var approvalID: String? = nil
    var approvalBot: String? = nil
    /// One button per option of an approval request (empty: the fixed categories).
    var actions: [PlannedApprovalAction] = []
}

/// A notification button that answers an approval request with one option. Needs the device unlocked.
struct PlannedApprovalAction: Sendable, Hashable, Codable {
    /// `drover.approval.choice.<n>`.
    var identifier: String
    var title: String
    var choice: Int
    /// A clearly negative option (Deny, Not now): shown as destructive.
    var destructive: Bool
}

/// Result of deciding what to do with one `native.notifications` response.
struct NotificationPlan: Sendable, Hashable {
    static let sessionCategory = "drover.session"
    static let infoCategory = "drover.info"
    /// Approval categories are `drover.approval.<digest of the buttons>`: one per distinct set of options.
    static let approvalCategoryPrefix = "drover.approval."
    static let approvalActionPrefix = "drover.approval.choice."
    static let ringCapacity = 200
    static let maxBodyLength = 300
    /// The contract's most; a notification has room for four buttons.
    static let maxApprovalActions = 4
    static let soundKinds: Set<String> = ["decision", "question", "error"]

    var notifications: [PlannedNotification]
    /// Cursor to store after posting (the old one when the response carried none).
    var cursor: String?
    /// The dedupe ring after this plan, oldest first, at most `ringCapacity` ids.
    var postedRing: [String]

    /// First-run rule: with no stored cursor, adopt the returned cursor and post nothing.
    static func make(feed: NotificationFeed, storedCursor: String?, mutedKinds: Set<String>, postedRing: [String]) -> NotificationPlan {
        let newCursor = feed.cursor?.value ?? storedCursor
        guard storedCursor != nil else {
            return NotificationPlan(notifications: [], cursor: newCursor, postedRing: postedRing)
        }
        var seen = Set(postedRing)
        var ring = postedRing
        var out: [PlannedNotification] = []
        for item in feed.items {
            if item.test == true { continue }
            if let k = item.kind, mutedKinds.contains(k) { continue }
            if let c = item.category, mutedKinds.contains(c) { continue }
            if seen.contains(item.id) { continue }
            seen.insert(item.id)
            ring.append(item.id)
            out.append(planned(item))
        }
        if ring.count > ringCapacity { ring.removeFirst(ring.count - ringCapacity) }
        return NotificationPlan(notifications: out, cursor: newCursor, postedRing: ring)
    }

    static func planned(_ item: NotificationFeed.Item) -> PlannedNotification {
        let kind = item.kind ?? item.category ?? "info"
        let hasSession = item.sessionId?.isEmpty == false
        let thread: String
        if let ref = item.ref, hasSession { thread = ref.key } else { thread = kind }
        var n = PlannedNotification(
            id: item.id,
            title: item.title,
            body: truncated(item.body ?? ""),
            threadID: thread,
            // An approval request is never answered with Reply, even one whose request did not decode.
            categoryID: hasSession && item.answer != "approval" ? sessionCategory : infoCategory,
            sessionId: hasSession ? item.sessionId : nil,
            host: item.host,
            kind: kind,
            playsSound: soundKinds.contains(kind))
        // A Grok bot's approval request: answered by its id, never with Reply (that would message the bot instead).
        if let approval = item.approval {
            let bot = ApprovalFormat.botName(bot: approval.bot)
            n.subtitle = "Asked by \(ApprovalFormat.askedBy(bot))"
            if !approval.question.isEmpty {
                n.body = truncated(approval.details.map { "\(approval.question)\n\($0)" } ?? approval.question)
            }
            let here = ApprovalFormat.isAnswerable(host: item.host)
            let actions = here && answersInNotification(approval) ? approvalActions(approval) : []
            n.categoryID = actions.isEmpty ? infoCategory : approvalCategory(actions)
            n.actions = actions
            // Tapped, it opens the bot's detail reviewing the whole request (another host's cannot be reviewed here).
            n.approvalID = here ? approval.id : nil
            n.approvalBot = bot
        }
        return n
    }

    /// Buttons on the notification only for words it shows whole: a complete request, its question unclipped, no
    /// details (a banner cannot be trusted to show them in full), at most four options, each label short enough for an
    /// action to show uncut. Anything else opens the app to review the whole request.
    static func answersInNotification(_ approval: ApprovalRequest) -> Bool {
        ApprovalFormat.showsWhole(approval) && approval.details == nil && approval.options.count <= maxApprovalActions
            && approval.options.allSatisfy { ApprovalFormat.title($0).count <= ApprovalFormat.notificationLabelMax }
    }

    /// One button per option, in the request's order, each label whole.
    static func approvalActions(_ approval: ApprovalRequest) -> [PlannedApprovalAction] {
        approval.options.map { o in
            let title = ApprovalFormat.title(o)
            return PlannedApprovalAction(identifier: approvalActionPrefix + String(o.n), title: title,
                                         choice: o.n, destructive: ApprovalFormat.isNegative(title))
        }
    }

    /// The category of a set of approval buttons: the same options share one, so requests do not pile categories up.
    /// Its id is the actions themselves, encoded one to one, not a hash: two option sets never share a category, so a bot that found colliding labels could not put one request's buttons on another's banner.
    static func approvalCategory(_ actions: [PlannedApprovalAction]) -> String {
        let parts = actions.map { [$0.identifier, $0.title, $0.destructive ? "1" : "0"] }
        return approvalCategoryPrefix + ((try? JSONEncoder().encode(parts)).map { $0.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") } ?? "")
    }

    /// The option an action identifier answers (`drover.approval.choice.2` -> 2), or nil for any other action.
    static func approvalChoice(fromAction id: String) -> Int? {
        guard id.hasPrefix(approvalActionPrefix), let n = Int(id.dropFirst(approvalActionPrefix.count)), n >= 1 else { return nil }
        return n
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

    static func truncated(_ s: String, limit: Int = maxBodyLength) -> String {
        s.count <= limit ? s : String(s.prefix(limit - 1)) + "\u{2026}"
    }
}

/// The approval categories registered with the notification center, newest last, kept across launches so a request
/// still in Notification Center keeps its buttons. Pure; NotificationManager stores and registers them.
struct ApprovalCategorySpec: Sendable, Hashable, Codable {
    var identifier: String
    var actions: [PlannedApprovalAction]

    static let cap = 24

    /// `specs` with `spec` added (or moved to the end), the oldest dropped past `cap`.
    static func adding(_ spec: ApprovalCategorySpec, to specs: [ApprovalCategorySpec], cap: Int = cap) -> [ApprovalCategorySpec] {
        var out = specs.filter { $0.identifier != spec.identifier }
        out.append(spec)
        if out.count > cap { out.removeFirst(out.count - cap) }
        return out
    }
}
