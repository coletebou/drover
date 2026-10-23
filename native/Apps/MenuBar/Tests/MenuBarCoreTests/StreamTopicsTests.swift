import Foundation
import Testing
@testable import MenuBarCore

// Light updates: the stream asks for summary, alerts, manager and turn only; a `summary` event is applied as
// is (no fetch); a daemon that ignores topics gets the old refresh-on-event rules.

@MainActor
@Suite struct StreamTopicsTests {
    nonisolated private func summaryJSON(_ s: Summary) throws -> String { String(decoding: try JSONEncoder().encode(s), as: UTF8.self) }

    private func store(_ t: FakeTransport) -> MenuBarStore {
        let store = MenuBarStore(preferences: { .default }, tokens: StaticTokens([.main: secret]), transport: t)
        store.sleep = { _ in }
        return store
    }

    @Test func streamRequestNamesTopicsAndNoToken() throws {
        let r = try client(FakeTransport()).streamRequest(topics: AppIdentifiers.streamTopics)
        #expect(r.url?.path == "/api/stream")
        let items = URLComponents(url: try #require(r.url), resolvingAgainstBaseURL: false)?.queryItems ?? []
        #expect(items == [URLQueryItem(name: "topics", value: "summary,alerts,manager,turn")])
        #expect(r.url?.absoluteString.contains(secret) == false)
        #expect(r.value(forHTTPHeaderField: "Authorization") == "Bearer " + secret)
    }

    @Test func summaryEventIsAppliedWithoutAFetch() throws {
        let t = FakeTransport(data: { _ in (500, Data()) })
        let s = store(t)
        var fetched = 0, changed = 0
        s.onSummaryFetched = { _ in fetched += 1 }
        s.onSummaryChanged = { _ in changed += 1 }
        s.handle(SSEEvent(event: "summary", data: try summaryJSON(.preview), id: nil))
        #expect(s.summary == .preview)
        #expect(fetched == 1 && changed == 1, "the widget cache is written for streamed summaries too")
        #expect(t.requests.isEmpty)
        var later = Summary.preview
        later.generatedAt = "2026-10-11T18:00:20Z"
        s.handle(SSEEvent(event: "summary", data: try summaryJSON(later), id: nil))
        #expect(fetched == 2 && changed == 1)
        // Garbage is ignored, the board stays.
        s.handle(SSEEvent(event: "summary", data: "{not json", id: nil))
        #expect(s.summary == later)
    }

    @Test func topicDaemonEventsDoNotRefresh() async throws {
        let t = FakeTransport(data: { _ in (200, okBody(try! summaryJSON(.preview))) })
        let s = store(t)
        s.handle(SSEEvent(event: "hello", data: #"{"host":"demo-mini","ts":1,"topics":["summary","alerts","manager","turn"]}"#, id: nil))
        s.handle(SSEEvent(event: "alerts", data: #"{"items":[],"ts":1}"#, id: nil))
        try await Task.sleep(for: .milliseconds(30))
        #expect(t.requests.isEmpty)
    }

    @Test func aHelloWithoutTopicsIsAnOlderDaemon() async throws {
        let t = FakeTransport(data: { _ in (200, okBody(try! summaryJSON(.preview))) })
        let s = store(t)
        s.handle(SSEEvent(event: "hello", data: #"{"host":"demo-mini","ts":1}"#, id: nil))
        s.handle(SSEEvent(event: "alerts", data: #"{"items":[],"ts":1}"#, id: nil))
        for _ in 0..<100 where t.requests.isEmpty { try await Task.sleep(for: .milliseconds(5)) }
        #expect(t.requests(path: "/api/op/native.summary").count == 1)
    }

    @Test func aDaemonIgnoringTopicsFallsBackToRefreshOnEvents() async throws {
        let t = FakeTransport(data: { _ in (200, okBody(try! summaryJSON(.preview))) })
        let s = store(t)
        s.handle(SSEEvent(event: "fleet", data: "{}", id: nil))
        for _ in 0..<100 where t.requests.isEmpty { try await Task.sleep(for: .milliseconds(5)) }
        #expect(t.requests(path: "/api/op/native.summary").count == 1)
    }

    @Test func managerEventsMatchTheManagersHost() throws {
        let t = FakeTransport(data: { _ in (500, Data()) })
        let s = store(t)
        s.handle(SSEEvent(event: "hello", data: #"{"host":"demo-mini","topics":["manager"]}"#, id: nil))
        s.handle(SSEEvent(event: "summary", data: try summaryJSON(.preview), id: nil)) // manager on "local"
        s.handle(SSEEvent(event: "manager", data: #"{"host":"demo-box","thread":"main","turnId":"t-1","phase":"delta","delta":"elsewhere"}"#, id: nil))
        #expect(s.manager.isEmpty)
        s.handle(SSEEvent(event: "manager", data: #"{"host":"demo-mini","thread":"main","turnId":"t-1","inReplyTo":"ev-1","phase":"delta","delta":"Here"}"#, id: nil))
        #expect(s.manager.reply?.text == "Here")
        s.handle(SSEEvent(event: "turn", data: #"{"id":"s-other","turn":{"role":"assistant","text":"not the manager"}}"#, id: nil))
        #expect(s.manager.reply?.text == "Here")
        s.handle(SSEEvent(event: "turn", data: #"{"id":"manager","host":"local","thread":"main","turn":{"id":"ev-2","role":"assistant","text":"Here it is.","inReplyTo":"ev-1"}}"#, id: nil))
        #expect(s.manager.reply?.text == "Here it is.")
        #expect(s.manager.reply?.phase == .done)
    }

    @Test func remoteManagerEventsCount() throws {
        var sum = Summary.preview
        sum.manager = ManagerState(up: true, lastNoteAt: nil, host: "demo-box")
        let s = store(FakeTransport())
        s.handle(SSEEvent(event: "summary", data: try summaryJSON(sum), id: nil))
        s.handle(SSEEvent(event: "manager", data: #"{"host":"local","phase":"delta","delta":"front"}"#, id: nil))
        #expect(s.manager.isEmpty)
        s.handle(SSEEvent(event: "manager", data: #"{"host":"demo-box","phase":"delta","delta":"remote"}"#, id: nil))
        #expect(s.manager.reply?.text == "remote")
    }

    @Test func fullStreamDeliversTheSummary() async throws {
        // native.summary fails here, so only the stream can bring the board.
        let body = try summaryJSON(.preview)
        let lines = ["event: hello", #"data: {"host":"demo-mini"}"#, "", "event: summary", "data: \(body)", ""]
        let t = FakeTransport(data: { r in
            r.url?.path == "/api/op/native.summary" ? (500, Data()) : (200, okBody(#"{"cursor":"c","items":[]}"#))
        }, lines: { r, n in
            #expect(r.url?.query == "topics=summary,alerts,manager,turn")
            return n == 1 ? (200, lines) : (401, [])
        })
        let s = MenuBarStore(preferences: { .default }, tokens: StaticTokens([.main: secret]), transport: t)
        s.sleep = { _ in try await Task.sleep(for: .milliseconds(5)) }
        s.start()
        for _ in 0..<200 where s.summary != .preview { try await Task.sleep(for: .milliseconds(5)) }
        #expect(s.summary == .preview)
        s.stop()
    }

    @Test func pollSkipsTicksWhileTheStreamDeliversSummaries() async throws {
        let body = try summaryJSON(.preview)
        let t = HoldingTransport(lines: ["event: summary", "data: \(body)", ""], summary: okBody(body))
        let s = MenuBarStore(preferences: { var p = MenuBarPreferences.default; p.pollSeconds = 900; return p },
                             tokens: StaticTokens([.main: secret]), transport: t)
        // Every poll tick is 10 ms here: without the skip there would be a fetch per tick.
        s.sleep = { _ in try await Task.sleep(for: .milliseconds(10)) }
        s.start()
        for _ in 0..<200 where !s.isLive { try await Task.sleep(for: .milliseconds(5)) }
        #expect(s.isLive)
        // The stream handles the summary right after the fetch on connect.
        try await Task.sleep(for: .milliseconds(30))
        let settled = t.summaryCalls
        try await Task.sleep(for: .milliseconds(200))
        // At most a tick that was already in flight; none per tick after the summary.
        #expect(t.summaryCalls <= settled + 1, "\(t.summaryCalls - settled) fetches after the summary")
        s.stop()
    }
}

/// A stream that delivers `lines` and then stays open (until cancelled); summaries answer `summary`, anything
/// else waits like a long poll.
final class HoldingTransport: HTTPTransport, @unchecked Sendable { // lock guards the counter
    let lines: [String]
    let summary: Data
    private let lock = NSLock()
    private var _summaryCalls = 0
    var summaryCalls: Int { lock.withLock { _summaryCalls } }

    init(lines: [String], summary: Data) {
        self.lines = lines
        self.summary = summary
    }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        if request.url?.path == "/api/op/native.summary" {
            lock.withLock { _summaryCalls += 1 }
            return (summary, FakeTransport.response(request, 200))
        }
        try await Task.sleep(for: .seconds(30))
        return (okBody(#"{"cursor":"c","items":[]}"#), FakeTransport.response(request, 200))
    }

    func lines(for request: URLRequest) async throws -> (AsyncThrowingStream<String, Error>, HTTPURLResponse) {
        let ls = lines
        let stream = AsyncThrowingStream<String, Error> { c in
            for l in ls { c.yield(l) }
        }
        return (stream, FakeTransport.response(request, 200))
    }
}
