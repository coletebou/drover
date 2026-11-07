import Foundation

/// A Grok bot's approval request (CONTRACT.md "Grok bot approvals"): the bot asks before it acts, with two to four
/// options, and the request is answered by `id` with `POST /api/approvals/answer` (main token, via watch). The words
/// are the bot's (a third-party model wrote them): shown as plain text, never acted on.
struct ApprovalRequest: Codable, Sendable, Equatable, Hashable {
    struct Option: Codable, Sendable, Equatable, Hashable, Identifiable {
        var n: Int
        var label: String
        var id: Int { n }

        init(n: Int, label: String) {
            self.n = n
            self.label = label
        }

        /// `n` as a number or a numeric string, at least 1.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            if let i = try? c.decode(Int.self, forKey: .n) { n = i }
            else if let s = try? c.decode(String.self, forKey: .n), let i = Int(s.trimmingCharacters(in: .whitespaces)) { n = i }
            else { throw DecodingError.dataCorruptedError(forKey: .n, in: c, debugDescription: "option number") }
            guard n >= 1 else { throw DecodingError.dataCorruptedError(forKey: .n, in: c, debugDescription: "option number below 1") }
            label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? ""
        }
    }

    var id: String
    /// The bot's session id, `grok:<name>`.
    var bot: String?
    /// purchase | action | post | other (anything new is kept as sent).
    var kind: String?
    var question: String
    var options: [Option]
    var details: String?
    var createdAt: FlexibleDate?
    var expiresAt: FlexibleDate?
    /// The payload shows the request whole and unaltered: only then is it answered as shown. Missing reads as false.
    var complete: Bool?
    /// Only on the full request (`GET /api/approvals?id=`): pending | decided | withdrawn | expired, the answer and the
    /// client that gave it.
    var status: String?
    var decisionLabel: String?
    var via: String?

    init(id: String, bot: String? = nil, kind: String? = nil, question: String, options: [Option], details: String? = nil,
         createdAt: FlexibleDate? = nil, expiresAt: FlexibleDate? = nil, complete: Bool? = nil, status: String? = nil,
         decisionLabel: String? = nil, via: String? = nil) {
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
        self.decisionLabel = decisionLabel
        self.via = via
    }

    var isComplete: Bool { complete == true }

    private enum CodingKeys: String, CodingKey {
        case id, bot, kind, question, options, details, createdAt, expiresAt, complete, status, decision, via
    }

    private struct Decision: Codable { var label: String? }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encodeIfPresent(bot, forKey: .bot)
        try c.encodeIfPresent(kind, forKey: .kind)
        try c.encode(question, forKey: .question)
        try c.encode(options, forKey: .options)
        try c.encodeIfPresent(details, forKey: .details)
        try c.encodeIfPresent(createdAt, forKey: .createdAt)
        try c.encodeIfPresent(expiresAt, forKey: .expiresAt)
        try c.encodeIfPresent(complete, forKey: .complete)
        try c.encodeIfPresent(status, forKey: .status)
        try c.encodeIfPresent(decisionLabel.map { Decision(label: $0) }, forKey: .decision)
        try c.encodeIfPresent(via, forKey: .via)
    }

    /// Tolerant: an id is all it needs; a malformed or repeated option is dropped, other malformed fields read as absent.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        guard !id.isEmpty else { throw DecodingError.dataCorruptedError(forKey: .id, in: c, debugDescription: "empty approval id") }
        bot = try? c.decodeIfPresent(String.self, forKey: .bot)
        kind = try? c.decodeIfPresent(String.self, forKey: .kind)
        question = (try? c.decodeIfPresent(String.self, forKey: .question)) ?? ""
        var seen = Set<Int>()
        options = ((try? c.decodeIfPresent([LossyOption].self, forKey: .options)) ?? [])
            .compactMap(\.value).filter { seen.insert($0.n).inserted }
        details = (try? c.decodeIfPresent(String.self, forKey: .details)).flatMap { $0.isEmpty ? nil : $0 }
        createdAt = try? c.decodeIfPresent(FlexibleDate.self, forKey: .createdAt)
        expiresAt = try? c.decodeIfPresent(FlexibleDate.self, forKey: .expiresAt)
        complete = try? c.decodeIfPresent(Bool.self, forKey: .complete)
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        decisionLabel = (try? c.decodeIfPresent(Decision.self, forKey: .decision))?.label
        via = try? c.decodeIfPresent(String.self, forKey: .via)
    }

    private struct LossyOption: Decodable {
        let value: Option?
        init(from decoder: Decoder) throws { value = try? Option(from: decoder) }
    }
}

/// What `POST /api/approvals/answer` came to.
enum ApprovalAnswerResult: Sendable, Equatable {
    /// 200: decided with `label`; `told` is false when the bot was not reached yet, `queued` when it waits in its inbox.
    case decided(label: String, told: Bool, queued: Bool)
    /// 409: answered already (another screen was quicker), withdrawn or expired.
    case closed(message: String)
}

/// What the watch's approval card offers (ApprovalFormat.cardMode, tested).
enum ApprovalCardMode: Equatable, Sendable {
    /// No buttons, and why: no main token, another host keeps the bot, expired, nothing to press.
    case blocked(String)
    /// The reviewed request is no longer pending: what became of it.
    case closed(String)
    /// One tap answers `request`: a complete payload the card shows whole, or the reviewed full request.
    case answer(ApprovalRequest)
    /// The words may be shortened: review the whole request first.
    case review
}

/// Pure wording and rules for the watch's approval card.
enum ApprovalFormat {
    /// The longest question a one-tap card shows unclipped (UTF-16 units, as the web board counts).
    static let oneTapQuestionMax = 120

    /// A payload one tap may answer as shown: complete (missing reads as false) and its question unclipped.
    static func showsWhole(_ a: ApprovalRequest) -> Bool {
        a.isComplete && a.question.utf16.count <= oneTapQuestionMax
    }

    /// One tap only on words shown whole: the card shows question, details and labels in full, so a payload that
    /// `showsWhole`, or the reviewed full request. Without the main token the card is read-only.
    static func cardMode(summary: ApprovalRequest, full: ApprovalRequest?, host: String?, canAnswer: Bool, now: Date) -> ApprovalCardMode {
        if !canAnswer { return .blocked("Answer on your iPhone") }
        if !isAnswerable(host: host) { return .blocked("\(host ?? "Another host") keeps this bot: answer it there.") }
        let request: ApprovalRequest
        if let full {
            if let closed = closedText(full) { return .closed(closed) }
            request = full
        } else {
            if isExpired(summary, now: now) { return .blocked("This request expired.") }
            guard showsWhole(summary) else { return .review }
            request = summary
        }
        if isExpired(request, now: now) { return .blocked("This request expired.") }
        if request.options.isEmpty { return .blocked("Answer it on your iPhone.") }
        return .answer(request)
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

    /// "Asked by Alpha, a Grok bot".
    static func askedBy(_ name: String?) -> String {
        guard let name, !name.isEmpty else { return "Asked by a Grok bot" }
        return "Asked by \(name), a Grok bot"
    }

    static func heading(kind: String?) -> String { kind == "purchase" ? "Asks to buy" : "Asks for your approval" }

    static func title(_ option: ApprovalRequest.Option) -> String {
        let l = option.label.trimmingCharacters(in: .whitespacesAndNewlines)
        return l.isEmpty ? "Option \(option.n)" : l
    }

    /// "40 min", "5 h", "2 days" (the web board's rule), nil once expired or without an expiry.
    static func standsFor(_ expiresAt: Date?, now: Date) -> String? {
        guard let expiresAt else { return nil }
        let left = expiresAt.timeIntervalSince(now)
        guard left > 0 else { return nil }
        if left < 90 * 60 { return "\(max(1, Int((left / 60).rounded()))) min" }
        if left < 48 * 3600 { return "\(Int((left / 3600).rounded())) h" }
        return "\(Int((left / 86400).rounded())) days"
    }

    static func isExpired(_ approval: ApprovalRequest, now: Date) -> Bool {
        guard let at = approval.expiresAt?.date else { return false }
        return at <= now
    }

    /// Who asks, that these are its words, how long it stands, how many more wait.
    static func note(botName: String?, expiresAt: Date?, more: Int, now: Date) -> String {
        var s = "\(askedBy(botName)). These are its words: check them before you answer."
        if let left = standsFor(expiresAt, now: now) { s += " Stands for \(left) more." }
        if more > 0 { s += " \(more) more after this one." }
        return s
    }

    /// Why the card asks for a review first: its words may have been shortened on the way.
    static let reviewNote = "This preview may be shortened. Review the whole request first."

    /// What a reviewed request that is no longer pending says instead of its buttons; nil while it is pending.
    static func closedText(_ a: ApprovalRequest) -> String? {
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

    /// Answered only on the daemon that keeps the bot: from the watch, the daemon's own (`local`).
    static func isAnswerable(host: String?) -> Bool {
        guard let h = host?.trimmingCharacters(in: .whitespaces), !h.isEmpty else { return true }
        return h == "local"
    }

    static func outcome(_ result: Result<ApprovalAnswerResult, Error>, botName: String?) -> (text: String, isError: Bool) {
        let bot = botName.flatMap { $0.isEmpty ? nil : $0 } ?? "The bot"
        switch result {
        case .success(.decided(let label, let told, let queued)):
            let answered = label.isEmpty ? "Answered." : "Answered \"\(label)\"."
            if !told { return ("\(answered) \(bot) was not reached; it sees the answer when it checks again.", true) }
            if queued { return ("\(answered) \(bot) sees it when it checks its inbox.", false) }
            return ("\(answered) \(bot) is told now.", false)
        case .success(.closed(let message)):
            return ("Not answered: \(trimmed(message)).", true)
        case .failure(let error):
            let m = (error as? WatchClientError)?.message ?? "Send failed"
            return ("Not answered: \(trimmed(m)).", true)
        }
    }

    /// What a settled request's card says until the summary drops it: the answer, or why it was not answered.
    static func settledText(_ result: ApprovalAnswerResult) -> String {
        switch result {
        case .decided(let label, _, _): label.isEmpty ? "Answered." : "Answered \"\(label)\"."
        case .closed(let message): "Not answered: \(trimmed(message))."
        }
    }

    private static func trimmed(_ s: String) -> String {
        let t = s.trimmingCharacters(in: CharacterSet(charactersIn: " .\n"))
        return t.isEmpty ? "the daemon refused" : t
    }
}
