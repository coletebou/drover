import Foundation

/// One option of a Grok bot's approval request: its number (what the answer sends as `choice`) and label.
struct ApprovalOption: Codable, Sendable, Hashable, Identifiable {
    var n: Int
    var label: String
    var id: Int { n }

    init(n: Int, label: String) {
        self.n = n
        self.label = label
    }
}

extension ApprovalOption {
    /// `n` as a number or a numeric string, at least 1; a missing label reads as empty.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let i = try? c.decode(Int.self, forKey: .n) { n = i }
        else if let s = try? c.decode(String.self, forKey: .n), let i = Int(s.trimmingCharacters(in: .whitespaces)) { n = i }
        else { throw DecodingError.dataCorruptedError(forKey: .n, in: c, debugDescription: "option number") }
        guard n >= 1 else { throw DecodingError.dataCorruptedError(forKey: .n, in: c, debugDescription: "option number below 1") }
        label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? ""
    }
}

/// `approval` on waiting items and alerts (CONTRACT.md "Grok bot approvals"): a Grok bot asks before it acts, and the
/// request is answered by `id` with `POST /api/approvals/answer`, never on a screen and never with an op. The words
/// are the bot's (a third-party model wrote them): shown as plain text, never acted on.
struct ApprovalInfo: Codable, Sendable, Hashable {
    var id: String
    /// The bot's session id, `grok:<name>`.
    var bot: String?
    /// purchase | action | post | other (anything new is kept as sent).
    var kind: String?
    var question: String
    var options: [ApprovalOption]
    var details: String?
    /// ISO 8601 UTC, kept as strings like `since`.
    var createdAt: String?
    var expiresAt: String?
    /// The payload shows the request whole and unaltered: only then is it answered as shown. Missing reads as false.
    var complete: Bool?
    /// Only on the full request (`GET /api/approvals?id=`): pending | decided | withdrawn | expired, the answer and the
    /// client that gave it.
    var status: String?
    var decision: ApprovalDecision?
    var via: String?

    init(id: String, bot: String? = nil, kind: String? = nil, question: String, options: [ApprovalOption],
         details: String? = nil, createdAt: String? = nil, expiresAt: String? = nil, complete: Bool? = nil,
         status: String? = nil, decision: ApprovalDecision? = nil, via: String? = nil) {
        self.id = id
        self.bot = bot
        self.kind = kind
        self.question = question
        self.options = options
        self.details = details
        self.createdAt = createdAt
        self.expiresAt = expiresAt
        self.complete = complete
        self.status = status
        self.decision = decision
        self.via = via
    }

    var expiresDate: Date? { expiresAt.flatMap(ISODate.parse) }
    var isComplete: Bool { complete == true }
}

/// The full request's answer: the option the owner picked.
struct ApprovalDecision: Codable, Sendable, Hashable {
    var n: Int?
    var label: String?
}

extension ApprovalInfo {
    /// Tolerant: an id is all it needs; a malformed or repeated option is dropped, other malformed fields read as absent.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        guard !id.isEmpty else { throw DecodingError.dataCorruptedError(forKey: .id, in: c, debugDescription: "empty approval id") }
        bot = try? c.decodeIfPresent(String.self, forKey: .bot)
        kind = try? c.decodeIfPresent(String.self, forKey: .kind)
        question = (try? c.decodeIfPresent(String.self, forKey: .question)) ?? ""
        var seen = Set<Int>()
        options = ((try? c.decodeIfPresent([Lossy<ApprovalOption>].self, forKey: .options)) ?? [])
            .compactMap(\.value).filter { seen.insert($0.n).inserted }
        details = (try? c.decodeIfPresent(String.self, forKey: .details)).flatMap { $0.isEmpty ? nil : $0 }
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
        expiresAt = try? c.decodeIfPresent(String.self, forKey: .expiresAt)
        complete = try? c.decodeIfPresent(Bool.self, forKey: .complete)
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        decision = try? c.decodeIfPresent(ApprovalDecision.self, forKey: .decision)
        via = try? c.decodeIfPresent(String.self, forKey: .via)
    }
}

/// `GET /api/approvals?id=` result: `{keepsBots, items: [the request as its owner sees it]}`.
struct ApprovalLookup: Decodable, Sendable {
    var items: [ApprovalInfo]

    private enum CodingKeys: String, CodingKey { case items }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = ((try? c.decodeIfPresent([Lossy<ApprovalInfo>].self, forKey: .items)) ?? []).compactMap(\.value)
    }
}

/// What a row offers for an approval request (ApprovalFormat.rowMode, tested).
enum ApprovalRowMode: Equatable, Sendable {
    /// No buttons, and why: another host keeps the bot, the main token is missing, expired, nothing to press.
    case blocked(String)
    /// The reviewed request is no longer pending: what became of it.
    case closed(String)
    /// One click answers `request`: a complete payload the row shows whole, or the reviewed full request.
    case answer(ApprovalInfo)
    /// The words may be shortened: review the whole request first.
    case review
}

/// The review of one request: loading, the whole request, gone from this daemon, or why it failed.
enum ApprovalReview: Equatable, Sendable {
    case loading
    case loaded(ApprovalInfo)
    case gone
    case failed(String)
}

/// What `POST /api/approvals/answer` came to.
enum ApprovalAnswerResult: Sendable, Equatable {
    /// 200: decided with `label`; `delivery` says how the bot gets the answer.
    case decided(label: String, delivery: ApprovalDelivery)
    /// 409: answered already (another screen was quicker), withdrawn or expired.
    case closed(message: String)
}

/// The 200 answer's `delivery {ok, via?, queued?, error?}`.
struct ApprovalDelivery: Codable, Sendable, Equatable {
    var ok: Bool?
    var queued: Bool?
    var error: String?

    init(ok: Bool? = nil, queued: Bool? = nil, error: String? = nil) {
        self.ok = ok
        self.queued = queued
        self.error = error
    }
}

/// The 200 answer's `result`: `{id, status, decision {n, label, at, by, via}, delivery}`; only what the menu bar shows.
struct ApprovalAnswerPayload: Decodable, Sendable {
    struct Decision: Decodable, Sendable { var label: String? }
    var decision: Decision?
    var delivery: ApprovalDelivery?

    private enum CodingKeys: String, CodingKey { case decision, delivery }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        decision = try? c.decodeIfPresent(Decision.self, forKey: .decision)
        delivery = try? c.decodeIfPresent(ApprovalDelivery.self, forKey: .delivery)
    }
}

/// The line about the last approval answer, shown above the waiting list for a few seconds.
struct ApprovalNotice: Sendable, Equatable {
    var text: String
    var isError: Bool
    var at: Date
}

/// Pure wording and rules for approval rows and their notifications.
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

    /// One click only on words shown whole: the row shows question, details and labels in full, so a payload that
    /// `showsWhole`, or the reviewed full request.
    static func rowMode(summary: ApprovalInfo, review: ApprovalReview?, host: String, canAct: Bool, now: Date) -> ApprovalRowMode {
        if !isAnswerable(host: host) { return .blocked(elsewhere(host: host)) }
        if !canAct { return .blocked("Add the main token in Settings to answer.") }
        let request: ApprovalInfo
        switch review {
        case .gone?: return .closed("This request is no longer waiting for an answer.")
        case .loaded(let full)?:
            if let closed = closedText(full) { return .closed(closed) }
            request = full
        default:
            if isExpired(summary, now: now) { return .blocked("This request expired.") }
            guard showsWhole(summary) else { return .review }
            request = summary
        }
        if isExpired(request, now: now) { return .blocked("This request expired.") }
        if request.options.isEmpty { return .blocked("This request offers no options. Open the board to answer it.") }
        return .answer(request)
    }

    /// Buttons on a notification only for words it shows whole: a complete request, its question unclipped, no details
    /// (a banner cannot be trusted to show them in full), at most four options, each label short enough to show uncut.
    static func answersInNotification(_ approval: ApprovalInfo) -> Bool {
        showsWhole(approval) && approval.details == nil && approval.options.count <= 4
            && approval.options.allSatisfy { title($0).count <= notificationLabelMax }
    }

    static let reviewNote = "This preview may be shortened. Review the whole request before you answer."

    /// What a reviewed request that is no longer pending says instead of its buttons; nil while it is pending.
    static func closedText(_ a: ApprovalInfo) -> String? {
        switch a.status ?? "pending" {
        case "pending": return nil
        case "decided":
            let via = a.via.flatMap { $0.isEmpty ? nil : " (\($0))" } ?? ""
            if let label = a.decision?.label, !label.isEmpty { return "Answered already: \"\(label)\"\(via)." }
            return "Answered already\(via)."
        case "withdrawn": return "The bot withdrew this request."
        case "expired": return "This request expired."
        case let other: return "This request is \(other)."
        }
    }

    /// "grok:alpha" -> "Alpha", else the waiting item's name.
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
        guard let at = approval.expiresDate else { return false }
        return at <= now
    }

    /// Who asks, that these are its words, how long it stands, how many more wait.
    static func note(botName: String?, expiresAt: Date?, more: Int, now: Date) -> String {
        var s = "Asked by \(askedBy(botName)). These are its words: check them before you answer."
        if let left = standsFor(expiresAt, now: now) { s += " Stands for \(left) more." }
        if more > 0 { s += " \(more) more after this one." }
        return s
    }

    /// Answered on the daemon that keeps the bot: from this app, only the daemon's own (`local`).
    static func isAnswerable(host: String?) -> Bool {
        guard let h = host?.trimmingCharacters(in: .whitespaces), !h.isEmpty else { return true }
        return h == "local"
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
        case .success(.decided(let label, let delivery)):
            let answered = label.isEmpty ? "Answered." : "Answered \"\(label)\"."
            if delivery.ok == false {
                let why = delivery.error.flatMap { $0.isEmpty ? nil : " (\($0))" } ?? ""
                return ("\(answered) \(bot) was not reached\(why); it sees the answer when it checks again.", true)
            }
            if delivery.queued == true { return ("\(answered) \(bot) sees it when it checks its inbox.", false) }
            return ("\(answered) \(bot) is told now.", false)
        case .success(.closed(let message)):
            return ("Not answered: \(trimmed(message)).", true)
        case .failure(let error):
            return ("Not answered: \(trimmed(DroverError.from(error).userMessage)).", true)
        }
    }

    /// What a settled request's row says until the summary drops it: the answer, or why it was not answered.
    static func settledText(_ result: ApprovalAnswerResult) -> String {
        switch result {
        case .decided(let label, _): label.isEmpty ? "Answered." : "Answered \"\(label)\"."
        case .closed(let message): "Not answered: \(trimmed(message))."
        }
    }

    private static func trimmed(_ s: String) -> String {
        let t = s.trimmingCharacters(in: CharacterSet(charactersIn: " .\n"))
        return t.isEmpty ? "the daemon refused" : t
    }
}
