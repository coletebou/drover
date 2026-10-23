import Foundation
import Observation
import ServiceManagement

@MainActor @Observable
final class LoginItem {
    private(set) var isEnabled = false
    private(set) var statusText = "Off"
    private(set) var lastError: String?
    private(set) var needsApproval = false

    init() { refresh() }

    func refresh() {
        let status = SMAppService.mainApp.status
        isEnabled = status == .enabled
        needsApproval = status == .requiresApproval
        switch status {
        case .enabled: statusText = "Opens at login"
        case .requiresApproval: statusText = "Needs approval in System Settings, Login Items"
        case .notRegistered: statusText = "Off"
        case .notFound: statusText = "Not available in this build"
        @unknown default: statusText = "Off"
        }
    }

    func setEnabled(_ on: Bool) {
        lastError = nil
        do {
            if on {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            lastError = "Could not change the login item."
        }
        refresh()
    }

    func openSystemSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }
}
