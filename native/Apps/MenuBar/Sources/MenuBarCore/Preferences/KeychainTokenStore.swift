import Foundation
import Security

enum KeychainError: Error, Equatable {
    case status(OSStatus)
    case emptyToken
}

/// Tokens as generic password items in the data protection keychain. Never logs token values.
final class KeychainTokenStore: TokenStoring {
    private let service: String
    private let accessGroup: String?

    init(service: String = AppIdentifiers.keychainService,
         accessGroup: String? = KeychainTokenStore.defaultAccessGroup) {
        self.service = service
        self.accessGroup = accessGroup
    }

    /// Nil when missing, empty or unexpanded (unsigned builds).
    static var defaultAccessGroup: String? {
        guard let s = Bundle.main.object(forInfoDictionaryKey: AppIdentifiers.keychainAccessGroupInfoKey) as? String,
              !s.isEmpty, !s.contains("$(") else { return nil }
        return s
    }

    static func looksLikeToken(_ s: String) -> Bool {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (16...512).contains(t.count) else { return false }
        return t.rangeOfCharacter(from: .whitespacesAndNewlines) == nil
    }

    func token(_ kind: TokenKind) -> String? {
        var query = baseQuery(kind, group: accessGroup)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var status = copy(query)
        if status.0 == errSecMissingEntitlement, accessGroup != nil {
            var q = baseQuery(kind, group: nil)
            q[kSecReturnData as String] = true
            q[kSecMatchLimit as String] = kSecMatchLimitOne
            status = copy(q)
        }
        guard status.0 == errSecSuccess, let data = status.1 else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func setToken(_ value: String?, for kind: TokenKind) throws {
        guard let value else {
            try withFallback { group in
                let s = SecItemDelete(self.baseQuery(kind, group: group) as CFDictionary)
                return s == errSecItemNotFound ? errSecSuccess : s
            }
            return
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw KeychainError.emptyToken }
        let data = Data(trimmed.utf8)
        try withFallback { group in
            let update = SecItemUpdate(self.baseQuery(kind, group: group) as CFDictionary,
                                       [kSecValueData as String: data] as CFDictionary)
            guard update == errSecItemNotFound else { return update }
            var add = self.baseQuery(kind, group: group)
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            return SecItemAdd(add as CFDictionary, nil)
        }
    }

    // MARK: - Private

    private func baseQuery(_ kind: TokenKind, group: String?) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: kind.rawValue,
            kSecUseDataProtectionKeychain as String: true,
        ]
        if let group { q[kSecAttrAccessGroup as String] = group }
        return q
    }

    private func copy(_ query: [String: Any]) -> (OSStatus, Data?) {
        var out: CFTypeRef?
        let s = SecItemCopyMatching(query as CFDictionary, &out)
        return (s, out as? Data)
    }

    private func withFallback(_ op: (String?) -> OSStatus) throws {
        var status = op(accessGroup)
        if status == errSecMissingEntitlement, accessGroup != nil {
            status = op(nil)
        }
        if status != errSecSuccess { throw KeychainError.status(status) }
    }
}
