import Foundation
import Security

/// Tokens in the Keychain, in the shared access group so widgets (account `widget` only) and the
/// Safari extension can read them. Values are never logged; errors carry the OSStatus only.
struct TokenVault: Sendable {
    enum Account: String, Sendable { case main, widget }

    /// What a save does with one stored token.
    enum Change: Equatable, Sendable {
        case keep
        case store(String)
        /// Removes the Keychain item, so widgets and the watch never get an empty token to send.
        case delete
    }

    var service = DroverIDs.keychainService
    /// nil = the app's default group (previews and unsigned builds).
    var accessGroup: String? = DroverIDs.keychainAccessGroup
    /// False for `--mock` launches: reads find nothing and writes do nothing, so the Keychain is never touched.
    var usesKeychain = true

    struct KeychainError: LocalizedError, Sendable {
        let status: OSStatus
        var errorDescription: String? { "Keychain error \(status)" }
    }

    private func baseQuery(_ account: Account) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account.rawValue,
        ]
        if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
        return q
    }

    func read(_ account: Account) -> String? {
        guard usesKeychain else { return nil }
        var q = baseQuery(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Saves (or deletes when `value` is nil or empty). Readable after first unlock so
    /// background refresh can use it while the phone is locked.
    func write(_ value: String?, for account: Account) throws {
        guard usesKeychain else { return }
        let q = baseQuery(account)
        guard let value, !value.isEmpty else { return try delete(account) }
        let data = Data(value.utf8)
        let attrs: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var s = SecItemUpdate(q as CFDictionary, attrs as CFDictionary)
        if s == errSecItemNotFound {
            var add = q
            add.merge(attrs) { _, new in new }
            s = SecItemAdd(add as CFDictionary, nil)
        }
        guard s == errSecSuccess else { throw KeychainError(status: s) }
    }

    func has(_ account: Account) -> Bool { read(account)?.isEmpty == false }

    /// Removes the item; one that is not there is fine.
    func delete(_ account: Account) throws {
        guard usesKeychain else { return }
        let s = SecItemDelete(baseQuery(account) as CFDictionary)
        guard s == errSecSuccess || s == errSecItemNotFound else { throw KeychainError(status: s) }
    }

    func apply(_ change: Change, for account: Account) throws {
        switch change {
        case .keep: break
        case .store(let value): try write(value, for: account)
        case .delete: try delete(account)
        }
    }
}

/// Non-secret settings in the App Group UserDefaults (shared with widgets).
struct SharedSettings: Sendable {
    /// The App Group's suite; logic tests pass a throwaway one.
    var suiteName = DroverIDs.appGroup
    private var defaults: UserDefaults { UserDefaults(suiteName: suiteName) ?? .standard }

    var baseURL: URL? {
        get { defaults.string(forKey: DroverIDs.baseURLDefaultsKey).flatMap(Self.normalizedURL) }
        nonmutating set { defaults.set(newValue?.absoluteString, forKey: DroverIDs.baseURLDefaultsKey) }
    }

    /// Sequence counter around configuration writes (odd while a write is in progress); see AppModel.makeAPI.
    var configRevision: Int {
        get { defaults.integer(forKey: "drover.configRevision") }
        nonmutating set { defaults.set(newValue, forKey: "drover.configRevision") }
    }

    /// Host that runs the OpenClaw manager; nil = find it from sessions.list.
    var managerHost: String? {
        get { defaults.string(forKey: "drover.managerHost").flatMap { $0.isEmpty ? nil : $0 } }
        nonmutating set { defaults.set(newValue, forKey: "drover.managerHost") }
    }

    /// Last `native.notifications` cursor delivered as local notifications.
    var notificationCursor: String? {
        get { defaults.string(forKey: "drover.notificationCursor") }
        nonmutating set { defaults.set(newValue, forKey: "drover.notificationCursor") }
    }

    /// Which notification kinds the user wants as local notifications (empty = all).
    var mutedNotificationKinds: Set<String> {
        get { Set(defaults.stringArray(forKey: "drover.mutedKinds") ?? []) }
        nonmutating set { defaults.set(Array(newValue).sorted(), forKey: "drover.mutedKinds") }
    }

    var hapticsEnabled: Bool {
        get { defaults.object(forKey: "drover.haptics") as? Bool ?? true }
        nonmutating set { defaults.set(newValue, forKey: "drover.haptics") }
    }

    /// Accepts `host:port`, `http://host:port/`, trims whitespace; only http and https.
    static func normalizedURL(_ raw: String) -> URL? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if !s.contains("://") { s = "http://" + s }
        while s.hasSuffix("/") { s.removeLast() }
        guard let url = URL(string: s), let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
              url.host?.isEmpty == false else { return nil }
        return url
    }
}
