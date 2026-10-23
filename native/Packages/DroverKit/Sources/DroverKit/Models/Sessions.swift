import Foundation

/// `sessions.list`.
public struct SessionList: Sendable, Hashable, Codable {
    public var host: String?
    public var codexError: String?
    public var sessions: [SessionInfo]
    public init(host: String?, codexError: String? = nil, sessions: [SessionInfo]) { self.host = host; self.codexError = codexError; self.sessions = sessions }
}

/// One Claude session, Codex thread, headless agent or the OpenClaw manager. Shapes differ per engine;
/// every field but `id` and `engine` is optional.
public struct SessionInfo: Sendable, Hashable, Codable, Identifiable {
    public var id: String
    public var engine: Engine
    /// `interactive`, `headless`, ... (engine specific).
    public var kind: String?
    public var name: String?
    /// `idle`, `busy`, `blocked`, `active`, `notLoaded`, `exited`, `transcript`, ...
    public var status: String?
    public var live: Bool?
    public var cwd: String?
    /// Claude registry form `session:@window.%pane`.
    public var tmux: String?
    public var model: String?
    public var startedAt: DroverTimestamp?
    public var createdAt: DroverTimestamp?
    public var updatedAt: DroverTimestamp?
    public var statusUpdatedAt: DroverTimestamp?

    public init(id: String, engine: Engine, kind: String? = nil, name: String? = nil, status: String? = nil, live: Bool? = nil, cwd: String? = nil, tmux: String? = nil, model: String? = nil, startedAt: DroverTimestamp? = nil, createdAt: DroverTimestamp? = nil, updatedAt: DroverTimestamp? = nil, statusUpdatedAt: DroverTimestamp? = nil) {
        self.id = id; self.engine = engine; self.kind = kind; self.name = name; self.status = status; self.live = live; self.cwd = cwd; self.tmux = tmux; self.model = model
        self.startedAt = startedAt; self.createdAt = createdAt; self.updatedAt = updatedAt; self.statusUpdatedAt = statusUpdatedAt
    }

    public var isLive: Bool { live ?? false }
    public var displayName: String { name?.isEmpty == false ? name! : String(id.prefix(8)) }
    /// The tmux window target (`session:@window`) for `tmux.capture` / `tmux.send`, from the registry form.
    public var tmuxWindow: String? {
        guard let t = tmux else { return nil }
        if let dot = t.range(of: ".%") { return String(t[..<dot.lowerBound]) }
        return t
    }
}

/// `sessions.transcript`.
public struct Transcript: Sendable, Hashable, Codable {
    public var engine: Engine?
    /// Byte offset: pass back as `since` for incremental reads.
    public var offset: Int?
    public var exists: Bool?
    public var turns: [Turn]
    public var summary: Summary?

    public init(engine: Engine? = nil, offset: Int? = nil, exists: Bool? = nil, turns: [Turn], summary: Summary? = nil) {
        self.engine = engine; self.offset = offset; self.exists = exists; self.turns = turns; self.summary = summary
    }

    public struct Summary: Sendable, Hashable, Codable {
        public var title: String?
        public var firstPrompt: String?
        public var lastReply: String?
        public var lastTs: DroverTimestamp?
    }

    public struct Turn: Sendable, Hashable, Codable {
        public var role: TurnRole
        public var ts: DroverTimestamp?
        public var uuid: String?
        public var text: String?
        public var tools: [ToolUse]?
        public var model: String?
        /// Number of tool results folded into a `tool_result` turn.
        public var count: Int?
        /// A meta (system-injected) user turn.
        public var meta: Bool?

        public init(role: TurnRole, ts: DroverTimestamp? = nil, uuid: String? = nil, text: String? = nil, tools: [ToolUse]? = nil, model: String? = nil, count: Int? = nil, meta: Bool? = nil) {
            self.role = role; self.ts = ts; self.uuid = uuid; self.text = text; self.tools = tools; self.model = model; self.count = count; self.meta = meta
        }
    }

    public struct ToolUse: Sendable, Hashable, Codable {
        public var name: String
        public init(name: String) { self.name = name }
    }
}

/// `sessions.message` result.
public struct MessageDelivery: Sendable, Hashable, Codable {
    public var ok: Bool
    public var via: String?
    public var queuedBehindTurn: Bool?
    /// Truth-file event id of the recorded message.
    public var event: String?
    public var error: String?
    public var reply: String?
    public var session: SessionRef?

    public struct SessionRef: Sendable, Hashable, Codable {
        public var id: String?
        public var name: String?
        public var status: String?
    }
}

/// `tmux.capture` result.
public struct PaneCapture: Sendable, Hashable, Codable {
    public var target: String
    public var text: String
    public var screen: Screen?

    public struct Screen: Sendable, Hashable, Codable {
        /// `idle`, `busy`, `dialog`, `unknown`, ...
        public var state: String
        public var reason: String?
    }
}

/// `tmux.send` / `tmux.keys` result. `refused` means a dialog is on screen (read the pane first).
public struct PaneSendResult: Sendable, Hashable, Codable {
    public var ok: Bool
    public var refused: Bool?
    public var reason: String?
    public var target: String?
    /// Last lines of the pane when refused.
    public var preview: String?
    /// Screen hash (`tmux.answer` passes it back as `expect`).
    public var hash: String?
    public var screen: PaneCapture.Screen?
}

/// `host.list` entry.
public struct HostEntry: Sendable, Hashable, Codable, Identifiable {
    public var name: String
    public var display: String?
    public var source: String?
    public var inSshConfig: Bool?
    public var id: String { name }
}
