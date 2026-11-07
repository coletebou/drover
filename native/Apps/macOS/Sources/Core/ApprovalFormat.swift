import Foundation

/// Pure wording and rules for a Grok bot's approval request on the board, in the chat and in notifications
/// (CONTRACT.md "Grok bot approvals"). Harness-tested.
enum ApprovalFormat {
    /// The longest question a one-click surface shows unclipped (UTF-16 units, as the web board counts): longer ones
    /// are answered from the full review.
    static let oneClickQuestionMax = 120
    /// The longest option label a notification action shows whole (an action cannot wrap; labels are never cut).
    static let notificationLabelMax = 20

    /// A payload one click may answer as shown: complete (missing reads as false) and its question unclipped.
    static func showsWhole(_ a: ApprovalInfo) -> Bool {
        a.isComplete && a.question.utf16.count <= oneClickQuestionMax
    }

    /// What a card offers: one click only on words shown whole (`showsWhole`, and the details in full when the surface
    /// cannot show them: `detailsShown`), else the review of the whole request first; once reviewed, the whole request.
    static func cardMode(summary: ApprovalInfo, review: ApprovalReview?, answerable: Bool, host: String, detailsShown: Bool = true,
                         now: Date) -> ApprovalCardMode {
        if !answerable { return .blocked(elsewhere(host: host)) }
        let request: ApprovalInfo
        // A surface that cannot show all of the reviewed request (a board row shows the board's words) leaves the
        // review to the card that can: it answers only the board's own whole words.
        switch detailsShown ? review : nil {
        case .gone?: return .closed("This request is no longer waiting for an answer.")
        case .loaded(let full)?:
            if let closed = closedText(full) { return .closed(closed) }
            request = full
        default:
            if isExpired(summary, now: now) { return .blocked("This request expired.") }
            guard showsWhole(summary), detailsShown || summary.details == nil else { return .review }
            request = summary
        }
        if isExpired(request, now: now) { return .blocked("This request expired.") }
        if request.options.isEmpty { return .blocked("This request offers no options. Answer it on the web board.") }
        return .answer(request)
    }

    /// Buttons on a notification only for words a banner shows whole: a complete request, its question unclipped, no
    /// details (a banner cannot be trusted to show them in full) and every label short enough to show uncut.
    static func answersInNotification(_ a: ApprovalInfo) -> Bool {
        showsWhole(a) && a.details == nil && a.options.allSatisfy { title($0).count <= notificationLabelMax }
    }

    static let reviewNote = "This preview may be shortened. Review the whole request before you answer."
    /// A board row's reason when the request is whole but has details the row does not show.
    static let detailsInChatNote = "Its details show in the chat: read them there before you answer."

    /// What a reviewed request that is no longer pending says instead of its buttons; nil while it is pending.
    static func closedText(_ a: ApprovalInfo) -> String? {
        switch a.status ?? "pending" {
        case "pending": return nil
        case "decided":
            let via = a.via.flatMap { $0.isEmpty ? nil : " (\($0))" } ?? ""
            if let label = a.decisionLabel, !label.isEmpty { return "Answered already: \"\(label)\"\(via)." }
            return "Answered already\(via)."
        case "withdrawn": return "The bot withdrew this request."
        case "expired": return "This request expired."
        case let other: return "This request is \(other)."
        }
    }

    /// "grok:alpha" -> "Alpha", else the session's name.
    static func botName(bot: String?, fallback: String? = nil) -> String? {
        if let bot = bot?.trimmingCharacters(in: .whitespaces), !bot.isEmpty {
            let name = bot.lowercased().hasPrefix("grok:") ? String(bot.dropFirst(5)) : bot
            if !name.isEmpty { return name.prefix(1).uppercased() + name.dropFirst() }
        }
        guard let fallback = fallback?.trimmingCharacters(in: .whitespaces), !fallback.isEmpty else { return nil }
        return fallback
    }

    /// "Alpha, a Grok bot".
    static func askedBy(_ name: String?) -> String {
        guard let name, !name.isEmpty else { return "a Grok bot" }
        return "\(name), a Grok bot"
    }

    static func heading(kind: String?) -> String { kind == "purchase" ? "Asks to buy" : "Asks for your approval" }

    static func title(_ option: ApprovalOption) -> String {
        let l = option.label.trimmingCharacters(in: .whitespacesAndNewlines)
        return l.isEmpty ? "Option \(option.n)" : l
    }

    /// "40 min", "5 h", "2 days" (the web board's rule); nil once expired or without an expiry.
    static func standsFor(_ expiresAt: Date?, now: Date) -> String? {
        guard let expiresAt else { return nil }
        let left = expiresAt.timeIntervalSince(now)
        guard left > 0 else { return nil }
        if left < 90 * 60 { return "\(max(1, Int((left / 60).rounded()))) min" }
        if left < 48 * 3600 { return "\(Int((left / 3600).rounded())) h" }
        return "\(Int((left / 86400).rounded())) days"
    }

    static func isExpired(_ approval: ApprovalInfo, now: Date) -> Bool {
        guard let at = approval.expiresAt else { return false }
        return at <= now
    }

    /// Who asks, that these are its words, how long it stands, how many more wait.
    static func note(botName: String?, expiresAt: Date?, more: Int, now: Date) -> String {
        var s = "Asked by \(askedBy(botName)). These are its words: check them before you answer."
        if let left = standsFor(expiresAt, now: now) { s += " Stands for \(left) more." }
        if more > 0 { s += " \(more) more after this one." }
        return s
    }

    /// Answered on the daemon that keeps the bot: from this app, only the daemon's own. The board names it `local` (or
    /// its own short name, which `isLocal` knows).
    static func isAnswerable(host: String?, isLocal: (String) -> Bool = { $0 == "local" }) -> Bool {
        guard let h = host?.trimmingCharacters(in: .whitespaces), !h.isEmpty else { return true }
        return isLocal(h)
    }

    static func elsewhere(host: String) -> String {
        "\(host) keeps this bot: answer it on \(host)'s own Drover board."
    }

    /// A clearly negative option (Deny, No, Not now, Skip...): a notification shows it as destructive.
    static func isNegative(_ label: String) -> Bool {
        let l = label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let words = ["deny", "no", "reject", "decline", "refuse", "cancel", "don't", "do not", "not now", "never", "skip",
                     "stop", "block"]
        return words.contains { w in
            guard l.hasPrefix(w) else { return false }
            guard let next = l.dropFirst(w.count).first else { return true }
            return !(next.isLetter || next.isNumber)
        }
    }

    /// What an answer came to, in one line.
    static func outcome(_ result: Result<ApprovalAnswerResult, Error>, botName: String?) -> (text: String, isError: Bool) {
        let bot = botName.flatMap { $0.isEmpty ? nil : $0 } ?? "The bot"
        switch result {
        case .success(.decided(let label, let delivered, let queued, let error)):
            let answered = label.isEmpty ? "Answered." : "Answered \"\(label)\"."
            if !delivered {
                let why = error.flatMap { $0.isEmpty ? nil : " (\($0))" } ?? ""
                return ("\(answered) \(bot) was not reached\(why); it sees the answer when it checks again.", true)
            }
            if queued { return ("\(answered) \(bot) sees it when it checks its inbox.", false) }
            return ("\(answered) \(bot) is told now.", false)
        case .success(.closed(let message)):
            return ("Not answered: \(trimmed(message)).", true)
        case .failure(let error):
            return ("Not answered: \(trimmed(error.localizedDescription)).", true)
        }
    }

    /// What a settled request's card says until the board drops it: the answer, or why it was not answered.
    static func settledText(_ result: ApprovalAnswerResult) -> String {
        switch result {
        case .decided(let label, _, _, _): label.isEmpty ? "Answered." : "Answered \"\(label)\"."
        case .closed(let message): "Not answered: \(trimmed(message))."
        }
    }

    private static func trimmed(_ s: String) -> String {
        let t = s.trimmingCharacters(in: CharacterSet(charactersIn: " .\n"))
        return t.isEmpty ? "the daemon refused" : t
    }
}
