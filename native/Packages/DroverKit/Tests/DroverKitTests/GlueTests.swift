import Foundation
import Testing
@testable import DroverKit

@Suite("Client glue")
struct GlueTests {
    @Test func eventStreamFromMockClientDeliversFixtureEvents() async throws {
        let stream = EventStream(client: MockServer.client(), backoff: Backoff(initial: .milliseconds(5), maximum: .milliseconds(5), multiplier: 1, jitter: 0))
        var kinds: [ServerEvent.Kind] = []
        for await update in stream.updates() {
            if case .event(let e) = update { kinds.append(e.kind) }
            if kinds.count >= 4 { break }
        }
        #expect(kinds == [.hello, .mutation, .notify, .alerts])
    }

    @Test func widgetClientCannotOpenTheStream() async throws {
        let stream = EventStream(client: MockServer.client(scope: .widget))
        var last: StreamUpdate?
        for await update in stream.updates() { last = update }
        #expect(last == .stopped(.forbidden(nil)))
    }

    @MainActor @Test func summaryStoreFromWidgetClient() async throws {
        let store = SummaryStore(client: MockServer.client(scope: .widget))
        await store.refresh()
        #expect(store.summary?.totals.waiting == 2)
        #expect(store.lastError == nil)
    }

    @Test func notificationFeedFromClient() async throws {
        let feed = NotificationFeed(client: MockServer.client(scope: .widget), defaults: nil)
        let first = try await feed.poll()
        #expect(first.isEmpty)
    }
}

@Suite("OpEnvelope")
struct OpEnvelopeTests {
    @Test func explicitNullResultIsJSONNull() throws {
        let data = Data(#"{"ok":true,"result":null,"ms":1}"#.utf8)
        let env = try JSONDecoder().decode(OpEnvelope<JSONValue>.self, from: data)
        #expect(env.result == .null)
        let model = try JSONDecoder().decode(OpEnvelope<NativeSummary>.self, from: data)
        #expect(model.result == nil)
        let absent = try JSONDecoder().decode(OpEnvelope<JSONValue>.self, from: Data(#"{"error":"unauthorized"}"#.utf8))
        #expect(absent.result == nil && absent.error == "unauthorized")
    }
}
