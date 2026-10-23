import Foundation

@MainActor
enum CoreTests {
    static func run() async {
        await T.suite("SSEParser") {
            var p = SSEParser()
            var out: [SSEParser.Message] = []
            for l in [": ping", "event: hello", "data: {\"host\":\"studio\"}", "", "data: a", "data: b", "", "event: x", "", "event: alerts\r", "data: {}\r", "\r"] {
                if let m = p.feed(line: l) { out.append(m) }
            }
            T.eq(out.count, 3, "messages")
            T.eq(out[0], .init(event: "hello", data: "{\"host\":\"studio\"}"))
            T.eq(out[1], .init(event: "message", data: "a\nb"))
            T.eq(out[2].event, "alerts", "CRLF stripped")
        }
        await T.suite("ServerEventMapper") {
            let m = ServerEventMapper.map(.init(event: "alerts", data: #"{"items":[{"key":"k1","ts":"2026-10-11T22:00:00.000Z","category":"needs-you","kind":"dialog","title":"demo-build needs a decision","body":"Allow?","sessionId":"s1","host":"studio","target":"work:1"},{"nope":1}],"ts":1}"#))
            guard case .alerts(let items) = m else { return T.fail("not alerts") }
            T.eq(items.count, 1, "invalid item dropped")
            T.check(ServerEventMapper.notifyItem(T.json(#"{"title":"x","muted":{"until":1}}"#)) == nil, "muted object dropped")
            T.check(ServerEventMapper.notifyItem(T.json(#"{"title":"x","muted":true}"#)) == nil, "muted true dropped")
            T.check(ServerEventMapper.notifyItem(T.json(#"{"title":"x","muted":false}"#)) != nil, "muted false kept")
            T.eq(items[0].id, "k1", "key used as id")
            T.eq(items[0].category, .needsYou)
            T.eq(items[0].tmuxTarget, "work:1")
            T.check(items[0].at.timeIntervalSince1970 > 1_700_000_000, "ISO date parsed")
            if case .turn(let e) = ServerEventMapper.map(.init(event: "turn", data: #"{"id":"s1","turn":{}}"#)) { T.eq(e.sessionId, "s1") } else { T.fail("turn") }
            if case .unknown(let n) = ServerEventMapper.map(.init(event: "codex", data: "{}")) { T.eq(n, "codex") } else { T.fail("codex should be unknown") }
            if case .changed = ServerEventMapper.map(.init(event: "notify", data: "not json")) {} else { T.fail("notify is changed even with bad data") }
        }
        await T.suite("BoardBuilder") {
            let fleet = T.json(#"""
            {"ts":"2026-10-11T22:00:00.000Z","hosts":[
              {"host":"local","ok":true,"sessions":[
                {"id":"a","engine":"claude","name":"demo-build","status":"busy","live":true,"tmux":"work:1.%3","updatedAt":1760220000000},
                {"id":"b","engine":"claude","name":"demo-review","status":"idle","live":true},
                {"id":"c","engine":"codex","status":"active","live":true,"preview":"fix the parser"},
                {"id":"f","engine":"claude","name":"demo-blocked","status":"blocked","live":true},
                {"id":"d","engine":"claude","status":"transcript","live":false},
                {"id":"e","engine":"claude","name":"demo-docs","status":"idle","live":true}
              ],"windows":[{"target":"work:5","agent":{"sessionId":"e"},"screen":{"state":"dialog"}}]},
              {"host":"devbox","ok":false,"error":"ssh timed out","sessions":[]}
            ]}
            """#)
            let b = BoardBuilder.build(fleet: fleet, native: nil)
            T.eq(b.sessions.count, 5, "non-live transcript dropped")
            T.eq(b.sessions.map(\.id), ["e", "a", "c", "f", "b"], "lane order (dialog waits; codex active works; blocked is idle)")
            T.eq(b.sessions.first { $0.id == "f" }?.lane, .idle, "blocked status alone is not waiting (web UI rule)")
            T.eq(b.sessions.first { $0.id == "a" }?.tmuxTarget, "work:1", "pane suffix stripped")
            T.eq(b.sessions.first { $0.id == "e" }?.lane, .waiting, "dialog on screen -> waiting")
            T.eq(b.sessions.first { $0.id == "c" }?.name, "fix the parser", "preview as name")
            T.eq(b.hosts.map(\.name), ["local", "devbox"])
            T.eq(b.hosts[0].waiting, 1); T.eq(b.hosts[0].working, 2); T.eq(b.hosts[0].idle, 2)
            T.eq(b.hosts[1].up, false)
            let native = T.json(#"{"waiting":[{"id":"b","host":"local","kind":"question","headline":"Accept trailing commas?"}],"working":[{"id":"work:7","host":"local","name":"demo-window","engine":"claude","headline":"Compiling"}]}"#)
            let n = BoardBuilder.build(fleet: fleet, native: native)
            let sb = n.sessions.first { $0.id == "b" }
            T.eq(sb?.lane, .waiting); T.eq(sb?.waitKind, .question); T.eq(sb?.headline, "Accept trailing commas?")
            T.check(n.usedNativeSummary)
            T.eq(n.sessions.first { $0.id == "e" }?.lane, .idle, "with native present it is authoritative (no dialog heuristic)")
            T.eq(n.sessions.first { $0.id == "a" }?.lane, .idle, "not in native.working -> idle")
            let win = n.sessions.first { $0.id == "work:7" }
            T.eq(win?.lane, .working, "window-only native item added"); T.eq(win?.tmuxTarget, "work:7"); T.eq(win?.name, "demo-window")
            T.eq(n.hosts[0].working, 1, "counted"); T.check(win?.windowOnly == true, "window-only flagged")
            // A window-only item whose id is a session id known to a window gets that window's target (review 2, P2a).
            let fleet2 = T.json(#"{"hosts":[{"host":"local","sessions":[],"windows":[{"target":"work:9","agent":{"sessionId":"S"},"screen":{"state":"idle"},"held":{"from":"peer"}}]}]}"#)
            let n2 = BoardBuilder.build(fleet: fleet2, native: T.json(#"{"waiting":[],"working":[{"id":"S","host":"local","name":"demo-s"}]}"#))
            T.eq(n2.sessions.first?.tmuxTarget, "work:9"); T.check(n2.sessions.first?.windowOnly == false, "has a session id")
            // Fallback (no native): a held message counts as waiting (review 2, P2c).
            let held = T.json(#"{"hosts":[{"host":"local","sessions":[{"id":"S","status":"blocked","live":true}],"windows":[{"target":"work:9","agent":{"sessionId":"S"},"screen":{"state":"idle"},"held":{"from":"peer"}}]}]}"#)
            T.eq(BoardBuilder.build(fleet: held, native: nil).sessions.first?.lane, .waiting, "held -> waiting")
        }
        await T.suite("TranscriptMapper") {
            let page = TranscriptMapper.page(T.json(#"{"turns":[{"role":"user","text":"hi","uuid":"u1","ts":"2026-10-11T22:00:00Z"},{"role":"thinking"},{"role":"assistant","text":"ok","tools":[{"name":"Bash"}]},{"role":"weird","text":"?"}],"offset":123}"#))
            T.eq(page.turns.count, 3, "empty thinking dropped")
            T.eq(page.turns[0].id, "u1")
            T.eq(page.turns[1].tools.map(\.name), ["Bash"])
            T.eq(page.turns[2].role, .other)
            T.eq(page.offset, 123)
        }
        await T.suite("TranscriptMapper incremental vs snapshot (review #5/#6)") {
            T.check(TranscriptMapper.page(T.json(#"{"engine":"claude","turns":[],"offset":10}"#)).incremental, "claude has a cursor")
            T.check(!TranscriptMapper.page(T.json(#"{"engine":"claude","headless":true,"turns":[],"offset":300}"#)).incremental, "headless is a snapshot")
            T.check(!TranscriptMapper.page(T.json(#"{"engine":"codex","turns":[],"offset":0}"#)).incremental, "codex is a snapshot")
            T.check(!TranscriptMapper.page(T.json(#"{"engine":"openclaw","turns":[],"offset":500}"#)).incremental, "manager is a snapshot")
        }
        await T.suite("Deep links honour hosts (review #11)") {
            let model = AppModel(settings: AppSettings(defaults: UserDefaults(suiteName: "harness-\(UUID())")!, group: nil),
                                 tokens: MemoryTokenStore("x"), service: MockDroverService())
            await model.refresh()
            T.check(!model.reveal(sessionId: "manager", host: "studio"), "known host is strict: no manager on studio")
            T.eq(model.selectedSessionKey, "studio|manager", "pending key kept")
            T.check(model.reveal(sessionId: "manager", host: "Some-Hostname"), "unknown host falls back to a unique id")
            T.eq(model.selectedSession?.host, "devbox")
            T.check(!model.reveal(sessionId: "nope", host: nil), "missing")
            T.eq(model.selectedSessionKey, "local|nope", "missing host defaults to local")
        }
        await T.suite("Stale refresh after reconfigure is dropped (review #2)") {
            let slow = SlowBoardService()
            let model = AppModel(settings: AppSettings(defaults: UserDefaults(suiteName: "harness-\(UUID())")!, group: nil),
                                 tokens: MemoryTokenStore(nil), service: slow)
            let inflight = Task { await model.refresh() }
            try await Task.sleep(for: .milliseconds(50))
            model.reconfigure()          // new LiveDroverService without a token: its refresh fails fast as notConfigured
            model.stop()
            await inflight.value
            T.eq(model.board.sessions.count, 0, "old server's board must not land after reconfigure")
            T.check(!model.isRefreshing, "refresh flag released")
        }
        await T.suite("AppModel navigation + URLs") {
            let model = AppModel(settings: AppSettings(defaults: UserDefaults(suiteName: "harness-\(UUID())")!, group: nil),
                                 tokens: MemoryTokenStore("x"), service: MockDroverService())
            await model.refresh()
            T.eq(model.board.sessions.count, MockDroverService.sessions.count)
            model.selectNext(); T.eq(model.selectedSession?.name, "demo-build", "j from nothing selects first")
            model.selectNext(); T.eq(model.selectedSession?.name, "demo-review")
            model.selectPrevious(); model.selectPrevious(); T.eq(model.selectedSession?.name, "demo-build", "k clamps at top")
            model.sidebarSelection = .host("devbox")
            model.open(url: URL(string: "drover://session/33333333-demo-docs?host=studio")!)
            T.eq(model.selectedSession?.name, "demo-docs"); T.eq(model.sidebarSelection, .all, "filter cleared to reveal")
            // drover://manager is the floating panel now (WindowRouter shows it); the main window keeps its selection.
            T.eq(model.open(url: URL(string: "drover://manager")!), .manager(inWindow: false))
            T.eq(model.selectedSession?.name, "demo-docs", "selection kept")
            T.eq(model.open(url: URL(string: "drover://manager?in=window")!), .manager(inWindow: true))
            T.eq(model.sidebarSelection, .manager); T.check(model.showsManager, "manager in the detail column")
            model.select(model.board.sessions.first { $0.name == "demo-docs" })
            T.eq(model.sidebarSelection, .all, "picking a session leaves the manager")
            model.focusComposer(draft: "yes")
            T.eq(model.composerDraft[model.selectedSessionKey!], "yes"); T.eq(model.detailTab, .chat)
        }
        await T.suite("KeychainTokenStore (dummy item, unentitled fallback path)") {
            // A throwaway service so the real `dev.drover.token` items are never touched.
            let store = KeychainTokenStore(service: "dev.drover.token.harness-\(UUID().uuidString)", account: "main", accessGroup: nil)
            T.check(store.read() == nil, "starts empty")
            do {
                try store.write("dummy-value-1")
                T.eq(store.read(), "dummy-value-1", "write then read")
                try store.write("dummy-value-2")
                T.eq(store.read(), "dummy-value-2", "update")
                try store.delete()
                T.check(store.read() == nil, "deleted from both stores")
                try store.delete()
            } catch { T.fail("keychain: \(error.localizedDescription)") }
        }
        await T.suite("AppSettings") {
            let s = AppSettings(defaults: UserDefaults(suiteName: "harness-\(UUID())")!, group: nil)
            T.eq(s.serverURL?.absoluteString, "http://127.0.0.1:7337")
            s.serverURLString = "ftp://x"; T.check(s.serverURL == nil, "non-http rejected")
            s.serverURLString = " http://100.64.0.1:7337 "; T.eq(s.serverURL?.host(), "100.64.0.1")
        }
    }
}

/// Board answers after 300 ms with the mock snapshot (for the reconfigure race test).
final class SlowBoardService: DroverService, @unchecked Sendable {
    private let mock = MockDroverService()
    func board() async throws -> BoardSnapshot { try await Task.sleep(for: .milliseconds(300)); return MockDroverService.snapshot }
    func transcript(of session: SessionItem, since: Int?, limit: Int?) async throws -> TranscriptPage { try await mock.transcript(of: session, since: since, limit: limit) }
    func capture(target: String, host: String, lines: Int) async throws -> ScreenCapture { try await mock.capture(target: target, host: host, lines: lines) }
    func sendMessage(to session: SessionItem, text: String) async throws -> MessageResult { try await mock.sendMessage(to: session, text: text) }
    func sendToPane(target: String, host: String, text: String, enter: Bool, force: Bool) async throws -> PaneSendResult { try await mock.sendToPane(target: target, host: host, text: text, enter: enter, force: force) }
    func sendKeys(target: String, host: String, keys: [PaneKey]) async throws { try await mock.sendKeys(target: target, host: host, keys: keys) }
    func supportsUploads() async -> Bool { false }
    func upload(for session: SessionItem, fileName: String, mime: String, data: Data) async throws -> String { throw DroverError.unsupported("Uploads") }
    func events(onState: @escaping @Sendable (ConnectionState) -> Void) -> AsyncStream<ServerEvent> { AsyncStream { _ in } }
    func notifications(since cursor: String?, wait: Int) async throws -> NotificationPage { NotificationPage(cursor: nil, items: []) }
    func ping() async throws -> String { "slow" }
}
