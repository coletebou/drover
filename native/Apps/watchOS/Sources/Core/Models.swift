import Foundation

// Watch-side models for the Drover ops the watch uses. They mirror CONTRACT.md
// (`native.summary`, `sessions.lastReply`) and decode tolerantly: unknown keys are
// ignored, optional keys may be missing, and dates may be ISO 8601 strings or epoch
// numbers. When DroverKit lands these can be replaced by its models one for one.

/// `native.summary` result: compact, widget-sized, safe to poll.
struct NativeSummary: Codable, Sendable, Equatable {
    var generatedAt: FlexibleDate?
    var hosts: [HostSummary]
    var waiting: [WaitingItem]
    var working: [WorkingItem]
    var totals: Totals
    var manager: ManagerStatus?

    init(generatedAt: FlexibleDate? = nil, hosts: [HostSummary] = [], waiting: [WaitingItem] = [],
         working: [WorkingItem] = [], totals: Totals = Totals(), manager: ManagerStatus? = nil) {
        self.generatedAt = generatedAt
        self.hosts = hosts
        self.waiting = waiting
        self.working = working
        self.totals = totals
        self.manager = manager
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        generatedAt = try c.decodeIfPresent(FlexibleDate.self, forKey: .generatedAt)
        hosts = try c.decodeIfPresent([HostSummary].self, forKey: .hosts) ?? []
        waiting = try c.decodeIfPresent([WaitingItem].self, forKey: .waiting) ?? []
        working = try c.decodeIfPresent([WorkingItem].self, forKey: .working) ?? []
        totals = try c.decodeIfPresent(Totals.self, forKey: .totals) ?? Totals()
        manager = try c.decodeIfPresent(ManagerStatus.self, forKey: .manager)
    }
}

struct HostSummary: Codable, Sendable, Equatable, Identifiable {
    var name: String
    var up: Bool
    var waiting: Int
    var working: Int
    var idle: Int
    var id: String { name }

    init(name: String, up: Bool = true, waiting: Int = 0, working: Int = 0, idle: Int = 0) {
        self.name = name
        self.up = up
        self.waiting = waiting
        self.working = working
        self.idle = idle
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        up = try c.decodeIfPresent(Bool.self, forKey: .up) ?? false
        waiting = try c.decodeIfPresent(Int.self, forKey: .waiting) ?? 0
        working = try c.decodeIfPresent(Int.self, forKey: .working) ?? 0
        idle = try c.decodeIfPresent(Int.self, forKey: .idle) ?? 0
    }
}

/// Why a session is waiting on you. Unknown server values decode as `.other`.
enum WaitingKind: String, Codable, Sendable, Equatable {
    case decision, question, finished, other

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WaitingKind(rawValue: raw) ?? .other
    }
}

struct WaitingItem: Codable, Sendable, Equatable, Identifiable, Hashable {
    var id: String
    var name: String
    var host: String?
    var engine: String
    var since: FlexibleDate?
    var kind: WaitingKind
    var headline: String
    /// How it is answered: `keys`, `reply`, or `approval` (a Grok bot's request, answered by its id).
    var answer: String?
    /// A Grok bot's approval request (`kind` stays `decision`, so older watches show it as a decision).
    var approval: ApprovalRequest?
    /// How many more requests from the same bot wait behind this one.
    var moreApprovals: Int?

    init(id: String, name: String, host: String? = nil, engine: String = "claude",
         since: FlexibleDate? = nil, kind: WaitingKind = .question, headline: String = "",
         answer: String? = nil, approval: ApprovalRequest? = nil, moreApprovals: Int? = nil) {
        self.id = id
        self.name = name
        self.host = host
        self.engine = engine
        self.since = since
        self.kind = kind
        self.headline = headline
        self.answer = answer
        self.approval = approval
        self.moreApprovals = moreApprovals
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? id
        host = try c.decodeIfPresent(String.self, forKey: .host)
        engine = try c.decodeIfPresent(String.self, forKey: .engine) ?? "claude"
        since = try c.decodeIfPresent(FlexibleDate.self, forKey: .since)
        kind = try c.decodeIfPresent(WaitingKind.self, forKey: .kind) ?? .other
        headline = try c.decodeIfPresent(String.self, forKey: .headline) ?? ""
        // New and optional: a malformed one is ignored, never fatal to the summary.
        answer = try? c.decodeIfPresent(String.self, forKey: .answer)
        approval = try? c.decodeIfPresent(ApprovalRequest.self, forKey: .approval)
        moreApprovals = try? c.decodeIfPresent(Int.self, forKey: .moreApprovals)
    }

    /// Stable identity across hosts: the same session id can exist on two machines.
    var key: String { "\(host ?? "local")/\(id)" }
    /// The bot's name, for "Asked by Alpha, a Grok bot".
    var botName: String? { ApprovalFormat.botName(bot: approval?.bot, fallback: name) }
}

struct WorkingItem: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var name: String
    var host: String?
    var engine: String
    var headline: String

    init(id: String, name: String, host: String? = nil, engine: String = "claude", headline: String = "") {
        self.id = id
        self.name = name
        self.host = host
        self.engine = engine
        self.headline = headline
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? id
        host = try c.decodeIfPresent(String.self, forKey: .host)
        engine = try c.decodeIfPresent(String.self, forKey: .engine) ?? "claude"
        headline = try c.decodeIfPresent(String.self, forKey: .headline) ?? ""
    }
}

struct Totals: Codable, Sendable, Equatable {
    var waiting: Int
    var working: Int
    var idle: Int
    var hosts: Int

    init(waiting: Int = 0, working: Int = 0, idle: Int = 0, hosts: Int = 0) {
        self.waiting = waiting
        self.working = working
        self.idle = idle
        self.hosts = hosts
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        waiting = try c.decodeIfPresent(Int.self, forKey: .waiting) ?? 0
        working = try c.decodeIfPresent(Int.self, forKey: .working) ?? 0
        idle = try c.decodeIfPresent(Int.self, forKey: .idle) ?? 0
        hosts = try c.decodeIfPresent(Int.self, forKey: .hosts) ?? 0
    }
}

struct ManagerStatus: Codable, Sendable, Equatable {
    var up: Bool
    var lastNoteAt: FlexibleDate?

    init(up: Bool = false, lastNoteAt: FlexibleDate? = nil) {
        self.up = up
        self.lastNoteAt = lastNoteAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        up = try c.decodeIfPresent(Bool.self, forKey: .up) ?? false
        lastNoteAt = try c.decodeIfPresent(FlexibleDate.self, forKey: .lastNoteAt)
    }
}

/// `sessions.lastReply` result: the last thing the session said. `text` is null when
/// the session has not replied yet.
struct LastReply: Codable, Sendable, Equatable {
    var id: String?
    var name: String?
    var engine: String?
    var text: String?
    var line: String?
    var ts: FlexibleDate?

    init(id: String? = nil, name: String? = nil, engine: String? = nil, text: String? = nil,
         line: String? = nil, ts: FlexibleDate? = nil) {
        self.id = id
        self.name = name
        self.engine = engine
        self.text = text
        self.line = line
        self.ts = ts
    }
}

/// A date the server may send as an ISO 8601 string (with or without fractional
/// seconds) or as an epoch number (milliseconds when large, else seconds). Encodes
/// back as an ISO 8601 string.
struct FlexibleDate: Codable, Sendable, Equatable, Hashable, Comparable {
    var date: Date

    init(_ date: Date) { self.date = date }

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let n = try? c.decode(Double.self) {
            date = Date(timeIntervalSince1970: n > 100_000_000_000 ? n / 1000 : n)
            return
        }
        let s = try c.decode(String.self)
        if let d = FlexibleDate.parse(s) {
            date = d
        } else {
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "unparseable date")
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(date.formatted(.iso8601.year().month().day().dateSeparator(.dash)
            .time(includingFractionalSeconds: true).timeSeparator(.colon).timeZone(separator: .omitted)))
    }

    static func parse(_ s: String) -> Date? {
        if let d = try? Date(s, strategy: .iso8601.year().month().day().dateSeparator(.dash)
            .time(includingFractionalSeconds: true).timeSeparator(.colon).timeZone(separator: .omitted)) {
            return d
        }
        if let d = try? Date(s, strategy: .iso8601) { return d }
        return nil
    }

    static func < (a: FlexibleDate, b: FlexibleDate) -> Bool { a.date < b.date }
}

/// Decodes and discards any JSON value (for ops whose result the watch does not need).
struct IgnoredResult: Decodable, Sendable {
    init(from decoder: Decoder) throws {}
    init() {}
}
