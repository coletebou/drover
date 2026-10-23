#if canImport(Security)
import Foundation
import Security

/// A failed Security call. Carries the status code only, never a token.
public struct KeychainError: Error, Sendable, CustomStringConvertible, LocalizedError {
    public let status: OSStatus
    public init(status: OSStatus) { self.status = status }
    public var description: String { "Keychain error \(status)" }
    public var errorDescription: String? { description }
}

/// Generic-password items, one per scope. Readable after the first unlock (background refresh, widgets),
/// never synced, never leaves the device.
public struct KeychainTokenStore: TokenStore {
    public let service: String
    public let accessGroup: String?

    /// accessGroup: full group incl. team prefix, e.g. "ABCDE12345.dev.drover.shared"; nil = app default group.
    public init(service: String = DroverIdentifiers.keychainService, accessGroup: String? = nil) {
        self.service = service
        self.accessGroup = accessGroup
    }

    private func baseQuery(_ scope: TokenScope) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: scope.rawValue,
            kSecAttrSynchronizable as String: false,
        ]
        if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
        #if os(macOS)
        q[kSecUseDataProtectionKeychain as String] = true
        #endif
        return q
    }

    public func token(for scope: TokenScope) async throws -> String? {
        var q = baseQuery(scope)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        guard let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func setToken(_ token: String?, for scope: TokenScope) async throws {
        let query = baseQuery(scope)
        guard let token else {
            let status = SecItemDelete(query as CFDictionary)
            if status != errSecSuccess && status != errSecItemNotFound { throw KeychainError(status: status) }
            return
        }
        let data = Data(token.utf8)
        let update: [String: Any] = [kSecValueData as String: data]
        var status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var add = query
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }
}
#endif
