import Foundation

// App-level models. These are what views see. The adapter in LiveDroverService maps daemon JSON (and, once
// merged, DroverKit types) into them, so views never depend on wire shapes.

/// The three board strips, in display order.
enum Lane: String, CaseIterable, Identifiable, Sendable {
    case waiting, working, idle
    var id: String { rawValue }
    var title: String {
        switch self {
        case .waiting: "Waiting on you"
        case .working: "Working"
        case .idle: "Idle"
        }
    }
}

/// Why a session is waiting (CONTRACT.md `native.summary.waiting[].kind`).
enum WaitKind: String, Sendable, Hashable {
    case decision, question, finished
    var label: String {
        switch self {
        case .decision: "needs a decision"
        case .question: "asked a question"
        case .finished: "finished"
        }
    }
}

/// One option of an on-screen dialog (`dialog.options[]`, labels already cleaned by the daemon).
struct DialogOption: Hashable, Sendable {
    var n: Int
    var label: String
    var selected = false
}

/// The question and options a session's pane shows (ux spec "Dialog fields").
struct DialogInfo: Hashable, Sendable {
    var question: String?
    var options: [DialogOption]
}

/// How a waiting session is answered: press one of its `keys`, or reply with a message (a question asked in text).
enum AnswerMode: String, Sendable, Hashable {
    case keys, reply
}

/// A recent "finished" alert shown on an idle strip.
struct FinishedNote: Hashable, Sendable {
    var text: String
    var at: Date?
}

struct SessionItem: Identifiable, Hashable, Sendable {
    /// Session id, Codex thread id, "manager", or a tmux window target for an agent seen only as a window.
    var id: String
    var name: String
    /// Fleet host alias as the daemon reports it (local host included).
    var host: String
    /// claude, codex, hermes, headless, openclaw, grok, or whatever the server sends.
    var engine: String
    /// Raw server status (busy, idle, blocked, ...).
    var status: String
    var cwd: String?
    /// tmux target like `work:3`, nil when the session has no pane.
    var tmuxTarget: String?
    var live: Bool
    var updatedAt: Date?
    var lane: Lane
    var waitKind: WaitKind?
    /// At most 140 chars, safe to show.
    var headline: String?
    /// An agent seen only as a tmux window (no session record): no transcript, no inbox. Use the pane.
    var windowOnly: Bool = false
    /// The session behind a window strip (`sessionId`), when it differs from `id`.
    var sessionId: String? = nil
    /// The pane's classification (idle, busy, dialog) when the board knows it.
    var screen: ScreenState = .unknown
    /// The dialog on screen, its screen hash (pass back as `expect`), and the keys it takes, in display order.
    var dialog: DialogInfo? = nil
    var hash: String? = nil
    var keys: [String] = []
    var answerMode: AnswerMode? = nil
    /// A peer message held on screen (deliver with Enter, drop with Escape).
    var held = false
    var heldFrom: String? = nil
    /// What the session asked (`ask.label`, `ask.text`).
    var askLabel: String? = nil
    var askText: String? = nil
    /// Last meaningful pane lines (board strip `tail`).
    var tail: [String] = []
    var finished: FinishedNote? = nil
    var windowName: String? = nil

    /// Stable key across hosts (ids can collide between machines).
    var key: String { "\(host)|\(id)" }
    var isManager: Bool { engine == "openclaw" || id == "manager" }
    /// The id transcript, message and follow calls use (a window strip's session, else `id`).
    var transcriptId: String { sessionId ?? id }
    /// A dialog or held message is up and answers to keys (the answer card and the board buttons show).
    var answersWithKeys: Bool {
        if answerMode == .reply { return false }
        return !keys.isEmpty || dialog != nil || held
    }
    /// Working right now (the chat's "working" line).
    var isWorking: Bool { lane == .working || status == "busy" }
}

struct HostItem: Identifiable, Hashable, Sendable {
    var name: String
    var up: Bool
    var waiting: Int
    var working: Int
    var idle: Int
    var error: String?
    var stale: Bool = false
    var id: String { name }
}

/// The fleet manager (native.board `manager`, native.summary `manager`).
struct ManagerInfo: Hashable, Sendable {
    var up: Bool
    /// The host that runs it, when the daemon says (nil: this one, or unknown).
    var host: String?
    var lastNoteAt: Date?

    static let unknown = ManagerInfo(up: false, host: nil, lastNoteAt: nil)
}

/// Where a board came from: the compact `native.board`, or the fleet.summary + native.summary fallback.
enum BoardSource: String, Sendable {
    case board, fleet, mock
}

struct BoardSnapshot: Sendable, Equatable {
    var generatedAt: Date
    var hosts: [HostItem]
    var sessions: [SessionItem]
    /// True when the daemon's `native.summary` op supplied waiting kinds and headlines.
    var usedNativeSummary: Bool
    /// Raw `native.summary` result bytes, handed to widgets via the App Group (CONTRACT.md widget handoff).
    var nativeSummaryJSON: Data? = nil
    var manager: ManagerInfo = .unknown
    var source: BoardSource = .fleet

    static let empty = BoardSnapshot(generatedAt: .distantPast, hosts: [], sessions: [], usedNativeSummary: false)

    func sessions(in lane: Lane, host: String? = nil) -> [SessionItem] {
        sessions.filter { $0.lane == lane && (host == nil || $0.host == host) }
    }

    /// Same board apart from when it was generated: assigning it would only make views redraw.
    func sameContent(as other: BoardSnapshot) -> Bool {
        hosts == other.hosts && sessions == other.sessions && manager == other.manager && source == other.source
            && usedNativeSummary == other.usedNativeSummary
    }
}

enum TurnRole: String, Sendable, Hashable {
    case user, assistant, toolResult = "tool_result", thinking, title, queue, system, other
}

/// One tool call of an assistant turn (`tools[]`: `{ id, name, input, summary }`).
struct ToolCall: Hashable, Sendable {
    /// `tool_use` id; results carry it as `toolUseId`. nil on daemons that predate it.
    var id: String?
    var name: String
    /// One plain line: the command, the path, the pattern. Computed here when the daemon sends none.
    var summary: String
    /// Compact input JSON, for "show all" when the summary is not enough.
    var input: String?
    /// Bash's own one-line purpose ("Run the unit tests"), when the agent gave one.
    var description: String? = nil
}

/// One tool result (`tool_result` turn `results[]`: `{ toolUseId, isError, text }`).
struct ToolResult: Hashable, Sendable {
    var toolUseId: String?
    var isError: Bool
    /// The output, at most 2000 chars from the daemon.
    var text: String
    /// The output's full length, when the daemon cut it.
    var chars: Int? = nil
}

struct TranscriptTurn: Identifiable, Hashable, Sendable {
    var id: String
    var role: TurnRole
    var text: String
    var ts: Date?
    /// Tool calls of an assistant turn.
    var tools: [ToolCall]
    /// Harness/meta user turns (hidden by default).
    var meta: Bool
    /// Results of a `tool_result` turn.
    var results: [ToolResult] = []
    /// Who sent a user turn when it was not the owner (`mcp`, a bot, another session).
    var actor: String? = nil
    /// A manager reply still in flight (the text so far), or a message not yet confirmed by the daemon.
    var pending = false
    /// The message a manager reply answers (its event id).
    var inReplyTo: String? = nil
    /// Manager conversation name (`main` by default).
    var thread: String? = nil
    /// The turn failed (a manager reply that errored, a message that was not delivered).
    var failed = false
}

struct TranscriptPage: Sendable {
    var turns: [TranscriptTurn]
    /// Pass back as `since` for the next incremental read. nil when the engine has no offsets.
    var offset: Int?
    /// True when `offset` is a real cursor (Claude transcripts). False: the page is a snapshot, re-read it whole.
    var incremental: Bool = true
    /// How many turns the daemon sent (before empty thinking and deltas were dropped): a full page means more exist.
    var sent: Int? = nil
}

enum ScreenState: String, Sendable {
    case idle, busy, dialog, unknown
}

struct ScreenCapture: Sendable, Equatable {
    var target: String
    var text: String
    var state: ScreenState
    var reason: String?
    /// The dialog on screen, its hash and keys, when the daemon reads them for the capture (otherwise ScreenDialog does).
    var dialog: DialogInfo? = nil
    var hash: String? = nil
    var keys: [String] = []
}

/// A key pressed in a pane (tmux key names on the wire). Dialog keys go through `sessions.answer`; the rest through
/// `tmux.keys`.
struct PaneKey: Hashable, Sendable, Identifiable {
    var rawValue: String
    init(_ raw: String) { rawValue = raw }
    var id: String { rawValue }

    static let enter = PaneKey("Enter"), escape = PaneKey("Escape"), ctrlC = PaneKey("C-c")
    static let up = PaneKey("Up"), down = PaneKey("Down")
    /// What the composer and the Session menu offer when no dialog is up.
    static let basic: [PaneKey] = [.enter, .escape, .ctrlC, .up, .down]

    var label: String {
        switch rawValue {
        case "Enter": "Enter"
        case "Escape": "Esc"
        case "C-c": "Ctrl-C"
        case "Up": "↑"
        case "Down": "↓"
        default: rawValue
        }
    }
    var spokenName: String {
        switch rawValue {
        case "Escape": "Escape"
        case "C-c": "Control C"
        case "Up": "Up arrow"
        case "Down": "Down arrow"
        default: rawValue
        }
    }
}

struct PaneSendResult: Sendable, Equatable {
    /// The daemon refused because a dialog is on screen (read the pane, then answer with keys).
    var refused: Bool
    var reason: String?
}

struct MessageResult: Sendable, Equatable {
    /// The session was mid-turn; the message waits behind it.
    var queuedBehindTurn: Bool
    /// Synchronous reply text (an older daemon's manager answers inline).
    var reply: String?
    /// `wait: false` was honoured: the reply streams as `manager` events.
    var pending = false
    /// The message's event id (the user turn's id in the manager transcript).
    var event: String? = nil
    /// The reply's turn id while it streams.
    var turnId: String? = nil
    var thread: String? = nil
}

/// `sessions.answer` / `tmux.answer` result. A refusal is a normal answer: show `reason`, or the dialog it carries.
struct AnswerResult: Sendable, Equatable {
    var ok: Bool
    var refused: Bool
    var reason: String?
    /// The screen's hash now, and (on "the screen changed") the dialog now on screen.
    var hash: String?
    var dialog: DialogInfo? = nil
    var keys: [String] = []
}

/// What a press left to say on its card: a refusal (an error), or a note (the dialog moved on).
struct AnswerNote: Equatable, Sendable {
    var text: String
    var isError: Bool
}

/// One manager conversation (`openclaw.threads`).
struct ManagerThread: Hashable, Sendable, Identifiable {
    var thread: String
    var turns: Int
    var lastAt: Date?
    var lastText: String?
    var id: String { thread }
}

/// SSE `manager` event: a reply streaming in.
struct ManagerStreamEvent: Sendable, Equatable {
    enum Phase: String, Sendable { case start, delta, done, error }
    var host: String?
    var thread: String
    var turnId: String
    var inReplyTo: String?
    var phase: Phase
    var delta: String?
    /// The reply so far (`done` carries all of it).
    var text: String?
    var error: String?
}

/// SSE `turn` event: a followed transcript grew, or the manager said something (`thread` set).
struct TurnEvent: Sendable {
    var sessionId: String?
    var host: String?
    var thread: String?
    var turn: TranscriptTurn?
}

/// Notification categories the daemon emits (core/notify.js CATEGORY_IDS plus `other` for anything new).
enum NotifyCategory: String, CaseIterable, Identifiable, Codable, Sendable {
    case needsYou = "needs-you", finished, error, manager, held, mr, launch, other
    var id: String { rawValue }
    var title: String {
        switch self {
        case .needsYou: "Needs you"
        case .finished: "Finished"
        case .error: "Errors"
        case .manager: "Manager"
        case .held: "Held messages"
        case .mr: "Merge requests"
        case .launch: "Launches"
        case .other: "Other"
        }
    }
    init(wire: String?) { self = wire.flatMap(NotifyCategory.init(rawValue:)) ?? .other }
}

struct NotifyItem: Identifiable, Hashable, Sendable {
    /// Server id, or the alert `key` when there is no id. Used to de-duplicate.
    var id: String
    var at: Date
    var category: NotifyCategory
    var kind: String
    var title: String
    var body: String
    var sessionId: String?
    var host: String?
    var tmuxTarget: String?
    /// `notify.test` alerts (Settings > Send test notification on the daemon).
    var test: Bool = false
    /// A dialog alert: what is on screen, its hash and the keys it takes (Approve, Deny, the options).
    var dialog: DialogInfo? = nil
    var hash: String? = nil
    var keys: [String] = []
    var answerMode: AnswerMode? = nil
    var held = false
}

struct NotificationPage: Sendable {
    var cursor: String?
    var items: [NotifyItem]
}

/// One parsed Server-Sent Event, already mapped (and decoded off the main actor) to what the app cares about.
enum ServerEvent: Sendable {
    /// Connected. `topics`: the daemon honours `?topics=` (and so sends `board` events).
    case hello(host: String?, topics: Bool)
    /// A mutating op ran (someone sent a message, launched, answered...).
    case mutation(op: String, sessionId: String?)
    /// New alerts for notifications.
    case alerts([NotifyItem])
    /// A followed transcript grew, or the manager said something.
    case turn(TurnEvent)
    /// The compact board changed (`board` event, the `native.board` result).
    case board(BoardSnapshot)
    /// A manager reply streaming in.
    case manager(ManagerStreamEvent)
    /// The daemon's settings changed.
    case settings
    /// Board-ish data changed on a daemon without `board` events (`snapshot`, `fleet`, `probe`, `notify`, `summary`).
    case changed(name: String)
    case unknown(name: String)
}

enum ConnectionState: Sendable, Equatable {
    case notConfigured, connecting, live, reconnecting(attempt: Int), failed(String)
    var label: String {
        switch self {
        case .notConfigured: "Not configured"
        case .connecting: "Connecting"
        case .live: "Live"
        case .reconnecting(let n): "Reconnecting (\(n))"
        case .failed(let m): "Offline: \(m)"
        }
    }
}
