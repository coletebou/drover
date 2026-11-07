import Foundation
import UserNotifications

@MainActor
final class NotificationController: NSObject, UNUserNotificationCenterDelegate {
    private let store: MenuBarStore
    private let preferences: @MainActor () -> MenuBarPreferences
    private let open: @MainActor (_ sessionId: String, _ host: String?) -> Void
    private let openBoard: @MainActor () -> Void
    /// Dev builds without an explicit opt-in post nothing (and never ask for permission).
    private let enabled: Bool

    private var posted = Set<String>()
    private var postedOrder: [String] = []
    private static let postedCap = 500

    /// Categories for dialog alerts, one per distinct set of buttons, newest last.
    private var dialogCategories: [String: UNNotificationCategory] = [:]
    private var dialogOrder: [String] = []
    private static let dialogCap = 24

    private static let replyAction = UNTextInputNotificationAction(
        identifier: "drover.reply", title: "Reply", options: [],
        textInputButtonTitle: "Send", textInputPlaceholder: "Message")
    // No .foreground: the Drover app activates itself for the deep link, so the menu bar app is not brought
    // forward too (one activation per click).
    private static let openAction = UNNotificationAction(identifier: "drover.open", title: "Open", options: [])

    init(
        store: MenuBarStore,
        preferences: @escaping @MainActor () -> MenuBarPreferences,
        open: @escaping @MainActor (_ sessionId: String, _ host: String?) -> Void,
        openBoard: @escaping @MainActor () -> Void,
        enabled: Bool = true
    ) {
        self.store = store
        self.preferences = preferences
        self.open = open
        self.openBoard = openBoard
        self.enabled = enabled
        super.init()
    }

    func activate() {
        guard enabled else { return }
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        registerCategories()
        Task { _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge]) }
        store.onNotifications = { [weak self] items in self?.post(items) }
    }

    private func registerCategories() {
        let fixed: [UNNotificationCategory] = [
            UNNotificationCategory(
                identifier: PlannedNotification.waitingCategory, actions: [Self.replyAction, Self.openAction],
                intentIdentifiers: [], options: []),
            UNNotificationCategory(
                identifier: PlannedNotification.infoCategory, actions: [Self.openAction], intentIdentifiers: [], options: []),
        ]
        UNUserNotificationCenter.current().setNotificationCategories(Set(fixed + dialogCategories.values))
    }

    /// A dialog alert's buttons: its keys, then Reply (when there is a session) and Open. An approval request's: one
    /// per option (answering needs the Mac unlocked; a clearly negative option is destructive), then Open, never Reply.
    private func ensureCategory(for note: PlannedNotification) {
        guard !note.actions.isEmpty || !note.approvalActions.isEmpty else { return }
        let id = note.categoryID
        if dialogCategories[id] != nil {
            dialogOrder.removeAll { $0 == id }
            dialogOrder.append(id)
            return
        }
        var actions: [UNNotificationAction] = note.actions.map {
            UNNotificationAction(identifier: $0.identifier, title: $0.title, options: [])
        }
        actions += note.approvalActions.map {
            UNNotificationAction(identifier: $0.identifier, title: $0.title,
                                 options: $0.destructive ? [.authenticationRequired, .destructive] : [.authenticationRequired])
        }
        if note.canReply { actions.append(Self.replyAction) }
        actions.append(Self.openAction)
        dialogCategories[id] = UNNotificationCategory(identifier: id, actions: actions, intentIdentifiers: [], options: [])
        dialogOrder.append(id)
        while dialogOrder.count > Self.dialogCap { dialogCategories[dialogOrder.removeFirst()] = nil }
        registerCategories()
    }

    func post(_ items: [NotificationItem]) {
        let planned = NotificationPlanner.plan(
            items, preferences: preferences(), mutedUntil: store.mutedUntil, now: Date(),
            alreadyPosted: posted)
        guard !planned.isEmpty else { return }
        // Includes items folded into a summary, so they are not posted again later.
        for item in items { remember(item.id) }
        let center = UNUserNotificationCenter.current()
        for note in planned {
            ensureCategory(for: note)
            let content = UNMutableNotificationContent()
            content.title = note.title
            if let subtitle = note.subtitle { content.subtitle = subtitle }
            content.body = note.body
            content.threadIdentifier = note.threadID
            content.categoryIdentifier = note.categoryID
            // The session, what a key button answers (the session or window, and the screen the alert was
            // raised for), and which daemon raised it (a URL without credentials), so actions on an alert from
            // a server the app no longer talks to are refused instead of going to the new one.
            content.userInfo = userInfo(for: note)
            if note.playSound { content.sound = .default }
            content.interruptionLevel = note.canReply || !note.actions.isEmpty || !note.approvalActions.isEmpty ? .timeSensitive : .active
            center.add(UNNotificationRequest(identifier: note.identifier, content: content, trigger: nil))
        }
    }

    private func remember(_ id: String) {
        guard posted.insert(id).inserted else { return }
        postedOrder.append(id)
        if postedOrder.count > Self.postedCap {
            posted.remove(postedOrder.removeFirst())
        }
    }

    private func postFailure(_ title: String, _ message: String, sessionId: String? = nil, host: String? = nil) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = message
        if let sessionId {
            content.categoryIdentifier = PlannedNotification.infoCategory
            var info = ["sessionId": sessionId]
            if let host { info["host"] = host }
            if let server = preferences().baseURL?.absoluteString { info["server"] = server }
            content.userInfo = info
        }
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: "drover.failed.\(UUID().uuidString)", content: content, trigger: nil))
    }

    private struct Response: Sendable {
        var action: String
        var sessionId: String?
        var host: String?
        var server: String?
        var answerID: String?
        var expect: String?
        var approvalID: String? = nil
        var approvalBot: String? = nil
        var text: String?
    }

    /// What a click on a posted alert does, without the notification center (the dev harness drives it).
    @discardableResult
    func respond(action: String, info: [String: String], text: String? = nil) async -> AnswerOutcome? {
        await handle(Response(action: action, sessionId: info["sessionId"], host: info["host"], server: info["server"],
                              answerID: info["answerId"], expect: info["expect"], approvalID: info["approvalId"],
                              approvalBot: info["approvalBot"], text: text))
    }

    /// The userInfo a planned alert is posted with.
    func userInfo(for note: PlannedNotification) -> [String: String] {
        var info: [String: String] = [:]
        if let sessionId = note.sessionId { info["sessionId"] = sessionId }
        if let host = note.host { info["host"] = host }
        if let answerID = note.answerID { info["answerId"] = answerID }
        if let expect = note.expect { info["expect"] = expect }
        if let approvalID = note.approvalID { info["approvalId"] = approvalID }
        if let bot = note.approvalBot { info["approvalBot"] = bot }
        if let server = preferences().baseURL?.absoluteString { info["server"] = server }
        return info
    }

    /// Returns the outcome of a key press (nil for other actions).
    @discardableResult
    private func handle(_ r: Response) async -> AnswerOutcome? {
        let key = PlannedAction.key(fromIdentifier: r.action)
        let choice = PlannedApprovalAction.choice(fromIdentifier: r.action)
        guard r.server == preferences().baseURL?.absoluteString else {
            if r.action == "drover.reply" || key != nil || choice != nil {
                postFailure("Not sent", "This alert came from a server this app no longer uses.")
            }
            return key == nil ? nil : .refused(reason: "this alert came from a server this app no longer uses")
        }
        if let choice {
            // A Grok bot's approval request, answered by its id; a refusal or an undelivered answer says so.
            guard let approvalID = r.approvalID, !approvalID.isEmpty else { return nil }
            let result: Result<ApprovalAnswerResult, Error>
            do { result = .success(try await store.answerApproval(id: approvalID, choice: choice)) }
            catch { result = .failure(error) }
            let o = ApprovalFormat.outcome(result, botName: r.approvalBot)
            if o.isError {
                let decided = if case .success(.decided) = result { true } else { false }
                postFailure(decided ? "Answered, not delivered" : "Not answered", o.text, sessionId: r.sessionId, host: r.host)
            }
            return nil
        }
        if let key {
            // Only with the hash of the screen the alert showed: a changed dialog refuses the press.
            guard let answerID = r.answerID, let expect = r.expect, !expect.isEmpty else { return nil }
            do {
                let outcome = try await store.answer(id: answerID, host: r.host ?? "local", key: key, expect: expect)
                if !outcome.isSent { postFailure("Not answered", outcome.message, sessionId: r.sessionId, host: r.host) }
                return outcome
            } catch {
                let message = (error as? DroverError)?.userMessage ?? "Could not send."
                postFailure("Not answered", message, sessionId: r.sessionId, host: r.host)
                return .refused(reason: message)
            }
        }
        switch r.action {
        case "drover.reply":
            guard let sessionId = r.sessionId, let text = r.text, !text.isEmpty else { return nil }
            let item = WaitingItem(
                id: sessionId, name: sessionId, host: r.host ?? "local", engine: "", since: nil,
                kind: .unknown, headline: "")
            do {
                try await store.reply(to: item, text: text)
            } catch {
                postFailure("Reply not sent", (error as? DroverError)?.userMessage ?? "Could not send.")
            }
        default:
            // "drover.open" and the default (tap) action.
            if let sessionId = r.sessionId { open(sessionId, r.host) } else if r.answerID != nil { openBoard() }
        }
        return nil
    }

    // MARK: UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
    ) async {
        // UNNotificationResponse is not Sendable: copy the plain values out before hopping.
        let info = response.notification.request.content.userInfo
        let r = Response(
            action: response.actionIdentifier == UNNotificationDefaultActionIdentifier ? "drover.open" : response.actionIdentifier,
            sessionId: info["sessionId"] as? String,
            host: info["host"] as? String,
            server: info["server"] as? String,
            answerID: info["answerId"] as? String,
            expect: info["expect"] as? String,
            approvalID: info["approvalId"] as? String,
            approvalBot: info["approvalBot"] as? String,
            text: (response as? UNTextInputNotificationResponse)?.userText)
        await handle(r)
    }
}
