import Foundation
import Testing
@testable import DroverWidgetCore

/// Cross-checks the widget model against core's shared fixtures (Fixtures/ at the repo root) once they exist,
/// so a server-side shape change breaks this test instead of a widget on someone's lock screen.
@Suite struct ContractFixtureTests {
    private static let fixtures = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().appendingPathComponent("Fixtures")

    private func load(_ name: String) -> Data? { try? Data(contentsOf: Self.fixtures.appendingPathComponent(name)) }

    @Test func decodesCoreCacheFixture() throws {
        guard let data = load("native-summary.json") else { return } // core fixtures not merged yet
        let s = try JSONDecoder().decode(NativeSummary.self, from: data)
        #expect(s.generatedAt != nil)
        #expect(!s.hosts.isEmpty)
        #expect(s.totals.hosts == s.hosts.count)
        #expect(s.waiting.allSatisfy { $0.waitingKind == .decision || $0.waitingKind == .question })
        #expect(s.waiting.allSatisfy { $0.since != nil })
        // The cache file must be writable as-is by SummaryCache.
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try SummaryCache(directory: dir).write(data)
        #expect(SummaryCache(directory: dir).read()?.summary == s)
    }

    @Test func parsesCoreEnvelopeFixture() throws {
        guard let data = load("native.summary.json") else { return }
        let r = try SummaryFetcher.parse(data: data, statusCode: 200)
        #expect(!r.summary.hosts.isEmpty)
    }

    @Test func parsesCoreEmptyEnvelopeFixture() throws {
        guard let data = load("native.summary.empty.json") else { return }
        let r = try SummaryFetcher.parse(data: data, statusCode: 200)
        #expect(r.summary.waiting.isEmpty && r.summary.totals.waiting == 0)
    }
}
