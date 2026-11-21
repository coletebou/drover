import Foundation
import Testing
@testable import DroverKit

/// The prompt spool's models (`prompts.list`, `prompts.status`, `prompts.sync`), decoded from the daemon-shaped
/// fixtures and from odd payloads an older or newer daemon could send. Not named *ClientTests: CI skips those.
@Suite struct PromptsModelTests {
    private func envelope<T: Decodable & Sendable>(_ name: String, as: T.Type = T.self) throws -> T {
        let data = try #require(Fixtures.data(name), "missing fixture \(name)")
        return try #require(try JSONDecoder().decode(OpEnvelope<T>.self, from: data).result, "\(name) has no result")
    }

    private func decode<T: Decodable>(_ json: String, as: T.Type = T.self) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    @Test func listFixture() throws {
        let l: PromptsList = try envelope("prompts.list.json")
        #expect(l.prompts.count == 5)
        #expect(l.more)
        #expect(l.total == nil)
        let first = try #require(l.prompts.first)
        #expect(first.id == "p_0d1e2f3a4b5c6d7e")
        #expect(first.engine == .claude)
        #expect(first.via == .typed)
        #expect(first.route == "local")
        #expect(first.opHost == "local")
        #expect(first.ts.isoString == "2026-11-21T22:03:11.000Z")
        // Newest first, as the daemon sends them.
        #expect(l.prompts.map(\.ts) == l.prompts.map(\.ts).sorted(by: >))
        // A multi-line prompt keeps every line, verbatim.
        #expect(l.prompts[1].text.contains("\n\n- labels\n"))
        #expect(l.prompts[1].via == .queued)
        #expect(l.prompts[1].engine == .codex)
        // No session, no route: a record read from a sink clone.
        let clone = l.prompts[3]
        #expect(clone.session == nil)
        #expect(clone.route == nil)
        #expect(clone.source == "sink:personal")
        #expect(clone.opHost == "demo-spare")
        // A peer message names its sender; an unknown field is ignored.
        #expect(l.prompts[4].via == .peer)
        #expect(l.prompts[4].from == "demo-review")
        #expect(l.perHost.count == 3)
        #expect(l.downHosts.isEmpty, "the down host's records came from a sink clone")
        #expect(l.coverage?.searched == ["demo-mac", "demo-box"])
        #expect(l.coverage?.partial.first?.host == "demo-spare")
    }

    @Test func statusFixtureAndLine() throws {
        let s: PromptsStatus = try envelope("prompts.status.json")
        #expect(s.records == 1204)
        #expect(s.files == 31)
        #expect(s.enabled == true)
        #expect(s.config?.found == true)
        #expect(s.sinks.map(\.name) == ["personal", "work"])
        #expect(s.sinks[1].failures == 2)
        let now = try #require(DroverTimestamp(iso: "2026-11-21T22:06:11.000Z")).date
        #expect(s.line(now: now) == "1,204 prompts, newest 3m ago; personal synced 6m ago (2 to push), work: push failed: remote rejected")
        #expect(PromptsStatus(records: 1).line(now: now) == "1 prompt; local spool only")
        #expect(PromptsStatus.grouped(1_234_567) == "1,234,567")
        #expect(PromptsStatus.grouped(999) == "999")
    }

    @Test func syncFixtureAndSummary() throws {
        let r: PromptsSyncResult = try envelope("prompts.sync.json")
        #expect(r.scanned == 412)
        #expect(r.added == 3)
        #expect(r.sinks.count == 2)
        #expect(r.sinks[0].ok && r.sinks[0].pushed == true)
        #expect(!r.sinks[1].ok)
        #expect(r.summary == "Scanned 412, added 3 prompts; work: push failed: remote rejected")
    }

    @Test func oddRecordsAreDroppedNotFatal() throws {
        let l: PromptsList = try decode(#"""
        { "prompts": [
            { "id": "p_ok", "ts": 1763762591000, "host": "h", "engine": "hermes", "text": "hi", "via": "someday", "route": { "old": true } },
            { "ts": "2026-11-21T22:03:11.000Z", "text": "no id" },
            { "id": "p_bad_ts", "ts": "yesterday", "text": "x" },
            { "id": "p_min", "ts": "2026-11-21T22:03:11Z", "text": "" }
          ],
          "perHost": [ { "host": "h", "ok": true }, { "nope": 1 } ],
          "coverage": { "searched": ["h"], "notCovered": [ { "host": "g", "reason": "never probed" }, 3 ] } }
        """#)
        #expect(l.prompts.map(\.id) == ["p_ok", "p_min"])
        #expect(l.prompts[0].via?.rawValue == "someday")
        #expect(l.prompts[0].via?.label == "someday")
        #expect(l.prompts[0].route == nil, "a route that is not a string is no alias")
        #expect(l.prompts[0].engine.rawValue == "hermes")
        #expect(l.prompts[1].host == "")
        #expect(l.prompts[1].opHost == "local")
        #expect(l.more == false)
        #expect(l.perHost.map(\.host) == ["h"])
        #expect(l.coverage?.notCovered.map(\.host) == ["g"])
    }

    @Test func emptyPayloadsDecode() throws {
        let l: PromptsList = try decode("{}")
        #expect(l.prompts.isEmpty && !l.more && l.perHost.isEmpty)
        let s: PromptsStatus = try decode(#"{"config":{"errors":["a rule needs a label", {"x":1}]}}"#)
        #expect(s.sinks.isEmpty)
        #expect(s.config?.errors == ["a rule needs a label"])
        let r: PromptsSyncResult = try decode(#"{"sinks":[{"name":"c","type":"command","ok":true,"runs":2,"pushed":3}]}"#)
        #expect(r.sinks[0].runs == 2)
        #expect(r.sinks[0].pushed == true)
        #expect(r.summary == "Scanned 0, added 0 prompts")
    }

    @Test func queryArguments() {
        #expect(PromptsQuery().arguments == ["limit": 200])
        #expect(PromptsQuery(scope: .all, q: "  build failed ", host: "demo-box", engine: "codex", label: "", before: "p_1", limit: 5000).arguments
            == ["q": "build failed", "host": "demo-box", "engine": "codex", "before": "p_1", "limit": 2000, "via": "all"])
        #expect(PromptsQuery(q: "   ", limit: nil).arguments == [:])
        let page = PromptsQuery(q: "x").after(PromptRecord(id: "p_last", ts: DroverTimestamp(Date(timeIntervalSince1970: 0)), host: "h", engine: .claude, text: "t"))
        #expect(page.arguments["before"] == "p_last")
        #expect(page.arguments["q"] == "x")
    }

    @Test func queryEncodesAsTheArgumentObject() throws {
        let data = try JSONEncoder().encode(PromptsQuery(scope: .all, q: "tests"))
        #expect(try JSONDecoder().decode(JSONValue.self, from: data) == ["q": "tests", "limit": 200, "via": "all"])
    }

    @Test func mergeByIdNewestFirst() {
        func r(_ id: String, _ s: Double) -> PromptRecord { PromptRecord(id: id, ts: DroverTimestamp(Date(timeIntervalSince1970: s)), host: "h", engine: .claude, text: id) }
        let merged = PromptsMerge.merge([r("a", 30), r("b", 20)], [r("b", 20), r("c", 10), r("d", 30)])
        #expect(merged.map(\.id) == ["d", "a", "b", "c"])
    }

    @Test func firstLine() {
        let p = PromptRecord(id: "p", ts: DroverTimestamp(Date()), host: "h", engine: .claude, text: "\n\n   \n  Fix the lexer  \nthen the parser")
        #expect(p.firstLine() == "Fix the lexer")
        #expect(p.firstLine(max: 5) == "Fix …")
    }

    @Test func viaLabels() {
        #expect(PromptVia.typed.label == "")
        #expect(PromptVia.drover.label == "via Drover")
        #expect(PromptVia.headless.label == "launch")
        #expect(PromptVia.mine == [.typed, .queued, .drover, .headless])
    }

    @Test func widgetScopedClientNeverSendsPromptOps() async {
        // Refused before any request is built: the widget token never goes out for prompts.*.
        let c = DroverClient(baseURL: URL(string: "http://127.0.0.1:9")!, tokens: InMemoryTokenStore([.widget: "w"]), scope: .widget)
        await #expect(throws: DroverError.forbidden("prompts.sync needs the main token")) { try await c.syncPrompts() }
        await #expect(throws: DroverError.forbidden("prompts.list needs the main token")) { try await c.prompts() }
        await #expect(throws: DroverError.forbidden("prompts.status needs the main token")) { try await c.promptsStatus() }
    }
}
