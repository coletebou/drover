import Foundation
import UserNotifications

@MainActor
final class NotificationManager: NSObject {
    static let shared = NotificationManager()

    private weak var model: AppModel?
    private var registered = false
    private var pendingRef: SessionRef?
    private var pendingBoard = false

    /// Installs the delegate and categories. Called from the app delegate during launch, so a tap or a
    /// Reply that cold-launches the app is delivered; `activate(model:)` later attaches the model.
    func registerEarly() {
        guard !registered else { return }
        registered = true
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let reply = UNTextInputNotificationAction(
            identifier: Self.replyAction, title: "Reply", options: [.authenticationRequired],
            textInputButtonTitle: "Send", textInputPlaceholder: "Message")
        let open = UNNotificationAction(identifier: Self.openAction, title: "Open", options: [.foreground])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: NotificationPlan.sessionCategory, actions: [reply, open],
                                   intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: NotificationPlan.infoCategory, actions: [open],
                                   intentIdentifiers: [], options: []),
        ])
    }

    func activate(model: AppModel) {
        registerEarly()
        self.model = model
        model.onAlertEvent = { Task { await NotificationManager.shared.pollNow() } }
        if let ref = pendingRef {
            pendingRef = nil
            pendingBoard = false
            model.open(ref)
        } else if pendingBoard {
            pendingBoard = false
            model.selectedTab = .board
        }
    }

    func requestAuthorization() async -> Bool {
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    /// Foreground poll; also called when the app becomes active.
    func pollNow() async {
        guard let api = AppModel.makeAPI() else { return }
        if let waiting = model?.summary?.totals.waiting {
            try? await UNUserNotificationCenter.current().setBadgeCount(waiting)
        }
        await NotificationPipeline.run(api: api)
    }

    fileprivate static let replyAction = "drover.reply"
    fileprivate static let openAction = "drover.open"

    private func applyOpen(_ ref: SessionRef) {
        if let model { model.open(ref) } else { pendingRef = ref; pendingBoard = false }
    }

    /// An alert without a session, such as the Safari extension's summary and overflow alerts, opens the board.
    private func applyOpenBoard() {
        if let model { model.selectedTab = .board } else { pendingBoard = true }
    }

    nonisolated private static func postStatus(_ text: String) async {
        let content = UNMutableNotificationContent()
        content.title = text
        content.interruptionLevel = .passive
        try? await UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: "drover.reply.status", content: content, trigger: nil))
    }

    nonisolated private static func sendReply(_ ref: SessionRef, text: String) async {
        guard let api = AppModel.makeAPI() else { return await postStatus("Reply failed: not configured") }
        do {
            let result = try await api.message(ref, text: text)
            if result.ok == false {
                await postStatus("Reply failed: \(result.error ?? "not delivered")")
            } else {
                await postStatus("Reply sent")
            }
        } catch {
            await postStatus("Reply failed: \(error.localizedDescription)")
        }
    }
}

extension NotificationManager: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse) async {
        let action = response.actionIdentifier
        let info = response.notification.request.content.userInfo
        let sessionId = info["sessionId"] as? String
        let host = info["host"] as? String
        let text = (response as? UNTextInputNotificationResponse)?.userText
        let ref = sessionId.map { SessionRef(id: $0, host: host) }

        switch action {
        case Self.replyAction:
            guard let ref, let text, !text.isEmpty else { return }
            await Self.sendReply(ref, text: text)
        case UNNotificationDismissActionIdentifier:
            return
        default:
            await MainActor.run {
                if let ref { NotificationManager.shared.applyOpen(ref) } else { NotificationManager.shared.applyOpenBoard() }
            }
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let kind = notification.request.content.userInfo["kind"] as? String
        if kind == "decision" || kind == "question" { return [.banner, .list, .sound] }
        return [.list]
    }
}
