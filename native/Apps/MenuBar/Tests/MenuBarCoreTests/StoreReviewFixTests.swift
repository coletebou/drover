import Foundation
import Testing
@testable import MenuBarCore

/// Regressions for the cross-model review: stale results after a server switch, the unconfigured
/// state, per-fetch cache writes and SSE drops not hiding an offline state.
@MainActor
@Suite struct StoreReviewFixTests {
    /// Answers `native.summary` per host; requests to `slowHost` take `delay`. Everything else 404s.
    final class HostTransport: HTTPTransport, @unchecked Sendable { // immutable after init
        let bodies: [String: Data]
        let slowHost: String?
        let delay: Duration
        init(bodies: [String: Data], slowHost: String? = nil, delay: Duration = .zero) {
            self.bodies = bodies; self.slowHost = slowHost; self.delay = delay
        }
        func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
            let host = request.url?.host ?? ""
            if host == slowHost { try await Task.sleep(for: delay) }
            let isSummary = request.url?.path == "/api/op/native.summary"
            let body = isSummary ? bodies[host] ?? Data() : Data()
            let code = isSummary && bodies[host] != nil ? 200 : 404
            return (body, HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: nil)!)
        }
        func lines(for request: URLRequest) async throws -> (AsyncThrowingStream<String, Error>, HTTPURLResponse) {
            throw URLError(.cannotConnectToHost)
        }
    }

    final class Prefs: @unchecked Sendable { var value = MenuBarPreferences() } // main actor only

    static func body(_ ids: [String]) throws -> Data {
        var s = Summary.empty
        s.generatedAt = "t"
        s.waiting = ids.map { WaitingItem(id: $0, name: $0, host: "local", engine: "claude", since: nil, kind: .question, headline: "h") }
        s.totals.waiting = ids.count
        return okBody(String(decoding: try JSONEncoder().encode(s), as: UTF8.self))
    }

    @Test func refreshWhileUnconfiguredKeepsOnboarding() async {
        let store = MenuBarStore(preferences: { .default }, tokens: StaticTokens([:]), transport: OfflineTransport())
        store.start()
        #expect(store.connection == .unconfigured)
        await store.refresh()
        #expect(store.connection == .unconfigured)
        #expect(store.lastError == nil)
    }

    @Test func staleRefreshFromOldServerIsDropped() async throws {
        let prefs = Prefs()
        prefs.value.serverURL = "https://old.test:1"
        let t = HostTransport(
            bodies: ["old.test": try Self.body(["old"]), "new.test": try Self.body(["new"])],
            slowHost: "old.test", delay: .milliseconds(300))
        let store = MenuBarStore(preferences: { prefs.value }, tokens: StaticTokens([.widget: "w"]), transport: t)
        let slow = Task { await store.refresh() }
        try await Task.sleep(for: .milliseconds(50))
        prefs.value.serverURL = "https://new.test:1"
        store.reconfigure()
        await slow.value
        try await Task.sleep(for: .milliseconds(100))
        #expect(store.connection != .unconfigured)
        #expect(store.summary?.waiting.map(\.id) == ["new"])
        store.stop()
    }

    @Test func serverChangeClearsSummary() async throws {
        let prefs = Prefs()
        prefs.value.serverURL = "https://a.test:1"
        let t = HostTransport(bodies: ["a.test": try Self.body(["x"])])
        let store = MenuBarStore(preferences: { prefs.value }, tokens: StaticTokens([.widget: "w"]), transport: t)
        store.start()
        await store.refresh()
        #expect(store.summary != nil, "\(store.connection) \(String(describing: store.lastError))")
        prefs.value.serverURL = "https://b.test:1"
        store.reconfigure()
        // b.test answers 404; the old server's sessions must not linger.
        #expect(store.summary == nil)
        store.stop()
    }

    @Test func fetchedFiresForUnchangedSummary() async throws {
        let t = HostTransport(bodies: ["127.0.0.1": try Self.body(["a"])])
        let store = MenuBarStore(preferences: { .default }, tokens: StaticTokens([.widget: "w"]), transport: t)
        var fetched = 0, changed = 0
        store.onSummaryFetched = { _ in fetched += 1 }
        store.onSummaryChanged = { _ in changed += 1 }
        await store.refresh()
        await store.refresh()
        #expect(fetched == 2 && changed == 1)
    }

    @Test func sseDropDoesNotHideOffline() async throws {
        // Main token present, so an SSE task runs and fails; the summary endpoint is down (404).
        let t = HostTransport(bodies: [:])
        let store = MenuBarStore(preferences: { .default }, tokens: StaticTokens([.main: "m"]), transport: t)
        store.sleep = { _ in try await Task.sleep(for: .milliseconds(20)) }
        store.start()
        try await Task.sleep(for: .milliseconds(150))
        if case .offline = store.connection {} else { Issue.record("expected offline, got \(store.connection)") }
        store.stop()
    }
}
