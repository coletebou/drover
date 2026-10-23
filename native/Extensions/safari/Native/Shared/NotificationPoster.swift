import Foundation
import UserNotifications

protocol NotificationPosting: Sendable {
    func post(_ p: NotifyPayload) async throws(NativeError)
    func clear(id: String) async
}

/// The containing Drover app registers these categories (with its own Reply and Open actions) and answers them:
/// NotificationCoordinator on the Mac, NotificationManager on iOS. Keep the identifiers and userInfo keys in step.
enum DroverNotificationIDs {
    static let sessionCategory = "drover.session"
    static let genericCategory = "drover.info"
    static let sessionIdKey = "sessionId"
    static let hostKey = "host"
    static let kindKey = "kind"
    /// The server the alert came from. The Mac app refuses a Reply when it has since switched servers.
    static let serverKey = "server"
}

struct UserNotificationPoster: NotificationPosting {
    /// The base URL the extension used (absoluteString of the App Group `drover.baseURL`, as the Mac app's
    /// activeServerURL is), stamped on every alert.
    let server: String?

    init(server: String? = nil) { self.server = server }

    func post(_ p: NotifyPayload) async throws(NativeError) {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard Self.isAuthorized(settings.authorizationStatus) else { throw .notAuthorized }

        let content = UNMutableNotificationContent()
        content.title = p.title
        content.body = p.body
        content.sound = .default
        var info: [String: String] = [:]
        if let s = p.sessionId, !s.isEmpty { info[DroverNotificationIDs.sessionIdKey] = s }
        if let h = p.host { info[DroverNotificationIDs.hostKey] = h }
        if let k = p.kind { info[DroverNotificationIDs.kindKey] = k }
        if let server, !server.isEmpty { info[DroverNotificationIDs.serverKey] = server }
        content.userInfo = info
        if let s = p.sessionId, !s.isEmpty {
            content.categoryIdentifier = DroverNotificationIDs.sessionCategory
            content.threadIdentifier = s
        } else {
            content.categoryIdentifier = DroverNotificationIDs.genericCategory
        }
        let request = UNNotificationRequest(identifier: p.id, content: content, trigger: nil)
        do {
            try await center.add(request)
        } catch {
            throw .notAuthorized
        }
    }

    func clear(id: String) async {
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: [id])
        center.removePendingNotificationRequests(withIdentifiers: [id])
    }

    private static func isAuthorized(_ status: UNAuthorizationStatus) -> Bool {
        switch status {
        case .authorized, .provisional: return true
        #if os(iOS)
        case .ephemeral: return true
        #endif
        default: return false
        }
    }
}
