import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import DroverKit

// A regression in the poll loop shows up as a hang: fail it in a minute instead of stalling CI.
@MainActor
@Suite(.timeLimit(.minutes(1)))
struct PairingControllerTests {
    static let base = URL(string: "http://127.0.0.1:7337")!

    @MainActor final class Store {
        var saved: [PairingTokens] = []
    }

    struct KeychainDown: LocalizedError {
        var errorDescription: String? { "Keychain error -34018" }
    }

    static func controller(_ transport: MockPairingTransport, clock: MockPairingClock = MockPairingClock()) -> PairingController {
        PairingController(makeClient: { PairingClient(baseURL: $0, transport: transport, clock: clock) })
    }

    static func until(_ condition: @MainActor () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while !condition() {
            guard ContinuousClock.now < deadline else { Issue.record("timed out"); return }
            try await Task.sleep(for: .milliseconds(5))
        }
    }

    @Test func approvalIsStoredThenForgotten() async throws {
        let t = MockPairingTransport([
            MockPairingTransport.created(expiresAt: "2027-01-15T08:02:00.000Z"),
            MockPairingTransport.approved(token: "main-secret", widgetToken: "widget-secret"),
        ])
        let c = Self.controller(t)
        let store = Store()
        c.start(baseURL: Self.base, client: "Drover for Mac", device: "Studio") { store.saved.append($0) }
        #expect(c.phase == .requesting)
        #expect(c.serverURL == Self.base)
        try await Self.until { c.phase == .paired }
        #expect(store.saved == [PairingTokens(main: "main-secret", widget: "widget-secret")])
        #expect(!String(describing: c.phase).contains("secret"))
    }

    @Test func waitingShowsTheCode() async throws {
        let t = MockPairingTransport([MockPairingTransport.created(code: "042137", expiresAt: "2027-01-15T08:02:00.000Z"), .hang])
        let c = Self.controller(t)
        c.start(baseURL: Self.base, client: "Drover for Mac", device: "Studio") { _ in }
        try await Self.until { c.phase.code != nil }
        #expect(c.phase == .waiting(code: "042137", expiresAt: Date(timeIntervalSince1970: 1_800_000_120)))
        #expect(c.phase.isActive)
        c.cancel()
        #expect(c.phase == .idle)
    }

    @Test func storingFailureIsShown() async throws {
        let t = MockPairingTransport([
            MockPairingTransport.created(expiresAt: "2027-01-15T08:02:00.000Z"),
            MockPairingTransport.approved(token: "main-secret", widgetToken: nil),
        ])
        let c = Self.controller(t)
        c.start(baseURL: Self.base, client: "Drover for Mac", device: "Studio") { _ in throw KeychainDown() }
        try await Self.until { !c.phase.isActive }
        #expect(c.phase == .failed("Paired, but the tokens could not be saved: Keychain error -34018"))
    }

    @Test func finalStatesPassThrough() async throws {
        for (answer, phase) in [(MockPairingTransport.denied, PairingPhase.denied), (MockPairingTransport.expired, .expired)] {
            let t = MockPairingTransport([MockPairingTransport.created(expiresAt: "2027-01-15T08:02:00.000Z"), answer])
            let c = Self.controller(t)
            c.start(baseURL: Self.base, client: "Drover for Mac", device: "Studio") { _ in Issue.record("no tokens expected") }
            try await Self.until { !c.phase.isActive }
            #expect(c.phase == phase)
        }
        let t = MockPairingTransport([.unreachable])
        let c = Self.controller(t)
        c.start(baseURL: Self.base, client: "Drover for Mac", device: "Studio") { _ in }
        try await Self.until { !c.phase.isActive }
        guard case .failed = c.phase else { Issue.record("expected failed, got \(c.phase)"); return }
        c.reset()
        #expect(c.phase == .idle)
    }

    @Test func cancelStopsPolling() async throws {
        let t = MockPairingTransport([MockPairingTransport.created(expiresAt: "2027-01-15T08:02:00.000Z"), MockPairingTransport.pending()])
        let c = Self.controller(t, clock: MockPairingClock(holding: true))
        c.start(baseURL: Self.base, client: "Drover for Mac", device: "Studio") { _ in Issue.record("no tokens expected") }
        try await Self.until { c.phase.code != nil }
        c.cancel()
        #expect(c.phase == .idle)
        try await Task.sleep(for: .milliseconds(100))
        #expect(t.requests.count == 1, "no poll after cancel")
        #expect(c.phase == .idle)
    }

    @Test func approvalAfterCancelIsIgnored() async throws {
        // The user saved a connection by hand while the approval was on its way: it must not overwrite it.
        let t = MockPairingTransport([MockPairingTransport.created(expiresAt: "2027-01-15T08:02:00.000Z"),
                                      .late(MockPairingTransport.approved(token: "main-secret", widgetToken: "widget-secret"), after: .milliseconds(300))])
        let c = Self.controller(t)
        let store = Store()
        c.start(baseURL: Self.base, client: "Drover for Mac", device: "Studio") { store.saved.append($0) }
        try await Self.until { t.requests.count == 2 }
        c.cancel()
        try await Task.sleep(for: .milliseconds(600))
        #expect(store.saved.isEmpty, "a late approval never reaches onApproved")
        #expect(c.phase == .idle)
    }

    @Test func startingAgainReplacesTheAttempt() async throws {
        let first = MockPairingTransport([MockPairingTransport.created(code: "111111", expiresAt: "2027-01-15T08:02:00.000Z"),
                                          MockPairingTransport.approved(token: "old-secret", widgetToken: nil)])
        let second = MockPairingTransport([MockPairingTransport.created(code: "222222", expiresAt: "2027-01-15T08:02:00.000Z"), .hang])
        let firstClock = MockPairingClock(holding: true)
        let c = PairingController(makeClient: { url in
            url.port == 1 ? PairingClient(baseURL: url, transport: first, clock: firstClock)
                          : PairingClient(baseURL: url, transport: second, clock: MockPairingClock())
        })
        let store = Store()
        c.start(baseURL: URL(string: "http://127.0.0.1:1")!, client: "Drover for Mac", device: "Studio") { store.saved.append($0) }
        try await Self.until { c.phase.code == "111111" }
        c.start(baseURL: URL(string: "http://127.0.0.1:2")!, client: "Drover for Mac", device: "Studio") { store.saved.append($0) }
        try await Self.until { c.phase.code == "222222" }
        try await Task.sleep(for: .milliseconds(100))
        #expect(c.phase.code == "222222")
        #expect(c.serverURL?.port == 2)
        #expect(first.requests.count == 1, "the replaced attempt never polls")
        #expect(store.saved.isEmpty)
        c.cancel()
    }
}
