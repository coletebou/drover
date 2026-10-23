import Foundation
import Testing
@testable import DroverKit

@Suite struct ModelDecodingTests {
    private func envelope<T: Decodable & Sendable>(_ name: String, as: T.Type = T.self) throws -> T {
        let data = try #require(Fixtures.data(name), "missing fixture \(name)")
        let env = try JSONDecoder().decode(OpEnvelope<T>.self, from: data)
        return try #require(env.result, "\(name) has no result")
    }

    @Test func nativeSummary() throws {
        let s: NativeSummary = try envelope("native.summary.json")
        #expect(!s.hosts.isEmpty)
        #expect(!s.waiting.isEmpty)
    }
    @Test func nativeSummaryEmpty() throws {
        let s: NativeSummary = try envelope("native.summary.empty.json")
        #expect(s.waiting.isEmpty)
    }
    @Test func notifications() throws {
        let n: NativeNotifications = try envelope("native.notifications.json")
        #expect(!n.items.isEmpty)
    }
    @Test func sessionsList() throws {
        let l: SessionList = try envelope("sessions.list.json")
        #expect(!l.sessions.isEmpty)
    }
    @Test func transcript() throws {
        let t: Transcript = try envelope("sessions.transcript.json")
        #expect(!t.turns.isEmpty)
    }
    @Test func message() throws {
        let m: MessageDelivery = try envelope("sessions.message.json")
        #expect(m.ok)
    }
    @Test func capture() throws {
        let c: PaneCapture = try envelope("tmux.capture.json")
        #expect(!c.text.isEmpty)
    }
    @Test func send() throws {
        let r: PaneSendResult = try envelope("tmux.send.json")
        #expect(r.ok)
    }
    @Test func sendRefused() throws {
        let r: PaneSendResult = try envelope("tmux.send.refused.json")
        #expect(r.refused == true)
    }
    @Test func hostList() throws {
        let h: [HostEntry] = try envelope("host.list.json")
        #expect(!h.isEmpty)
    }
    @Test func errorOp() throws {
        let env = try JSONDecoder().decode(OpEnvelope<JSONValue>.self, from: try #require(Fixtures.data("error.op.json")))
        #expect(env.ok == false)
        #expect(env.error == "session not found")
    }

    @Test func bareSummaryRoundTrips() throws {
        let s = try JSONDecoder().decode(NativeSummary.self, from: try #require(Fixtures.data("native-summary.json")))
        let again = try JSONDecoder().decode(NativeSummary.self, from: JSONEncoder().encode(s))
        #expect(s == again)
    }

    @Test func timestamps() throws {
        func decode(_ json: String) throws -> DroverTimestamp {
            try JSONDecoder().decode([DroverTimestamp].self, from: Data("[\(json)]".utf8))[0]
        }
        let expected = Date(timeIntervalSince1970: 1_760_000_000)
        #expect(try decode("1760000000000").date == expected)
        #expect(try decode("1760000000").date == expected)
        #expect(try decode("\"1760000000\"").date == expected)
        #expect(try decode("\"2025-10-09T08:53:20Z\"").date == expected)
        #expect(try decode("\"2025-10-09T08:53:20.000Z\"").date == expected)
        #expect(try decode("\"2025-10-09T08:53:20.500Z\"").date == expected.addingTimeInterval(0.5))
    }

    @Test func openEnumsKeepUnknownValues() throws {
        let k = try JSONDecoder().decode([NotificationKind].self, from: Data(#"["future-kind"]"#.utf8))
        #expect(k[0].rawValue == "future-kind")
        #expect(k[0] != .decision)
        let e = try JSONDecoder().decode([Engine].self, from: Data(#"["future-kind"]"#.utf8))
        #expect(e[0].rawValue == "future-kind")
    }

    @Test func tmuxWindowStripsPane() {
        let s = SessionInfo(id: "x", engine: .claude, tmux: "demo:@3.%12")
        #expect(s.tmuxWindow == "demo:@3")
        #expect(SessionInfo(id: "x", engine: .claude, tmux: "demo:@3").tmuxWindow == "demo:@3")
        #expect(SessionInfo(id: "x", engine: .claude).tmuxWindow == nil)
    }
}
