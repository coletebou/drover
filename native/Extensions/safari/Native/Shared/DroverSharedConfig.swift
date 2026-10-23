import Foundation

/// Identifiers shared by the extension, the host apps and the main Drover apps.
/// Values come from Info.plist (see CONTRACT.md "Apple identifiers"), with the contract defaults.
struct DroverSharedConfig: Sendable, Equatable {
    var appGroup: String
    var keychainAccessGroup: String?
    var keychainService: String
    var keychainAccount: String
    var baseURLDefaultsKey: String

    static let defaultAppGroup = "group.dev.drover"
    static let defaultService = "dev.drover.token"
    static let defaultAccount = "main"
    static let defaultBaseURLKey = "drover.baseURL"

    init(appGroup: String = DroverSharedConfig.defaultAppGroup,
         keychainAccessGroup: String? = nil,
         keychainService: String = DroverSharedConfig.defaultService,
         keychainAccount: String = DroverSharedConfig.defaultAccount,
         baseURLDefaultsKey: String = DroverSharedConfig.defaultBaseURLKey) {
        self.appGroup = appGroup
        self.keychainAccessGroup = keychainAccessGroup
        self.keychainService = keychainService
        self.keychainAccount = keychainAccount
        self.baseURLDefaultsKey = baseURLDefaultsKey
    }

    static func fromBundle(_ bundle: Bundle = .main) -> DroverSharedConfig {
        func value(_ key: String) -> String? {
            guard let s = bundle.object(forInfoDictionaryKey: key) as? String else { return nil }
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            // An unexpanded build variable means the key is effectively unset.
            return t.isEmpty || t.hasPrefix("$(") ? nil : t
        }
        return DroverSharedConfig(
            appGroup: value("DroverAppGroup") ?? defaultAppGroup,
            keychainAccessGroup: value("DroverKeychainAccessGroup"),
            keychainService: value("DroverKeychainService") ?? defaultService,
            keychainAccount: value("DroverKeychainAccount") ?? defaultAccount,
            baseURLDefaultsKey: value("DroverBaseURLDefaultsKey") ?? defaultBaseURLKey)
    }
}
