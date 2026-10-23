import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import DroverKit

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    func increment() { lock.lock(); n += 1; lock.unlock() }
    var value: Int { lock.lock(); defer { lock.unlock() }; return n }
}

@MainActor
struct SummaryStoreTests {
    func tempCache() -> (SummaryCache, URL) {
        let dir = FileManager.default.temporaryDirectory.appending(path: "droverkit-store-\(UUID().uuidString)")
        return (SummaryCache(directory: dir), dir)
    }

    func waitUntil(_ timeout: Duration = .seconds(3), _ cond: @MainActor () -> Bool) async {
        let deadline = ContinuousClock.now + timeout
        while !cond() && ContinuousClock.now < deadline { try? await Task.sleep(for: .milliseconds(10)) }
    }

    @Test func loadsCacheAtInit() throws {
        let (cache, dir) = tempCache()
        defer { try? FileManager.default.removeItem(at: dir) }
        let summary = try TestFixtures.summary()
        try cache.save(summary)
        let store = SummaryStore(fetch: { throw DroverError.notConfigured }, cache: cache)
        #expect(store.summary == summary)
        #expect(store.fetchedAt != nil)
    }

    @Test func refreshSuccessSavesAndNotifies() async throws {
        let (cache, dir) = tempCache()
        defer { try? FileManager.default.removeItem(at: dir) }
        let summary = try TestFixtures.summary()
        let saved = Counter()
        let store = SummaryStore(fetch: { summary }, cache: cache, onSave: { saved.increment() })
        await store.refresh()
        #expect(store.summary == summary)
        #expect(store.lastError == nil)
        #expect(store.fetchedAt != nil)
        #expect(!store.isRefreshing)
        #expect(saved.value == 1)
        #expect(cache.load()?.summary == summary)
    }

    @Test func refreshErrorKeepsOldSummary() async throws {
        let summary = try TestFixtures.summary()
        let calls = Counter()
        let store = SummaryStore(fetch: {
            calls.increment()
            if calls.value == 1 { return summary }
            throw DroverError.unauthorized
        })
        await store.refresh()
        await store.refresh()
        #expect(store.summary == summary)
        #expect(store.lastError == .unauthorized)
        struct Odd: Error {}
        let other = SummaryStore(fetch: { throw Odd() })
        await other.refresh()
        if case .transport = other.lastError {} else { Issue.record("expected transport error") }
    }

    @Test func followRefreshesAfterMutation() async throws {
        let summary = try TestFixtures.summary()
        let calls = Counter()
        let store = SummaryStore(fetch: { calls.increment(); return summary })
        store.debounce = .milliseconds(30)
        let connector = FakeConnector([
            .init(status: 200, lines: ["event: mutation", "data: {}", ""], hold: true),
        ])
        store.follow(EventStream(request: { URLRequest(url: EventStreamTests.url) },
                                 backoff: EventStreamTests.fast, connect: connector.connect()))
        // .open triggers a refresh, the mutation a debounced one.
        await waitUntil { calls.value >= 2 }
        #expect(calls.value >= 2)
        store.stopFollowing()
    }

    @Test func irrelevantEventDoesNotRefreshAfterOpen() async throws {
        let summary = try TestFixtures.summary()
        let calls = Counter()
        let store = SummaryStore(fetch: { calls.increment(); return summary })
        store.debounce = .milliseconds(20)
        let connector = FakeConnector([
            .init(status: 200, lines: ["event: hello", "data: {}", ""], hold: true),
        ])
        store.follow(EventStream(request: { URLRequest(url: EventStreamTests.url) },
                                 backoff: EventStreamTests.fast, connect: connector.connect()))
        await waitUntil { calls.value >= 1 }
        try await Task.sleep(for: .milliseconds(150))
        #expect(calls.value == 1)
        store.stopFollowing()
    }

    @Test func pollingRepeatsThenStops() async throws {
        let summary = try TestFixtures.summary()
        let calls = Counter()
        let store = SummaryStore(fetch: { calls.increment(); return summary })
        store.startPolling(every: .milliseconds(20))
        store.startPolling(every: .milliseconds(20))
        await waitUntil { calls.value >= 3 }
        #expect(calls.value >= 3)
        store.stopPolling()
        try await Task.sleep(for: .milliseconds(60))
        let after = calls.value
        try await Task.sleep(for: .milliseconds(100))
        #expect(calls.value == after)
    }
}
