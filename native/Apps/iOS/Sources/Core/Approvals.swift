import Foundation

/// A Grok bot's approval request (CONTRACT.md "Grok bot approvals"): the bot asks the owner before it acts, with two to
/// four options, and the request is answered by its `id` with `POST /api/approvals/answer` (main token), never on a
/// screen and never with an op. The words are the bot's (it thinks on a third-party model, `untrusted`): they are shown
/// as plain text and never acted on.
struct ApprovalRequest: Codable, Sendable, Hashable, Identifiable {
    struct Option: Codable, Sendable, Hashable, Identifiable {
        var n: Int
        var label: String
        var id: Int { n }
    }

    /// The full request's answer (`GET /api/approvals?id=`): the option the owner picked.
    struct Decision: Codable, Sendable, Hashable {
        var n: Int?
        var label: String?
    }

    var id: String
    /// The bot's session id, `grok:<name>`.
    var bot: String?
    /// purchase | action | post | other; anything new is kept as sent.
    var kind: String?
    var question: String
    var options: [Option]
    var details: String?
    var createdAt: LooseDate?
    var expiresAt: LooseDate?
    var untrusted: Bool?
    /// This payload shows the request whole and unaltered (question, details and labels as stored). Only then may a
    /// surface that shows all of it answer in one tap; otherwise the full request is reviewed first. Missing (an older
    /// daemon) counts as false.
    var complete: Bool?
    /// Only on the full request (`GET /api/approvals?id=`): pending | decided | withdrawn | expired, the bot's display
    /// name, the answer and the client that gave it.
    var status: String?
    var botName: String?
    var decision: Decision?
    var via: String?

    init(id: String, bot: String? = nil, kind: String? = nil, question: String, options: [Option], details: String? = nil,
         createdAt: LooseDate? = nil, expiresAt: LooseDate? = nil, untrusted: Bool? = true, complete: Bool? = nil,
         status: String? = nil, botName: String? = nil, decision: Decision? = nil, via: String? = nil) {
        self.id = id; self.bot = bot; self.kind = kind; self.question = question; self.options = options
        self.details = details; self.createdAt = createdAt; self.expiresAt = expiresAt; self.untrusted = untrusted
        self.complete = complete; self.status = status; self.botName = botName; self.decision = decision; self.via = via
    }

    /// Whether this payload may be answered as shown (CONTRACT.md: `complete`, missing reads as false).
    var isComplete: Bool { complete == true }
}

extension ApprovalRequest {
    /// Tolerant: an id is all it needs; a malformed option is dropped, any other malformed field reads as absent.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(LooseString.self, forKey: .id).value
        guard !id.isEmpty else { throw DecodingError.dataCorruptedError(forKey: .id, in: c, debugDescription: "empty approval id") }
        bot = c.lenient(String.self, forKey: .bot)
        kind = c.lenient(String.self, forKey: .kind)
        question = c.lenient(String.self, forKey: .question) ?? ""
        var seen = Set<Int>()
        options = (c.lenient([Lossy<Option>].self, forKey: .options) ?? []).compactMap(\.value).filter { seen.insert($0.n).inserted }
        details = c.lenient(String.self, forKey: .details).flatMap { $0.isEmpty ? nil : $0 }
        createdAt = c.lenient(LooseDate.self, forKey: .createdAt)
        expiresAt = c.lenient(LooseDate.self, forKey: .expiresAt)
        untrusted = c.lenient(Bool.self, forKey: .untrusted)
        complete = c.lenient(Bool.self, forKey: .complete)
        status = c.lenient(String.self, forKey: .status)
        botName = c.lenient(String.self, forKey: .botName)
        decision = c.lenient(Decision.self, forKey: .decision)
        via = c.lenient(String.self, forKey: .via)
    }
}

/// `GET /api/approvals?id=` result: `{keepsBots, items: [the request as its owner sees it]}`.
struct ApprovalLookup: Decodable, Sendable {
    var keepsBots: Bool?
    var items: [ApprovalRequest]

    enum CodingKeys: String, CodingKey { case keepsBots, items }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        keepsBots = c.lenient(Bool.self, forKey: .keepsBots)
        items = (c.lenient([Lossy<ApprovalRequest>].self, forKey: .items) ?? []).compactMap(\.value)
    }
}

extension ApprovalRequest.Option {
    /// `n` as a number or a numeric string, at least 1; a missing label reads as empty (shown as "Option n").
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let i = c.lenient(Int.self, forKey: .n) { n = i }
        else if let s = c.lenient(String.self, forKey: .n), let i = Int(s.trimmingCharacters(in: .whitespaces)) { n = i }
        else { throw DecodingError.dataCorruptedError(forKey: .n, in: c, debugDescription: "option number") }
        guard n >= 1 else { throw DecodingError.dataCorruptedError(forKey: .n, in: c, debugDescription: "option number below 1") }
        label = c.lenient(String.self, forKey: .label) ?? ""
    }
}

/// Decodes `T` or nothing, so one bad array element does not fail its container.
struct Lossy<T: Decodable & Sendable>: Decodable, Sendable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

/// What `POST /api/approvals/answer` came to.
enum ApprovalAnswerResult: Sendable, Hashable {
    /// 200: the request is decided with `label`; `delivery` says how the bot gets the answer.
    case decided(label: String, delivery: ApprovalDelivery)
    /// 409: answered already (another screen was quicker), withdrawn or expired. Show `message` and drop the card.
    case closed(message: String)
}

/// The 200 answer's `delivery {ok, via?, queued?, error?}`.
struct ApprovalDelivery: Codable, Sendable, Hashable {
    var ok: Bool?
    var queued: Bool?
    var error: String?
}

/// The 200 answer's `result`: `{id, status, decision {n, label, at, by, via}, delivery}`. Only what a client shows.
struct ApprovalAnswerPayload: Decodable, Sendable {
    struct Decision: Decodable, Sendable { var n: Int?; var label: String? }
    var id: String?
    var status: String?
    var decision: Decision?
    var delivery: ApprovalDelivery?

    enum CodingKeys: String, CodingKey { case id, status, decision, delivery }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(String.self, forKey: .id)
        status = c.lenient(String.self, forKey: .status)
        decision = c.lenient(Decision.self, forKey: .decision)
        delivery = c.lenient(ApprovalDelivery.self, forKey: .delivery)
    }
}

/// What an approval card offers. Pure (ApprovalFormat.cardMode), so the one-tap rule is tested.
enum ApprovalCardMode: Equatable, Sendable {
    /// No buttons: why (another host keeps the bot, a read-only token, expired, nothing to press).
    case blocked(String)
    /// The reviewed request is no longer pending: what became of it.
    case closed(String)
    /// One tap answers `request`: a complete payload this card shows whole, or the reviewed full request.
    case answer(ApprovalRequest)
    /// The words may be shortened: review the whole request before answering.
    case review
}

/// A short line about the last answer, shown above the waiting list until it is dismissed or replaced.
struct ApprovalNotice: Identifiable, Equatable, Sendable {
    let id = UUID()
    var text: String
    var isError: Bool
}

/// Pure wording and rules for approval cards and their notifications (CONTRACT.md "Grok bot approvals").
enum ApprovalFormat {
    /// Who asks: the bot's name from `grok:<name>` ("grok:alpha" -> "Alpha"), else the waiting item's name.
    static func botName(bot: String?, fallback: String? = nil) -> String? {
        if let bot = bot?.trimmingCharacters(in: .whitespaces), !bot.isEmpty {
            let name = bot.lowercased().hasPrefix("grok:") ? String(bot.dropFirst(5)) : bot
            if !name.isEmpty { return name.prefix(1).uppercased() + name.dropFirst() }
        }
        guard let fallback = fallback?.trimmingCharacters(in: .whitespaces), !fallback.isEmpty else { return nil }
        return fallback
    }

    /// "Alpha, a Grok bot", or "a Grok bot" when the name is unknown.
    static func askedBy(_ name: String?) -> String {
        guard let name, !name.isEmpty else { return "a Grok bot" }
        return "\(name), a Grok bot"
    }

    /// The card's heading: what kind of thing it asks for.
    static func heading(kind: String?) -> String {
        kind == "purchase" ? "Asks to buy" : "Asks for your approval"
    }

    /// A button's text: the option's label, or "Option n" when it has none.
    static func title(_ option: ApprovalRequest.Option) -> String {
        let l = option.label.trimmingCharacters(in: .whitespacesAndNewlines)
        return l.isEmpty ? "Option \(option.n)" : l
    }

    /// How long a request still stands, in words ("40 min", "5 h", "2 days"), or nil once it expired (the web board's
    /// rule). nil for no expiry too.
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

    /// The note under a card: who asks, that these are its words, how long it stands, how many more wait.
    static func note(botName: String?, expiresAt: Date?, more: Int, now: Date) -> String {
        var s = "Asked by \(askedBy(botName)). These are its words: check them before you answer."
        if let left = standsFor(expiresAt, now: now) { s += " Stands for \(left) more." }
        if more > 0 { s += " \(more) more after this one." }
        return s
    }

    /// A request is answered on the daemon that keeps its bot: from this app, only the daemon's own (`local`).
    static func isAnswerable(host: String?) -> Bool {
        guard let h = host?.trimmingCharacters(in: .whitespaces), !h.isEmpty else { return true }
        return h == localHostName
    }

    /// Why a card shows no buttons for a request on another host.
    static func elsewhere(host: String) -> String {
        "\(host) keeps this bot: answer it on \(host)'s own Drover board."
    }

    /// The longest question a one-tap surface shows unclipped (UTF-16 units, as the web board counts): longer ones are
    /// answered from the full review.
    static let oneTapQuestionMax = 120
    /// The longest option label a notification action shows whole (an action cannot wrap; labels are never cut).
    static let notificationLabelMax = 20

    /// A payload one tap may answer as shown: complete (missing reads as false) and its question unclipped.
    static func showsWhole(_ a: ApprovalRequest) -> Bool {
        a.isComplete && a.question.utf16.count <= oneTapQuestionMax
    }

    /// What a card shows the request with `summary` (from the board) offers, once `full` (the reviewed request, if
    /// any) is known. One tap only on words shown whole: the card shows question, details and labels in full, so a
    /// complete payload with its question unclipped (`showsWhole`), or the reviewed full request itself.
    static func cardMode(summary: ApprovalRequest, full: ApprovalRequest?, host: String?, hasMainToken: Bool, now: Date) -> ApprovalCardMode {
        if !isAnswerable(host: host), let host { return .blocked(elsewhere(host: host)) }
        if !hasMainToken { return .blocked("Read-only token: add the main token in Settings to answer.") }
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
        if request.options.isEmpty { return .blocked("This request offers no options. Answer it on the Drover board.") }
        return .answer(request)
    }

    /// Why a card asks for a review before it answers: its words may have been shortened on the way.
    static let reviewNote = "This preview may be shortened. Review the whole request before you answer."

    /// What a reviewed request that is no longer pending says instead of its buttons; nil while it is pending.
    static func closedText(_ a: ApprovalRequest) -> String? {
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

    /// What an answer came to, in one line: the answer and how the bot gets it, or why it was not answered.
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
            return ("Not answered: \(trimmed(error.localizedDescription)).", true)
        }
    }

    /// What a settled request's card says until the board drops it: the answer, or why it was not answered.
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
