import Foundation
import Testing
@testable import DroverWidgetCore

@Suite struct NativeSummaryTests {
    @Test func decodesSampleFixture() {
        let s = SummaryFixtures.sample
        #expect(s.hosts.count == 3)
        #expect(s.waiting.first?.waitingKind == .decision)
        #expect(s.totals.waiting == 3)
        #expect(s.generatedAt != nil)
    }

    @Test func decodesEpochMillisAndNulls() {
        let s = SummaryFixtures.empty
        #expect(s.generatedAt == Date(timeIntervalSince1970: 1_791_760_000))
        #expect(s.manager?.lastNoteAt == nil)
        #expect(s.waiting.isEmpty)
    }

    @Test func filterRecomputesTotalsFromHost() {
        let s = SummaryFixtures.sample.filtered(host: "demo-mac")
        #expect(s.hosts.map(\.name) == ["demo-mac"])
        #expect(s.waiting.allSatisfy { $0.host == "demo-mac" })
        #expect(s.totals.waiting == 2 && s.totals.working == 1 && s.totals.idle == 3 && s.totals.hosts == 1)
        #expect(SummaryFixtures.sample.filtered(host: nil) == SummaryFixtures.sample)
    }
}

@Suite struct NativeSummaryRejectionTests {
    @Test func rejectsObjectsThatAreNotSummaries() {
        for json in ["{}", #"{"ok":true}"#, #"{"waiting":[]}"#] {
            #expect(throws: DecodingError.self) { try JSONDecoder().decode(NativeSummary.self, from: Data(json.utf8)) }
        }
    }

    @Test func dropsOneMalformedItemNotTheSummary() throws {
        let json = #"{"hosts":[{"name":"demo-mac","up":true,"waiting":1,"working":0,"idle":0}],"waiting":[{"name":"no-id"},{"id":"s-1","name":"demo-ok","host":"demo-mac","kind":"decision","headline":"h","since":"2026-10-11T22:00:00.000Z"}]}"#
        let s = try JSONDecoder().decode(NativeSummary.self, from: Data(json.utf8))
        #expect(s.waiting.map(\.id) == ["s-1"])
        #expect(s.totals.waiting == 1 && s.totals.hosts == 1)
    }
}
