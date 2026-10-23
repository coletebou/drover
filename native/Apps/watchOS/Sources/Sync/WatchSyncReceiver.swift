import Foundation
import Observation
import WatchConnectivity
import WatchKit

/// Receives the server URL and tokens the iPhone app sends with `transferUserInfo`
/// and stores them. Tokens are never logged or displayed.
@MainActor
@Observable
final class WatchSyncReceiver: NSObject {
    static let shared = WatchSyncReceiver()

    /// When a payload was last applied. Drives the pairing status view.
    private(set) var lastSyncAt: Date?

    @ObservationIgnored private weak var model: AppModel?
    @ObservationIgnored private var activated = false
    /// Work started by a delivery that the background task must wait for before returning.
    @ObservationIgnored private var pendingWork: [Task<Void, Never>] = []

    func attach(model: AppModel) { self.model = model }

    func activate() {
        guard WCSession.isSupported(), !activated else { return }
        activated = true
        let session = WCSession.default
        session.delegate = self
        session.activate()
    }

    /// Called from `.backgroundTask(.watchConnectivity)`. Stays alive until WatchConnectivity
    /// has delivered pending content, for at most 20 seconds.
    func handleBackgroundTask() async {
        guard WCSession.isSupported() else { return }
        activate()
        let deadline = ContinuousClock.now + .seconds(20)
        while WCSession.default.activationState != .activated || WCSession.default.hasContentPending {
            if ContinuousClock.now >= deadline { break }
            do { try await Task.sleep(for: .milliseconds(250)) } catch { break }
        }
        // Deliveries may have started a background download enqueue; let it reach resume().
        while !pendingWork.isEmpty {
            let work = pendingWork
            pendingWork = []
            for t in work { await t.value }
        }
    }

    func unpair() {
        try? makeApplier().unpair()
        model?.clearData()
        didChangeCredentials()
    }

    private func makeApplier() -> SyncApplier {
        if let model {
            return SyncApplier(vault: model.vault, config: model.config, cache: model.cache, seen: model.seen)
        }
        return SyncApplier(vault: KeychainTokenVault(), config: WatchConfig(), cache: .standard(), seen: SeenWaitingStore())
    }

    private func apply(_ p: WatchSyncPayload) {
        let change = (try? makeApplier().apply(p)) ?? SyncChange()
        lastSyncAt = Date()
        if change.serverChanged { model?.clearData() }
        if change.any || change.serverChanged { didChangeCredentials() }
    }

    private func didChangeCredentials() {
        model?.reloadCredentials()
        Complications.reload()
        // A transfer can arrive while the app runs in the background: then only the widget
        // token may be used.
        if WKApplication.shared().applicationState == .active {
            Task { await self.model?.refresh() }
        } else {
            // Not frontmost: an ordinary URLSession may not run; queue the background download.
            pendingWork.append(Task { await BackgroundSummaryDownload.shared.enqueue() })
        }
    }
}

extension WatchSyncReceiver: WCSessionDelegate {
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
                             error: Error?) {
        guard activationState == .activated,
              let payload = WatchSyncPayload(userInfo: session.receivedApplicationContext) else { return }
        Task { @MainActor in self.apply(payload) }
    }

    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        guard let payload = WatchSyncPayload(userInfo: userInfo) else { return }
        Task { @MainActor in self.apply(payload) }
    }
}
