import Foundation
import Security

/// Base URL and read-only widget token, as the widgets need them to call `native.summary`.
struct WidgetCredentials: Sendable, Equatable {
    var baseURL: URL
    var token: String

    /// Trims both values and validates the URL (http or https with a host); nil when unusable.
    static func resolve(baseURLString: String?, token: String?) -> WidgetCredentials? {
        let trimmedToken = (token ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        var base = (baseURLString ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedToken.isEmpty, !base.isEmpty else { return nil }
        while base.hasSuffix("/") { base.removeLast() }
        guard let url = URL(string: base), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https", let host = url.host, !host.isEmpty else { return nil }
        return WidgetCredentials(baseURL: url, token: trimmedToken)
    }

    /// Reads the base URL from the App Group defaults and the widget token from the Keychain.
    static func load() -> WidgetCredentials? {
        let base = UserDefaults(suiteName: SharedConfig.appGroup)?.string(forKey: SharedConfig.baseURLDefaultsKey)
        return resolve(baseURLString: base, token: readWidgetToken())
    }

    /// The widget-scope token from the shared Keychain item. Never reads the `main` account.
    static func readWidgetToken() -> String? {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: SharedConfig.keychainService,
            kSecAttrAccount as String: SharedConfig.widgetTokenAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        #if os(macOS)
        query[kSecUseDataProtectionKeychain as String] = true
        #endif
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
