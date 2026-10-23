import Foundation
import Observation

/// User preferences (UserDefaults). The token is NOT here: it lives in the Keychain (TokenStore).
@Observable @MainActor
final class AppSettings {
    nonisolated static let appGroup = "group.dev.drover"

    private let defaults: UserDefaults
    private let group: UserDefaults?

    /// e.g. `http://127.0.0.1:7337`. Mirrored to the App Group key `drover.baseURL` for widgets.
    var serverURLString: String {
        didSet { persistServerURL() }
    }

    /// Notification rules (per-category on/off and sound, quiet hours). Shape owned by NotificationRules.swift.
    var notificationRules: NotificationRules {
        didSet { defaults.set(try? JSONEncoder().encode(notificationRules), forKey: Keys.rules) }
    }

    /// Show the turns Chat hides by default: harness/meta user turns, queued messages, titles.
    var showToolTurns: Bool {
        didSet { defaults.set(showToolTurns, forKey: Keys.showTools) }
    }

    init(defaults: UserDefaults = .standard, group: UserDefaults? = UserDefaults(suiteName: AppSettings.appGroup)) {
        self.defaults = defaults
        self.group = group
        serverURLString = defaults.string(forKey: Keys.serverURL) ?? "http://127.0.0.1:7337"
        notificationRules = defaults.data(forKey: Keys.rules).flatMap { try? JSONDecoder().decode(NotificationRules.self, from: $0) } ?? NotificationRules()
        showToolTurns = defaults.object(forKey: Keys.showTools) as? Bool ?? false
    }

    /// Writes the URL to this app's defaults and to the App Group key `drover.baseURL` (menu bar, Safari extension,
    /// widgets). Runs on every edit; pairing calls it too, since the default URL is never written until edited.
    func persistServerURL() {
        defaults.set(serverURLString, forKey: Keys.serverURL)
        group?.set(serverURLString, forKey: "drover.baseURL")
    }

    /// Parsed base URL, nil when empty or not http(s).
    var serverURL: URL? {
        let s = serverURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let u = URL(string: s), let scheme = u.scheme?.lowercased(), scheme == "http" || scheme == "https", u.host() != nil else { return nil }
        return u
    }

    private enum Keys {
        static let serverURL = "drover.serverURL"
        static let rules = "drover.notificationRules"
        static let showTools = "drover.showToolTurns"
    }
}
