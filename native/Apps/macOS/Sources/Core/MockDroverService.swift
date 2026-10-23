import Foundation

/// Synthetic data for previews, the harness and `--mock` launches. Names are invented (CONTRACT.md: no company data).
final class MockDroverService: DroverService, @unchecked Sendable {
    private let lock = NSLock()
    private var sent: [String] = []
    private var listeners: [UUID: AsyncStream<ServerEvent>.Continuation] = [:]
    private var managerTurns: [TranscriptTurn] = MockDroverService.managerHistory
    /// Panes whose dialog was answered: they read idle until the mock is made again.
    private var answeredTargets = Set<String>()
    var uploadsSupported = true
    /// Seconds between streamed manager deltas (the harness sets 0).
    var streamStep: Double = 0.25
    /// Seconds a manager transcript read takes (the harness: an answer that lands after a server switch).
    var managerReadDelay: Double = 0
    /// When set, only that host runs a manager: a read of any other (nil: the front daemon) is "session not found".
    var managerOnlyAt: String?
    /// The host each manager transcript read asked (nil: the front daemon).
    var managerReadHosts: [String?] { lock.withLock { managerReads } }
    private var managerReads: [String?] = []

    static let buildDialog = DialogInfo(question: "Do you want to proceed?", options: [
        DialogOption(n: 1, label: "Yes", selected: true),
        DialogOption(n: 2, label: "Yes, and don't ask again for npm test commands"),
        DialogOption(n: 3, label: "No, and tell Claude what to do differently"),
    ])
    static let buildHash = "5f1d0c9a7e2b4d63"

    static let sessions: [SessionItem] = [
        SessionItem(id: "11111111-demo-build", name: "demo-build", host: "studio", engine: "claude", status: "blocked",
                    cwd: "~/code/demo", tmuxTarget: "work:1", live: true, updatedAt: Date(timeIntervalSinceNow: -90),
                    lane: .waiting, waitKind: .decision, headline: "Bash(npm test) wants to run",
                    screen: .dialog, dialog: buildDialog, hash: buildHash, keys: ["1", "2", "3", "Enter", "Escape"],
                    answerMode: .keys, askLabel: "needs a decision", askText: "Do you want to proceed?",
                    tail: ["Bash(npm test)", "Do you want to proceed?"]),
        SessionItem(id: "22222222-demo-review", name: "demo-review", host: "studio", engine: "codex", status: "idle",
                    cwd: "~/code/demo", tmuxTarget: "work:2", live: true, updatedAt: Date(timeIntervalSinceNow: -300),
                    lane: .waiting, waitKind: .question, headline: "Should the parser accept trailing commas?",
                    answerMode: .reply, askLabel: "asked a question", askText: "Should the parser accept trailing commas?"),
        SessionItem(id: "33333333-demo-docs", name: "demo-docs", host: "studio", engine: "claude", status: "busy",
                    cwd: "~/code/docs", tmuxTarget: "work:3", live: true, updatedAt: Date(timeIntervalSinceNow: -20),
                    lane: .working, waitKind: nil, headline: "Rewriting the setup guide", screen: .busy),
        SessionItem(id: "44444444-demo-lint", name: "demo-lint", host: "devbox", engine: "headless", status: "busy",
                    cwd: "~/src/lint", tmuxTarget: nil, live: true, updatedAt: Date(timeIntervalSinceNow: -40),
                    lane: .working, waitKind: nil, headline: nil),
        SessionItem(id: "manager", name: "manager", host: "devbox", engine: "openclaw", status: "idle",
                    cwd: nil, tmuxTarget: nil, live: true, updatedAt: Date(timeIntervalSinceNow: -900),
                    lane: .idle, waitKind: nil, headline: nil),
        SessionItem(id: "55555555-demo-notes", name: "demo-notes", host: "devbox", engine: "claude", status: "idle",
                    cwd: "~/notes", tmuxTarget: "notes:0", live: true, updatedAt: Date(timeIntervalSinceNow: -3600),
                    lane: .idle, waitKind: nil, headline: nil, screen: .idle,
                    finished: FinishedNote(text: "Notes reorganised into three folders.", at: Date(timeIntervalSinceNow: -3500))),
    ]

    static let snapshot = BoardSnapshot(
        generatedAt: Date(),
        hosts: [HostItem(name: "studio", up: true, waiting: 2, working: 1, idle: 0),
                HostItem(name: "devbox", up: true, waiting: 0, working: 1, idle: 2),
                HostItem(name: "spare", up: false, waiting: 0, working: 0, idle: 0, error: "ssh timed out")],
        sessions: sessions, usedNativeSummary: true,
        manager: ManagerInfo(up: true, host: "devbox", lastNoteAt: Date(timeIntervalSinceNow: -600)), source: .mock)

    var messagesSent: [String] { lock.withLock { sent } }

    func board() async throws -> BoardSnapshot { Self.snapshot }

    /// A session's synthetic transcript: a request, a run of tool calls with results, Markdown text, a question.
    static func transcript(t0: Date = Date(timeIntervalSinceNow: -600)) -> [TranscriptTurn] {
        func at(_ s: Double) -> Date { t0.addingTimeInterval(s) }
        return [
            TranscriptTurn(id: "t1", role: .user, text: "Run the tests and fix whatever fails.", ts: at(0), tools: [], meta: false),
            TranscriptTurn(id: "t1m", role: .user, text: "<system-reminder>harness note</system-reminder>", ts: at(1), tools: [], meta: true),
            TranscriptTurn(id: "t2", role: .thinking, text: "", ts: at(5), tools: [], meta: false),
            TranscriptTurn(id: "t3", role: .assistant, text: "", ts: at(8),
                           tools: [ToolCall(id: "tu1", name: "Bash", summary: "npm test", input: #"{"command":"npm test"}"#)], meta: false),
            TranscriptTurn(id: "t4", role: .toolResult, text: "", ts: at(20), tools: [], meta: false,
                           results: [ToolResult(toolUseId: "tu1", isError: true, text: "FAIL parser_tests\n  ✕ accepts trailing commas (4 ms)\n  ✕ keeps order (2 ms)\n\nTests: 2 failed, 48 passed, 50 total\nTime: 1.92 s")]),
            TranscriptTurn(id: "t5", role: .assistant, text: "", ts: at(22),
                           tools: [ToolCall(id: "tu2", name: "Read", summary: "~/code/demo/src/parser.ts", input: nil)], meta: false),
            TranscriptTurn(id: "t6", role: .toolResult, text: "", ts: at(23), tools: [], meta: false,
                           results: [ToolResult(toolUseId: "tu2", isError: false, text: "export function parse(src: string) {\n  const tokens = lex(src)\n  return list(tokens)\n}")]),
            TranscriptTurn(id: "t7", role: .assistant, text: "", ts: at(25),
                           tools: [ToolCall(id: "tu3", name: "Grep", summary: "\"trailing\" in ~/code/demo/src", input: nil)], meta: false),
            TranscriptTurn(id: "t8", role: .toolResult, text: "", ts: at(26), tools: [], meta: false,
                           results: [ToolResult(toolUseId: "tu3", isError: false, text: "src/lexer.ts:41: // trailing commas are not allowed yet")]),
            TranscriptTurn(id: "t9", role: .assistant, text: """
            Both failures come from **trailing commas**. The lexer rejects them on purpose:

            - `parser_tests` expects `[1, 2,]` to parse
            - the lexer stops at the `,` before `]`

            ```ts
            // src/lexer.ts
            if (next === ']') throw new Error('trailing comma')
            ```

            See [the grammar notes](https://example.com/grammar) for why.
            """, ts: at(40), tools: [], meta: false),
            TranscriptTurn(id: "t10", role: .assistant, text: "   \n", ts: at(41), tools: [], meta: false),
            TranscriptTurn(id: "t11", role: .assistant, text: "Should the parser accept trailing commas?", ts: at(60), tools: [], meta: false),
        ]
    }

    static let managerHistory: [TranscriptTurn] = [
        TranscriptTurn(id: "m1", role: .user, text: "Who is waiting on me?", ts: Date(timeIntervalSinceNow: -700), tools: [], meta: false, thread: "main"),
        TranscriptTurn(id: "m2", role: .assistant, text: "Two sessions wait on you:\n\n1. **demo-build** wants to run `npm test`.\n2. **demo-review** asks whether the parser should accept trailing commas.", ts: Date(timeIntervalSinceNow: -690), tools: [], meta: false, inReplyTo: "m1", thread: "main"),
    ]

    func transcript(of session: SessionItem, since: Int?, limit: Int?) async throws -> TranscriptPage {
        if session.isManager { return try await managerTranscript(thread: "main", host: session.host) }
        if since != nil { return TranscriptPage(turns: [], offset: since) }
        return TranscriptPage(turns: Self.transcript(), offset: 4096)
    }

    func capture(target: String, host: String, lines: Int) async throws -> ScreenCapture {
        if lock.withLock({ answeredTargets.contains(target) }) {
            return ScreenCapture(target: target, text: "● Bash(npm test)\n  ⎿  2 passed\n\n> \n? for shortcuts", state: .idle,
                                 reason: "claude prompt footer visible")
        }
        if target == "work:1" {
            return ScreenCapture(target: target, text: """
            ● Bash(npm test)
              ⎿  Running…

            ╭──────────────────────────────────────────────────────────────╮
            │ Bash command                                                 │
            │                                                              │
            │   npm test                                                   │
            │   Run the test suite                                         │
            │                                                              │
            │ Do you want to proceed?                                      │
            │ ❯ 1. Yes                                                     │
            │   2. Yes, and don't ask again for npm test commands          │
            │   3. No, and tell Claude what to do differently (esc)        │
            ╰──────────────────────────────────────────────────────────────╯
            """, state: .dialog, reason: "a selector or permission prompt is on screen")
        }
        let long = (1...60).map { "  \($0)  " + String(repeating: "wide output column ", count: 8) }.joined(separator: "\n")
        return ScreenCapture(target: target, text: "● Updating the setup guide\n\(long)\n\n✻ Writing… (esc to interrupt)", state: .busy,
                             reason: "agent is working (esc to interrupt visible)")
    }

    func sendMessage(to session: SessionItem, text: String) async throws -> MessageResult {
        if session.isManager { return try await messageManager(text: text, thread: "main", host: session.host) }
        lock.withLock { sent.append("message \(session.id): \(text)") }
        return MessageResult(queuedBehindTurn: session.lane == .working, reply: nil)
    }

    func sendToPane(target: String, host: String, text: String, enter: Bool, force: Bool) async throws -> PaneSendResult {
        lock.withLock { sent.append("pane \(target): \(text)") }
        return PaneSendResult(refused: !force && target == "work:1", reason: "a selector or permission prompt is on screen")
    }

    func sendKeys(target: String, host: String, keys: [PaneKey]) async throws {
        lock.withLock { sent.append("keys \(target): \(keys.map(\.rawValue).joined(separator: " "))") }
    }

    /// The dialog a refusal brings when the screen moved on (`expect: "moved"`): the next question.
    static let nextQuestion = DialogInfo(question: "Which fixtures?", options: [DialogOption(n: 1, label: "All", selected: true), DialogOption(n: 2, label: "New ones")])

    func answer(id: String, host: String, target: String?, key: String, expect: String?) async throws -> AnswerResult {
        lock.withLock { sent.append("answer \(id) \(key) expect \(expect ?? "-")") }
        if expect == "moved" {
            return AnswerResult(ok: false, refused: true, reason: "the screen changed since you read it; read it again",
                                hash: "next-hash", dialog: Self.nextQuestion)
        }
        if let expect, expect != Self.buildHash {
            return AnswerResult(ok: false, refused: true, reason: "the screen changed since you read it; read it again", hash: Self.buildHash)
        }
        if let target { lock.withLock { _ = answeredTargets.insert(target) } }
        return AnswerResult(ok: true, refused: false, reason: nil, hash: Self.buildHash)
    }

    func managerTranscript(thread: String, host: String?) async throws -> TranscriptPage {
        lock.withLock { managerReads.append(host) }
        if managerReadDelay > 0 { try? await Task.sleep(for: .seconds(managerReadDelay)) }
        if let only = managerOnlyAt, host != only { throw DroverError.server("session not found") }
        let turns = lock.withLock { managerTurns.filter { ($0.thread ?? "main") == thread } }
        return TranscriptPage(turns: turns, offset: turns.count, incremental: false)
    }

    /// Answers like a streaming daemon: `pending` at once, then `manager` start / delta / done and the final `turn`.
    func messageManager(text: String, thread: String, host: String?) async throws -> MessageResult {
        let event = "e-\(UUID().uuidString.prefix(8))", turnId = "r-\(UUID().uuidString.prefix(8))"
        let user = TranscriptTurn(id: event, role: .user, text: text, ts: Date(), tools: [], meta: false, thread: thread)
        lock.withLock {
            sent.append("manager[\(thread)]: \(text)")
            managerTurns.append(user)
        }
        let reply = "Here is what I see on the demo fleet:\n\n- **demo-build** waits on a permission prompt\n- **demo-docs** is rewriting the setup guide\n\nNothing else needs you."
        let step = streamStep
        Task {
            self.emit(.turn(TurnEvent(sessionId: "manager", host: host, thread: thread, turn: user)))
            self.emit(.manager(ManagerStreamEvent(host: host, thread: thread, turnId: turnId, inReplyTo: event, phase: .start)))
            var sofar = ""
            for word in reply.split(separator: " ", omittingEmptySubsequences: false) {
                if step > 0 { try? await Task.sleep(for: .seconds(step / 4)) }
                let delta = (sofar.isEmpty ? "" : " ") + word
                sofar += delta
                self.emit(.manager(ManagerStreamEvent(host: host, thread: thread, turnId: turnId, inReplyTo: event, phase: .delta, delta: delta, text: sofar)))
            }
            self.emit(.manager(ManagerStreamEvent(host: host, thread: thread, turnId: turnId, inReplyTo: event, phase: .done, text: reply)))
            let final = TranscriptTurn(id: turnId, role: .assistant, text: reply, ts: Date(), tools: [], meta: false, inReplyTo: event, thread: thread)
            self.lock.withLock { self.managerTurns.append(final) }
            self.emit(.turn(TurnEvent(sessionId: "manager", host: host, thread: thread, turn: final)))
        }
        return MessageResult(queuedBehindTurn: false, reply: nil, pending: true, event: event, turnId: turnId, thread: thread)
    }

    func managerThreads(host: String?) async throws -> [ManagerThread] {
        [ManagerThread(thread: "main", turns: 4, lastAt: Date(timeIntervalSinceNow: -690), lastText: "Two sessions wait on you"),
         ManagerThread(thread: "release", turns: 2, lastAt: Date(timeIntervalSinceNow: -86_400), lastText: "The release branch is green")]
    }

    func sweep(host: String?) async throws -> String {
        lock.withLock { sent.append("sweep") }
        return "Sweep queued: sweep now"
    }

    func supportsUploads() async -> Bool { uploadsSupported }

    func upload(for session: SessionItem, fileName: String, mime: String, data: Data) async throws -> String {
        "/tmp/drover-uploads/\(session.id)/\(fileName)"
    }

    private func emit(_ e: ServerEvent) {
        let all = lock.withLock { Array(listeners.values) }
        for c in all { c.yield(e) }
    }

    func events(onState: @escaping @Sendable (ConnectionState) -> Void) -> AsyncStream<ServerEvent> {
        onState(.live)
        let id = UUID()
        return AsyncStream { c in
            self.lock.withLock { self.listeners[id] = c }
            c.onTermination = { _ in self.lock.withLock { _ = self.listeners.removeValue(forKey: id) } }
        }
    }

    func notifications(since cursor: String?, wait: Int) async throws -> NotificationPage {
        if cursor != nil { try await Task.sleep(for: .seconds(max(wait, 1))); return NotificationPage(cursor: cursor, items: []) }
        return NotificationPage(cursor: "c1", items: [
            NotifyItem(id: "n1", at: Date(timeIntervalSinceNow: -60), category: .needsYou, kind: "decision",
                       title: "demo-build needs a decision", body: "Allow running the test suite?",
                       sessionId: "11111111-demo-build", host: "studio", tmuxTarget: "work:1",
                       dialog: Self.buildDialog, hash: Self.buildHash, keys: ["1", "2", "3", "Enter", "Escape"], answerMode: .keys),
        ])
    }

    func ping() async throws -> String { "studio" }
}
