import Foundation

/// The WatchConnectivity `transferUserInfo` payload the iOS app sends
/// (Apps/iOS/Sources/Background/WatchTokenSync.swift, window 03-ios-app):
/// `{"drover.baseURL": String, "drover.token": String, "drover.widgetToken": String?}`.
/// A key that is present with an empty string clears that value on the watch; a key
/// that is absent leaves the stored value unchanged.
///
/// `description`, `debugDescription` and the mirror redact tokens, so printing or
/// dumping a payload can never leak one.
struct WatchSyncPayload: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    static let baseURLKey = "drover.baseURL"
    static let tokenKey = "drover.token"
    static let widgetTokenKey = "drover.widgetToken"

    /// nil: not in the payload. "": clear.
    var baseURL: String?
    var token: String?
    var widgetToken: String?

    init(baseURL: String? = nil, token: String? = nil, widgetToken: String? = nil) {
        self.baseURL = baseURL
        self.token = token
        self.widgetToken = widgetToken
    }

    /// nil when the dictionary carries none of the known keys (not a Drover payload).
    init?(userInfo: [String: Any]) {
        let b = userInfo[Self.baseURLKey] as? String
        let t = userInfo[Self.tokenKey] as? String
        let w = userInfo[Self.widgetTokenKey] as? String
        guard b != nil || t != nil || w != nil else { return nil }
        self.init(baseURL: b, token: t, widgetToken: w)
    }

    var userInfo: [String: Any] {
        var d: [String: Any] = [:]
        if let baseURL { d[Self.baseURLKey] = baseURL }
        if let token { d[Self.tokenKey] = token }
        if let widgetToken { d[Self.widgetTokenKey] = widgetToken }
        return d
    }

    var description: String {
        func r(_ s: String?) -> String { s == nil ? "absent" : (s!.isEmpty ? "clear" : "[redacted]") }
        return "WatchSyncPayload(baseURL: \(baseURL ?? "absent"), token: \(r(token)), widgetToken: \(r(widgetToken)))"
    }

    var debugDescription: String { description }

    var customMirror: Mirror { Mirror(self, children: ["summary": description]) }
}
