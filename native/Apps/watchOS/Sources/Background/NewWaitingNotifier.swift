import Foundation
import UserNotifications

/// Local notification used to get a haptic while the app is in the background.
enum NewWaitingNotifier {
    static func requestAuthorization() async {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
    }

    static func post(_ items: [WaitingItem]) async {
        let center = UNUserNotificationCenter.current()
        let status = await center.notificationSettings().authorizationStatus
        guard status == .authorized || status == .provisional else { return }
        guard let payload = NotificationContent.make(for: items) else { return }
        let content = UNMutableNotificationContent()
        content.title = payload.title
        content.body = payload.body
        content.sound = .default
        content.threadIdentifier = payload.threadIdentifier
        content.userInfo = [NotificationContent.linkKey: payload.link.absoluteString]
        let request = UNNotificationRequest(identifier: payload.identifier, content: content, trigger: nil)
        try? await center.add(request)
    }
}
