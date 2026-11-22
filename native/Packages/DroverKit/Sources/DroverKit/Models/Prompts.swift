import Foundation

// The prompt spool (CONTRACT.md "Ops added 2026-11-21", docs/specs/2026-11-21-cohesion-overhaul.md "Prompts: the
// spool"): every prompt typed into Claude Code or Codex, fleet-wide, verbatim (secrets redacted by the daemon).
// Decoding is tolerant: unknown fields are ignored, every field but `id`, `ts` and `text` is optional, and a record
// that does not decode is dropped from its page instead of failing the page.

/// Where a turn came from (`via`). Open: unknown values decode as themselves.
public struct PromptVia: RawRepresentable, Sendable, Hashable, Codable, CustomStringConvertible {
    public var rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ raw: String) { self.rawValue = raw }
    public init(from decoder: any Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: any Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(rawValue) }
    public var description: String { rawValue }

    /// A person at the agent.
    public static let typed = PromptVia("typed")
    /// Typed while a turn ran.
    public static let queued = PromptVia("queued")
    /// Another session's message (`from` names it).
    public static let peer = PromptVia("peer")
    /// Sent through Drover (`sessions.message`, `tmux.send`).
    public static let drover = PromptVia("drover")
    /// The owner's message to the fleet manager (engine "openclaw", session "manager").
    public static let manager = PromptVia("manager")
    /// An agent's own `drover_send` (as opposed to `.peer`, another session's own message).
    public static let agent = PromptVia("agent")
    /// The first prompt of a headless launch.
    public static let headless = PromptVia("headless")
    /// A program's run (`claude -p`, the Agent SDK, `codex exec`) that no Drover launch started.
    public static let sdk = PromptVia("sdk")

    /// What a human actually typed, before marks: into a session, tmux, Drover, or the fleet manager. What
    /// `who: mine` defaults to for a record with no mark of its own (the daemon's rule; records carry their own
    /// `mine`/`marked` once a mark decides it).
    public static let mine: [PromptVia] = [.typed, .queued, .drover, .manager]

    /// A short label for a row ("" for typed, the common case).
    public var label: String {
        switch rawValue {
        case "typed": ""
        case "queued": "queued"
        case "drover": "via Drover"
        case "headless": "launch"
        case "peer": "from an agent"
        case "agent": "via drover_send"
        case "manager": "to manager"
        case "sdk": "program"
        default: rawValue
        }
    }
}

/// One prompt (`prompts.list` `prompts[]`).
public struct PromptRecord: Sendable, Hashable, Codable, Identifiable {
    /// Record version (1).
    public var v: Int?
    /// `p_` + 16 hex: the same turn collected twice is one record.
    public var id: String
    public var ts: DroverTimestamp
    /// The machine's own short name (not an op alias: use `route` for ops).
    public var host: String
    public var engine: Engine
    /// The session (Claude) or thread (Codex) id; nil when unknown.
    public var session: String?
    /// The working directory, `~`-relative where it is under the home.
    public var cwd: String?
    public var project: String?
    /// `work`, `personal`, `default`, or any string from the prompts config.
    public var label: String?
    public var via: PromptVia?
    /// The prompt, verbatim. Show it as plain text, never as markup.
    public var text: String
    /// For `via: peer`: the sending session's name.
    public var from: String?
    /// The `host` arg for other ops (`local` for the daemon's machine); nil when no alias is known.
    public var route: String?
    /// `sink:<name>`: read from a git sink's clone because its host did not answer.
    public var source: String?
    /// Whether this is "mine" after any mark: a person's mark when `marked`, else the daemon's via default.
    public var mine: Bool?
    /// True when a person's mark decided `mine` (`prompts.mark`), rather than the via default.
    public var marked: Bool?
    /// Who set the mark, when `marked`.
    public var actor: String?

    public init(v: Int? = 1, id: String, ts: DroverTimestamp, host: String, engine: Engine, session: String? = nil, cwd: String? = nil,
                project: String? = nil, label: String? = nil, via: PromptVia? = nil, text: String, from: String? = nil,
                route: String? = nil, source: String? = nil, mine: Bool? = nil, marked: Bool? = nil, actor: String? = nil) {
        self.v = v; self.id = id; self.ts = ts; self.host = host; self.engine = engine; self.session = session; self.cwd = cwd
        self.project = project; self.label = label; self.via = via; self.text = text; self.from = from; self.route = route; self.source = source
        self.mine = mine; self.marked = marked; self.actor = actor
    }

    private enum CodingKeys: String, CodingKey { case v, id, ts, host, engine, session, cwd, project, label, via, text, from, route, source, mine, marked, actor }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        v = try? c.decodeIfPresent(Int.self, forKey: .v)
        id = try c.decode(String.self, forKey: .id)
        ts = try c.decode(DroverTimestamp.self, forKey: .ts)
        text = try c.decode(String.self, forKey: .text)
        host = (try? c.decodeIfPresent(String.self, forKey: .host)) ?? ""
        engine = (try? c.decodeIfPresent(Engine.self, forKey: .engine)) ?? Engine("unknown")
        session = Self.string(c, .session)
        cwd = Self.string(c, .cwd)
        project = Self.string(c, .project)
        label = Self.string(c, .label)
        via = try? c.decodeIfPresent(PromptVia.self, forKey: .via)
        from = Self.string(c, .from)
        // A route is a host alias string; anything else (null, an older daemon's object) means "no alias".
        route = Self.string(c, .route)
        source = Self.string(c, .source)
        mine = try? c.decodeIfPresent(Bool.self, forKey: .mine)
        marked = try? c.decodeIfPresent(Bool.self, forKey: .marked)
        actor = Self.string(c, .actor)
    }

    private static func string(_ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> String? {
        guard let s = try? c.decodeIfPresent(String.self, forKey: key), !s.isEmpty else { return nil }
        return s
    }

    /// The `host` arg to open this prompt's session with: `route`, else the record's own host.
    public var opHost: String { route ?? (host.isEmpty ? "local" : host) }

    /// The first non-blank line, cut to `max` characters (a one-line preview).
    public func firstLine(max: Int = 160) -> String {
        let line = text.split(separator: "\n", omittingEmptySubsequences: true)
            .first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.map(String.init) ?? ""
        let t = line.trimmingCharacters(in: .whitespaces)
        return t.count > max ? String(t.prefix(max - 1)) + "…" : t
    }
}

/// `prompts.list` result.
public struct PromptsList: Sendable, Hashable, Codable {
    public var ms: Double?
    /// Newest first, merged by id across hosts.
    public var prompts: [PromptRecord]
    /// There may be matches past this page: ask again with `before` = the last id.
    public var more: Bool
    public var perHost: [HostResult]
    public var coverage: Coverage?
    /// Every match, when every host read every day file (first pages only).
    public var total: Int?

    public init(ms: Double? = nil, prompts: [PromptRecord], more: Bool = false, perHost: [HostResult] = [], coverage: Coverage? = nil, total: Int? = nil) {
        self.ms = ms; self.prompts = prompts; self.more = more; self.perHost = perHost; self.coverage = coverage; self.total = total
    }

    private enum CodingKeys: String, CodingKey { case ms, prompts, more, perHost, coverage, total }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ms = try? c.decodeIfPresent(Double.self, forKey: .ms)
        prompts = (try c.decodeIfPresent([Lossy<PromptRecord>].self, forKey: .prompts) ?? []).compactMap(\.value)
        more = (try? c.decodeIfPresent(Bool.self, forKey: .more)) ?? false
        perHost = ((try? c.decodeIfPresent([Lossy<HostResult>].self, forKey: .perHost)) ?? []).compactMap(\.value)
        coverage = try? c.decodeIfPresent(Coverage.self, forKey: .coverage)
        total = (try? c.decodeIfPresent(Double.self, forKey: .total)).map { Int($0) }
    }

    /// One host's answer: `ok: false` with `error` when it did not answer, `source: sink:<name>` when its records
    /// came from a sink clone.
    public struct HostResult: Sendable, Hashable, Codable, Identifiable {
        public var host: String
        public var ok: Bool
        public var count: Int?
        public var ms: Double?
        public var error: String?
        public var source: String?
        public var more: Bool?
        public var id: String { host + "|" + (source ?? "") }
        public init(host: String, ok: Bool, count: Int? = nil, ms: Double? = nil, error: String? = nil, source: String? = nil, more: Bool? = nil) {
            self.host = host; self.ok = ok; self.count = count; self.ms = ms; self.error = error; self.source = source; self.more = more
        }
    }

    public struct Coverage: Sendable, Hashable, Codable {
        public var searched: [String]
        public var notCovered: [Gap]
        public var partial: [Gap]
        public init(searched: [String] = [], notCovered: [Gap] = [], partial: [Gap] = []) {
            self.searched = searched; self.notCovered = notCovered; self.partial = partial
        }
        private enum CodingKeys: String, CodingKey { case searched, notCovered, partial }
        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            searched = (try? c.decodeIfPresent([String].self, forKey: .searched)) ?? []
            notCovered = ((try? c.decodeIfPresent([Lossy<Gap>].self, forKey: .notCovered)) ?? []).compactMap(\.value)
            partial = ((try? c.decodeIfPresent([Lossy<Gap>].self, forKey: .partial)) ?? []).compactMap(\.value)
        }
        public struct Gap: Sendable, Hashable, Codable {
            public var host: String
            public var reason: String?
            public init(host: String, reason: String? = nil) { self.host = host; self.reason = reason }
        }
    }

    /// Hosts that did not answer (their prompts, if any, come from a sink clone).
    public var downHosts: [HostResult] { perHost.filter { !$0.ok && $0.source == nil } }
}

/// `prompts.status` result: the spool on one machine.
public struct PromptsStatus: Sendable, Hashable, Codable {
    public var host: String?
    public var enabled: Bool?
    /// Day files in the spool.
    public var files: Int?
    public var records: Int?
    public var oldest: DroverTimestamp?
    public var newest: DroverTimestamp?
    public var lastScan: DroverTimestamp?
    public var lastMs: Double?
    public var lastError: String?
    public var scanning: Bool?
    /// Transcript files it follows.
    public var sources: Int?
    public var config: Config?
    public var sinks: [Sink]

    public init(host: String? = nil, enabled: Bool? = nil, files: Int? = nil, records: Int? = nil, oldest: DroverTimestamp? = nil,
                newest: DroverTimestamp? = nil, lastScan: DroverTimestamp? = nil, lastMs: Double? = nil, lastError: String? = nil,
                scanning: Bool? = nil, sources: Int? = nil, config: Config? = nil, sinks: [Sink] = []) {
        self.host = host; self.enabled = enabled; self.files = files; self.records = records; self.oldest = oldest; self.newest = newest
        self.lastScan = lastScan; self.lastMs = lastMs; self.lastError = lastError; self.scanning = scanning; self.sources = sources
        self.config = config; self.sinks = sinks
    }

    private enum CodingKeys: String, CodingKey { case host, enabled, files, records, oldest, newest, lastScan, lastMs, lastError, scanning, sources, config, sinks }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        host = try? c.decodeIfPresent(String.self, forKey: .host)
        enabled = try? c.decodeIfPresent(Bool.self, forKey: .enabled)
        files = (try? c.decodeIfPresent(Double.self, forKey: .files)).map { Int($0) }
        records = (try? c.decodeIfPresent(Double.self, forKey: .records)).map { Int($0) }
        oldest = try? c.decodeIfPresent(DroverTimestamp.self, forKey: .oldest)
        newest = try? c.decodeIfPresent(DroverTimestamp.self, forKey: .newest)
        lastScan = try? c.decodeIfPresent(DroverTimestamp.self, forKey: .lastScan)
        lastMs = try? c.decodeIfPresent(Double.self, forKey: .lastMs)
        lastError = try? c.decodeIfPresent(String.self, forKey: .lastError)
        scanning = try? c.decodeIfPresent(Bool.self, forKey: .scanning)
        sources = (try? c.decodeIfPresent(Double.self, forKey: .sources)).map { Int($0) }
        config = try? c.decodeIfPresent(Config.self, forKey: .config)
        sinks = ((try? c.decodeIfPresent([Lossy<Sink>].self, forKey: .sinks)) ?? []).compactMap(\.value)
    }

    /// The prompts config file (`~/.config/drover/prompts.json`): where, whether it exists, what is wrong in it.
    public struct Config: Sendable, Hashable, Codable {
        public var file: String?
        public var found: Bool?
        public var errors: [String]
        public init(file: String? = nil, found: Bool? = nil, errors: [String] = []) { self.file = file; self.found = found; self.errors = errors }
        private enum CodingKeys: String, CodingKey { case file, found, errors }
        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            file = try? c.decodeIfPresent(String.self, forKey: .file)
            found = try? c.decodeIfPresent(Bool.self, forKey: .found)
            errors = ((try? c.decodeIfPresent([JSONValue].self, forKey: .errors)) ?? []).compactMap { $0.stringValue }
        }
    }

    /// A git or command sink and how its syncs went.
    public struct Sink: Sendable, Hashable, Codable, Identifiable {
        public var name: String
        public var type: String?
        public var labels: [String]?
        public var lastSync: DroverTimestamp?
        public var lastAttempt: DroverTimestamp?
        public var lastError: String?
        public var nextAttempt: DroverTimestamp?
        public var failures: Int?
        /// Records not delivered yet.
        public var pending: Int?
        public var id: String { name }
        public init(name: String, type: String? = nil, labels: [String]? = nil, lastSync: DroverTimestamp? = nil, lastAttempt: DroverTimestamp? = nil,
                    lastError: String? = nil, nextAttempt: DroverTimestamp? = nil, failures: Int? = nil, pending: Int? = nil) {
            self.name = name; self.type = type; self.labels = labels; self.lastSync = lastSync; self.lastAttempt = lastAttempt
            self.lastError = lastError; self.nextAttempt = nextAttempt; self.failures = failures; self.pending = pending
        }
    }

    /// "1,204 prompts, newest 3m ago; personal synced 4m ago, work: push failed" (the web UI's status line).
    public func line(now: Date = Date()) -> String {
        let n = records ?? 0
        var first = "\(Self.grouped(n)) prompt\(n == 1 ? "" : "s")"
        if let newest { first += ", newest \(Self.ago(newest.date, now: now)) ago" }
        if scanning == true { first += ", scanning" }
        let parts = sinks.map { s -> String in
            if let e = s.lastError { return "\(s.name): \(e)" }
            if let at = s.lastSync { return "\(s.name) synced \(Self.ago(at.date, now: now)) ago" + ((s.pending ?? 0) > 0 ? " (\(s.pending!) to push)" : "") }
            return "\(s.name) not synced yet"
        }
        return first + "; " + (parts.isEmpty ? "local spool only" : parts.joined(separator: ", "))
    }

    /// 1204 -> "1,204" (no locale lookup: the same on every platform).
    public static func grouped(_ n: Int) -> String {
        let digits = String(abs(n))
        var out = ""
        for (i, ch) in digits.enumerated() {
            if i > 0 && (digits.count - i) % 3 == 0 { out.append(",") }
            out.append(ch)
        }
        return (n < 0 ? "-" : "") + out
    }

    /// "now", "4m", "3h", "2d".
    public static func ago(_ date: Date, now: Date = Date()) -> String {
        let s = max(0, Int(now.timeIntervalSince(date).rounded()))
        if s < 45 { return "now" }
        if s < 3600 { return "\(Int((Double(s) / 60).rounded()))m" }
        if s < 86_400 { return "\(Int((Double(s) / 3600).rounded()))h" }
        return "\(Int((Double(s) / 86_400).rounded()))d"
    }
}

/// `prompts.sync` result: the scan it ran, then each sink's push.
public struct PromptsSyncResult: Sendable, Hashable, Codable {
    public var host: String?
    /// Transcript files read.
    public var scanned: Int?
    /// New prompts the scan found.
    public var added: Int?
    public var sinks: [Sink]
    public var ms: Double?

    public init(host: String? = nil, scanned: Int? = nil, added: Int? = nil, sinks: [Sink] = [], ms: Double? = nil) {
        self.host = host; self.scanned = scanned; self.added = added; self.sinks = sinks; self.ms = ms
    }

    private enum CodingKeys: String, CodingKey { case host, scanned, added, sinks, ms }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        host = try? c.decodeIfPresent(String.self, forKey: .host)
        scanned = (try? c.decodeIfPresent(Double.self, forKey: .scanned)).map { Int($0) }
        added = (try? c.decodeIfPresent(Double.self, forKey: .added)).map { Int($0) }
        sinks = ((try? c.decodeIfPresent([Lossy<Sink>].self, forKey: .sinks)) ?? []).compactMap(\.value)
        ms = try? c.decodeIfPresent(Double.self, forKey: .ms)
    }

    public struct Sink: Sendable, Hashable, Codable, Identifiable {
        public var name: String
        public var type: String?
        public var ok: Bool
        public var added: Int?
        public var pushed: Bool?
        public var runs: Int?
        public var error: String?
        public var ms: Double?
        public var id: String { name }
        public init(name: String, type: String? = nil, ok: Bool, added: Int? = nil, pushed: Bool? = nil, runs: Int? = nil, error: String? = nil, ms: Double? = nil) {
            self.name = name; self.type = type; self.ok = ok; self.added = added; self.pushed = pushed; self.runs = runs; self.error = error; self.ms = ms
        }
        private enum CodingKeys: String, CodingKey { case name, type, ok, added, pushed, runs, error, ms }
        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            name = try c.decode(String.self, forKey: .name)
            type = try? c.decodeIfPresent(String.self, forKey: .type)
            ok = (try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? false
            added = (try? c.decodeIfPresent(Double.self, forKey: .added)).map { Int($0) }
            // `pushed` is a flag on git sinks; a count would be tolerated as "something went".
            if let b = try? c.decodeIfPresent(Bool.self, forKey: .pushed) { pushed = b }
            else if let n = try? c.decodeIfPresent(Double.self, forKey: .pushed) { pushed = n > 0 }
            else { pushed = nil }
            runs = (try? c.decodeIfPresent(Double.self, forKey: .runs)).map { Int($0) }
            error = try? c.decodeIfPresent(String.self, forKey: .error)
            ms = try? c.decodeIfPresent(Double.self, forKey: .ms)
        }
    }

    /// "Scanned 12, added 3 prompts" plus each failed sink ("; work: push failed").
    public var summary: String {
        let a = added ?? 0
        var s = "Scanned \(scanned ?? 0), added \(a) prompt\(a == 1 ? "" : "s")"
        let bad = sinks.filter { !$0.ok }
        if !bad.isEmpty { s += "; " + bad.map { "\($0.name): \($0.error ?? "failed")" }.joined(separator: ", ") }
        return s
    }
}

/// What to ask `prompts.list` for. Empty filters are left out; `.mine` leaves `who` to the daemon's default.
public struct PromptsQuery: Sendable, Hashable, Encodable {
    /// `who`: what a person actually typed (`mine`, the default), a slice of that, or everything (`all`).
    public enum Scope: String, Sendable, Hashable, CaseIterable, Codable, Identifiable {
        /// What the owner (or Drover, for them) actually typed into a session, tmux, or Drover: the daemon's default.
        case mine
        /// The owner's own messages to the fleet manager (`via: manager`).
        case manager
        /// Another session's message, or an agent's own `drover_send` (`via: peer` or `agent`).
        case agents
        /// A headless launch's first prompt, or a program's own run (`via: headless` or `sdk`).
        case programs
        /// Everything not marked mine.
        case notMine = "not-mine"
        /// Every record, no filter.
        case all

        public var id: String { rawValue }

        /// A picker label ("Mine", "Not mine", ...).
        public var title: String {
            switch self {
            case .mine: "Mine"
            case .manager: "Manager"
            case .agents: "Agents"
            case .programs: "Programs"
            case .notMine: "Not mine"
            case .all: "All"
            }
        }
    }

    public var scope: Scope
    /// Words, every one must be in the prompt (any case).
    public var q: String?
    public var host: String?
    public var engine: String?
    public var label: String?
    /// A prompt id: the page after it.
    public var before: String?
    /// Default 200, at most 2000.
    public var limit: Int?

    public static let pageSize = 200

    public init(scope: Scope = .mine, q: String? = nil, host: String? = nil, engine: String? = nil, label: String? = nil,
                before: String? = nil, limit: Int? = PromptsQuery.pageSize) {
        self.scope = scope; self.q = q; self.host = host; self.engine = engine; self.label = label; self.before = before; self.limit = limit
    }

    /// The op arguments.
    public var arguments: [String: JSONValue] {
        var a: [String: JSONValue] = [:]
        func put(_ k: String, _ v: String?) {
            if let t = v?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty { a[k] = .string(t) }
        }
        put("q", q); put("host", host); put("engine", engine); put("label", label); put("before", before)
        if let limit { a["limit"] = .number(Double(min(max(limit, 1), 2000))) }
        // Mine is the daemon's default: send who only when asking for something else.
        if scope != .mine { a["who"] = .string(scope.rawValue) }
        return a
    }

    /// The same query, one page further (`before` = the last record of the page shown).
    public func after(_ last: PromptRecord?) -> PromptsQuery {
        var n = self; n.before = last?.id; return n
    }

    public func encode(to encoder: any Encoder) throws { try JSONValue.object(arguments).encode(to: encoder) }
}

/// `prompts.mark` result: the ids changed, the mark applied (`nil` means cleared), and the event it wrote.
public struct PromptsMarkResult: Sendable, Hashable, Codable {
    public var ok: Bool?
    public var ids: [String]
    public var mine: Bool?
    public var event: String?

    public init(ok: Bool? = nil, ids: [String] = [], mine: Bool? = nil, event: String? = nil) {
        self.ok = ok; self.ids = ids; self.mine = mine; self.event = event
    }

    private enum CodingKeys: String, CodingKey { case ok, ids, mine, event }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try? c.decodeIfPresent(Bool.self, forKey: .ok)
        ids = (try? c.decodeIfPresent([String].self, forKey: .ids)) ?? []
        mine = try? c.decodeIfPresent(Bool.self, forKey: .mine)
        event = try? c.decodeIfPresent(String.self, forKey: .event)
    }
}

/// Paging and live refreshes overlap: records by id, newest first (ties by id, as the web UI sorts them).
public enum PromptsMerge {
    public static func merge(_ lists: [PromptRecord]...) -> [PromptRecord] {
        var seen = Set<String>(), out: [PromptRecord] = []
        for l in lists { for p in l where seen.insert(p.id).inserted { out.append(p) } }
        return out.sorted { a, b in a.ts == b.ts ? a.id > b.id : a.ts > b.ts }
    }
}

/// Decodes `T`, or nil when the element does not match (so one odd record never fails a page).
struct Lossy<T: Decodable & Sendable>: Decodable, Sendable {
    let value: T?
    init(from decoder: any Decoder) throws { value = try? T(from: decoder) }
}
