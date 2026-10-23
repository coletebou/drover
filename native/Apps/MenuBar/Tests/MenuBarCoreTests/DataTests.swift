import Foundation
import Testing
@testable import MenuBarCore

// MARK: - Fake transport

final class FakeTransport: HTTPTransport, @unchecked Sendable { // lock guards all mutable state
    typealias DataHandler = @Sendable (URLRequest) throws -> (Int, Data)
    typealias LinesHandler = @Sendable (URLRequest, Int) throws -> (Int, [String])

    private let lock = NSLock()
    private var _requests: [URLRequest] = []
    private var _streamCalls = 0
    var dataHandler: DataHandler
    var linesHandler: LinesHandler

    init(data: @escaping DataHandler = { _ in (404, Data()) },
         lines: @escaping LinesHandler = { _, _ in (404, []) }) {
        dataHandler = data
        linesHandler = lines
    }

    var requests: [URLRequest] { lock.withLock { _requests } }
    func requests(path: String) -> [URLRequest] { requests.filter { $0.url?.path == path } }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        lock.withLock { _requests.append(request) }
        let (code, body) = try dataHandler(request)
        return (body, Self.response(request, code))
    }

    func lines(for request: URLRequest) async throws -> (AsyncThrowingStream<String, Error>, HTTPURLResponse) {
        let n = lock.withLock { () -> Int in _requests.append(request); _streamCalls += 1; return _streamCalls }
        let (code, lines) = try linesHandler(request, n)
        let stream = AsyncThrowingStream<String, Error> { c in
            lines.forEach { c.yield($0) }
            c.finish()
        }
        return (stream, Self.response(request, code))
    }

    static func response(_ r: URLRequest, _ code: Int) -> HTTPURLResponse {
        HTTPURLResponse(url: r.url!, statusCode: code, httpVersion: nil, headerFields: nil)!
    }
}

let baseURL = URL(string: "http://127.0.0.1:7337")!
let secret = "tok-SECRET-123"

func envelope(_ fixture: String = "summary-envelope") throws -> Data { try Fixtures.data(fixture) }

func bodyJSON(_ body: Data?) throws -> [String: Any] {
    let data = try #require(body)
    return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
}

func okBody(_ json: String) -> Data { Data(#"{"ok":true,"result":\#(json)}"#.utf8) }

func client(_ transport: FakeTransport, tokens: [TokenKind: String] = [.main: secret, .widget: "w-" + secret]) -> DroverClient {
    DroverClient(baseURL: baseURL, tokens: StaticTokens(tokens), transport: transport)
}

// MARK: - SSE parser

@Suite struct SSEParserTests {
    private func run(_ lines: [String]) -> [SSEEvent] {
        var p = SSEParser()
        return lines.compactMap { p.feed($0) }
    }

    @Test func multiLineDataAndName() {
        let e = run(["event: mutation", "data: a", "data: b", "id: 7", ""])
        #expect(e == [SSEEvent(event: "mutation", data: "a\nb", id: "7")])
    }

    @Test func defaultsToMessage() {
        #expect(run(["data: x", ""]) == [SSEEvent(event: "message", data: "x", id: nil)])
    }

    @Test func commentsIgnored() {
        #expect(run([": ping", ""]).isEmpty)
        #expect(run([": ping", "data: x", ""]).count == 1)
    }

    @Test func noSpaceAfterColonAndOnlyOneStripped() {
        #expect(run(["data:x", ""]).first?.data == "x")
        #expect(run(["data:  x", ""]).first?.data == " x")
    }

    @Test func dataLessBlockIgnoredAndStateResets() {
        let e = run(["event: probe", "", "data: y", ""])
        #expect(e == [SSEEvent(event: "message", data: "y", id: nil)])
    }

    @Test func unknownFieldsAndRetryIgnored() {
        #expect(run(["retry: 5", "foo: bar", "data: z", ""]).first?.data == "z")
    }

    @Test func splitterStripsCRLFAndKeepsBlankLines() {
        var s = LineSplitter()
        var out: [String] = []
        for b in Array("event: a\r\ndata: 1\r\n\r\n".utf8) { if let l = s.feed(b) { out.append(l) } }
        #expect(out == ["event: a", "data: 1", ""])
        #expect(run(out).count == 1)
    }
}

// MARK: - Client

@Suite struct DroverClientTests {
    @Test func summaryEnvelopeAndRequestShape() async throws {
        let body = try envelope()
        let t = FakeTransport(data: { _ in (200, body) })
        let s = try await client(t).summary(token: .widget)
        #expect(s.totals.waiting == 2)
        let r = try #require(t.requests.first)
        #expect(r.httpMethod == "POST")
        #expect(r.url?.path == "/api/op/native.summary")
        #expect(r.value(forHTTPHeaderField: "Authorization") == "Bearer w-" + secret)
        #expect(r.value(forHTTPHeaderField: "Content-Type") == "application/json")
    }

    @Test func mainTokenKindUsed() async throws {
        let t = FakeTransport(data: { _ in (200, okBody("{}")) })
        try await client(t).sweep()
        #expect(t.requests.first?.value(forHTTPHeaderField: "Authorization") == "Bearer " + secret)
    }

    @Test func bodyContainsArgs() async throws {
        let t = FakeTransport(data: { _ in (200, okBody("{}")) })
        try await client(t).sendMessage(id: "s-1", host: "demo-box", text: "hello")
        let r = try #require(t.requests.first)
        #expect(r.url?.path == "/api/op/sessions.message")
        let json = try bodyJSON(r.httpBody)
        #expect(json["id"] as? String == "s-1")
        #expect(json["text"] as? String == "hello")
        #expect(json["host"] as? String == "demo-box")
        #expect(json["actor"] as? String == AppIdentifiers.actor)
    }

    @Test func emptyHostOmitted() async throws {
        let t = FakeTransport(data: { _ in (200, okBody("{}")) })
        try await client(t).sendMessage(id: "s-1", host: "", text: "hi")
        let json = try bodyJSON(t.requests.first?.httpBody)
        #expect(json["host"] == nil)
    }

    @Test func notificationsArgsOmittedWhenNil() async throws {
        let t = FakeTransport(data: { _ in (200, okBody(#"{"cursor":"c","items":[]}"#)) })
        let page = try await client(t).notifications(since: nil, wait: nil, limit: 5, token: .widget)
        #expect(page.cursor == "c")
        let json = try bodyJSON(t.requests.first?.httpBody)
        #expect(json["since"] == nil && json["wait"] == nil && json["limit"] as? Int == 5)
    }

    @Test(arguments: [401, 403])
    func unauthorized(code: Int) async {
        let t = FakeTransport(data: { _ in (code, Data(#"{"ok":false,"error":"nope"}"#.utf8)) })
        await #expect(throws: DroverError.unauthorized) { try await client(t).summary(token: .main) }
    }

    @Test func serverErrorOnNon2xxAndOkFalse() async {
        let t1 = FakeTransport(data: { _ in (500, Data(#"{"ok":false,"error":"boom"}"#.utf8)) })
        await #expect(throws: DroverError.server("boom")) { try await client(t1).summary(token: .main) }
        let t2 = FakeTransport(data: { _ in (200, Data(#"{"ok":false,"error":"bad op"}"#.utf8)) })
        await #expect(throws: DroverError.server("bad op")) { try await client(t2).summary(token: .main) }
        let t3 = FakeTransport(data: { _ in (502, Data("<html>".utf8)) })
        await #expect(throws: DroverError.http(502)) { try await client(t3).summary(token: .main) }
    }

    @Test func decodingFailure() async {
        let t = FakeTransport(data: { _ in (200, Data("nonsense".utf8)) })
        do {
            _ = try await client(t).summary(token: .main)
            Issue.record("expected throw")
        } catch let e as DroverError {
            guard case .decoding = e else { Issue.record("wrong error \(e)"); return }
        } catch { Issue.record("wrong error") }
    }

    @Test func missingTokenMakesNoRequest() async {
        let t = FakeTransport(data: { _ in (200, okBody("{}")) })
        let c = client(t, tokens: [.widget: "w"])
        await #expect(throws: DroverError.missingToken(.main)) { try await c.sweep() }
        #expect(t.requests.isEmpty)
        #expect(throws: DroverError.missingToken(.main)) { try c.streamRequest() }
    }

    @Test func transportErrorHasNoURLOrToken() async {
        let t = FakeTransport(data: { _ in throw URLError(.cannotConnectToHost) })
        do {
            _ = try await client(t).summary(token: .main)
            Issue.record("expected throw")
        } catch let e as DroverError {
            #expect(e == .transport("Cannot reach the server."))
        } catch { Issue.record("wrong error") }
    }

    @Test func noTokenInAnyUserMessage() {
        let errors: [DroverError] = [.notConfigured, .missingToken(.main), .missingToken(.widget), .unauthorized,
                                  .http(500), .decoding("x"), .transport("Cannot reach the server.")]
        for e in errors { #expect(!e.userMessage.contains(secret) && !e.userMessage.contains("http:")) }
    }

    @Test func streamRequestUsesHeaderNotQuery() throws {
        let r = try client(FakeTransport()).streamRequest()
        #expect(r.url?.path == "/api/stream")
        #expect(r.url?.query == nil)
        #expect(r.value(forHTTPHeaderField: "Authorization") == "Bearer " + secret)
        #expect(r.value(forHTTPHeaderField: "Accept") == "text/event-stream")
    }
}

// MARK: - Event stream

final class Sleeps: @unchecked Sendable { // lock guards the array
    private let lock = NSLock()
    private var values: [Duration] = []
    func add(_ d: Duration) { lock.withLock { values.append(d) } }
    var all: [Duration] { lock.withLock { values } }
}

@Suite struct EventStreamTests {
    private func seconds(_ d: Duration) -> Double {
        Double(d.components.seconds) + Double(d.components.attoseconds) / 1e18
    }

    @Test func reconnectsWithBackoffThenStopsOn401() async {
        let sleeps = Sleeps()
        let t = FakeTransport(lines: { _, n in
            switch n {
            case 1, 2: throw URLError(.cannotConnectToHost)
            case 3: return (200, ["event: fleet", "data: {}", "", "event: hello", "data: 1", ""])
            default: return (401, [])
            }
        })
        let stream = EventStream(
            makeRequest: { try client(FakeTransport()).streamRequest() }, transport: t,
            sleep: { sleeps.add($0) })
        var updates: [StreamUpdate] = []
        for await u in stream.updates() { updates.append(u) }
        #expect(updates.last == .disconnected(.unauthorized))
        let events = updates.compactMap { u -> String? in if case .event(let e) = u { e.event } else { nil } }
        #expect(events == ["fleet", "hello"])
        #expect(updates.contains(.connected))
        #expect(t.requests.count == 4)
        let d = sleeps.all.map(seconds)
        #expect(d.count == 3)
        // 1 s, 2 s, 4 s: a short-lived connection (even one that sent `hello`) does not reset the
        // backoff; each with up to 20% jitter.
        let base = [1.0, 2.0, 4.0]
        for (x, b) in zip(d, base) { #expect(x >= b && x <= b * 1.2 + 0.001) }
    }

    @Test func cancellingConsumerStopsTask() async {
        let t = FakeTransport(lines: { _, _ in (200, []) })
        let stream = EventStream(
            makeRequest: { try client(FakeTransport()).streamRequest() }, transport: t,
            sleep: { _ in try await Task.sleep(for: .seconds(60)) })
        let consumer = Task { for await _ in stream.updates() {} }
        try? await Task.sleep(for: .milliseconds(50))
        consumer.cancel()
        await consumer.value
        let count = t.requests.count
        try? await Task.sleep(for: .milliseconds(50))
        #expect(t.requests.count == count)
    }
}

// MARK: - Cache

@Suite struct SummaryCacheTests {
    @Test func roundTripIsBareObject() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("drover-cache-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let s = Summary.preview
        try SummaryCache.write(s, to: dir)
        #expect(SummaryCache.read(from: dir) == s)
        let raw = try Data(contentsOf: dir.appendingPathComponent(AppIdentifiers.summaryCacheFile))
        let json = try #require(JSONSerialization.jsonObject(with: raw) as? [String: Any])
        #expect(json["generatedAt"] != nil)
        #expect(json["ok"] == nil)
    }

    @Test func readMissingIsNil() {
        #expect(SummaryCache.read(from: URL(fileURLWithPath: "/nonexistent-drover-dir")) == nil)
    }
}

// MARK: - Store

@MainActor
@Suite struct MenuBarStoreTests {
    private func summaryBody(_ s: Summary) throws -> Data {
        okBody(String(decoding: try JSONEncoder().encode(s), as: UTF8.self))
    }

    private func makeStore(_ t: FakeTransport, tokens: [TokenKind: String] = [.main: secret]) -> MenuBarStore {
        MenuBarStore(preferences: { .default }, tokens: StaticTokens(tokens), transport: t)
    }

    private func withWaiting(_ ids: [String], generatedAt: String = "t") -> Summary {
        var s = Summary.empty
        s.generatedAt = generatedAt
        s.waiting = ids.map { WaitingItem(id: $0, name: $0, host: "local", engine: "claude", since: nil, kind: .question, headline: "h") }
        s.totals.waiting = ids.count
        return s
    }

    /// A transport whose summary response can be swapped between calls.
    private final class Box: @unchecked Sendable { // lock guards body
        private let lock = NSLock()
        private var _body = Data()
        var body: Data { get { lock.withLock { _body } } set { lock.withLock { _body = newValue } } }
    }

    @Test func baselineThenNewWaitingThenGeneratedAtOnly() async throws {
        let box = Box()
        box.body = try summaryBody(withWaiting(["a"]))
        let t = FakeTransport(data: { _ in (200, box.body) })
        let store = makeStore(t)
        var fresh: [[WaitingItem]] = []
        var changed = 0
        store.onNewWaiting = { fresh.append($0) }
        store.onSummaryChanged = { _ in changed += 1 }

        await store.refresh()
        #expect(fresh.isEmpty)
        #expect(changed == 1)
        #expect(store.connection == .polling)
        #expect(store.lastUpdated != nil && store.lastError == nil)

        box.body = try summaryBody(withWaiting(["a"], generatedAt: "later"))
        await store.refresh()
        #expect(changed == 1)
        #expect(store.summary?.generatedAt == "later")

        box.body = try summaryBody(withWaiting(["a", "b"]))
        await store.refresh()
        #expect(changed == 2)
        #expect(fresh.count == 1 && fresh[0].map(\.id) == ["b"])
    }

    @Test func unauthorizedAndOfflineKeepOldSummary() async throws {
        let box = Box()
        box.body = try summaryBody(withWaiting(["a"]))
        let status = Box()
        status.body = Data("200".utf8)
        let t = FakeTransport(data: { _ in
            (Int(String(decoding: status.body, as: UTF8.self))!, box.body)
        })
        let store = makeStore(t)
        await store.refresh()
        status.body = Data("401".utf8)
        await store.refresh()
        #expect(store.connection == .unauthorized)
        #expect(store.lastError == .unauthorized)
        status.body = Data("502".utf8)
        box.body = Data("x".utf8)
        await store.refresh()
        #expect(store.connection == .offline(DroverError.http(502).userMessage))
        #expect(store.summary?.waiting.map(\.id) == ["a"])
    }

    @Test func replyEmptyTextMakesNoRequest() async throws {
        let t = FakeTransport(data: { _ in (200, okBody("{}")) })
        let store = makeStore(t)
        try await store.reply(to: Summary.preview.waiting[0], text: "  \n ")
        #expect(t.requests.isEmpty)
    }

    @Test func replySendsTrimmedThenRefreshes() async throws {
        let sum = try summaryBody(.preview)
        let t = FakeTransport(data: { r in r.url?.path == "/api/op/native.summary" ? (200, sum) : (200, okBody("{}")) })
        let store = makeStore(t)
        try await store.reply(to: Summary.preview.waiting[0], text: " go ahead ")
        #expect(t.requests.map { $0.url?.path } == ["/api/op/sessions.message", "/api/op/native.summary"])
        let json = try bodyJSON(t.requests[0].httpBody)
        #expect(json["text"] as? String == "go ahead")
        #expect(store.summary == .preview)
    }

    @Test func actionsWithoutMainTokenThrow() async {
        let t = FakeTransport(data: { _ in (200, okBody("{}")) })
        let store = makeStore(t, tokens: [.widget: "w"])
        let item = Summary.preview.waiting[0]
        await #expect(throws: DroverError.missingToken(.main)) { try await store.reply(to: item, text: "hi") }
        await #expect(throws: DroverError.missingToken(.main)) { try await store.sweepManager() }
        await #expect(throws: DroverError.missingToken(.main)) { try await store.muteAlerts(minutes: 30) }
        #expect(t.requests.isEmpty)
        #expect(store.canAct == false)
    }

    @Test func muteCallsEachCategoryAndSetsMutedUntil() async throws {
        let t = FakeTransport(data: { _ in (200, okBody("{}")) })
        let store = makeStore(t)
        let before = Date()
        try await store.muteAlerts(minutes: 30)
        let reqs = t.requests(path: "/api/op/notify.mute")
        #expect(reqs.count == MenuBarStore.alertCategories.count)
        let targets = try reqs.map { r -> String in
            let j = try bodyJSON(r.httpBody)
            #expect(j["scope"] as? String == "category" && j["minutes"] as? Int == 30)
            return try #require(j["target"] as? String)
        }
        #expect(targets == MenuBarStore.alertCategories)
        let until = try #require(store.mutedUntil)
        #expect(until.timeIntervalSince(before) >= 30 * 60 - 1)
    }

    @Test func startUnconfigured() {
        let store = makeStore(FakeTransport(), tokens: [:])
        store.start()
        #expect(store.connection == .unconfigured)
        let bad = MenuBarStore(preferences: { var p = MenuBarPreferences.default; p.serverURL = ""; return p },
                               tokens: StaticTokens([.main: "x"]), transport: FakeTransport())
        bad.start()
        #expect(bad.connection == .unconfigured)
    }

    @Test func startPollsAndStops() async throws {
        let sum = try summaryBody(.preview)
        let t = FakeTransport(data: { r in
            r.url?.path == "/api/op/native.summary" ? (200, sum) : (401, Data())
        })
        let store = makeStore(t, tokens: [.widget: "w"])
        store.start()
        store.start() // idempotent
        for _ in 0..<100 where store.summary == nil { try await Task.sleep(for: .milliseconds(10)) }
        #expect(store.summary == .preview)
        #expect(store.connection == .polling)
        #expect(t.requests(path: "/api/op/native.summary").count == 1)
        store.stop()
    }
}
