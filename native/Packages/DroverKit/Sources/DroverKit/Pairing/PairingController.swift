import Foundation
import Observation

/// What a pairing view shows. Unlike `PairingState` it never holds a token: once the app has stored the tokens the
/// phase only says `paired`.
public enum PairingPhase: Sendable, Equatable {
    case idle
    case requesting
    /// Show `code` (`PairingCode.formatted`) until `expiresAt`, on this device's clock.
    case waiting(code: String, expiresAt: Date)
    /// Approved, and the app stored both tokens.
    case paired
    case denied
    case expired
    /// A sentence for the user.
    case failed(String)

    /// requesting or waiting: an attempt is in flight.
    public var isActive: Bool {
        switch self {
        case .requesting, .waiting: true
        default: false
        }
    }

    /// The code while waiting, else nil.
    public var code: String? {
        if case .waiting(let code, _) = self { code } else { nil }
    }
}

/// One pairing at a time for a view: runs `PairingClient.states`, publishes the phase and hands the tokens to the
/// app's `onApproved`, which stores them where a pasted token goes. The controller keeps no token.
@MainActor @Observable
public final class PairingController {
    public private(set) var phase: PairingPhase = .idle
    /// The daemon of the current or last attempt.
    public private(set) var serverURL: URL?

    @ObservationIgnored private let makeClient: @Sendable (URL) -> PairingClient
    @ObservationIgnored private var task: Task<Void, Never>?
    /// Bumped by start and cancel, so a replaced attempt's late states never land.
    @ObservationIgnored private var attempt = 0

    /// `makeClient`: tests and previews pass a client with a mock transport and clock.
    public init(makeClient: @escaping @Sendable (URL) -> PairingClient = { PairingClient(baseURL: $0) }) {
        self.makeClient = makeClient
    }

    deinit {
        task?.cancel()
    }

    /// Cancels any attempt in flight and pairs with `baseURL`. `onApproved` runs on the main actor with both
    /// tokens; throw from it when storing them failed and the phase says so instead of `paired`.
    public func start(baseURL: URL, client: String, device: String,
                      onApproved: @escaping @MainActor (PairingTokens) throws -> Void) {
        task?.cancel()
        attempt &+= 1
        let current = attempt
        serverURL = baseURL
        phase = .requesting
        let states = makeClient(baseURL).states(client: client, device: device)
        task = Task { [weak self] in
            for await state in states {
                guard let self, self.attempt == current else { return }
                self.apply(state, onApproved: onApproved)
            }
        }
    }

    /// Stops the attempt in flight (no further request is sent) and goes back to idle. A finished phase stays.
    public func cancel() {
        task?.cancel()
        task = nil
        attempt &+= 1
        if phase.isActive { phase = .idle }
    }

    /// Back to idle, whatever the phase.
    public func reset() {
        cancel()
        phase = .idle
    }

    private func apply(_ state: PairingState, onApproved: @MainActor (PairingTokens) throws -> Void) {
        switch state {
        case .idle: break
        case .requesting: phase = .requesting
        case .waiting(let code, let expiresAt): phase = .waiting(code: code, expiresAt: expiresAt)
        case .approved(let tokens):
            do {
                try onApproved(tokens)
                phase = .paired
            } catch {
                phase = .failed("Paired, but the tokens could not be saved: \(error.localizedDescription)")
            }
        case .denied: phase = .denied
        case .expired: phase = .expired
        case .failed(let message): phase = .failed(message)
        }
    }
}
