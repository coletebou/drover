import Foundation

/// Shared Apple identifiers. Source of truth: the "Apple identifiers" table in CONTRACT.md.
enum DroverIDs {
    static let appGroup = "group.dev.drover"
    /// Info.plist key whose value is `$(AppIdentifierPrefix)dev.drover.shared`, expanded at build time,
    /// so the team prefix never has to be hardcoded.
    static let keychainGroupInfoKey = "DroverKeychainAccessGroup"
    static let keychainService = "dev.drover.token"
    static let mainTokenAccount = "main"
    static let widgetTokenAccount = "widget"
    /// App Group UserDefaults key for the daemon base URL (shared with widgets).
    static let baseURLDefaultsKey = "drover.baseURL"
    /// File in the App Group container: the bare `native.summary` result object.
    static let summaryFileName = "summary.json"
    static let refreshTaskID = "dev.drover.app.refresh"
    static let urlScheme = "drover"
    /// Value sent as `actor` on mutating ops so the truth file shows where a message came from. `ios` is one of the
    /// owner's client names (the daemon's core/owner.js), so the manager reads it as the owner, in the shared conversation.
    static let actor = "ios"
    /// `via` of an approval answered from a notification action (the board's answers say `actor`, `ios`).
    static let notificationVia = "ios-notification"

    /// The full Keychain access group, or nil when the build did not set it (previews, unsigned typecheck).
    static var keychainAccessGroup: String? {
        guard let v = Bundle.main.object(forInfoDictionaryKey: keychainGroupInfoKey) as? String,
              !v.isEmpty, !v.hasPrefix("$(") else { return nil }
        return v
    }
}
