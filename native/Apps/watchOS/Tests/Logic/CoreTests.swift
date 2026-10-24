import Foundation

let coreTests: [TestCase] = [
    TestCase("decodes the synthetic native.summary fixture") {
        let s = try JSONDecoder().decode(NativeSummary.self, from: try fixture("native.summary.json"))
        try expectEqual(s.hosts.count, 2)
        try expectEqual(s.hosts[1].up, false)
        try expectEqual(s.waiting.map(\.kind), [.decision, .question, .other])
        try expectEqual(s.waiting[0].key, "demo-mac/s-demo-build")
        try expect(s.waiting[0].since != nil && s.waiting[1].since != nil, "string and epoch-ms dates")
        try expect(s.waiting[2].since == nil)
        try expectEqual(s.totals.waiting, 3)
        try expectEqual(s.manager?.up, true)
        try expect(s.manager?.lastNoteAt == nil)
        try expect(s.generatedAt != nil, "fractional ISO 8601")
    },
    TestCase("decodes the repo Fixtures/native-summary*.json when core has written them") {
        let dir = URL(fileURLWithPath: ProcessInfo.processInfo.environment["DROVER_REPO_FIXTURES"] ?? "/nonexistent")
        let files = ((try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [])
            .filter { ($0.lastPathComponent.hasPrefix("native-summary") || $0.lastPathComponent.hasPrefix("native.summary")) && $0.pathExtension == "json" }
        try expect(files.count >= 2, "core's Fixtures/native-summary.json and native.summary*.json present")
        for f in files {
            let data = try Data(contentsOf: f)
            // Accept either the bare result or the {ok,result} envelope.
            let body = (try? WatchClient.unwrap(data, status: 200)) ?? data
            do { _ = try JSONDecoder().decode(NativeSummary.self, from: body) } catch {
                throw TestFailure(description: "\(f.lastPathComponent): \(error)")
            }
        }
    },
    TestCase("minimal summary decodes with defaults") {
        let s = try JSONDecoder().decode(NativeSummary.self, from: Data("{}".utf8))
        try expectEqual(s, NativeSummary())
    },
    TestCase("FlexibleDate: seconds, milliseconds, ISO with and without fraction, round trip") {
        let dec = JSONDecoder()
        let a = try dec.decode(FlexibleDate.self, from: Data("1791758100".utf8))
        let b = try dec.decode(FlexibleDate.self, from: Data("1791758100000".utf8))
        try expectEqual(a, b)
        let c = try dec.decode(FlexibleDate.self, from: Data(#""2026-10-11T22:36:00Z""#.utf8))
        let d = try dec.decode(FlexibleDate.self, from: Data(#""2026-10-11T22:36:00.000Z""#.utf8))
        try expectEqual(c, d)
        let e = try dec.decode(FlexibleDate.self, from: try JSONEncoder().encode(d))
        try expect(abs(e.date.timeIntervalSince(d.date)) < 0.001)
        try expect((try? dec.decode(FlexibleDate.self, from: Data(#""yesterday""#.utf8))) == nil)
    },
    TestCase("envelope: ok result, server error string, error object, non-JSON 500") {
        let r = try WatchClient.unwrap(envelope(#"{"a":1}"#), status: 200)
        try expectEqual(String(data: r, encoding: .utf8), #"{"a":1}"#)
        try expectEqual(String(data: try WatchClient.unwrap(envelope("null"), status: 200), encoding: .utf8), "null")
        do { _ = try WatchClient.unwrap(Data(#"{"ok":false,"error":"session not found"}"#.utf8), status: 200); throw TestFailure(description: "no throw") }
        catch let e as WatchClientError { try expectEqual(e, .server("session not found")) }
        do { _ = try WatchClient.unwrap(Data(#"{"ok":false,"error":{"message":"bad"}}"#.utf8), status: 400); throw TestFailure(description: "no throw") }
        catch let e as WatchClientError { try expectEqual(e, .server("bad")) }
        do { _ = try WatchClient.unwrap(Data("<html>".utf8), status: 502); throw TestFailure(description: "no throw") }
        catch let e as WatchClientError { try expectEqual(e, .http(502)) }
    },
    TestCase("client: POST /api/op/<op>, bearer header only, token never in URL or body") {
        StubURLProtocol.responses["sessions.message"] = (200, envelope(#"{"delivered":true}"#))
        let client = WatchClient(baseURL: URL(string: "http://127.0.0.1:7337")!, session: StubURLProtocol.session())
        try await client.sendMessage(id: "s-demo-build", host: "demo-box", text: "yes", token: "tok-SECRET")
        let r = try StubURLProtocol.recorded.first.unwrapOrThrow()
        try expectEqual(r.url.absoluteString, "http://127.0.0.1:7337/api/op/sessions.message")
        try expectEqual(r.method, "POST")
        try expectEqual(r.headers["Authorization"], "Bearer tok-SECRET")
        let body = try JSONSerialization.jsonObject(with: r.body) as? [String: String]
        try expectEqual(body, ["id": "s-demo-build", "host": "demo-box", "text": "yes", "actor": "watch"])
        try expect(!r.url.absoluteString.contains("SECRET"))
        try expect(!(String(data: r.body, encoding: .utf8) ?? "").contains("SECRET"))
    },
    TestCase("client: host local or nil is omitted") {
        try expectEqual(WatchClient.args(id: "x", host: nil), ["id": "x"])
        try expectEqual(WatchClient.args(id: "x", host: "local"), ["id": "x"])
        try expectEqual(WatchClient.args(id: "x", host: ""), ["id": "x"])
    },
    TestCase("client: 401 maps to unauthorized, transport errors map without detail") {
        StubURLProtocol.responses["native.summary"] = (401, Data(#"{"ok":false,"error":"unauthorized"}"#.utf8))
        let client = WatchClient(baseURL: URL(string: "http://127.0.0.1:7337")!, session: StubURLProtocol.session())
        try await expectThrows(WatchClientError.unauthorized) { _ = try await client.summary(token: "t") }
        StubURLProtocol.failWith = URLError(.cannotConnectToHost)
        try await expectThrows(WatchClientError.transport("Server unreachable")) { _ = try await client.summary(token: "t") }
    },
    TestCase("client: lastReply decodes null and a reply") {
        let client = WatchClient(baseURL: URL(string: "http://127.0.0.1:7337")!, session: StubURLProtocol.session())
        StubURLProtocol.responses["sessions.lastReply"] = (200, envelope("null"))
        let none = try await client.lastReply(id: "x", host: nil, token: "t")
        try expect(none == nil)
        StubURLProtocol.responses["sessions.lastReply"] = (200, envelope(#"{"id":"x","name":"demo-build","engine":"claude","text":"Done.\nShip it?","line":"Ship it?","ts":"2026-10-11T22:36:00Z","ask":{"kind":"question"}}"#))
        let r = try await client.lastReply(id: "x", host: nil, token: "t")
        try expectEqual(r?.line, "Ship it?")
        try expectEqual(r?.text, "Done.\nShip it?")
    },
    TestCase("config: normalizes URLs and strips credentials, query and trailing slash") {
        try expectEqual(WatchConfig.normalize(" http://127.0.0.1:7337/ ")?.absoluteString, "http://127.0.0.1:7337")
        try expectEqual(WatchConfig.normalize("https://user:pw@demo.example:8443/?token=abc#x")?.absoluteString, "https://demo.example:8443")
        try expect(WatchConfig.normalize("ftp://demo.example") == nil)
        try expect(WatchConfig.normalize("not a url") == nil)
        let cfg = WatchConfig(defaults: scratchDefaults())
        cfg.baseURL = URL(string: "http://100.64.0.1:7337")
        try expectEqual(cfg.baseURL?.absoluteString, "http://100.64.0.1:7337")
        try expectEqual(cfg.defaults.string(forKey: "drover.baseURL"), "http://100.64.0.1:7337")
    },
    TestCase("memory vault: set, clear with nil and empty string") {
        let v = MemoryTokenVault(main: "m", widget: nil)
        try expect(v.has(.main) && !v.has(.widget))
        try v.setToken("w", for: .widget)
        try expectEqual(v.token(.widget), "w")
        try v.setToken("", for: .main)
        try expect(!v.has(.main))
    },
    TestCase("waiting diff: only new keys, forgets items that stopped waiting") {
        let a = WaitingItem(id: "a", name: "a", host: "h1"), b = WaitingItem(id: "b", name: "b", host: "h1")
        let a2 = WaitingItem(id: "a", name: "a", host: "h2")
        var (fresh, seen) = WaitingDiff.newItems(seen: [], current: [a, b])
        try expectEqual(fresh, [a, b])
        (fresh, seen) = WaitingDiff.newItems(seen: seen, current: [a, b, a2])
        try expectEqual(fresh, [a2], "same id on another host is new")
        (fresh, seen) = WaitingDiff.newItems(seen: seen, current: [b])
        try expectEqual(fresh, [])
        (fresh, seen) = WaitingDiff.newItems(seen: seen, current: [a, b])
        try expectEqual(fresh, [a], "a waits again after it was answered")
    },
    TestCase("fetcher: widget token preferred, main only when allowed, raw result cached") {
        let raw = String(data: try fixture("native.summary.json"), encoding: .utf8)!
        StubURLProtocol.responses["native.summary"] = (200, envelope(raw))
        let cfg = WatchConfig(defaults: scratchDefaults())
        cfg.baseURL = URL(string: "http://127.0.0.1:7337")
        let cache = SummaryCache(fileURL: scratchFile())
        let seen = SeenWaitingStore(defaults: scratchDefaults())
        let mainOnly = SummaryFetcher(vault: MemoryTokenVault(main: "main-tok"), config: cfg, cache: cache, seen: seen,
                                      session: StubURLProtocol.session())
        try await expectThrows(WatchClientError.missingToken(.widget)) { _ = try await mainOnly.fetch(allowMainToken: false) }
        try expect(StubURLProtocol.recorded.isEmpty, "background never sends the main token")
        let out = try await mainOnly.fetch(allowMainToken: true)
        try expectEqual(StubURLProtocol.recorded.last?.headers["Authorization"], "Bearer main-tok")
        try expectEqual(out.newWaiting.count, 3)
        let both = SummaryFetcher(vault: MemoryTokenVault(main: "main-tok", widget: "widget-tok"), config: cfg, cache: cache,
                                  seen: seen, session: StubURLProtocol.session())
        let again = try await both.fetch(allowMainToken: true)
        try expectEqual(StubURLProtocol.recorded.last?.headers["Authorization"], "Bearer widget-tok")
        try expectEqual(again.newWaiting.count, 0, "already seen")
        // Cache holds the bare result JSON (what the complications read).
        let cached = try JSONSerialization.jsonObject(with: try Data(contentsOf: cache.fileURL)) as? [String: Any]
        try expect(cached?["ok"] == nil && cached?["waiting"] != nil)
        try expectEqual(cache.load()?.waiting.count, 3)
    },
    TestCase("fetcher: not configured without a base URL") {
        let f = SummaryFetcher(vault: MemoryTokenVault(widget: "w"), config: WatchConfig(defaults: scratchDefaults()),
                               cache: SummaryCache(fileURL: scratchFile()), seen: SeenWaitingStore(defaults: scratchDefaults()))
        try await expectThrows(WatchClientError.notConfigured) { _ = try await f.fetch(allowMainToken: true) }
    },
    TestCase("deep links: parse and build") {
        try expectEqual(DeepLink(url: URL(string: "drover://session/s-demo-build?host=demo-box")!), .session(id: "s-demo-build", host: "demo-box"))
        try expectEqual(DeepLink(url: URL(string: "drover://session/s-demo-build")!), .session(id: "s-demo-build", host: nil))
        try expectEqual(DeepLink(url: URL(string: "drover://board")!), .board)
        try expectEqual(DeepLink(url: URL(string: "drover://manager")!), .manager)
        try expect(DeepLink(url: URL(string: "drover://session")!) == nil)
        try expect(DeepLink(url: URL(string: "https://board")!) == nil)
        let l = DeepLink.session(id: "s-1", host: "demo-mac")
        try expectEqual(DeepLink(url: l.url), l)
    },
    TestCase("model: refresh loads, reports new waiting once, send needs the main token") {
        let raw = String(data: try fixture("native.summary.json"), encoding: .utf8)!
        StubURLProtocol.responses["native.summary"] = (200, envelope(raw))
        StubURLProtocol.responses["sessions.message"] = (200, envelope("{}"))
        let cfg = WatchConfig(defaults: scratchDefaults())
        cfg.baseURL = URL(string: "http://127.0.0.1:7337")
        let vault = MemoryTokenVault(widget: "w")
        let m = AppModel(vault: vault, config: cfg, cache: SummaryCache(fileURL: scratchFile()),
                         seen: SeenWaitingStore(defaults: scratchDefaults()), session: StubURLProtocol.session())
        var buzzed: [[WaitingItem]] = []
        m.onNewWaiting = { buzzed.append($0) }
        try expect(m.isConfigured && !m.canReply)
        await m.refresh()
        try expectEqual(m.phase, .loaded)
        try expectEqual(m.waiting.count, 3)
        await m.refresh()
        try expectEqual(buzzed.map(\.count), [3])
        try await expectThrows(WatchClientError.missingToken(.main)) { try await m.send("yes", to: m.waiting[0]) }
        try vault.setToken("main", for: .main)
        m.reloadCredentials()
        try expect(m.canReply)
        try await m.send("  yes  ", to: m.waiting[0])
        let sent = StubURLProtocol.recorded.first { $0.url.lastPathComponent == "sessions.message" }
        let body = try JSONSerialization.jsonObject(with: try sent.unwrapOrThrow().body) as? [String: String]
        try expectEqual(body?["text"], "yes")
        try expectEqual(sent?.headers["Authorization"], "Bearer main")
    },
    TestCase("model: refresh without config fails with a pairing message, no request") {
        let m = AppModel(vault: MemoryTokenVault(), config: WatchConfig(defaults: scratchDefaults()),
                         cache: SummaryCache(fileURL: scratchFile()), seen: SeenWaitingStore(defaults: scratchDefaults()),
                         session: StubURLProtocol.session())
        await m.refresh()
        try expectEqual(m.phase, .failed("Set the server on your iPhone"))
        try expect(StubURLProtocol.recorded.isEmpty)
    },
    TestCase("model: deep link navigates when the item is known, board pops to root") {
        let m = AppModel.preview()
        m.open(URL(string: "drover://session/s-demo-build?host=demo-mac")!)
        try expectEqual(m.path.map(\.id), ["s-demo-build"])
        try expect(m.pendingDeepLink == nil)
        m.open(URL(string: "drover://board")!)
        try expect(m.path.isEmpty && m.pendingDeepLink == nil)
        await m.refresh()
        try expectEqual(m.phase, .loaded)
    },
    TestCase("model: a --mock launch is the offline preview, --mock-session opens that item") {
        let m = AppModel.mock(arguments: ["DroverWatch", "--mock", "--mock-session", "s-demo-review"])
        try expectEqual(m.path.map(\.id), ["s-demo-review"])
        try expect(m.summary == PreviewData.summary && m.canReply)
        try expect(AppModel.mock(arguments: ["DroverWatch", "--mock"]).path.isEmpty)
        try expect(AppModel.mock(arguments: ["DroverWatch", "--mock", "--mock-session", "nope"]).path.isEmpty)
        await m.refresh()
        try expectEqual(m.phase, .loaded, "offline: nothing to fetch")
    },
    TestCase("model: unknown session link waits for the next refresh, then resolves or drops") {
        let m = AppModel.preview(summary: NativeSummary())
        m.open(URL(string: "drover://session/s-demo-build?host=demo-mac")!)
        try expect(m.path.isEmpty)
        try expectEqual(m.pendingDeepLink, .session(id: "s-demo-build", host: "demo-mac"), "kept until a refresh completes")
        await m.refresh()   // offline preview: counts as a completed refresh, item still unknown
        try expect(m.pendingDeepLink == nil && m.path.isEmpty)
    },
    TestCase("model: open() picks up a newer summary.json written in the background") {
        let raw = try fixture("native.summary.json")
        let cache = SummaryCache(fileURL: scratchFile())
        let cfg = WatchConfig(defaults: scratchDefaults())
        cfg.baseURL = URL(string: "http://127.0.0.1:7337")
        let m = AppModel(vault: MemoryTokenVault(widget: "w"), config: cfg, cache: cache,
                         seen: SeenWaitingStore(defaults: scratchDefaults()), session: StubURLProtocol.session())
        try expect(m.summary == nil)
        cache.save(raw: raw)
        m.open(URL(string: "drover://session/s-demo-build?host=demo-mac")!)
        try expectEqual(m.path.map(\.id), ["s-demo-build"])
    },
    TestCase("model: background-style refresh never falls back to the main token") {
        let cfg = WatchConfig(defaults: scratchDefaults())
        cfg.baseURL = URL(string: "http://127.0.0.1:7337")
        let m = AppModel(vault: MemoryTokenVault(main: "main-only"), config: cfg, cache: SummaryCache(fileURL: scratchFile()),
                         seen: SeenWaitingStore(defaults: scratchDefaults()), session: StubURLProtocol.session())
        await m.refresh(allowMainToken: false)
        try expect(StubURLProtocol.recorded.isEmpty, "no request with the main token")
        if case .failed = m.phase {} else { throw TestFailure(description: "expected failed, got \(m.phase)") }
    },
    TestCase("fetcher: response dropped when the server changed while in flight") {
        let raw = String(data: try fixture("native.summary.json"), encoding: .utf8)!
        StubURLProtocol.responses["native.summary"] = (200, envelope(raw))
        let cfg = WatchConfig(defaults: scratchDefaults())
        cfg.baseURL = URL(string: "http://127.0.0.1:7337")
        let cache = SummaryCache(fileURL: scratchFile())
        StubURLProtocol.onRequest = { cfg.baseURL = URL(string: "http://127.0.0.2:7337") }
        let f = SummaryFetcher(vault: MemoryTokenVault(widget: "w"), config: cfg, cache: cache,
                               seen: SeenWaitingStore(defaults: scratchDefaults()), session: StubURLProtocol.session())
        try await expectThrows(WatchClientError.superseded) { _ = try await f.fetch(allowMainToken: false) }
        try expect(cache.load() == nil, "old server's data not cached")
    },
    TestCase("fetcher: background request is a GET with the widget token, ingest validates it") {
        let cfg = WatchConfig(defaults: scratchDefaults())
        cfg.baseURL = URL(string: "http://127.0.0.1:7337")
        let vault = MemoryTokenVault(main: "main-tok", widget: "widget-tok")
        let cache = SummaryCache(fileURL: scratchFile())
        let f = SummaryFetcher(vault: vault, config: cfg, cache: cache, seen: SeenWaitingStore(defaults: scratchDefaults()))
        let req = try f.backgroundRequest().unwrapOrThrow()
        try expectEqual(req.httpMethod, "GET")
        try expectEqual(req.url?.absoluteString, "http://127.0.0.1:7337/api/op/native.summary")
        try expectEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer widget-tok")
        try expect(req.httpBody == nil)
        let body = envelope(String(data: try fixture("native.summary.json"), encoding: .utf8)!)
        let out = try f.ingest(data: body, status: 200, request: req)
        try expectEqual(out.newWaiting.count, 3)
        try expectEqual(cache.load()?.waiting.count, 3)
        try expect(throws: WatchClientError.unauthorized) { _ = try f.ingest(data: Data(), status: 403, request: req) }
        try vault.setToken("rotated", for: .widget)
        try expect(throws: WatchClientError.superseded) { _ = try f.ingest(data: body, status: 200, request: req) }
        try vault.setToken("widget-tok", for: .widget)
        cfg.baseURL = URL(string: "http://127.0.0.2:7337")
        try expect(throws: WatchClientError.superseded) { _ = try f.ingest(data: body, status: 200, request: req) }
        try vault.setToken(nil, for: .widget)
        try expect(f.backgroundRequest() == nil, "never falls back to the main token")
    },
    TestCase("envelope: server error text has the call token redacted") {
        let data = Data(#"{"ok":false,"error":"bad token tok-SECRET-9 for op"}"#.utf8)
        do { _ = try WatchClient.unwrap(data, status: 400, redacting: "tok-SECRET-9"); throw TestFailure(description: "no throw") }
        catch let e as WatchClientError { try expectEqual(e, .server("bad token [redacted] for op")) }
    },
    TestCase("deep links: ids with an encoded slash stay one component") {
        let l = DeepLink.session(id: "group/session", host: "demo-mac")
        try expect(l.url.absoluteString.contains("group%2Fsession"), l.url.absoluteString)
        try expectEqual(DeepLink(url: l.url), l)
        try expectEqual(DeepLink(url: URL(string: "drover://session/group%2Fsession")!), .session(id: "group/session", host: nil))
    },
    TestCase("model: clearData resets navigation") {
        let m = AppModel.preview()
        m.open(URL(string: "drover://session/s-demo-build?host=demo-mac")!)
        try expect(!m.path.isEmpty)
        m.clearData()
        try expect(m.path.isEmpty)
    },
    TestCase("sync payload: decode keys, redacted description") {
        let p = try WatchSyncPayload(userInfo: ["drover.baseURL": "http://127.0.0.1:7337", "drover.token": "SECRET-1", "drover.widgetToken": ""]).unwrapOrThrow()
        try expectEqual(p.token, "SECRET-1")
        try expectEqual(p.widgetToken, "")
        try expect(WatchSyncPayload(userInfo: ["other": 1]) == nil)
        let printed = "\(p) \(String(describing: p)) \(String(reflecting: p))"
        var dumped = ""; dump(p, to: &dumped)
        try expect(!printed.contains("SECRET") && !dumped.contains("SECRET"), "tokens redacted")
        try expect(printed.contains("[redacted]") && printed.contains("clear"))
        try expectEqual(WatchSyncPayload(userInfo: p.userInfo), p)
    },
]

extension Optional {
    func unwrapOrThrow(file: StaticString = #fileID, line: UInt = #line) throws -> Wrapped {
        guard let v = self else { throw TestFailure(description: "\(file):\(line): unexpected nil") }
        return v
    }
}

func repoFixture(_ name: String) throws -> Data {
    let dir = ProcessInfo.processInfo.environment["DROVER_REPO_FIXTURES"] ?? "Fixtures"
    return try Data(contentsOf: URL(fileURLWithPath: dir).appending(path: name))
}

let coreModelExtraTests: [TestCase] = [
    TestCase("repo fixtures: error envelopes and sessions.message map as the client expects") {
        let client = WatchClient(baseURL: URL(string: "http://127.0.0.1:7337")!, session: StubURLProtocol.session())
        StubURLProtocol.responses["native.summary"] = (401, try repoFixture("error.unauthorized.json"))
        try await expectThrows(WatchClientError.unauthorized) { _ = try await client.summary(token: "t") }
        StubURLProtocol.responses["sessions.message"] = (200, try repoFixture("error.op.json"))
        try await expectThrows(WatchClientError.server("session not found")) {
            try await client.sendMessage(id: "x", host: nil, text: "yes", token: "t")
        }
        StubURLProtocol.responses["sessions.message"] = (200, try repoFixture("sessions.message.json"))
        try await client.sendMessage(id: "x", host: nil, text: "yes", token: "t")
        let empty = try JSONDecoder().decode(NativeSummary.self,
                                             from: try WatchClient.unwrap(try repoFixture("native.summary.empty.json"), status: 200))
        try expect(empty.waiting.isEmpty && empty.hosts.first?.name == "local")
    },
    TestCase("fetcher: an older snapshot never overwrites a newer cache") {
        let cache = SummaryCache(fileURL: scratchFile())
        let seen = SeenWaitingStore(defaults: scratchDefaults())
        let f = SummaryFetcher(vault: MemoryTokenVault(widget: "w"), config: WatchConfig(defaults: scratchDefaults()),
                               cache: cache, seen: seen)
        let item = WaitingItem(id: "s1", name: "demo-build", host: "local")
        let newer = NativeSummary(generatedAt: FlexibleDate(Date(timeIntervalSince1970: 2000)), waiting: [])
        let older = NativeSummary(generatedAt: FlexibleDate(Date(timeIntervalSince1970: 1000)), waiting: [item])
        _ = f.commit(newer, raw: try JSONEncoder().encode(newer))
        let out = f.commit(older, raw: try JSONEncoder().encode(older))
        try expect(out.newWaiting.isEmpty, "answered session not announced again")
        try expect(cache.load()?.waiting.isEmpty == true, "cache keeps the newer snapshot")
    },
    TestCase("fetcher: credentials snapshot pairs one server with one token, isCurrent tracks changes") {
        let cfg = WatchConfig(defaults: scratchDefaults())
        let vault = MemoryTokenVault(main: "m", widget: "w")
        let f = SummaryFetcher(vault: vault, config: cfg, cache: SummaryCache(fileURL: scratchFile()),
                               seen: SeenWaitingStore(defaults: scratchDefaults()))
        try expect(throws: WatchClientError.notConfigured) { _ = try f.credentials(allowMainToken: true) }
        cfg.baseURL = URL(string: "http://127.0.0.1:7337")
        let c = try f.credentials(allowMainToken: false)
        try expectEqual(c.token, "w")
        try expect(f.isCurrent(c))
        try vault.setToken(nil, for: .widget)
        try expect(!f.isCurrent(c), "token removed")
        try expectEqual(try f.credentials(allowMainToken: true).token, "m")
        try expect(throws: WatchClientError.missingToken(.widget)) { _ = try f.credentials(allowMainToken: false) }
    },
    TestCase("model: clearData drops the summary and pending link") {
        let m = AppModel.preview(summary: NativeSummary())
        m.open(URL(string: "drover://session/x")!)
        m.clearData()
        try expect(m.summary == nil && m.lastUpdated == nil && m.pendingDeepLink == nil)
        try expectEqual(m.phase, .idle)
    },
]
