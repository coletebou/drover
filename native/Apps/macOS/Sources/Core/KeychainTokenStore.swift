import Foundation
import Security

/// Where the bearer token lives. Never log or print what `read()` returns.
protocol TokenStore: Sendable {
    func read() -> String?
    func write(_ token: String) throws
    func delete() throws
}

/// Keychain-backed store using the shared identifiers from CONTRACT.md (service `dev.drover.token`,
/// account `main`). Shim until DroverKit's KeychainTokenStore lands; same service/account so the swap keeps the item.
struct KeychainTokenStore: TokenStore {
    var service = "dev.drover.token"
    var account = "main"
    /// `$(AppIdentifierPrefix)dev.drover.shared` once signed with a team; nil uses the app's default group.
    var accessGroup: String? = Bundle.main.object(forInfoDictionaryKey: "DroverKeychainAccessGroup") as? String

    /// Same query shape as DroverKit's KeychainTokenStore and the widgets' reader: data protection keychain on
    /// macOS, never synchronizable. `legacy` is the fallback for the unentitled dev build (tools/build-app.sh),
    /// where the data protection keychain answers errSecMissingEntitlement.
    private func baseQuery(legacy: Bool = false) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
        guard !legacy else { return q }
        if let accessGroup, !accessGroup.isEmpty, !accessGroup.contains("$(") {
            q[kSecAttrAccessGroup as String] = accessGroup
        }
        q[kSecUseDataProtectionKeychain as String] = true
        return q
    }

    /// Run `op` against the data protection keychain, falling back to the legacy one when unentitled.
    /// Unentitled, writes answer errSecMissingEntitlement but reads answer errSecItemNotFound, so reads
    /// also fall back on not-found (`alsoOnNotFound`).
    private func withFallback(alsoOnNotFound: Bool = false, _ op: ([String: Any]) -> OSStatus) -> OSStatus {
        let s = op(baseQuery())
        let fallback = s == errSecMissingEntitlement || (alsoOnNotFound && s == errSecItemNotFound)
        return fallback ? op(baseQuery(legacy: true)) : s
    }

    func read() -> String? {
        var out: CFTypeRef?
        let status = withFallback(alsoOnNotFound: true) { q in
            var q = q
            q[kSecReturnData as String] = true
            q[kSecMatchLimit as String] = kSecMatchLimitOne
            return SecItemCopyMatching(q as CFDictionary, &out)
        }
        guard status == errSecSuccess, let data = out as? Data else { return nil }
        let s = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return s.isEmpty ? nil : s
    }

    func write(_ token: String) throws {
        let data = Data(token.trimmingCharacters(in: .whitespacesAndNewlines).utf8)
        let status = withFallback { q in
            let s = SecItemUpdate(q as CFDictionary, [kSecValueData as String: data] as CFDictionary)
            guard s == errSecItemNotFound else { return s }
            var add = q
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly  // same as DroverKit
            return SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    /// Deletes from both stores: reads fall back to the legacy keychain, so a leftover there would resurrect the token.
    func delete() throws {
        for legacy in [false, true] {
            let s = SecItemDelete(baseQuery(legacy: legacy) as CFDictionary)
            guard s == errSecSuccess || s == errSecItemNotFound || s == errSecMissingEntitlement else { throw KeychainError(status: s) }
        }
    }
}

struct KeychainError: LocalizedError {
    var status: OSStatus
    var errorDescription: String? {
        "Keychain error \(status)" + ((SecCopyErrorMessageString(status, nil) as String?).map { ": \($0)" } ?? "")
    }
}

/// In-memory store for previews and the test harness.
final class MemoryTokenStore: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var token: String?
    init(_ token: String? = nil) { self.token = token }
    func read() -> String? { lock.withLock { token } }
    func write(_ token: String) throws { lock.withLock { self.token = token } }
    func delete() throws { lock.withLock { token = nil } }
}
