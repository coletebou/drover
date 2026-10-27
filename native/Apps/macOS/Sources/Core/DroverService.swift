import Foundation

/// Everything the macOS app asks of Drover. Views and AppModel depend on this protocol only.
/// `LiveDroverService` talks to the daemon; `MockDroverService` serves synthetic data for previews and the harness.
/// When DroverKit merges, only LiveDroverService changes (it becomes an adapter over DroverClient/EventStream).
protocol DroverService: Sendable {
    /// Board data: hosts plus every live session, already sorted into lanes (`native.board`, or the fleet fallback).
    func board() async throws -> BoardSnapshot
    /// Transcript turns. Pass the previous page's `offset` as `since` for incremental reads; `limit` turns at most
    /// (nil: the service's default page).
    func transcript(of session: SessionItem, since: Int?, limit: Int?) async throws -> TranscriptPage
    /// Last `lines` lines of a tmux pane, with the server's screen classification.
    func capture(target: String, host: String, lines: Int) async throws -> ScreenCapture
    /// Deliver a message into the session (inbox socket / Codex thread), as if typed.
    func sendMessage(to session: SessionItem, text: String) async throws -> MessageResult
    /// Paste text into the session's pane. `force` overrides the dialog guard.
    func sendToPane(target: String, host: String, text: String, enter: Bool, force: Bool) async throws -> PaneSendResult
    /// Press raw keys in a pane (`tmux.keys`; no dialog guard, so not for answering dialogs).
    func sendKeys(target: String, host: String, keys: [PaneKey]) async throws
    /// Press one key on the dialog a session shows, only if the screen still hashes to `expect`
    /// (`sessions.answer`, falling back to `tmux.answer` on the window `target` for daemons that predate it).
    func answer(id: String, host: String, target: String?, key: String, expect: String?) async throws -> AnswerResult
    /// Answer a Grok bot's approval request with option `choice` (its `n`): `POST /api/approvals/answer {id, choice,
    /// via: "mac"}`. Not an op. A request no longer pending (409) is a result, not an error.
    func answerApproval(id: String, choice: Int) async throws -> ApprovalAnswerResult
    /// The whole request (`GET /api/approvals?id=`): its words unshortened, its status and answer. nil when this daemon
    /// keeps no such request. What a card whose words may be shortened answers from.
    func approval(id: String) async throws -> ApprovalInfo?
    /// Ask the daemon to follow (or stop following) a Claude transcript, so `turn` events carry its new turns.
    func follow(id: String, host: String, on: Bool) async
    /// The manager conversation `thread` (`sessions.transcript {id: "manager", thread}`).
    func managerTranscript(thread: String, host: String?) async throws -> TranscriptPage
    /// Message the manager. Returns at once (`wait: false`) on daemons that stream; older ones answer inline.
    func messageManager(text: String, thread: String, host: String?) async throws -> MessageResult
    /// The manager's conversations, newest first (`openclaw.threads`). Throws `unsupported` on older daemons.
    func managerThreads(host: String?) async throws -> [ManagerThread]
    /// `openclaw.sweep`: the manager looks at the fleet now.
    func sweep(host: String?) async throws -> String
    /// True when the daemon exposes `uploads.put` (checked via GET /api/ops, cached).
    func supportsUploads() async -> Bool
    /// Store a file in the session's upload inbox on its host; returns the absolute path on that host.
    func upload(for session: SessionItem, fileName: String, mime: String, data: Data) async throws -> String
    /// Live events. The stream reconnects with backoff on its own and reports state via `onState`.
    /// It finishes only when the consuming task is cancelled.
    func events(onState: @escaping @Sendable (ConnectionState) -> Void) -> AsyncStream<ServerEvent>
    /// `native.notifications` long poll (CONTRACT.md): items newer than `since` (opaque cursor), oldest first,
    /// held open up to `wait` seconds (max 25). Muted alerts are already removed by the daemon.
    /// Throws `DroverError.unsupported` when the daemon predates the op (fall back to SSE `.alerts`).
    func notifications(since cursor: String?, wait: Int) async throws -> NotificationPage
    /// Cheap authenticated call for Settings > Test connection. Returns the daemon's host name.
    func ping() async throws -> String
}

/// Defaults for services that have no manager or dialogs (test doubles).
extension DroverService {
    func transcript(of session: SessionItem, since: Int?) async throws -> TranscriptPage {
        try await transcript(of: session, since: since, limit: nil)
    }
    func answer(id: String, host: String, target: String?, key: String, expect: String?) async throws -> AnswerResult {
        throw DroverError.unsupported("Answering dialogs")
    }
    func answerApproval(id: String, choice: Int) async throws -> ApprovalAnswerResult {
        throw DroverError.unsupported("Answering approval requests")
    }
    func approval(id: String) async throws -> ApprovalInfo? { throw DroverError.unsupported("Approval requests") }
    func follow(id: String, host: String, on: Bool) async {}
    func managerTranscript(thread: String, host: String?) async throws -> TranscriptPage { TranscriptPage(turns: [], offset: nil, incremental: false) }
    func messageManager(text: String, thread: String, host: String?) async throws -> MessageResult {
        throw DroverError.unsupported("The manager")
    }
    func managerThreads(host: String?) async throws -> [ManagerThread] { throw DroverError.unsupported("openclaw.threads") }
    func sweep(host: String?) async throws -> String { throw DroverError.unsupported("openclaw.sweep") }
}

enum DroverError: LocalizedError, Equatable {
    case notConfigured
    case unauthorized
    case http(Int, String?)
    case server(String)
    case decoding(String)
    case unsupported(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured: "Set the server URL and token in Settings."
        case .unauthorized: "The daemon rejected the token."
        case .http(let code, let msg): "HTTP \(code)" + (msg.map { ": \($0)" } ?? "")
        case .server(let msg): msg
        case .decoding(let msg): "Unexpected response: \(msg)"
        case .unsupported(let what): "\(what) is not available on this daemon."
        }
    }

    /// The daemon predates an op ("unknown op native.board").
    var isUnknownOp: Bool {
        if case .server(let m) = self { return m.localizedCaseInsensitiveContains("unknown op") }
        return false
    }
}
