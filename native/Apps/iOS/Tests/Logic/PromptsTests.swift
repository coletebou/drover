import DroverKit
import Foundation

// Logic tests of the prompts slice: the tab bar's Agents grouping, deep links, the store (Mine and All, debounced
// search, paging, pull to refresh, sync, an older daemon), the session behind a prompt, the row text, and the HTTP
// client's arguments.
extension Suites {
    static var promptsSuites: [(String, () async throws -> Void)] {
        [("prompts tabs", promptsTabs), ("prompts store", promptsStore), ("prompts session", promptsSession),
         ("prompts format", promptsFormat), ("prompts http", promptsHTTP), ("prompts older daemon", promptsOlderDaemon)]
    }

    @MainActor
    static func until(_ cond: () -> Bool) async {
        for _ in 0..<300 where !cond() { try? await Task.sleep(for: .milliseconds(10)) }
    }

    @MainActor
    static func promptsTabs() async throws {
        let m = AppModel.preview()
        expect(m.tabBarSelection == .board, "Agents first")
        m.selectedTab = .sessions
        expect(m.tabBarSelection == .board, "List is the Agents tab too")
        m.tabBarSelection = .prompts
        expect(m.selectedTab == .prompts, "Prompts tab")
        m.tabBarSelection = .board
        expect(m.selectedTab == .sessions, "the Agents tab goes back to the view shown last (List)")
        m.selectedTab = .board
        m.tabBarSelection = .manager
        m.tabBarSelection = .board
        expect(m.selectedTab == .board, "or Lanes")
        expect(DeepLink(url: URL(string: "drover://prompts")!) == .prompts, "prompts link")
        m.handle(url: URL(string: "drover://prompts")!)
        expect(m.selectedTab == .prompts, "the prompts link opens the tab")
        expect(AppModel.Tab(rawValue: "sessions") == .sessions && AppModel.Tab(rawValue: "prompts") == .prompts, "--mock-tab values")
    }

    @MainActor
    static func promptsStore() async throws {
        let m = AppModel(api: MockDroverAPI(delay: .zero))
        let s = m.prompts
        s.debounce = .milliseconds(30)
        await s.appear()
        expect(s.loaded && s.records.count == 4, "Mine: four of the five, the peer message left out (\(s.records.count))")
        expect(s.status?.records == 412, "status read with the first page")
        expect(s.records.map(\.ts) == s.records.map(\.ts).sorted(by: >), "newest first")
        s.scope = .all
        await until { s.records.count == 5 }
        expect(s.records.count == 5, "All adds the peer message")
        s.scope = .mine
        await until { s.records.count == 4 }
        s.search = "t"
        s.search = "the tests"
        await until { s.records.count == 1 }
        expect(s.records.map(\.id) == ["p_mock000000000001"], "every word must match: \(s.records.map(\.id))")
        s.search = ""
        await until { s.records.count == 4 }
        s.pageSize = 2
        await s.reload()
        expect(s.records.count == 2 && s.more, "a first page of two, more to come")
        await s.loadMore()
        expect(s.records.count == 4 && !s.more, "the second page, and the end (\(s.records.count), \(s.more))")
        await s.loadMore()
        expect(s.records.count == 4, "nothing past the end")
        await s.sync()
        expect(s.syncNote == "Scanned 30, added 1 prompt", "sync result: \(s.syncNote ?? "nil")")
        expect(!s.syncing, "not syncing after")
        s.reset()
        expect(s.records.isEmpty && !s.loaded && s.status == nil && s.syncNote == nil, "reset")
    }

    @MainActor
    static func promptsSession() async throws {
        let m = AppModel(api: MockDroverAPI(delay: .zero))
        await m.refreshAll()
        let s = m.prompts
        let fixture = MockDroverAPI.promptsFixture
        expect(s.sessionRef(for: fixture[0]) == SessionRef(id: "11111111-aaaa-4bbb-8ccc-000000000001", host: "local"), "a waiting session on this machine")
        expect(s.sessionRef(for: fixture[1])?.host == "demo-box", "a session on another host, by the record's route")
        expect(s.sessionRef(for: fixture[3]) == nil, "no session id: nothing to open")
        var elsewhere = fixture[0]; elsewhere.route = "demo-spare"
        expect(s.sessionRef(for: elsewhere) == nil, "the same id on another host is not on the board")
        var manager = fixture[0]; manager.session = "manager"
        expect(s.sessionRef(for: manager) == nil, "never the manager by id")
        if let ref = s.sessionRef(for: fixture[1]) { m.open(ref, in: .sessions) }
        expect(m.selectedTab == .sessions && m.sessionsSelection?.id == "thread-demo-review", "Open session lands on Agents › List")
    }

    static func promptsFormat() async throws {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let iso = ISO8601DateFormatter()
        let now = iso.date(from: "2026-11-21T23:00:00Z")!
        expect(PromptsStore.time(iso.date(from: "2026-11-21T22:03:11Z")!, now: now, calendar: cal) == "22:03", "today")
        expect(PromptsStore.time(iso.date(from: "2026-11-18T09:05:00Z")!, now: now, calendar: cal) == "Wed 09:05", "this week")
        expect(PromptsStore.time(iso.date(from: "2026-10-02T09:05:00Z")!, now: now, calendar: cal) == "2 Oct 09:05", "older")
        let p = PromptRecord(id: "p", ts: DroverTimestamp(iso.date(from: "2026-11-21T22:03:11Z")!), host: "demo-box", engine: .codex,
                             project: "webapp", via: .queued, text: "x")
        expect(PromptsStore.meta(p, now: now, calendar: cal) == "22:03 · demo-box · codex · webapp · queued", PromptsStore.meta(p, now: now, calendar: cal))
        var peer = p; peer.via = .peer; peer.from = "demo-review"; peer.project = nil
        expect(PromptsStore.meta(peer, now: now, calendar: cal) == "22:03 · demo-box · codex · from demo-review", "a peer names its sender")
        var typed = p; typed.via = .typed
        expect(!PromptsStore.meta(typed, now: now, calendar: cal).contains("typed"), "typed is the default and not shown")
    }

    struct Missing: Error {}
    static func need<T>(_ v: T?) throws -> T { guard let v else { throw Missing() }; return v }

    static func promptsHTTP() async throws {
        let args = try HTTPDroverAPI.promptArgs(PromptsQuery(scope: .all, q: " lexer ", before: "p_1"))
        expect(args == ["q": .string("lexer"), "before": .string("p_1"), "limit": .number(200), "via": .string("all")], "\(args)")
        let mine = try HTTPDroverAPI.promptArgs(PromptsQuery())
        expect(mine == ["limit": .number(200)], "Mine sends no via")
        // The daemon's envelope decodes into DroverKit's models.
        let list: PromptsList = try HTTPDroverAPI.decodeResult(try need(Fixtures.data("prompts.list.json")), op: "prompts.list")
        expect(list.prompts.count == 5 && list.more, "prompts.list fixture")
        let status: PromptsStatus = try HTTPDroverAPI.decodeResult(try need(Fixtures.data("prompts.status.json")), op: "prompts.status")
        expect(status.sinks.count == 2, "prompts.status fixture")
        let sync: PromptsSyncResult = try HTTPDroverAPI.decodeResult(try need(Fixtures.data("prompts.sync.json")), op: "prompts.sync")
        expect(sync.added == 3, "prompts.sync fixture")
    }

    /// A daemon from before the spool answers "unknown op": the tab says so instead of showing an error.
    struct OlderDaemon: DroverAPI {
        let base = MockDroverAPI(delay: .zero)
        func summary() async throws -> NativeSummary { try await base.summary() }
        func notifications(since cursor: String?, wait: Int?) async throws -> NotificationFeed { try await base.notifications(since: cursor, wait: wait) }
        func sessions(host: String?) async throws -> [SessionInfo] { try await base.sessions(host: host) }
        func transcript(_ ref: SessionRef, since: Int?, limit: Int) async throws -> TranscriptPage { try await base.transcript(ref, since: since, limit: limit) }
        func lastReply(_ ref: SessionRef) async throws -> LastReply { try await base.lastReply(ref) }
        func message(_ ref: SessionRef, text: String) async throws -> MessageResult { try await base.message(ref, text: text) }
        func capture(host: String?, target: String, lines: Int) async throws -> ScreenCapture { try await base.capture(host: host, target: target, lines: lines) }
        func sendKeys(host: String?, target: String, keys: [PaneKey]) async throws -> PaneSendResult { try await base.sendKeys(host: host, target: target, keys: keys) }
        func sendToPane(host: String?, target: String, text: String, enter: Bool) async throws -> PaneSendResult { try await base.sendToPane(host: host, target: target, text: text, enter: enter) }
        func upload(_ ref: SessionRef, name: String, mime: String, data: Data) async throws -> UploadResult { try await base.upload(ref, name: name, mime: mime, data: data) }
        func managerStatus(host: String?) async throws -> JSONValue { try await base.managerStatus(host: host) }
        func managerFeed(host: String?, limit: Int) async throws -> JSONValue { try await base.managerFeed(host: host, limit: limit) }
        func managerSweep(host: String?) async throws -> JSONValue { try await base.managerSweep(host: host) }
        func answerApproval(id: String, choice: Int, via: String) async throws -> ApprovalAnswerResult { try await base.answerApproval(id: id, choice: choice, via: via) }
        func approval(id: String) async throws -> ApprovalRequest? { try await base.approval(id: id) }
        func events() -> AsyncThrowingStream<ServerEvent, Error> { base.events() }
        func prompts(_ query: PromptsQuery) async throws -> PromptsList { throw DroverError.server("unknown op prompts.list") }
    }

    @MainActor
    static func promptsOlderDaemon() async throws {
        let m = AppModel(api: OlderDaemon())
        await m.prompts.appear()
        expect(m.prompts.unsupported && m.prompts.error == nil, "an older daemon is not an error")
        let u = AppModel(api: UnconfiguredDroverAPI())
        await u.prompts.reload()
        expect(u.prompts.error != nil && !u.prompts.unsupported, "no server: the error says so")
    }
}
