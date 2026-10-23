import Foundation

/// Identifiers every Apple target shares (CONTRACT.md "Apple identifiers" and "Widget data handoff").
public enum DroverIdentifiers {
    public static let bundlePrefix = "dev.drover"
    public static let appGroup = "group.dev.drover"
    /// Without the `$(AppIdentifierPrefix)` team prefix; `KeychainTokenStore` takes the full group.
    public static let keychainGroupSuffix = "dev.drover.shared"
    public static let keychainService = "dev.drover.token"
    /// File in the App Group container holding the bare `native.summary` result.
    public static let summaryCacheFile = "summary.json"
    /// `UserDefaults(suiteName: appGroup)` key for the daemon base URL (string).
    public static let baseURLDefaultsKey = "drover.baseURL"
    public static let urlScheme = "drover"
}
