import Foundation
import UserNotifications

/// Opens the tapped notification's deep link in the app.
@MainActor
final class NotificationRouter: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationRouter()
    private weak var model: AppModel?

    func install(model: AppModel) {
        self.model = model
        UNUserNotificationCenter.current().delegate = self
    }

    private func open(_ link: String?) {
        guard let link, let url = URL(string: link) else { return }
        model?.open(url)
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse) async {
        let link = response.notification.request.content.userInfo[NotificationContent.linkKey] as? String
        await open(link)
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        []
    }
}
