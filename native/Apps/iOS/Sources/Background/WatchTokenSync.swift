import Foundation
import WatchConnectivity

/// Sends the base URL and tokens to the paired watch with `transferUserInfo`. Payload contents are never logged or shown.
@MainActor
final class WatchTokenSync: NSObject {
    static let shared = WatchTokenSync()

    private static let tokenKey = "drover.token"

    private var session: WCSession? {
        WCSession.isSupported() ? WCSession.default : nil
    }

    func activate() {
        guard let session else { return }
        session.delegate = self
        session.activate()
    }

    /// Sends base URL and tokens to the paired watch.
    func push() {
        guard let session, session.activationState == .activated,
              session.isPaired, session.isWatchAppInstalled else { return }
        let vault = TokenVault()
        for transfer in session.outstandingUserInfoTransfers where transfer.userInfo[Self.tokenKey] != nil {
            transfer.cancel()
        }
        // On the watch an absent key means "leave unchanged" and an empty string means "clear", so always send all three.
        let payload: [String: Any] = [
            "drover.baseURL": SharedSettings().baseURL?.absoluteString ?? "",
            Self.tokenKey: vault.read(.main) ?? "",
            "drover.widgetToken": vault.read(.widget) ?? "",
        ]
        session.transferUserInfo(payload)
    }
}

extension WatchTokenSync: WCSessionDelegate {
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
                             error: Error?) {
        guard activationState == .activated else { return }
        Task { @MainActor in WatchTokenSync.shared.push() }
    }

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }
}
