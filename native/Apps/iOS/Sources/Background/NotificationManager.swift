import Foundation
import UserNotifications

@MainActor
final class NotificationManager: NSObject {
    static let shared = NotificationManager()

    private weak var model: AppModel?
    private var registered = false
    private var pendingRef: SessionRef?
    private var pendingBoard = false
    /// An approval request whose notification was tapped before the model was attached: reviewed once it is.
    private var pendingReview: String?

    /// Installs the delegate and categories. Called from the app delegate during launch, so a tap or a
    /// Reply that cold-launches the app is delivered; `activate(model:)` later attaches the model.
    func registerEarly() {
        guard !registered else { return }
        registered = true
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories(Set(Self.fixedCategories + Self.storedApprovalSpecs().map(Self.category)))
    }

    private static var fixedCategories: [UNNotificationCategory] {
        let reply = UNTextInputNotificationAction(
            identifier: replyAction, title: "Reply", options: [.authenticationRequired],
            textInputButtonTitle: "Send", textInputPlaceholder: "Message")
        let open = UNNotificationAction(identifier: openAction, title: "Open", options: [.foreground])
        return [
            UNNotificationCategory(identifier: NotificationPlan.sessionCategory, actions: [reply, open],
                                   intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: NotificationPlan.infoCategory, actions: [open],
                                   intentIdentifiers: [], options: []),
        ]
    }

    func activate(model: AppModel) {
        registerEarly()
        self.model = model
        model.onAlertEvent = { Task { await NotificationManager.shared.pollNow() } }
        if let review = pendingReview {
            pendingReview = nil
            model.reviewApprovalID = review
        }
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

    /// A tapped approval alert: the bot's detail opens reviewing the whole request (ApprovalCard.reviewsOnOpen).
    private func applyReview(_ id: String) {
        if let model { model.reviewApprovalID = id } else { pendingReview = id }
    }

    // MARK: approval categories

    private static let approvalSpecsKey = "drover.approvalCategories"

    /// The approval categories registered before, newest last (kept across launches: a request still in Notification
    /// Center keeps its buttons after the app was relaunched).
    private static func storedApprovalSpecs() -> [ApprovalCategorySpec] {
        guard let data = UserDefaults.standard.data(forKey: approvalSpecsKey) else { return [] }
        return (try? JSONDecoder().decode([ApprovalCategorySpec].self, from: data)) ?? []
    }

    /// One button per option. Answering needs the device unlocked; a clearly negative option is destructive.
    private static func category(_ spec: ApprovalCategorySpec) -> UNNotificationCategory {
        let actions = spec.actions.map { a in
            UNNotificationAction(identifier: a.identifier, title: a.title,
                                 options: a.destructive ? [.authenticationRequired, .destructive] : [.authenticationRequired])
        }
        return UNNotificationCategory(identifier: spec.identifier, actions: actions, intentIdentifiers: [], options: [])
    }

    /// Registers the category of an approval request's buttons, with the fixed ones and the newest others, and waits
    /// until the notification center has it (a banner posted before would show no buttons).
    func registerApprovalCategory(_ n: PlannedNotification) async {
        guard !n.actions.isEmpty else { return }
        let spec = ApprovalCategorySpec(identifier: n.categoryID, actions: n.actions)
        let old = Self.storedApprovalSpecs()
        let specs = ApprovalCategorySpec.adding(spec, to: old)
        if let data = try? JSONEncoder().encode(specs) { UserDefaults.standard.set(data, forKey: Self.approvalSpecsKey) }
        let center = UNUserNotificationCenter.current()
        guard old.last != spec else { return }
        center.setNotificationCategories(Set(Self.fixedCategories + specs.map(Self.category)))
        // setNotificationCategories applies asynchronously; reading them back waits for it.
        _ = await center.notificationCategories()
    }

    // MARK: answering from a notification

    nonisolated private static func postStatus(_ text: String, id: String = "drover.reply.status", passive: Bool = true) async {
        let content = UNMutableNotificationContent()
        content.title = text
        content.interruptionLevel = passive ? .passive : .active
        try? await UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: id, content: content, trigger: nil))
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

    /// An approval button: answers the request by id (`via` ios-notification), only on the daemon that raised the alert,
    /// then says what came of it (a refusal as an alert of its own) and refreshes the board.
    nonisolated private static func answerApproval(id: String, choice: Int, bot: String?, server: String?) async {
        let status = "drover.approval.status"
        guard let api = AppModel.makeAPI() else {
            return await postStatus("Not answered: Drover is not set up on this iPhone.", id: status, passive: false)
        }
        if let server, server != SharedSettings().baseURL?.absoluteString {
            return await postStatus("Not answered: this alert came from a server this app no longer uses.", id: status, passive: false)
        }
        let result: Result<ApprovalAnswerResult, Error>
        do { result = .success(try await api.answerApproval(id: id, choice: choice, via: DroverIDs.notificationVia)) }
        catch { result = .failure(error) }
        let o = ApprovalFormat.outcome(result, botName: bot)
        await postStatus(o.text, id: status, passive: !o.isError)
        await MainActor.run { NotificationManager.shared.refreshAfterAnswer() }
    }

    private func refreshAfterAnswer() {
        guard let model else { return }
        Task { await model.refreshSummary() }
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

        if let choice = NotificationPlan.approvalChoice(fromAction: action) {
            guard let approvalId = info["approvalId"] as? String, !approvalId.isEmpty else { return }
            await Self.answerApproval(id: approvalId, choice: choice, bot: info["approvalBot"] as? String,
                                      server: info["server"] as? String)
            return
        }
        switch action {
        case Self.replyAction:
            guard let ref, let text, !text.isEmpty else { return }
            await Self.sendReply(ref, text: text)
        case UNNotificationDismissActionIdentifier:
            return
        default:
            let review = (info["approvalId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            await MainActor.run {
                if let review { NotificationManager.shared.applyReview(review) }
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
