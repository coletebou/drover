import Foundation

// Wire models for the Drover ops the menu bar uses. Shapes follow CONTRACT.md (`native.summary`,
// `native.notifications`). Decoding is tolerant: unknown enum values and missing optional fields
// never fail a whole summary. When DroverKit lands, these map 1:1 onto its models (see DroverKitBridge note
// in README.md).

/// `{ ok: true, result, ms, cache }` or `{ ok: false, error }`.
struct OpEnvelope<T: Decodable & Sendable>: Decodable, Sendable {
    let ok: Bool
    let result: T?
    let error: String?
}

/// An op result we do not inspect (mutations: reply, sweep, mute).
struct AnyResult: Decodable, Sendable {
    init(from decoder: Decoder) throws {}
    init() {}
}

enum WaitingKind: String, Codable, Sendable {
    case decision, question, finished, unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WaitingKind(rawValue: raw) ?? .unknown
    }
}

struct SummaryHost: Codable, Sendable, Hashable, Identifiable {
    var name: String
    var up: Bool
    var waiting: Int
    var working: Int
    var idle: Int
    var id: String { name }
}

/// One option of an on-screen dialog: its number, its cleaned label, and whether it is the highlighted
/// one (what Enter picks).
struct DialogOption: Codable, Sendable, Hashable {
    var n: Int
    var label: String
    var selected: Bool?

    init(n: Int, label: String, selected: Bool? = nil) {
        self.n = n
        self.label = label
        self.selected = selected
    }
}

extension DialogOption {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let n = try? c.decode(Int.self, forKey: .n) {
            self.n = n
        } else if let s = try? c.decode(String.self, forKey: .n), let n = Int(s) {
            self.n = n
        } else {
            throw DecodingError.dataCorruptedError(forKey: .n, in: c, debugDescription: "option number")
        }
        label = (try? c.decode(String.self, forKey: .label)) ?? ""
        selected = try? c.decodeIfPresent(Bool.self, forKey: .selected)
    }
}

/// `dialog` on waiting items and alerts (the UX overhaul contract): the question and at most nine options.
struct DialogInfo: Codable, Sendable, Hashable {
    var question: String?
    var options: [DialogOption]

    init(question: String?, options: [DialogOption]) {
        self.question = question
        self.options = options
    }

    var selectedOption: DialogOption? { options.first { $0.selected == true } }
}

extension DialogInfo {
    /// Tolerant: a malformed option is dropped instead of failing the whole summary.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        question = try? c.decodeIfPresent(String.self, forKey: .question)
        options = ((try? c.decodeIfPresent([Lossy<DialogOption>].self, forKey: .options)) ?? []).compactMap(\.value)
    }
}

/// How a waiting item is answered: `keys` (press one of `keys` on the dialog) or `reply` (send a message:
/// the agent asked in text). Unknown values decode as `unknown`.
enum AnswerMode: String, Codable, Sendable {
    case keys, reply, unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AnswerMode(rawValue: raw) ?? .unknown
    }
}

/// Decodes `T` or nothing, so one bad array element does not fail its container.
struct Lossy<T: Decodable & Sendable>: Decodable, Sendable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

struct WaitingItem: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var name: String
    var host: String
    var engine: String
    /// ISO 8601 UTC time the session started waiting (kept as a string; see `sinceDate`).
    var since: String?
    var kind: WaitingKind
    /// At most 140 chars, no secrets (server guarantees).
    var headline: String
    /// The dialog on screen, when there is one (daemons from before the UX overhaul send none).
    var dialog: DialogInfo? = nil
    /// The screen hash to pass back as `sessions.answer` `expect`.
    var hash: String? = nil
    /// The keys this dialog takes, in display order.
    var keys: [String]? = nil
    var answer: AnswerMode? = nil

    var sinceDate: Date? { since.flatMap(ISODate.parse) }
}

extension WaitingItem {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        host = try c.decode(String.self, forKey: .host)
        engine = try c.decode(String.self, forKey: .engine)
        since = try c.decodeIfPresent(String.self, forKey: .since)
        kind = try c.decode(WaitingKind.self, forKey: .kind)
        headline = try c.decode(String.self, forKey: .headline)
        // The answer fields are optional and new: a malformed one is ignored, never fatal.
        dialog = try? c.decodeIfPresent(DialogInfo.self, forKey: .dialog)
        hash = try? c.decodeIfPresent(String.self, forKey: .hash)
        keys = try? c.decodeIfPresent([String].self, forKey: .keys)
        answer = try? c.decodeIfPresent(AnswerMode.self, forKey: .answer)
    }
}

struct WorkingItem: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var name: String
    var host: String
    var engine: String
    var headline: String
}

struct SummaryTotals: Codable, Sendable, Hashable {
    var waiting: Int
    var working: Int
    var idle: Int
    var hosts: Int
}

struct ManagerState: Codable, Sendable, Hashable {
    var up: Bool
    var lastNoteAt: String?
    /// The host the manager runs on, as an op `host` argument (`local` or nil: the daemon's own machine).
    var host: String? = nil

    /// The `host` argument for manager ops: nil for the daemon's own machine.
    var opHost: String? {
        guard let host, !host.isEmpty, host != "local" else { return nil }
        return host
    }
}

/// `native.summary` result.
struct Summary: Codable, Sendable, Hashable {
    var generatedAt: String
    var hosts: [SummaryHost]
    var waiting: [WaitingItem]
    var working: [WorkingItem]
    var totals: SummaryTotals
    var manager: ManagerState?
    /// The daemon's owner (`DROVER_OWNER`): their turns read "You" (`AppIdentifiers.isOwner`). Older daemons send none.
    var owner: String? = nil

    static let empty = Summary(
        generatedAt: "", hosts: [], waiting: [], working: [],
        totals: SummaryTotals(waiting: 0, working: 0, idle: 0, hosts: 0), manager: nil)
}

struct NotificationItem: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var at: String
    /// `decision|question|finished|error|mr|launch|manager`; kept as a string so new kinds decode.
    var kind: String
    var title: String
    var body: String?
    var sessionId: String?
    var host: String?
    /// The web UI's alert category (`needs-you|finished|error|held|mr|launch|manager`).
    var category: String?
    /// True for `notify.test` alerts.
    var test: Bool?
    /// Dialog fields, as on waiting items (only while a dialog or a held peer message is on screen).
    var dialog: DialogInfo? = nil
    var hash: String? = nil
    var keys: [String]? = nil
    var answer: AnswerMode? = nil
    /// A tmux window target, for an agent seen only as a window (no session id).
    var target: String? = nil

    var isNeedsYou: Bool { category == "needs-you" || kind == "decision" || kind == "question" }
    var isHeld: Bool { category == "held" }
    /// The `id` for `sessions.answer`: the session, else the window.
    var answerID: String? { sessionId ?? target }
}

extension NotificationItem {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        at = try c.decode(String.self, forKey: .at)
        kind = try c.decode(String.self, forKey: .kind)
        title = try c.decode(String.self, forKey: .title)
        body = try c.decodeIfPresent(String.self, forKey: .body)
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId)
        host = try c.decodeIfPresent(String.self, forKey: .host)
        category = try c.decodeIfPresent(String.self, forKey: .category)
        test = try c.decodeIfPresent(Bool.self, forKey: .test)
        dialog = try? c.decodeIfPresent(DialogInfo.self, forKey: .dialog)
        hash = try? c.decodeIfPresent(String.self, forKey: .hash)
        keys = try? c.decodeIfPresent([String].self, forKey: .keys)
        answer = try? c.decodeIfPresent(AnswerMode.self, forKey: .answer)
        target = try? c.decodeIfPresent(String.self, forKey: .target)
    }
}

/// `native.notifications` result.
struct NotificationsPage: Codable, Sendable, Hashable {
    var cursor: String?
    var items: [NotificationItem]
}

enum ISODate {
    static func parse(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }
}
