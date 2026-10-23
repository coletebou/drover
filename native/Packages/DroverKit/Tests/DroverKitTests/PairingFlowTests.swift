import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import DroverKit

// Portable (Linux CI): a scripted transport and a mock clock, no URLProtocol, no network.
// Not named *ClientTests: CI runs `swift test --skip ClientTests`, a pattern that would skip this suite too.
// A regression in the poll loop shows up as a hang: fail it in a minute instead of stalling CI.
@Suite(.timeLimit(.minutes(1)))
struct PairingFlowTests {
    static let base = URL(string: "http://127.0.0.1:7337")!
    /// MockPairingClock's default start, 2027-01-15T08:00:00Z.
    static let start = Date(timeIntervalSince1970: 1_800_000_000)
    static let in120s = "2027-01-15T08:02:00.000Z"
    static let main = "main-secret-0123"
    static let widget = "widget-secret-4567"

    static func client(_ transport: MockPairingTransport, clock: MockPairingClock = MockPairingClock()) -> PairingClient {
        PairingClient(baseURL: base, transport: transport, clock: clock)
    }

    static func collect(_ stream: AsyncStream<PairingState>) async -> [PairingState] {
        var out: [PairingState] = []
        for await s in stream { out.append(s) }
        return out
    }

    static func secs(_ d: Duration) -> Double { Double(d.components.seconds) + Double(d.components.attoseconds) / 1e18 }

    static func waiting(_ code: String = "123456", at expiresAt: Date = start.addingTimeInterval(120)) -> PairingState {
        .waiting(code: code, expiresAt: expiresAt)
    }

    // MARK: requests on the wire

    @Test func requestIsUnauthenticatedJSON() async throws {
        let t = MockPairingTransport([MockPairingTransport.created(expiresAt: Self.in120s)])
        let ticket = try await Self.client(t).request(client: "Drover for Mac", device: "Studio")
        let r = try #require(t.requests.first)
        #expect(r.httpMethod == "POST")
        #expect(r.url?.absoluteString == "http://127.0.0.1:7337/api/pair/request")
        #expect(r.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(r.allHTTPHeaderFields?.keys.contains { $0.lowercased() == "authorization" } == false)
        #expect(r.value(forHTTPHeaderField: "Content-Type") == "application/json")
        let body = try JSONDecoder().decode([String: String].self, from: try #require(r.httpBody))
        #expect(body == ["client": "Drover for Mac", "device": "Studio"])
        #expect(ticket.code == "123456")
        #expect(ticket.requestId == MockPairingTransport.requestId)
        #expect(ticket.expiresAt == Self.start.addingTimeInterval(120))
        #expect(ticket.pollInterval == .milliseconds(1500))
    }

    @Test func statusAsksWithTheRequestIdOnly() async throws {
        let t = MockPairingTransport([MockPairingTransport.created(expiresAt: Self.in120s), MockPairingTransport.pending()])
        let c = Self.client(t)
        let ticket = try await c.request(client: "Drover for iPhone", device: "iPhone")
        #expect(try await c.status(of: ticket) == .pending(expiresAt: nil))
        let r = try #require(t.requests.last)
        #expect(r.httpMethod == "GET")
        #expect(r.url?.absoluteString == "http://127.0.0.1:7337/api/pair/status?requestId=\(MockPairingTransport.requestId)")
        #expect(r.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(r.httpBody == nil)
    }

    @Test func baseURLQueryAndCredentialsAreDropped() async throws {
        let t = MockPairingTransport([MockPairingTransport.created(expiresAt: Self.in120s)])
        let c = PairingClient(baseURL: URL(string: "https://u:p@mac.example.ts.net:8446/drover/?token=x#f")!, transport: t, clock: MockPairingClock())
        _ = try await c.request(client: "Drover for Mac", device: "")
        #expect(t.requests.first?.url?.absoluteString == "https://mac.example.ts.net:8446/drover/api/pair/request")
    }

    @Test func invalidURLSendsNothing() async {
        let t = MockPairingTransport([MockPairingTransport.created(expiresAt: Self.in120s)])
        let c = PairingClient(baseURL: URL(string: "ftp://127.0.0.1/")!, transport: t, clock: MockPairingClock())
        let states = await Self.collect(c.states(client: "Drover for Mac", device: "Studio"))
        #expect(states == [.requesting, .failed(PairingError.invalidURL.errorDescription!)])
        #expect(t.requests.isEmpty)
    }

    // MARK: outcomes

    @Test func approvedAfterPollingEveryPollMs() async {
        let t = MockPairingTransport([
            MockPairingTransport.created(expiresAt: Self.in120s),
            MockPairingTransport.pending(expiresAt: Self.in120s),
            MockPairingTransport.pending(expiresAt: Self.in120s),
            MockPairingTransport.approved(token: Self.main, widgetToken: Self.widget),
            MockPairingTransport.expired,   // must never be asked for: the approval ends the loop
        ])
        let clock = MockPairingClock()
        let states = await Self.collect(Self.client(t, clock: clock).states(client: "Drover for Mac", device: "Studio"))
        #expect(states == [.requesting, Self.waiting(), .approved(PairingTokens(main: Self.main, widget: Self.widget))])
        #expect(clock.sleeps == [.milliseconds(1500), .milliseconds(1500), .milliseconds(1500)], "one poll per pollMs")
        #expect(t.requests.count == 4, "request + three polls, nothing after the approval")
    }

    @Test func denied() async {
        let t = MockPairingTransport([MockPairingTransport.created(expiresAt: Self.in120s), MockPairingTransport.pending(), MockPairingTransport.denied])
        let states = await Self.collect(Self.client(t).states(client: "Drover for Mac", device: "Studio"))
        #expect(states == [.requesting, Self.waiting(), .denied])
    }

    @Test func notFoundMeansExpired() async {
        let t = MockPairingTransport([MockPairingTransport.created(expiresAt: Self.in120s), MockPairingTransport.expired])
        let states = await Self.collect(Self.client(t).states(client: "Drover for Mac", device: "Studio"))
        #expect(states == [.requesting, Self.waiting(), .expired])
        #expect(t.requests.count == 2)
    }

    @Test func expiredBodyWithoutA404AlsoEnds() async {
        let t = MockPairingTransport([
            MockPairingTransport.created(expiresAt: Self.in120s),
            .http(status: 200, body: #"{"status":"expired"}"#, headers: [:]),
        ])
        let states = await Self.collect(Self.client(t).states(client: "Drover for Mac", device: "Studio"))
        #expect(states.last == .expired)
    }

    @Test func endsAtExpiresAt() async {
        // The daemon keeps saying pending (say its clock lags): the last poll lands on expiresAt, so a late approval
        // is still collected, and then the client gives up.
        let t = MockPairingTransport([MockPairingTransport.created(expiresAt: "2027-01-15T08:00:04.000Z"), MockPairingTransport.pending()])
        let clock = MockPairingClock()
        let states = await Self.collect(Self.client(t, clock: clock).states(client: "Drover for Mac", device: "Studio"))
        #expect(states == [.requesting, Self.waiting(at: Self.start.addingTimeInterval(4)), .expired])
        #expect(t.requests.count == 4, "polls at 1.5, 3 and 4 s")
        #expect(clock.sleeps == [.milliseconds(1500), .milliseconds(1500), .milliseconds(1000)], "the last wait stops at the deadline")
        #expect(clock.now() == Self.start.addingTimeInterval(4))
    }

    @Test func pendingNeverExtendsTheDeadline() async {
        // A daemon answering pending with an ever later expiresAt cannot keep the client polling.
        let t = MockPairingTransport([
            MockPairingTransport.created(expiresAt: "2027-01-15T08:00:04.000Z"),
            MockPairingTransport.pending(expiresAt: "2027-01-15T08:01:00.000Z"),
            MockPairingTransport.pending(expiresAt: "2027-01-15T09:00:00.000Z"),
            MockPairingTransport.pending(expiresAt: "2099-01-01T00:00:00.000Z"),
        ])
        let clock = MockPairingClock()
        let states = await Self.collect(Self.client(t, clock: clock).states(client: "Drover for Mac", device: "Studio"))
        #expect(states == [.requesting, Self.waiting(at: Self.start.addingTimeInterval(4)), .expired])
        #expect(clock.now() == Self.start.addingTimeInterval(4), "ends at the first deadline")
        #expect(t.requests.count == 4)
    }

    @Test func pendingCanBringTheDeadlineCloser() async {
        let t = MockPairingTransport([MockPairingTransport.created(expiresAt: Self.in120s), MockPairingTransport.pending(expiresAt: "2027-01-15T08:00:03.000Z")])
        let clock = MockPairingClock()
        let states = await Self.collect(Self.client(t, clock: clock).states(client: "Drover for Mac", device: "Studio"))
        #expect(states == [.requesting, Self.waiting(), Self.waiting(at: Self.start.addingTimeInterval(3)), .expired],
                "the countdown follows the earlier deadline")
        #expect(clock.now() == Self.start.addingTimeInterval(3))
    }

    @Test func aReplyAfterCancelIsDropped() async throws {
        // The approval is already on the wire when the caller cancels: run() must not hand it over.
        let t = MockPairingTransport([MockPairingTransport.created(expiresAt: Self.in120s),
                                      .late(MockPairingTransport.approved(token: Self.main, widgetToken: Self.widget), after: .milliseconds(300))])
        let client = Self.client(t)
        let log = StateLog()
        let task = Task { await client.run(client: "Drover for Mac", device: "Studio") { log.add($0) } }
        try await Self.eventually { t.requests.count == 2 }
        task.cancel()
        await task.value
        #expect(log.states == [.requesting, Self.waiting()], "no approved after the cancel")
    }

    @Test func tooManyPendingRequests() async {
        let t = MockPairingTransport([MockPairingTransport.error(429, "too many pairing requests; approve or deny the pending ones, or wait for them to expire")])
        let states = await Self.collect(Self.client(t).states(client: "Drover for Mac", device: "Studio"))
        #expect(states == [.requesting, .failed(PairingError.tooManyRequests.errorDescription!)])
        #expect(t.requests.count == 1)
    }

    @Test func daemonWithoutPairingIsUnsupported() async {
        // A Drover from before pairing wants a token for every /api/ path.
        let t = MockPairingTransport([MockPairingTransport.error(401, "unauthorized")])
        let states = await Self.collect(Self.client(t).states(client: "Drover for Mac", device: "Studio"))
        #expect(states == [.requesting, .failed(PairingError.unsupported.errorDescription!)])
    }

    @Test func badRequestIsRefusedWithTheDaemonsReason() async {
        let t = MockPairingTransport([MockPairingTransport.error(400, "client is required")])
        let states = await Self.collect(Self.client(t).states(client: "", device: ""))
        #expect(states.last == .failed("The daemon refused to pair (HTTP 400): client is required."))
    }

    @Test func unreachableDaemonFails() async {
        let t = MockPairingTransport([.unreachable])
        let states = await Self.collect(Self.client(t).states(client: "Drover for Mac", device: "Studio"))
        guard case .failed(let message) = states.last else { Issue.record("expected failed, got \(states)"); return }
        #expect(message.hasPrefix("Could not reach the daemon"))
    }

    @Test func transientPollFailuresAreRetried() async {
        let t = MockPairingTransport([
            MockPairingTransport.created(expiresAt: Self.in120s),
            .unreachable,
            .http(status: 502, body: "<html>bad gateway</html>", headers: [:]),
            MockPairingTransport.error(503, "restarting"),
            MockPairingTransport.approved(token: Self.main, widgetToken: Self.widget),
        ])
        let states = await Self.collect(Self.client(t).states(client: "Drover for Mac", device: "Studio"))
        #expect(states.last == .approved(PairingTokens(main: Self.main, widget: Self.widget)))
        #expect(t.requests.count == 5)
    }

    @Test func refusedPollFails() async {
        let t = MockPairingTransport([MockPairingTransport.created(expiresAt: Self.in120s), MockPairingTransport.error(403, "bad origin")])
        let states = await Self.collect(Self.client(t).states(client: "Drover for Mac", device: "Studio"))
        #expect(states.last == .failed("The daemon refused to pair (HTTP 403): bad origin."))
        #expect(t.requests.count == 2)
    }

    @Test func unknownStatusKeepsPolling() async {
        let t = MockPairingTransport([
            MockPairingTransport.created(expiresAt: Self.in120s),
            .http(status: 200, body: #"{"status":"scanned"}"#, headers: [:]),
            MockPairingTransport.approved(token: Self.main, widgetToken: nil),
        ])
        let states = await Self.collect(Self.client(t).states(client: "Drover for Mac", device: "Studio"))
        #expect(states.last == .approved(PairingTokens(main: Self.main, widget: nil)), "no widget token: nil, not empty")
    }

    @Test func approvedWithoutATokenFails() async {
        let t = MockPairingTransport([MockPairingTransport.created(expiresAt: Self.in120s), .http(status: 200, body: #"{"status":"approved","token":""}"#, headers: [:])])
        let states = await Self.collect(Self.client(t).states(client: "Drover for Mac", device: "Studio"))
        #expect(states.last == .failed(PairingError.badResponse("approved without a token").errorDescription!))
    }

    @Test func malformedRequestAnswersFail() async throws {
        for body in [#"{"code":"123456","expiresAt":"2027-01-15T08:02:00.000Z"}"#,                 // no requestId
                     #"{"requestId":"0123456789abcdef0123456789abcdef","code":"12ab56"}"#,           // not digits
                     #"{"requestId":"../../etc","code":"123456"}"#,                                  // unsafe id
                     "not json"] {
            let t = MockPairingTransport([.http(status: 201, body: body, headers: [:])])
            await #expect(throws: PairingError.self) { try await Self.client(t).request(client: "Drover for Mac", device: "") }
        }
    }

    @Test func pollIntervalComesFromTheDaemonWithinBounds() async throws {
        for (ms, expected) in [(500.0, Duration.milliseconds(500)), (0, .milliseconds(250)), (60_000, .seconds(10))] {
            let t = MockPairingTransport([MockPairingTransport.created(expiresAt: Self.in120s, pollMs: ms)])
            #expect(try await Self.client(t).request(client: "Drover for Mac", device: "").pollInterval == expected)
        }
        let missing = MockPairingTransport([.http(status: 201, body: #"{"requestId":"abc123","code":"123456"}"#, headers: [:])])
        let ticket = try await Self.client(missing).request(client: "Drover for Mac", device: "")
        #expect(ticket.pollInterval == .milliseconds(1500), "default pollMs")
        #expect(ticket.expiresAt == Self.start.addingTimeInterval(120), "default lifetime when expiresAt is missing")
    }

    @Test func expiryIsMeasuredAgainstTheDaemonsClock() async throws {
        // The daemon's clock is 10 minutes behind this device: without the Date header the code would look
        // lapsed already. With it, the device waits the code's full two minutes on its own clock.
        let t = MockPairingTransport([MockPairingTransport.created(expiresAt: "2027-01-15T07:52:00.000Z", date: "Fri, 15 Jan 2027 07:50:00 GMT")])
        let ticket = try await Self.client(t).request(client: "Drover for Mac", device: "")
        #expect(ticket.expiresAt == Self.start.addingTimeInterval(120))
        #expect(PairingClient.httpDate("Fri, 15 Jan 2027 08:00:00 GMT") == Self.start)
        #expect(PairingClient.httpDate("yesterday") == nil)
    }

    // MARK: cancellation

    @Test func cancellingWhileWaitingStopsPolling() async throws {
        let t = MockPairingTransport([MockPairingTransport.created(expiresAt: Self.in120s), MockPairingTransport.pending()])
        let stream = Self.client(t, clock: MockPairingClock(holding: true)).states(client: "Drover for Mac", device: "Studio")
        let seen = Seen()
        let consumer = Task {
            for await s in stream { await seen.add(s) }
        }
        try await Self.eventually { await seen.states.count == 2 }
        consumer.cancel()
        _ = await consumer.value
        try await Task.sleep(for: .milliseconds(100))
        #expect(await seen.states == [.requesting, Self.waiting()], "no final state after a cancel")
        #expect(t.requests.count == 1, "no poll after the cancel")
    }

    @Test func cancellingDuringAPollEndsQuietly() async throws {
        let t = MockPairingTransport([MockPairingTransport.created(expiresAt: Self.in120s), .hang])
        let stream = Self.client(t).states(client: "Drover for Mac", device: "Studio")
        let seen = Seen()
        let consumer = Task {
            for await s in stream { await seen.add(s) }
        }
        try await Self.eventually { t.requests.count == 2 }
        consumer.cancel()
        _ = await consumer.value
        try await Task.sleep(for: .milliseconds(100))
        #expect(await seen.states == [.requesting, Self.waiting()])
        #expect(t.requests.count == 2)
    }

    static func eventually(_ condition: @Sendable () async -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while !(await condition()) {
            guard ContinuousClock.now < deadline else { Issue.record("timed out"); return }
            try await Task.sleep(for: .milliseconds(5))
        }
    }

    // MARK: secrets and formatting

    @Test func tokensAndTheRequestIdNeverPrint() async throws {
        let tokens = PairingTokens(main: Self.main, widget: Self.widget)
        let state = PairingState.approved(tokens)
        var dumped = ""
        dump(state, to: &dumped)
        var dumpedTokens = ""
        dump(tokens, to: &dumpedTokens)
        for text in [String(describing: tokens), String(reflecting: tokens), "\(state)", String(reflecting: state), dumped, dumpedTokens,
                     String(describing: [state]), String(describing: Optional(tokens))] {
            #expect(!text.contains(Self.main) && !text.contains(Self.widget), "leaked in \(text)")
        }
        let t = MockPairingTransport([MockPairingTransport.created(expiresAt: Self.in120s)])
        let ticket = try await Self.client(t).request(client: "Drover for Mac", device: "")
        var dumpedTicket = ""
        dump(ticket, to: &dumpedTicket)
        for text in [String(describing: ticket), String(reflecting: ticket), dumpedTicket] {
            #expect(!text.contains(MockPairingTransport.requestId), "request id leaked in \(text)")
        }
    }

    @Test func requestIdNeverReachesAnErrorMessage() async {
        let id = MockPairingTransport.requestId
        let t = MockPairingTransport([MockPairingTransport.created(expiresAt: Self.in120s), MockPairingTransport.error(400, "bad requestId \(id)")])
        let states = await Self.collect(Self.client(t).states(client: "Drover for Mac", device: ""))
        guard case .failed(let message) = states.last else { Issue.record("expected failed"); return }
        #expect(!message.contains(id))
    }

    @Test func codeFormatting() {
        #expect(PairingCode.formatted("123456") == "123 456")
        #expect(PairingCode.formatted("012345") == "012 345", "leading zero kept")
        #expect(PairingCode.formatted("1234") == "123 4")
        #expect(PairingCode.approveCommand("123456") == "drover pair approve 123456")
        #expect(PairingCode.instructions("123456")
                == "Approve this code on your Mac: run `drover pair approve 123456` or use Approve in Drover's browser UI.")
        #expect(PairingCode.spoken("123456") == "1 2 3, 4 5 6")
    }

    @Test func labelsFitTheDaemon() {
        #expect(PairingClient.label("  Alice's   Mac\nStudio\t") == "Alice's Mac Studio")
        #expect(PairingClient.label("a\u{0007}b") == "a b", "control characters become spaces")
        let long = PairingClient.label(String(repeating: "x", count: 100))
        #expect(long.utf16.count == 64)
        let emoji = PairingClient.label(String(repeating: "a", count: 63) + "📱")
        #expect(emoji == String(repeating: "a", count: 63), "a surrogate pair is never split")
        #expect(PairingClient.label(String(repeating: "a", count: 63) + " b") == String(repeating: "a", count: 63), "no trailing space")
    }

    @Test func loopback() {
        for s in ["http://127.0.0.1:7337", "http://localhost:7337", "http://[::1]:7337", "http://127.1.2.3", "https://LOCALHOST"] {
            #expect(PairingClient.isLoopback(URL(string: s)!), "\(s)")
        }
        for s in ["http://100.64.0.1:7337", "https://mac.example.ts.net:8446", "http://0.0.0.0:7337", "http://127.0.0.1.example.com",
                  "http://10.0.0.127", "http://128.0.0.1"] {
            #expect(!PairingClient.isLoopback(URL(string: s)!), "\(s)")
        }
    }
}

actor Seen {
    private(set) var states: [PairingState] = []
    func add(_ s: PairingState) { states.append(s) }
}

/// States from `run(...)`'s synchronous emit.
final class StateLog: @unchecked Sendable {
    private let lock = NSLock()
    private var all: [PairingState] = []
    var states: [PairingState] {
        lock.lock(); defer { lock.unlock() }
        return all
    }
    func add(_ s: PairingState) {
        lock.lock(); defer { lock.unlock() }
        all.append(s)
    }
}
