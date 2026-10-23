import Foundation
import Security

/// Which Drover token. `widget` is read-only (only `native.summary` and
/// `native.notifications`); `main` can send messages. See CONTRACT.md.
enum TokenKind: String, Sendable, CaseIterable {
    case main, widget
}

/// Secret storage for the two tokens. Implementations must never log or print a token.
protocol TokenVault: Sendable {
    func token(_ kind: TokenKind) -> String?
    func setToken(_ token: String?, for kind: TokenKind) throws
}

extension TokenVault {
    func has(_ kind: TokenKind) -> Bool { !(token(kind) ?? "").isEmpty }
}

enum TokenVaultError: Error, Equatable {
    case keychain(OSStatus)
}

/// Keychain-backed vault on the watch. Service and accounts follow CONTRACT.md
/// (`dev.drover.token`, accounts `main` and `widget`). On watchOS the access group is the
/// watch app's own keychain (the iPhone keychain is not shared with the watch); pass the
/// shared access group so the watch widget extension can read the widget token too.
struct KeychainTokenVault: TokenVault {
    static let service = "dev.drover.token"

    var service: String = KeychainTokenVault.service
    /// e.g. "<TEAMID>.dev.drover.shared"; nil means the app's default group.
    var accessGroup: String?

    init(service: String = KeychainTokenVault.service, accessGroup: String? = KeychainTokenVault.defaultAccessGroup()) {
        self.service = service
        self.accessGroup = accessGroup
    }

    /// Reads `DroverKeychainAccessGroup` from Info.plist (set by project.part.yml to
    /// `$(AppIdentifierPrefix)dev.drover.shared`). Missing or unexpanded means nil.
    static func defaultAccessGroup(bundle: Bundle = .main) -> String? {
        guard let g = bundle.object(forInfoDictionaryKey: "DroverKeychainAccessGroup") as? String,
              !g.isEmpty, !g.contains("$(") else { return nil }
        return g
    }

    private func baseQuery(_ kind: TokenKind) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: kind.rawValue,
        ]
        if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
        return q
    }

    func token(_ kind: TokenKind) -> String? {
        var q = baseQuery(kind)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data, let s = String(data: data, encoding: .utf8), !s.isEmpty else { return nil }
        return s
    }

    func setToken(_ token: String?, for kind: TokenKind) throws {
        let q = baseQuery(kind)
        guard let token, !token.isEmpty else {
            let st = SecItemDelete(q as CFDictionary)
            guard st == errSecSuccess || st == errSecItemNotFound else { throw TokenVaultError.keychain(st) }
            return
        }
        let data = Data(token.utf8)
        // AfterFirstUnlock so background refresh can read the widget token while the watch is locked.
        let attrs: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var st = SecItemUpdate(q as CFDictionary, attrs as CFDictionary)
        if st == errSecItemNotFound {
            var add = q
            add.merge(attrs) { _, new in new }
            st = SecItemAdd(add as CFDictionary, nil)
        }
        guard st == errSecSuccess else { throw TokenVaultError.keychain(st) }
    }
}

/// In-memory vault for previews and tests.
final class MemoryTokenVault: TokenVault, @unchecked Sendable {
    private let lock = NSLock()
    private var store: [TokenKind: String]

    init(main: String? = nil, widget: String? = nil) {
        var s: [TokenKind: String] = [:]
        s[.main] = main
        s[.widget] = widget
        store = s
    }

    func token(_ kind: TokenKind) -> String? {
        lock.lock(); defer { lock.unlock() }
        return store[kind]
    }

    func setToken(_ token: String?, for kind: TokenKind) throws {
        lock.lock(); defer { lock.unlock() }
        store[kind] = (token?.isEmpty ?? true) ? nil : token
    }
}
