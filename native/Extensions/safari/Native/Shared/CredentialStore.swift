import Foundation
import Security

protocol CredentialReading: Sendable {
    func baseURL() -> URL?
    func token() -> String?
}

enum CredentialStoreError: Error, Equatable, Sendable {
    case invalidURL
    case keychain(Int32)
}

/// Reads and writes the shared base URL (App Group defaults) and token (Keychain generic password).
/// Never logs or prints values.
struct SharedCredentialStore: CredentialReading {
    let config: DroverSharedConfig

    init(config: DroverSharedConfig) {
        self.config = config
    }

    static func isAcceptableBaseURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return false }
        guard let host = url.host, !host.isEmpty else { return false }
        return true
    }

    func baseURL() -> URL? {
        guard let defaults = UserDefaults(suiteName: config.appGroup),
              let text = defaults.string(forKey: config.baseURLDefaultsKey) else { return nil }
        guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              Self.isAcceptableBaseURL(url) else { return nil }
        return url
    }

    func token() -> String? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data,
              let text = String(data: data, encoding: .utf8) else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// Host-app fallback form. The base URL is validated; a nil or empty token leaves the stored token untouched.
    func save(baseURL: URL, token: String?) throws {
        guard Self.isAcceptableBaseURL(baseURL) else { throw CredentialStoreError.invalidURL }
        guard let defaults = UserDefaults(suiteName: config.appGroup) else { throw CredentialStoreError.invalidURL }
        if let token = token?.trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty {
            try saveToken(token)
        }
        defaults.set(baseURL.absoluteString, forKey: config.baseURLDefaultsKey)
    }

    private func saveToken(_ token: String) throws {
        let data = Data(token.utf8)
        let update: [String: Any] = [kSecValueData as String: data]
        var status = SecItemUpdate(baseQuery() as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var add = baseQuery()
            add[kSecValueData as String] = data
            // Same attributes as DroverKit KeychainTokenStore: this device only, never iCloud-synced.
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw CredentialStoreError.keychain(status) }
    }

    private func baseQuery() -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: config.keychainService,
            kSecAttrAccount as String: config.keychainAccount,
            kSecAttrSynchronizable as String: false,
        ]
        if let group = config.keychainAccessGroup {
            query[kSecAttrAccessGroup as String] = group
        }
        #if os(macOS)
        query[kSecUseDataProtectionKeychain as String] = true
        #endif
        return query
    }
}
