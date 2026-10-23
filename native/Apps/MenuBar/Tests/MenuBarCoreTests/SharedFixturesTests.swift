import Foundation
import Testing
@testable import MenuBarCore

/// Decodes the repo-wide `Fixtures/` (owned by the core window, shared with DroverKit) with the menu
/// bar's models, so drift between the two is caught here. Skipped while those files are absent.
@Suite struct SharedFixturesTests {
    static let root = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Fixtures")

    static func load(_ name: String) -> Data? {
        try? Data(contentsOf: root.appendingPathComponent(name))
    }

    @Test(.enabled(if: load("native-summary.json") != nil))
    func bareSummaryCache() throws {
        let s = try JSONDecoder().decode(Summary.self, from: #require(Self.load("native-summary.json")))
        #expect(s.totals.hosts == s.hosts.count)
        #expect(s.waiting.allSatisfy { $0.kind != .unknown && $0.sinceDate != nil })
    }

    @Test(.enabled(if: load("native.summary.json") != nil))
    func summaryEnvelope() throws {
        let e = try JSONDecoder().decode(OpEnvelope<Summary>.self, from: #require(Self.load("native.summary.json")))
        #expect(e.ok && e.result != nil)
    }

    @Test(.enabled(if: load("native.summary.empty.json") != nil))
    func emptySummaryEnvelope() throws {
        let e = try JSONDecoder().decode(OpEnvelope<Summary>.self, from: #require(Self.load("native.summary.empty.json")))
        #expect(e.result?.waiting.isEmpty == true)
        #expect(BadgeState(summary: e.result, connection: .live).count == 0)
    }

    @Test(.enabled(if: load("native.notifications.json") != nil))
    func notificationsEnvelope() throws {
        let e = try JSONDecoder().decode(OpEnvelope<NotificationsPage>.self, from: #require(Self.load("native.notifications.json")))
        let page = try #require(e.result)
        #expect(page.cursor != nil && !page.items.isEmpty)
        #expect(page.items.contains { $0.isNeedsYou })
    }

    @Test(.enabled(if: load("events.sse.txt") != nil))
    func sseTranscript() throws {
        let text = String(decoding: try #require(Self.load("events.sse.txt")), as: UTF8.self)
        var parser = SSEParser()
        var names: [String] = []
        for line in text.components(separatedBy: "\n") {
            let l = line.hasSuffix("\r") ? String(line.dropLast()) : line
            if let ev = parser.feed(l) { names.append(ev.event) }
        }
        #expect(names.contains("hello") && names.contains("mutation") && names.contains("notify"))
    }
}
