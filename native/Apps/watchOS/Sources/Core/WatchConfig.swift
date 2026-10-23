import Foundation

/// Shared, non-secret identifiers from CONTRACT.md.
enum DroverIdentifiers {
    static let appGroup = "group.dev.drover"
    static let summaryFileName = "summary.json"
    static let urlScheme = "drover"
}

/// Non-secret watch settings (server URL). Stored in the App Group defaults so the
/// watch widget extension sees the same values. Tokens live in `TokenVault`, never here.
struct WatchConfig: Sendable {
    static let baseURLKey = "drover.baseURL"

    let defaults: UserDefaults

    init(defaults: UserDefaults = UserDefaults(suiteName: DroverIdentifiers.appGroup) ?? .standard) {
        self.defaults = defaults
    }

    var baseURL: URL? {
        get { defaults.string(forKey: Self.baseURLKey).flatMap(WatchConfig.normalize) }
        nonmutating set { defaults.set(newValue?.absoluteString, forKey: Self.baseURLKey) }
    }

    /// Accepts "http(s)://host[:port][/]" only; strips a trailing slash and any query,
    /// fragment or credentials so a token can never ride along in the URL.
    static func normalize(_ raw: String) -> URL? {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var c = URLComponents(string: s),
              let scheme = c.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = c.host, !host.isEmpty else { return nil }
        c.scheme = scheme
        c.user = nil
        c.password = nil
        c.query = nil
        c.fragment = nil
        while c.path.hasSuffix("/") { c.path.removeLast() }
        return c.url
    }
}

extension UserDefaults: @retroactive @unchecked Sendable {}
