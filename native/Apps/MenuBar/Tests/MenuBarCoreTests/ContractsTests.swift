import Foundation
import Testing
@testable import MenuBarCore

@Suite struct ContractsTests {
    @Test func fixtureDecodes() throws {
        let s = try Fixtures.summary()
        #expect(s.totals.waiting == 2)
        #expect(s.waiting.first?.kind == .decision)
        #expect(s.waiting.first?.sinceDate != nil)
    }

    @Test func unknownKindDoesNotFail() throws {
        let json = #"{"id":"a","name":"demo","host":"local","engine":"claude","kind":"brand-new","headline":"h"}"#
        let item = try JSONDecoder().decode(WaitingItem.self, from: Data(json.utf8))
        #expect(item.kind == .unknown)
        #expect(item.since == nil)
    }

    @Test func badgeStates() {
        #expect(BadgeState(summary: nil, connection: .unconfigured).tone == .unconfigured)
        #expect(BadgeState(summary: nil, connection: .unauthorized).tone == .error)
        #expect(BadgeState(summary: nil, connection: .offline("x")).tone == .error)
        #expect(BadgeState(summary: nil, connection: .polling).tone == .idle)
        let live = BadgeState(summary: .preview, connection: .live)
        #expect(live.count == 2 && live.tone == .waiting)
        let stale = BadgeState(summary: .preview, connection: .offline("x"))
        #expect(stale.count == 2 && stale.tone == .error)
        var quiet = Summary.preview
        quiet.totals.waiting = 0
        #expect(BadgeState(summary: quiet, connection: .live).tone == .working)
        quiet.totals.working = 0
        #expect(BadgeState(summary: quiet, connection: .live) == BadgeState(count: 0, tone: .idle, label: "Drover, all idle"))
    }

    @Test func baseURLValidation() {
        var p = MenuBarPreferences()
        #expect(p.baseURL?.absoluteString == "http://127.0.0.1:7337")
        p.serverURL = " https://demo.example.ts.net:7337/ "
        #expect(p.baseURL?.absoluteString == "https://demo.example.ts.net:7337")
        for bad in ["", "ftp://x", "http://", "http://u:p@h", "http://h/?token=x", "http://h/#x", "not a url"] {
            p.serverURL = bad
            #expect(p.baseURL == nil, "\(bad)")
        }
        for ok in ["http://localhost:7337", "http://100.64.1.2:7337", "http://demo-mini.local:7337",
                   "http://demo-mini:7337", "http://[::1]:7337", "https://demo.example.ts.net"] {
            p.serverURL = ok
            #expect(p.baseURL != nil, "\(ok)")
        }
        // ATS blocks plain http to other qualified names, so they are refused up front.
        p.serverURL = "http://demo.example.ts.net:7337"
        #expect(p.baseURL == nil)
        p.pollSeconds = 1
        #expect(p.clampedPollSeconds == 15)
        p.pollSeconds = 99_999
        #expect(p.clampedPollSeconds == 900)
    }

    @Test func links() {
        #expect(Links.appSession("s-1", host: "local").absoluteString == "drover://session/s-1")
        #expect(Links.appSession("s-1", host: "demo-box").absoluteString == "drover://session/s-1?host=demo-box")
        let base = URL(string: "http://127.0.0.1:7337")!
        #expect(Links.webSession(base: base, id: "s 1", host: "", engine: "claude", name: "demo/x").absoluteString
                == "http://127.0.0.1:7337/#/pop/session/local/s%201/claude/demo%2Fx")
        #expect(Links.webBoard(base: base).absoluteString == "http://127.0.0.1:7337/#/board")
    }
}

enum Fixtures {
    static func data(_ name: String) throws -> Data {
        let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
        return try Data(contentsOf: url)
    }
    static func summary() throws -> Summary {
        try JSONDecoder().decode(Summary.self, from: data("summary"))
    }
}
