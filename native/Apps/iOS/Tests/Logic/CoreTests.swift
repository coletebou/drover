import Foundation

extension Suites {
    /// Add suites here; other test files append theirs in `Suites.extra` (see Background tests).
    static var all: [(String, () async throws -> Void)] {
        [("models", models), ("sse", sse), ("deeplinks", deeplinks), ("pair links", pairLinks), ("pairing save", pairingSave),
         ("urls", urls), ("mock", mock), ("mock launch", mockLaunch), ("fixtures", FixtureTests.run),
         ("review fixes", reviewFixes)] + extra
    }

    static func models() throws {
        let s = try decode(NativeSummary.self, """
        {"generatedAt":"2026-10-11T18:00:00.000Z","hosts":[{"name":"local","up":true,"waiting":1,"working":0,"idle":2}],
         "waiting":[{"id":"abc","name":"demo-build","host":"local","engine":"claude","since":1791000000000,"kind":"decision","headline":"Allow?"}],
         "working":[],"totals":{"waiting":1,"working":0,"idle":2,"hosts":1},"manager":{"up":true,"lastNoteAt":null}}
        """)
        expect(s.waiting.first?.ref == SessionRef(id: "abc", host: "local"), "waiting ref")
        expect(s.waiting.first?.since?.date == Date(timeIntervalSince1970: 1_791_000_000), "ms date")
        expect(s.generatedAt != nil, "iso fractional date")
        let rt = try JSONDecoder().decode(NativeSummary.self, from: JSONEncoder().encode(s))
        expect(rt == s, "summary round trip")

        let list = try decode(SessionList.self, """
        {"sessions":[{"id":"s1","engine":"claude","name":"demo","status":"busy","tmux":"demo:@1.%1","live":true,"startedAt":1791000000000},
                     {"id":"t1","engine":"codex","live":false,"status":"rollout","cwd":null},
                     {"id":"h1","engine":"weird-new-engine","tmux":{"unexpected":"object"}}],"host":"Mb"}
        """)
        expect(list.sessions.count == 3, "three sessions")
        expect(list.sessions[2].engine == .unknown, "unknown engine tolerated")
        expect(list.sessions[2].tmux == nil, "non-string tmux tolerated")

        let page = try decode(TranscriptPage.self, """
        {"engine":"claude","turns":[{"role":"assistant","ts":"2026-10-11T18:00:00Z","uuid":"u1","text":"hi","tools":[{"name":"Bash","input":{}}]},
          {"role":"tool_result","count":2,"text":"ok"}],"offset":4096,"summary":{"x":1}}
        """)
        expect(page.offset == 4096 && page.turns.count == 2, "transcript page")
        expect(page.turns[0].toolNames == ["Bash"], "tool names")

        let msg = try decode(MessageResult.self, #"{"delivery":{"ok":true,"queuedBehindTurn":true}}"#)
        expect(msg.ok == true && msg.queuedBehindTurn == true, "nested delivery")
        let feed = try decode(NotificationFeed.self, #"{"cursor":42,"items":[{"id":"n1","title":"t","sessionId":"s","host":"local"}]}"#)
        expect(feed.cursor?.value == "42" && feed.items.first?.ref?.id == "s", "feed numeric cursor")
    }

    static func sse() {
        var p = SSEParser()
        var got: [ServerEvent] = []
        for l in ["event: hello", "data: {\"a\":1}", "", ": ping", "", "event: mutation", "data: {}", "event: x", "data: 1"] {
            if let e = p.feed(l) { got.append(e) }
        }
        if let e = p.flush() { got.append(e) }
        expect(got.map(\.name) == ["hello", "mutation", "x"], "sse names \(got.map(\.name))")
        expect(got.first?.data == "{\"a\":1}", "sse data")
    }

    static func deeplinks() {
        expect(DeepLink(url: URL(string: "drover://session/abc-1?host=demo-box")!) == .session(SessionRef(id: "abc-1", host: "demo-box")), "session link")
        expect(DeepLink(url: URL(string: "drover://session/abc")!) == .session(SessionRef(id: "abc", host: nil)), "session link no host")
        expect(DeepLink(url: URL(string: "drover://board")!) == .board, "board link")
        expect(DeepLink(url: URL(string: "drover://manager")!) == .manager, "manager link")
        expect(DeepLink(url: URL(string: "https://board")!) == nil, "wrong scheme")
        expect(DeepLink(url: URL(string: "drover://session/")!) == nil, "empty id")
        expect(SessionRef(id: "a", host: "local").hostArg == nil, "local host omitted")

        func pair(_ s: String) -> DeepLink? { DeepLink(url: URL(string: s)!) }
        expect(pair("drover://pair?url=http%3A%2F%2F100.64.0.1%3A7337") == .pair(URL(string: "http://100.64.0.1:7337")!), "pair link")
        expect(pair("drover://pair?url=https%3A%2F%2Fmac.example.ts.net%3A8446%2F") == .pair(URL(string: "https://mac.example.ts.net:8446")!),
               "pair link, https, trailing slash trimmed")
        expect(pair("drover://pair?url=https://mac.example.ts.net:8446/drover") == .pair(URL(string: "https://mac.example.ts.net:8446/drover")!),
               "pair link, unencoded, with a path")
        expect(pair("drover://pair?url=ftp%3A%2F%2F100.64.0.1") == nil, "pair link: http and https only")
        expect(pair("drover://pair?url=javascript%3Aalert(1)") == nil, "pair link: no other schemes")
        expect(pair("drover://pair?url=100.64.0.1%3A7337") == nil, "pair link: the scheme is required")
        expect(pair("drover://pair?url=http%3A%2F%2F100.64.0.1%3A7337&token=abc") == nil, "pair link never carries a token")
        expect(pair("drover://pair?token=abc&url=http%3A%2F%2F100.64.0.1%3A7337") == nil, "not even first")
        expect(pair("drover://pair?url=http%3A%2F%2F100.64.0.1%3A7337%2F%3Ftoken%3Dabc") == nil, "no query inside the address")
        expect(pair("drover://pair?url=http%3A%2F%2Fu%3Asecret%40100.64.0.1%3A7337") == nil, "no credentials in the address")
        expect(pair("drover://pair?url=http%3A%2F%2F100.64.0.1%23frag") == nil, "no fragment")
        expect(pair("drover://pair?url=") == nil && pair("drover://pair") == nil, "pair link needs an address")
    }

    static func pairLinks() {
        func starts(_ link: String, configured: String?) -> Bool {
            PairLinkPolicy.startsAutomatically(link: URL(string: link)!, configured: configured.map { URL(string: $0)! })
        }
        expect(!starts("http://100.64.0.1:7337", configured: nil), "fresh install: a link only fills in the address")
        expect(!starts("https://evil.example", configured: nil), "fresh install: an attacker's link waits for a tap")
        expect(starts("http://100.64.0.1:7337", configured: "http://100.64.0.1:7337"), "same daemon: pair again at once")
        expect(starts("http://100.64.0.1:7337", configured: "http://100.64.0.1:7337/"), "same daemon, trailing slash")
        expect(starts("HTTPS://MAC.Example.TS.NET:8446/drover", configured: "https://mac.example.ts.net:8446/drover"),
               "scheme and host case are ignored")
        expect(!starts("https://mac.example.ts.net:8446/Team", configured: "https://mac.example.ts.net:8446/team"),
               "path case is kept: a proxy can route /Team and /team to different daemons")
        expect(!starts("http://100.64.0.2:7337", configured: "http://100.64.0.1:7337"), "another daemon waits for a tap")
        expect(!starts("http://100.64.0.1:7338", configured: "http://100.64.0.1:7337"), "another port is another daemon")
        expect(!starts("https://evil.example", configured: "http://100.64.0.1:7337"), "an attacker's link waits for a tap")
        let note = PairLinkPolicy.confirmation(for: URL(string: "https://evil.example:8443")!)
        expect(note.contains("https://evil.example:8443") && note.contains("Pair with Mac"), "the note names the address and the button")
    }

    /// A pairing approval without a widget token deletes the stored one through the vault's delete path, never
    /// writing an empty token. Runs the real save path against a throwaway Keychain service and defaults suite.
    @MainActor
    static func pairingSave() async throws {
        expect(PairingSave.widgetChange(nil) == .delete, "no widget token from the daemon deletes ours")
        expect(PairingSave.widgetChange("") == .delete, "an empty one is never stored")
        expect(PairingSave.widgetChange("w") == .store("w"), "a widget token is stored")
        let vault = TokenVault(service: "dev.drover.token.logic-\(UUID().uuidString)", accessGroup: nil)
        let suite = "drover-logic-\(UUID().uuidString)"
        defer {
            try? vault.delete(.main)
            try? vault.delete(.widget)
            UserDefaults().removePersistentDomain(forName: suite)
        }
        try vault.write("old-widget", for: .widget)
        expect(vault.read(.widget) == "old-widget", "set up: an older daemon's widget token")
        let m = AppModel(api: MockDroverAPI(delay: .zero), vault: vault, settings: SharedSettings(suiteName: suite))
        try m.configure(baseURL: "http://127.0.0.1:9", mainToken: .store("main-secret"), widgetToken: PairingSave.widgetChange(nil))
        expect(vault.read(.main) == "main-secret", "main token stored")
        expect(vault.read(.widget) == nil, "widget item deleted, not left empty")
        expect(m.settings.baseURL == URL(string: "http://127.0.0.1:9")!, "address saved")
        try m.configure(baseURL: "http://127.0.0.1:9", mainToken: .keep, widgetToken: .delete)
        expect(vault.read(.main) == "main-secret" && vault.read(.widget) == nil, "keep leaves a token, deleting nothing is fine")
    }

    static func urls() {
        expect(SharedSettings.normalizedURL("127.0.0.1:7337")?.absoluteString == "http://127.0.0.1:7337", "bare host")
        expect(SharedSettings.normalizedURL(" https://box.example.ts.net:7337/ ")?.absoluteString == "https://box.example.ts.net:7337", "trim")
        expect(SharedSettings.normalizedURL("ftp://x") == nil, "reject ftp")
        expect(SharedSettings.normalizedURL("") == nil, "reject empty")
    }

    @MainActor
    static func mock() async {
        let m = AppModel.preview()
        await m.refreshAll()
        expect(m.summary?.totals.waiting == 2, "mock summary")
        expect(m.sessions.contains { $0.host == "demo-box" }, "sessions across hosts")
        expect(m.boardState(for: SessionRef(id: "11111111-aaaa-4bbb-8ccc-000000000001", host: "local")) == .waiting, "board state")
        m.handle(url: URL(string: "drover://session/thread-demo-review?host=demo-box")!)
        expect(m.selectedTab == .sessions && m.sessionsSelection?.host == "demo-box", "deep link opens session")
        m.handle(url: URL(string: "drover://session/manager")!)
        expect(m.selectedTab == .manager, "manager id opens manager tab")
        expect(m.handle(url: URL(string: "drover://pair?url=http%3A%2F%2F127.0.0.1%3A7337")!), "pair link handled")
        expect(m.selectedTab == .settings && m.pendingPairURL == URL(string: "http://127.0.0.1:7337")!, "pair link opens Settings with the address")
        m.pendingPairURL = nil
        expect(!m.handle(url: URL(string: "drover://pair?url=http%3A%2F%2F127.0.0.1%3A7337&token=abc")!), "token-carrying link refused")
        expect(m.pendingPairURL == nil, "and leaves nothing to pair with")
    }

    /// `--mock` launches pick the first screen from their arguments and keep out of the Keychain and the App Group.
    @MainActor
    static func mockLaunch() throws {
        let tab = AppModel.mock(arguments: ["Drover", "--mock", "--mock-tab", "manager"])
        expect(tab.selectedTab == .manager && tab.hasMainToken, "--mock-tab picks the tab")
        expect(AppModel.mock(arguments: ["Drover", "--mock", "--mock-tab", "nope"]).selectedTab == .board, "unknown tab ignored")
        let open = AppModel.mock(arguments: ["Drover", "--mock", "--mock-session", "thread-demo-review"])
        expect(open.selectedTab == .board && open.boardSelection == SessionRef(id: "thread-demo-review", host: "demo-box"),
               "--mock-session opens the fixture session, host included")
        expect(!open.vault.usesKeychain && open.settings.suiteName != DroverIDs.appGroup, "no Keychain, no App Group")
        let service = "dev.drover.token.logic-\(UUID().uuidString)"
        defer { try? TokenVault(service: service, accessGroup: nil).delete(.main) }
        try TokenVault(service: service, accessGroup: nil, usesKeychain: false).write("main-secret", for: .main)
        expect(TokenVault(service: service, accessGroup: nil).read(.main) == nil, "a write off the Keychain stores nothing")
    }
}

extension Suites {
    static func reviewFixes() async throws {
        // Repeated uuid-less turns (Codex) stay distinct.
        let page = try decode(TranscriptPage.self, #"{"engine":"codex","turns":[{"role":"user","text":"continue"},{"role":"user","text":"continue"}],"offset":0}"#)
        expect(Set(page.turns.map(\.id)).count == 2, "repeated turns keep distinct ids")
        // Throttle: one claim per window.
        var t = LiveThrottle(); let now = ContinuousClock.now
        expect(t.claim(.summary, at: now, window: .seconds(1)), "first claim")
        expect(!t.claim(.summary, at: now + .milliseconds(500), window: .seconds(1)), "throttled inside window")
        expect(t.claim(.sessions, at: now, window: .seconds(1)), "channels independent")
        expect(t.claim(.summary, at: now + .milliseconds(1500), window: .seconds(1)), "claim after window")
        expect(LiveEventKind(name: "alerts") == .alerts && LiveEventKind(name: "turn") == .board && LiveEventKind(name: "x") == .ignore, "event kinds")
        // SingleFlight: overlapping calls run the work at most twice (one run plus one rerun), never in parallel.
        let counter = await MainActor.run { () -> (SingleFlight, Box) in (SingleFlight(), Box()) }
        await withTaskGroup(of: Void.self) { g in
            for _ in 0..<5 {
                g.addTask { await counter.0.run { counter.1.n += 1; try? await Task.sleep(for: .milliseconds(30)) } }
            }
        }
        let runs = await MainActor.run { counter.1.n }
        expect(runs >= 1 && runs <= 2, "single flight coalesces (\(runs) runs)")
        // A caller arriving during a run waits for at most two runs even while calls keep coming.
        let flight = await MainActor.run { SingleFlight() }
        let feeder = Task { for _ in 0..<40 { Task { await flight.run { try? await Task.sleep(for: .milliseconds(20)) } }; try? await Task.sleep(for: .milliseconds(5)) } }
        try? await Task.sleep(for: .milliseconds(10))
        let start = ContinuousClock.now
        await flight.run { try? await Task.sleep(for: .milliseconds(20)) }
        let waited = ContinuousClock.now - start
        feeder.cancel()
        expect(waited < .milliseconds(150), "bounded wait under sustained calls (\(waited))")
        // Unconfigured client never fabricates data.
        do { _ = try await UnconfiguredDroverAPI().summary(); expect(false, "unconfigured throws") }
        catch { expect((error as? DroverError) == .notConfigured, "unconfigured error") }
    }
}

@MainActor final class Box { var n = 0 }
