import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import DroverKit

@Suite struct ClientTests {
    private func make(scope: TokenScope = .main, overrides: [String: String] = [:]) -> (DroverClient, URLSession) {
        let s = MockServer.session(overrides: overrides)
        return (MockServer.client(scope: scope, session: s), s)
    }

    @Test func summary() async throws {
        let (c, s) = make()
        let sum = try await c.summary()
        #expect(!sum.hosts.isEmpty)
        let r = try #require(MockURLProtocol.lastRequest(in: s))
        #expect(r.method == "POST")
        #expect(r.url.path == "/api/op/native.summary")
        #expect(r.header("Authorization") == "Bearer mock-token")
        #expect(r.header("Content-Type") == "application/json")
        #expect(r.header("Accept") == "application/json")
        #expect(r.url.query == nil)
        #expect(!r.url.absoluteString.contains("mock-token"))
    }

    @Test func notificationsOmitNilArgs() async throws {
        let (c, s) = make()
        let n = try await c.notifications(since: nil)
        #expect(!n.items.isEmpty)
        #expect(MockURLProtocol.lastRequest(in: s)?.bodyJSON == .object([:]))
        _ = try await c.notifications(since: "abc", limit: 5, wait: 10)
        #expect(MockURLProtocol.lastRequest(in: s)?.bodyJSON == ["since": "abc", "limit": 5, "wait": 10])
    }

    @Test func sessionsSendIncludeRecentFalse() async throws {
        let (c, s) = make()
        let l = try await c.sessions()
        #expect(!l.sessions.isEmpty)
        #expect(MockURLProtocol.lastRequest(in: s)?.bodyJSON == ["includeRecent": false])
        _ = try await c.sessions(host: "")
        #expect(MockURLProtocol.lastRequest(in: s)?.bodyJSON == ["includeRecent": false])
        _ = try await c.sessions(host: "demo-box")
        #expect(MockURLProtocol.lastRequest(in: s)?.bodyJSON?["host"] == "demo-box")
    }

    @Test func hostsAndTranscript() async throws {
        let (c, s) = make()
        #expect(try await c.hosts().isEmpty == false)
        let t = try await c.transcript(id: "abc")
        #expect(!t.turns.isEmpty)
        #expect(MockURLProtocol.lastRequest(in: s)?.bodyJSON == ["id": "abc"])
    }

    @Test func sendMessageCarriesActor() async throws {
        let (c, s) = make()
        let m = try await c.sendMessage(id: "abc", text: "hi")
        #expect(m.ok)
        #expect(MockURLProtocol.lastRequest(in: s)?.bodyJSON == ["id": "abc", "text": "hi", "actor": "owner"])
    }

    @Test func paneOps() async throws {
        let (c, s) = make()
        let cap = try await c.capture(target: "demo:@3")
        #expect(!cap.text.isEmpty)
        #expect(MockURLProtocol.lastRequest(in: s)?.bodyJSON == ["target": "demo:@3"])
        let r = try await c.sendToPane(target: "demo:@3", text: "x")
        #expect(r.ok)
        #expect(MockURLProtocol.lastRequest(in: s)?.bodyJSON == ["target": "demo:@3", "text": "x", "enter": true, "force": false, "actor": "owner"])
        _ = try await c.sendKeys(target: "demo:@3", keys: ["Enter"])
        #expect(MockURLProtocol.lastRequest(in: s)?.url.path == "/api/op/tmux.keys")
        _ = try await c.answer(target: "demo:@3", key: "1", expect: "h")
        #expect(MockURLProtocol.lastRequest(in: s)?.bodyJSON == ["target": "demo:@3", "key": "1", "expect": "h", "actor": "owner"])
        let reply = try await c.lastReply(id: "abc")
        #expect(reply["text"] != nil)
    }

    @Test func refusedDecodes() async throws {
        let (c, _) = make(overrides: ["tmux.send": try #require(Fixtures.all["tmux.send.refused.json"])])
        let r = try await c.sendToPane(target: "demo:@3", text: "x")
        #expect(r.refused == true)
    }

    @Test func emptyStoreIsNotConfigured() async {
        let s = MockServer.session()
        let c = DroverClient(baseURL: MockServer.baseURL, tokens: InMemoryTokenStore(), session: s)
        await #expect(throws: DroverError.notConfigured) { try await c.summary() }
        #expect(MockURLProtocol.lastRequest(in: s) == nil)
    }

    @Test func wrongTokenIsUnauthorized() async {
        let c = DroverClient(baseURL: MockServer.baseURL, tokens: InMemoryTokenStore([.main: "nope"]), session: MockServer.session())
        await #expect(throws: DroverError.unauthorized) { try await c.summary() }
    }

    @Test func widgetScope() async throws {
        let (c, _) = make(scope: .widget)
        _ = try await c.summary()
        await #expect(throws: DroverError.forbidden("widget token: read-only scope")) { try await c.sessions() }
        let main = c.scoped(.main)
        #expect(main.scope == .main)
        _ = try await main.sessions()
    }

    @Test func okFalseIsServerError() async {
        let (c, _) = make(overrides: ["sessions.message": #"{ "ok": false, "error": "session not found" }"#])
        await #expect(throws: DroverError.server(status: 200, message: "session not found")) {
            try await c.sendMessage(id: "x", text: "y")
        }
    }

    @Test func decodingErrorNamesOp() async {
        let (c, _) = make(overrides: ["native.summary": #"{ "ok": true, "result": { "hosts": 1 } }"#])
        do {
            _ = try await c.summary()
            Issue.record("expected failure")
        } catch DroverError.decoding(let m) {
            #expect(m.hasPrefix("native.summary:"))
        } catch {
            Issue.record("wrong error \(error)")
        }
    }

    @Test func emptyResult() async {
        let (c, _) = make(overrides: ["native.summary": #"{ "ok": true }"#])
        await #expect(throws: DroverError.decoding("native.summary: empty result")) { try await c.summary() }
    }

    @Test func unknownOpIsServerError() async {
        let (c, _) = make()
        await #expect(throws: DroverError.server(status: 400, message: "unknown op nope")) {
            try await c.call("nope", as: JSONValue.self)
        }
    }

    @Test func pathPrefixIsKept() async throws {
        let s = MockServer.session()
        let store = InMemoryTokenStore([.main: "mock-token"])
        for base in ["http://drover.mock/prefix/", "http://drover.mock/prefix"] {
            let c = DroverClient(baseURL: URL(string: base)!, tokens: store, session: s)
            _ = try await c.summary()
            #expect(MockURLProtocol.lastRequest(in: s)?.url.path == "/prefix/api/op/native.summary")
        }
    }

    @Test func getPutsQueryInURL() async throws {
        let (c, s) = make()
        _ = try await c.get("native.summary", ["a": "b"], as: NativeSummary.self)
        let r = try #require(MockURLProtocol.lastRequest(in: s))
        #expect(r.method == "GET")
        #expect(r.url.query == "a=b")
        #expect(r.body == nil)
    }

    @Test func streamRequestHeaders() async throws {
        let (c, _) = make()
        let r = try await c.streamRequest()
        #expect(r.url?.path == "/api/stream")
        #expect(r.value(forHTTPHeaderField: "Authorization") == "Bearer mock-token")
        #expect(r.value(forHTTPHeaderField: "Accept") == "text/event-stream")
        #expect(r.value(forHTTPHeaderField: "Cache-Control") == "no-cache")
        #expect(r.timeoutInterval == 90)
        #expect(r.url?.query == nil)
    }

    @Test func waitExtendsTimeout() async throws {
        let (c, s) = make()
        _ = try await c.notifications(since: nil, wait: 25)
        #expect(MockURLProtocol.lastRequest(in: s)?.timeout == 55)
    }
}
