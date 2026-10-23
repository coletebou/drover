import Foundation
import Observation

/// Mirror with all-optional fields so JSON from an older or newer build still loads: each
/// missing field falls back to its default. (An `init(from:)` extension would clash with the
/// synthesized one.)
private struct StoredPreferences: Decodable {
    var serverURL: String?
    var pollSeconds: Int?
    var openTarget: OpenTarget?
    var notifyOnWaiting: Bool?
    var notificationSound: Bool?
    var hotkey: KeyCombo?
    var hasHotkey: Bool

    enum CodingKeys: String, CodingKey {
        case serverURL, pollSeconds, openTarget, notifyOnWaiting, notificationSound, hotkey
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        serverURL = try? c.decodeIfPresent(String.self, forKey: .serverURL)
        pollSeconds = try? c.decodeIfPresent(Int.self, forKey: .pollSeconds)
        openTarget = try? c.decodeIfPresent(OpenTarget.self, forKey: .openTarget)
        notifyOnWaiting = try? c.decodeIfPresent(Bool.self, forKey: .notifyOnWaiting)
        notificationSound = try? c.decodeIfPresent(Bool.self, forKey: .notificationSound)
        hasHotkey = c.contains(.hotkey)
        hotkey = try? c.decodeIfPresent(KeyCombo.self, forKey: .hotkey)
    }

    var preferences: MenuBarPreferences {
        let d = MenuBarPreferences.default
        return MenuBarPreferences(
            serverURL: serverURL ?? d.serverURL,
            pollSeconds: pollSeconds ?? d.pollSeconds,
            openTarget: openTarget ?? d.openTarget,
            notifyOnWaiting: notifyOnWaiting ?? d.notifyOnWaiting,
            notificationSound: notificationSound ?? d.notificationSound,
            hotkey: hasHotkey ? hotkey : d.hotkey)
    }
}

@MainActor @Observable
final class PreferencesStore {
    static let defaultsKey = "menubar.preferences"

    var value: MenuBarPreferences {
        didSet { save() }
    }

    @ObservationIgnored var onChange: (@MainActor (MenuBarPreferences) -> Void)?

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let shared: UserDefaults?

    init(defaults: UserDefaults = .standard,
         shared: UserDefaults? = UserDefaults(suiteName: AppIdentifiers.appGroup)) {
        self.defaults = defaults
        self.shared = shared
        if let data = defaults.data(forKey: Self.defaultsKey),
           let decoded = try? JSONDecoder().decode(StoredPreferences.self, from: data) {
            self.value = decoded.preferences
        } else {
            self.value = .default
        }
        syncShared()
    }

    private func save() {
        if let data = try? JSONEncoder().encode(value) {
            var out = data
            // The synthesized encoder omits a nil hotkey, which would load back as the default
            // shortcut. Store an explicit null so "disabled" survives a relaunch.
            if value.hotkey == nil,
               var obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                obj["hotkey"] = NSNull()
                out = (try? JSONSerialization.data(withJSONObject: obj)) ?? data
            }
            defaults.set(out, forKey: Self.defaultsKey)
        }
        syncShared()
        onChange?(value)
    }

    private func syncShared() {
        if let url = value.baseURL {
            shared?.set(url.absoluteString, forKey: AppIdentifiers.sharedBaseURLKey)
        } else {
            shared?.removeObject(forKey: AppIdentifiers.sharedBaseURLKey)
        }
    }
}
