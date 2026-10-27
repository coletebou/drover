import Foundation

// Models mirror CONTRACT.md and the server's real responses (~/code/drover/web core/api.js).
// When DroverKit lands with Fixtures/*.json, these are replaced by its types (see Apps/iOS/README.md).

/// The server's local host alias. Ops sent with this host (or none) run on the daemon's own machine.
let localHostName = "local"

/// A session on a specific host: the unit every detail screen, deep link and notification points at.
struct SessionRef: Hashable, Codable, Sendable, Identifiable {
    var id: String
    /// Fleet host alias; nil or "local" means the daemon's own machine.
    var host: String?

    var hostArg: String? { (host == nil || host == localHostName || host?.isEmpty == true) ? nil : host }
    var displayHost: String { hostArg ?? localHostName }
    var key: String { "\(displayHost)/\(id)" }

    static let manager = SessionRef(id: "manager", host: nil)
}

enum Engine: String, Codable, Sendable, CaseIterable {
    case claude, codex, headless, openclaw, grok, unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Engine(rawValue: raw) ?? .unknown
    }

    var label: String {
        switch self {
        case .claude: "Claude"
        case .codex: "Codex"
        case .headless: "Headless"
        case .openclaw: "Manager"
        case .grok: "Grok bot"
        case .unknown: "Agent"
        }
    }
}

/// Board state of a session, the only thing colour is used for.
enum BoardState: String, Codable, Sendable {
    case waiting, working, idle, error, manager
}

extension BoardState {
    var label: String {
        switch self {
        case .waiting: "Waiting on you"
        case .working: "Working"
        case .idle: "Idle"
        case .error: "Error"
        case .manager: "Manager"
        }
    }

    var symbol: String {
        switch self {
        case .waiting: "hand.raised.fill"
        case .working: "gearshape.2.fill"
        case .idle: "moon.zzz.fill"
        case .error: "exclamationmark.triangle.fill"
        case .manager: "person.crop.circle.badge.checkmark"
        }
    }

    /// Maps a sessions.list status string to a board state.
    init(status: String?, engine: Engine = .unknown) {
        if engine == .openclaw { self = .manager; return }
        switch status?.lowercased() ?? "" {
        case "waiting", "dialog", "needs-you", "blocked": self = .waiting
        case "busy", "working", "running", "active", "inprogress": self = .working
        case "error", "failed", "down": self = .error
        default: self = .idle
        }
    }
}

// MARK: native.summary

struct NativeSummary: Codable, Sendable, Hashable {
    var generatedAt: LooseDate?
    var hosts: [HostSummary]
    var waiting: [WaitingItem]
    var working: [WorkingItem]
    var totals: Totals
    var manager: ManagerHealth?

    struct HostSummary: Codable, Sendable, Hashable, Identifiable {
        var name: String
        var up: Bool
        var waiting: Int
        var working: Int
        var idle: Int
        var id: String { name }
    }

    struct WaitingItem: Codable, Sendable, Hashable, Identifiable {
        var id: String
        var name: String?
        var host: String?
        var engine: Engine?
        var since: LooseDate?
        /// decision | question | finished
        var kind: String?
        /// At most 140 chars, no secrets (server guarantees).
        var headline: String?
        /// How it is answered: `keys`, `reply`, or `approval` (a Grok bot's request, answered by its id). New values
        /// are kept as sent.
        var answer: String? = nil
        /// A Grok bot's approval request (`answer` is `approval`); `kind` stays `decision` for older clients.
        var approval: ApprovalRequest? = nil
        /// How many more requests from the same bot wait behind this one.
        var moreApprovals: Int? = nil
        var ref: SessionRef { SessionRef(id: id, host: host) }
        var title: String { name?.isEmpty == false ? name! : id }
        /// The bot's name for "Asked by Alpha, a Grok bot".
        var botName: String? { ApprovalFormat.botName(bot: approval?.bot, fallback: name) }
    }

    struct WorkingItem: Codable, Sendable, Hashable, Identifiable {
        var id: String
        var name: String?
        var host: String?
        var engine: Engine?
        var headline: String?
        var ref: SessionRef { SessionRef(id: id, host: host) }
        var title: String { name?.isEmpty == false ? name! : id }
    }

    struct Totals: Codable, Sendable, Hashable {
        var waiting: Int
        var working: Int
        var idle: Int
        var hosts: Int
    }

    struct ManagerHealth: Codable, Sendable, Hashable {
        var up: Bool?
        var lastNoteAt: LooseDate?
    }
}

extension NativeSummary.WaitingItem {
    /// The fields an older client knew decode as before; the answer fields are new and optional, so a malformed one is
    /// ignored, never fatal to the summary.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name)
        host = try c.decodeIfPresent(String.self, forKey: .host)
        engine = try c.decodeIfPresent(Engine.self, forKey: .engine)
        since = try c.decodeIfPresent(LooseDate.self, forKey: .since)
        kind = try c.decodeIfPresent(String.self, forKey: .kind)
        headline = try c.decodeIfPresent(String.self, forKey: .headline)
        answer = c.lenient(String.self, forKey: .answer)
        approval = c.lenient(ApprovalRequest.self, forKey: .approval)
        moreApprovals = c.lenient(Int.self, forKey: .moreApprovals)
    }
}

// MARK: native.notifications

struct NotificationFeed: Codable, Sendable, Hashable {
    var cursor: LooseString?
    var items: [Item]

    struct Item: Codable, Sendable, Hashable, Identifiable {
        var id: String
        var at: LooseDate?
        /// decision|question|finished|error|mr|launch|manager (tolerate unknown values)
        var kind: String?
        /// The web UI's alert category: needs-you|finished|error|held|mr|launch|manager
        var category: String?
        /// True for `notify.test` alerts.
        var test: Bool?
        var title: String
        var body: String?
        var sessionId: String?
        var host: String?
        /// `approval` for a Grok bot's approval request (answered by its id), as on waiting items.
        var answer: String? = nil
        var approval: ApprovalRequest? = nil
        var ref: SessionRef? { sessionId.map { SessionRef(id: $0, host: host) } }
    }
}

extension NotificationFeed.Item {
    /// As before for the fields an older client knew; the answer fields are optional and a malformed one is ignored.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        at = try c.decodeIfPresent(LooseDate.self, forKey: .at)
        kind = try c.decodeIfPresent(String.self, forKey: .kind)
        category = try c.decodeIfPresent(String.self, forKey: .category)
        test = try c.decodeIfPresent(Bool.self, forKey: .test)
        title = try c.decode(String.self, forKey: .title)
        body = try c.decodeIfPresent(String.self, forKey: .body)
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId)
        host = try c.decodeIfPresent(String.self, forKey: .host)
        answer = c.lenient(String.self, forKey: .answer)
        approval = c.lenient(ApprovalRequest.self, forKey: .approval)
    }
}

// MARK: sessions.list

struct SessionInfo: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var engine: Engine
    var name: String?
    /// busy, idle, waiting, dead, transcript, rollout, ready, down, ... (engine specific)
    var status: String?
    var cwd: String?
    /// tmux target like `native:@95.%100` when the session runs in tmux.
    var tmux: String?
    var live: Bool?
    var startedAt: LooseDate?
    var updatedAt: LooseDate?
    /// Set by the client to the host it was listed from.
    var host: String?

    var ref: SessionRef { SessionRef(id: id, host: host) }
    var title: String { name?.isEmpty == false ? name! : String(id.prefix(8)) }
    var isLive: Bool { live ?? false }

    enum CodingKeys: String, CodingKey {
        case id, engine, name, status, cwd, tmux, live, startedAt, updatedAt, host
    }

    init(id: String, engine: Engine, name: String? = nil, status: String? = nil, cwd: String? = nil,
         tmux: String? = nil, live: Bool? = nil, startedAt: LooseDate? = nil, updatedAt: LooseDate? = nil,
         host: String? = nil) {
        self.id = id; self.engine = engine; self.name = name; self.status = status; self.cwd = cwd
        self.tmux = tmux; self.live = live; self.startedAt = startedAt; self.updatedAt = updatedAt; self.host = host
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(LooseString.self, forKey: .id).value
        engine = c.lenient(Engine.self, forKey: .engine) ?? .unknown
        name = c.lenient(String.self, forKey: .name)
        status = c.lenient(String.self, forKey: .status)
        cwd = c.lenient(String.self, forKey: .cwd)
        tmux = c.lenient(String.self, forKey: .tmux)
        live = c.lenient(Bool.self, forKey: .live)
        startedAt = c.lenient(LooseDate.self, forKey: .startedAt)
        updatedAt = c.lenient(LooseDate.self, forKey: .updatedAt)
        host = c.lenient(String.self, forKey: .host)
    }
}

struct SessionList: Decodable, Sendable {
    var sessions: [SessionInfo]
    var host: String?
}

// MARK: sessions.transcript

struct TranscriptPage: Decodable, Sendable, Hashable {
    var engine: Engine?
    var turns: [Turn]
    /// Opaque cursor for the next incremental read (byte offset for Claude, turn count for others).
    var offset: Int?
    /// True for agents held by the daemon: `turns` is then a rolling full snapshot, never incremental.
    var headless: Bool?

    enum CodingKeys: String, CodingKey { case engine, turns, offset, headless }

    init(engine: Engine?, turns: [Turn], offset: Int?, headless: Bool? = nil) {
        self.engine = engine; self.turns = turns; self.offset = offset; self.headless = headless
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        engine = c.lenient(Engine.self, forKey: .engine)
        // Number the turns so entries without a server uuid (Codex, title, queue) keep distinct ids
        // even when role, time and text repeat ("continue", the same tool command twice).
        turns = (c.lenient([Turn].self, forKey: .turns) ?? []).enumerated().map { i, t in
            var t = t; t.seq = i; return t
        }
        offset = c.lenient(Int.self, forKey: .offset) ?? c.lenient(Double.self, forKey: .offset).map { Int($0) }
        headless = c.lenient(Bool.self, forKey: .headless)
    }
}

struct Turn: Codable, Sendable, Hashable, Identifiable {
    /// user, assistant, tool_result, tool, thinking, title, queue, result
    var role: String
    var ts: LooseDate?
    var uuid: String?
    var text: String?
    var model: String?
    /// Tool calls on an assistant turn, loosely shaped; shown as a compact list of names.
    var tools: [JSONValue]?
    var meta: Bool?
    /// Position in the page it came from (set by `TranscriptPage`, not by the server).
    var seq: Int?

    /// Stable id: the server's uuid when present, else position, role, time and a content hash.
    var id: String { uuid ?? "\(seq ?? -1)-\(role)-\(ts?.date.timeIntervalSince1970 ?? 0)-\(text?.hashValue ?? 0)" }

    enum CodingKeys: String, CodingKey { case role, ts, uuid, text, model, tools, meta }

    init(role: String, ts: LooseDate? = nil, uuid: String? = nil, text: String? = nil, model: String? = nil,
         tools: [JSONValue]? = nil, meta: Bool? = nil) {
        self.role = role; self.ts = ts; self.uuid = uuid; self.text = text; self.model = model
        self.tools = tools; self.meta = meta
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        role = c.lenient(String.self, forKey: .role) ?? "unknown"
        ts = c.lenient(LooseDate.self, forKey: .ts)
        uuid = c.lenient(String.self, forKey: .uuid)
        text = c.lenient(String.self, forKey: .text)
        model = c.lenient(String.self, forKey: .model)
        tools = c.lenient([JSONValue].self, forKey: .tools)
        meta = c.lenient(Bool.self, forKey: .meta)
    }

    var toolNames: [String] {
        (tools ?? []).compactMap { $0["name"]?.string ?? $0.string }
    }
}

// MARK: sessions.lastReply

struct LastReply: Decodable, Sendable, Hashable {
    var id: String?
    var name: String?
    var engine: Engine?
    var text: String?
    var line: String?
    var ts: LooseDate?
}

// MARK: tmux.capture / tmux.send / tmux.keys

struct ScreenCapture: Decodable, Sendable, Hashable {
    var target: String?
    var text: String
    var screen: Screen?

    struct Screen: Decodable, Sendable, Hashable {
        /// dialog | busy | idle | unknown
        var state: String
        var reason: String?
    }
}

struct PaneSendResult: Decodable, Sendable, Hashable {
    var ok: Bool?
    /// True when the server refused because a dialog is on screen (read the pane first).
    var refused: Bool?
    var reason: String?
    var error: String?
}

/// Keys the key-buttons row may send through `tmux.keys` (tmux key names the server accepts).
enum PaneKey: String, CaseIterable, Sendable, Identifiable {
    case enter = "Enter", escape = "Escape", yes = "y", no = "n"
    case one = "1", two = "2", three = "3", up = "Up", down = "Down", tab = "Tab"
    var id: String { rawValue }
    var label: String {
        switch self {
        case .enter: "Enter"
        case .escape: "Esc"
        case .up: "Up"
        case .down: "Down"
        case .tab: "Tab"
        default: rawValue
        }
    }
    var accessibilityLabel: String {
        switch self {
        case .enter: "Press Enter"
        case .escape: "Press Escape"
        case .yes: "Answer yes"
        case .no: "Answer no"
        case .one: "Choose option 1"
        case .two: "Choose option 2"
        case .three: "Choose option 3"
        case .up: "Arrow up"
        case .down: "Arrow down"
        case .tab: "Press Tab"
        }
    }
}

// MARK: sessions.message / uploads.put

struct MessageResult: Decodable, Sendable, Hashable {
    var ok: Bool?
    /// True when the session was busy and the message waits for the current turn.
    var queuedBehindTurn: Bool?
    /// The manager's reply when id is "manager".
    var reply: String?
    var error: String?

    enum CodingKeys: String, CodingKey { case ok, queuedBehindTurn, reply, error, delivery }

    init(ok: Bool? = true, queuedBehindTurn: Bool? = nil, reply: String? = nil, error: String? = nil) {
        self.ok = ok; self.queuedBehindTurn = queuedBehindTurn; self.reply = reply; self.error = error
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let delivery = c.lenient(JSONValue.self, forKey: .delivery)
        ok = c.lenient(Bool.self, forKey: .ok) ?? delivery?["ok"]?.bool
        queuedBehindTurn = c.lenient(Bool.self, forKey: .queuedBehindTurn) ?? delivery?["queuedBehindTurn"]?.bool
        reply = c.lenient(String.self, forKey: .reply) ?? delivery?["reply"]?.string
        error = c.lenient(String.self, forKey: .error) ?? delivery?["error"]?.string
    }
}

struct UploadResult: Decodable, Sendable, Hashable {
    /// Absolute path on the session's host; put it in the message so the agent can Read it.
    var path: String
    var size: Int?
}

// MARK: SSE

struct ServerEvent: Sendable, Hashable {
    /// mutation, notify, snapshot, fleet, probe, hello, or anything new (tolerate unknown).
    var name: String
    var data: String
}
