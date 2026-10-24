import Foundation

/// Synthetic data for previews and tests. Invented names only (CONTRACT.md: no company data).
struct MockDroverAPI: DroverAPI {
    var delay: Duration = .milliseconds(150)

    /// Launch time: fixture times are relative to it, so ages read like a live fleet ("4 min. ago").
    static let now = Date()

    static let summaryFixture = NativeSummary(
        generatedAt: LooseDate(now),
        hosts: [
            .init(name: "local", up: true, waiting: 1, working: 1, idle: 2),
            .init(name: "demo-box", up: true, waiting: 1, working: 0, idle: 1),
            .init(name: "demo-spare", up: false, waiting: 0, working: 0, idle: 0),
        ],
        waiting: [
            .init(id: "11111111-aaaa-4bbb-8ccc-000000000001", name: "demo-build", host: "local", engine: .claude,
                  since: LooseDate(now.addingTimeInterval(-240)), kind: "decision",
                  headline: "Allow running the test suite with network access?"),
            .init(id: "thread-demo-review", name: "demo-review", host: "demo-box", engine: .codex,
                  since: LooseDate(now.addingTimeInterval(-900)), kind: "question",
                  headline: "Should I also update the changelog?"),
        ],
        working: [
            .init(id: "11111111-aaaa-4bbb-8ccc-000000000002", name: "demo-docs", host: "local", engine: .claude,
                  headline: "Rewriting the setup guide"),
        ],
        totals: .init(waiting: 2, working: 1, idle: 3, hosts: 3),
        manager: .init(up: true, lastNoteAt: LooseDate(now.addingTimeInterval(-1800)))
    )

    static let sessionsFixture: [SessionInfo] = [
        .init(id: "11111111-aaaa-4bbb-8ccc-000000000001", engine: .claude, name: "demo-build", status: "waiting",
              cwd: "~/code/demo", tmux: "demo:@1.%1", live: true, host: "local"),
        .init(id: "11111111-aaaa-4bbb-8ccc-000000000002", engine: .claude, name: "demo-docs", status: "busy",
              cwd: "~/code/demo-docs", tmux: "demo:@2.%2", live: true, host: "local"),
        .init(id: "11111111-aaaa-4bbb-8ccc-000000000003", engine: .claude, name: "demo-idle", status: "idle",
              cwd: "~/code/demo", tmux: nil, live: true, host: "local"),
        .init(id: "thread-demo-review", engine: .codex, name: "demo-review", status: "idle",
              cwd: "~/code/demo", live: true, host: "demo-box"),
        .init(id: "manager", engine: .openclaw, name: "manager", status: "ready", live: true, host: "demo-box"),
    ]

    static let transcriptFixture: [Turn] = [
        Turn(role: "user", ts: LooseDate(now.addingTimeInterval(-600)), uuid: "t1",
             text: "Run the demo build and tell me if anything fails."),
        Turn(role: "assistant", ts: LooseDate(now.addingTimeInterval(-590)), uuid: "t2",
             text: "Starting the build. I will run the unit tests after it compiles.",
             tools: [.object(["name": .string("Bash")])]),
        Turn(role: "tool_result", ts: LooseDate(now.addingTimeInterval(-500)), uuid: "t3", text: "Build succeeded (42 s)"),
        Turn(role: "assistant", ts: LooseDate(now.addingTimeInterval(-240)), uuid: "t4",
             text: "The build passed. The test suite needs network access. Should I allow it?"),
    ]

    static let managerTranscriptFixture: [Turn] = [
        Turn(role: "user", ts: LooseDate(now.addingTimeInterval(-420)), uuid: "m1", text: "What needs me right now?"),
        Turn(role: "assistant", ts: LooseDate(now.addingTimeInterval(-410)), uuid: "m2",
             text: "Two sessions wait on you. **demo-build** asks to run the test suite with network access, and "
                 + "**demo-review** asks whether to update the changelog. demo-docs is still rewriting the setup guide."),
        Turn(role: "user", ts: LooseDate(now.addingTimeInterval(-300)), uuid: "m3", text: "Why is demo-spare down?"),
        Turn(role: "assistant", ts: LooseDate(now.addingTimeInterval(-290)), uuid: "m4",
             text: "It stopped answering after its nightly restart. I will check it again on the next sweep."),
    ]

    func summary() async throws -> NativeSummary { try await Task.sleep(for: delay); return Self.summaryFixture }

    func notifications(since cursor: String?, wait: Int?) async throws -> NotificationFeed {
        try await Task.sleep(for: delay)
        let items: [NotificationFeed.Item] = [
            .init(id: "n1", at: LooseDate(Self.now), kind: "decision", category: "needs-you", test: nil, title: "demo-build needs you",
                  body: "Allow running the test suite with network access?",
                  sessionId: "11111111-aaaa-4bbb-8ccc-000000000001", host: "local"),
        ]
        return NotificationFeed(cursor: LooseString("c1"), items: cursor == "c1" ? [] : items)
    }

    func sessions(host: String?) async throws -> [SessionInfo] {
        try await Task.sleep(for: delay)
        let h = host ?? localHostName
        return Self.sessionsFixture.filter { ($0.host ?? localHostName) == h }
    }

    func transcript(_ ref: SessionRef, since: Int?, limit: Int) async throws -> TranscriptPage {
        try await Task.sleep(for: delay)
        let manager = ref.id == SessionRef.manager.id
        let all = manager ? Self.managerTranscriptFixture : Self.transcriptFixture
        let from = min(since ?? 0, all.count)
        return TranscriptPage(engine: manager ? .openclaw : .claude, turns: Array(all[from...].prefix(limit)), offset: all.count)
    }

    func lastReply(_ ref: SessionRef) async throws -> LastReply {
        LastReply(id: ref.id, name: "demo-build", engine: .claude, text: Self.transcriptFixture.last?.text,
                  line: Self.transcriptFixture.last?.text, ts: LooseDate(Self.now))
    }

    func message(_ ref: SessionRef, text: String) async throws -> MessageResult {
        try await Task.sleep(for: delay)
        return ref.id == SessionRef.manager.id
            ? MessageResult(ok: true, reply: "Fleet is calm: 2 waiting, 1 working. Nothing is stuck.")
            : MessageResult(ok: true, queuedBehindTurn: false)
    }

    func capture(host: String?, target: String, lines: Int) async throws -> ScreenCapture {
        try await Task.sleep(for: delay)
        return ScreenCapture(target: target, text: """
        ● The test suite needs network access.

        Allow network for this command?
        ❯ 1. Yes
          2. Yes, and don't ask again
          3. No, and tell Claude what to do differently

        Esc to cancel
        """, screen: .init(state: "dialog", reason: "a selector or permission prompt is on screen"))
    }

    func sendKeys(host: String?, target: String, keys: [PaneKey]) async throws -> PaneSendResult { PaneSendResult(ok: true) }

    func sendToPane(host: String?, target: String, text: String, enter: Bool) async throws -> PaneSendResult {
        PaneSendResult(ok: true)
    }

    func upload(_ ref: SessionRef, name: String, mime: String, data: Data) async throws -> UploadResult {
        UploadResult(path: "~/.cache/drover/uploads/\(ref.id)/\(name)", size: data.count)
    }

    func managerStatus(host: String?) async throws -> JSONValue {
        .object(["gateway": .object(["up": .bool(true)]), "unit": .object(["state": .string("active")]),
                 "model": .object(["primary": .string("demo-model"), "thinking": .string("medium"),
                                   "heartbeatEvery": .string("30m")]),
                 "cost": .object(["todayUsd": .number(0.42), "budgetUsd": .number(5)])])
    }

    func managerFeed(host: String?, limit: Int) async throws -> JSONValue {
        .array([
            .object(["type": .string("note"), "ts": .string(Self.now.addingTimeInterval(-1800).formatted(.iso8601)),
                     "text": .string("Swept 3 hosts. demo-build waits on a permission prompt.")]),
        ])
    }

    func managerSweep(host: String?) async throws -> JSONValue { .object(["ok": .bool(true)]) }

    func events() -> AsyncThrowingStream<ServerEvent, Error> {
        AsyncThrowingStream { c in
            c.yield(ServerEvent(name: "hello", data: "{}"))
        }
    }
}
