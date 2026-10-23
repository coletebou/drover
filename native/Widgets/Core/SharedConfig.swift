import Foundation

/// Identifiers shared with the apps. Values come from CONTRACT.md ("Apple identifiers" and
/// "Widget data handoff"); change them there first.
enum SharedConfig {
    static let appGroup = "group.dev.drover"
    static let baseURLDefaultsKey = "drover.baseURL"
    static let summaryCacheFileName = "summary.json"
    static let keychainService = "dev.drover.token"
    /// Widgets read only the read-only widget-scope token, never the main one.
    static let widgetTokenAccount = "widget"
    /// `$(AppIdentifierPrefix)dev.drover.shared`; the team prefix is resolved from entitlements at runtime,
    /// so Keychain queries omit kSecAttrAccessGroup and rely on the entitlement's first group.
    static let keychainAccessGroupSuffix = "dev.drover.shared"
    static let urlScheme = "drover"
    static let summaryOp = "native.summary"

    /// Widget kinds (stable: renaming them drops users' placed widgets).
    static let summaryWidgetKind = "DroverSummaryWidget"
    static let waitingWidgetKind = "DroverWaitingWidget"
}
