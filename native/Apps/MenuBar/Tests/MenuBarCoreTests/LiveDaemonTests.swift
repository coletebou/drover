import Foundation
import Testing
@testable import MenuBarCore

/// Opt-in wire check against a running Drover daemon. Off by default (CI and normal runs skip it).
///   DROVER_LIVE_URL=http://127.0.0.1:7337 DROVER_LIVE_WIDGET_TOKEN_FILE=~/.local/state/drover/widget-token swift test --filter LiveDaemon
/// Reads the token from the file and never prints it; reports only counts, never session names.
@MainActor
@Suite struct LiveDaemonTests {
    nonisolated static let env = ProcessInfo.processInfo.environment
    nonisolated static var enabled: Bool { env["DROVER_LIVE_URL"] != nil && env["DROVER_LIVE_WIDGET_TOKEN_FILE"] != nil }

    nonisolated static func widgetToken() throws -> String {
        let path = (env["DROVER_LIVE_WIDGET_TOKEN_FILE"]! as NSString).expandingTildeInPath
        return try String(contentsOfFile: path, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    @Test(.enabled(if: enabled)) func summaryAndNotificationsWithWidgetToken() async throws {
        var prefs = MenuBarPreferences()
        prefs.serverURL = Self.env["DROVER_LIVE_URL"]!
        let p = prefs
        let tokens = StaticTokens([.widget: try Self.widgetToken()])
        let store = MenuBarStore(preferences: { p }, tokens: tokens, transport: URLSessionTransport())
        await store.refresh()
        let s = try #require(store.summary, "no summary: \(String(describing: store.lastError))")
        #expect(store.connection == .polling)
        #expect(s.totals.hosts == s.hosts.count)
        #expect(s.totals.waiting == s.waiting.count)
        print("live summary: hosts \(s.totals.hosts), waiting \(s.totals.waiting), working \(s.totals.working), idle \(s.totals.idle), kinds \(Set(s.waiting.map(\.kind.rawValue)).sorted())")

        let client = DroverClient(baseURL: try #require(p.baseURL), tokens: tokens, transport: URLSessionTransport())
        let page = try await client.notifications(since: nil, wait: nil, limit: 5, token: .widget)
        #expect(page.cursor != nil)
        print("live notifications: \(page.items.count) items, kinds \(Set(page.items.map(\.kind)).sorted())")

        // The widget token is read-only: a mutating op must be refused.
        await #expect(throws: DroverError.unauthorized) {
            try await DroverClient(baseURL: p.baseURL!, tokens: StaticTokens([.main: try Self.widgetToken()]),
                                transport: URLSessionTransport()).sweep()
        }
    }
}
