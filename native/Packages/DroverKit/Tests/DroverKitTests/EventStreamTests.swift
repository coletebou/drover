import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import DroverKit

actor FakeConnector {
    struct Script { var status: Int; var lines: [String]; var hold = false }
    private var scripts: [Script]
    private(set) var calls = 0
    init(_ scripts: [Script]) { self.scripts = scripts }

    func next() -> Script {
        calls += 1
        return scripts.isEmpty ? Script(status: 200, lines: [], hold: true) : scripts.removeFirst()
    }

    nonisolated func connect() -> EventStream.Connect {
        { _ in
            let s = await self.next()
            let stream = AsyncThrowingStream<String, any Error> { c in
                for l in s.lines { c.yield(l) }
                if !s.hold { c.finish() }
            }
            return (s.status, stream)
        }
    }
}

struct EventStreamTests {
    static let url = URL(string: "http://drover.test/api/stream")!
    static let fast = Backoff(initial: .milliseconds(5), maximum: .milliseconds(40), multiplier: 2, jitter: 0)

    static func stream(_ fake: FakeConnector, backoff: Backoff = fast, healthyAfter: Duration = .zero,
                       request: @escaping @Sendable () async throws -> URLRequest = { URLRequest(url: url) }) -> EventStream {
        var s = EventStream(request: request, backoff: backoff, connect: fake.connect())
        s.healthyAfter = healthyAfter
        return s
    }

    static func collect(_ s: EventStream, until stop: (StreamUpdate) -> Bool) async -> [StreamUpdate] {
        var out: [StreamUpdate] = []
        for await u in s.updates() {
            out.append(u)
            if stop(u) { break }
        }
        return out
    }

    static func isWaiting(_ u: StreamUpdate) -> Bool { if case .waiting = u { true } else { false } }

    @Test func eventsInOrderThenReconnect() async {
        let fake = FakeConnector([
            .init(status: 200, lines: ["event: hello", "data: {}", "", "event: mutation", "data: {}", ""]),
            .init(status: 200, lines: ["event: notify", "data: {}", ""]),
        ])
        var opens = 0
        let updates = await Self.collect(Self.stream(fake)) { u in
            if case .open = u { opens += 1 }
            return opens == 2
        }
        let names = updates.compactMap { u -> String? in if case .event(let e) = u { e.name } else { nil } }
        #expect(names == ["hello", "mutation"])
        #expect(updates.first == .connecting)
        #expect(updates.contains(where: Self.isWaiting))
        #expect(await fake.calls == 2)
    }

    @Test func unauthorizedStops() async {
        let fake = FakeConnector([.init(status: 401, lines: [])])
        var all: [StreamUpdate] = []
        for await u in Self.stream(fake).updates() { all.append(u) }
        #expect(all == [.connecting, .stopped(.unauthorized)])
        #expect(await fake.calls == 1)
    }

    @Test func forbiddenStops() async {
        let fake = FakeConnector([.init(status: 403, lines: [])])
        var all: [StreamUpdate] = []
        for await u in Self.stream(fake).updates() { all.append(u) }
        #expect(all.last == .stopped(.forbidden(nil)))
    }

    @Test func notConfiguredStops() async {
        let fake = FakeConnector([])
        var all: [StreamUpdate] = []
        for await u in Self.stream(fake, request: { throw DroverError.notConfigured }).updates() { all.append(u) }
        #expect(all == [.connecting, .stopped(.notConfigured)])
        #expect(await fake.calls == 0)
    }

    @Test func serverErrorRetries() async {
        let fake = FakeConnector([.init(status: 500, lines: []), .init(status: 200, lines: [], hold: true)])
        let updates = await Self.collect(Self.stream(fake)) { $0 == .open }
        #expect(updates.contains(where: Self.isWaiting))
        #expect(await fake.calls == 2)
    }

    @Test func attemptResetsAfterEvent() async {
        let b = Backoff(initial: .milliseconds(10), maximum: .milliseconds(1000), multiplier: 2, jitter: 0)
        let fake = FakeConnector([
            .init(status: 200, lines: []),                 // fail: attempt 0 -> 10 ms
            .init(status: 200, lines: []),                 // fail: attempt 1 -> 20 ms
            .init(status: 200, lines: ["data: x", ""]),    // event, then end: reset -> 10 ms
            .init(status: 200, lines: []),                 // fail: attempt 1 -> 20 ms
            .init(status: 200, lines: [], hold: true),
        ])
        var waits: [Duration] = []
        _ = await Self.collect(Self.stream(fake, backoff: b)) { u in
            if case .waiting(let d) = u { waits.append(d) }
            return waits.count == 4
        }
        #expect(waits == [.milliseconds(10), .milliseconds(20), .milliseconds(10), .milliseconds(20)])
    }

    @Test func shortLivedConnectionsKeepBackingOff() async {
        let b = Backoff(initial: .milliseconds(10), maximum: .milliseconds(1000), multiplier: 2, jitter: 0)
        let fake = FakeConnector([
            .init(status: 200, lines: ["event: hello", "data: {}", ""]),   // hello, then dropped at once
            .init(status: 200, lines: ["event: hello", "data: {}", ""]),
            .init(status: 200, lines: ["event: hello", "data: {}", ""]),
            .init(status: 200, lines: [], hold: true),
        ])
        var waits: [Duration] = []
        _ = await Self.collect(Self.stream(fake, backoff: b, healthyAfter: .seconds(10))) { u in
            if case .waiting(let d) = u { waits.append(d) }
            return waits.count == 3
        }
        #expect(waits == [.milliseconds(10), .milliseconds(20), .milliseconds(40)])
    }

    @Test func cancellingConsumerStopsConnecting() async throws {
        let fake = FakeConnector([])   // holds the first connection open forever
        let s = Self.stream(fake)
        let task = Task { for await _ in s.updates() {} }
        try await Task.sleep(for: .milliseconds(50))
        let before = await fake.calls
        task.cancel()
        _ = await task.value
        try await Task.sleep(for: .milliseconds(100))
        #expect(await fake.calls == before)
        #expect(before == 1)
    }
}
