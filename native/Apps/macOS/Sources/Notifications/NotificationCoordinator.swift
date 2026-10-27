import AppKit
import Foundation
import UserNotifications

/// Posts UserNotifications for server alerts, with Reply and Open actions, and on dialog alerts one action per key the
/// dialog takes (its options, or Approve and Deny), pressed through `sessions.answer` with the alert's screen hash.
/// A tap opens the session in the one main window (WindowRouter), never through a `drover://` URL.
@MainActor
final class NotificationCoordinator: NSObject, UNUserNotificationCenterDelegate {
    weak var model: AppModel?

    private var prepared = false
    private var started = false
    private var feedTask: Task<Void, Never>?
    private(set) var usesSSEFallback = false
    private var seen = Set<String>()
    private var seenOrder: [String] = []
    /// Per-dialog categories (`drover.dialog.<signature>`), the most recent ones, registered with the fixed two.
    private var dialogCategories: [String: UNNotificationCategory] = [:]
    private var dialogOrder: [String] = []

    /// Real notifications: off in the dev build unless DROVER_DEV_NOTIFY=1 (the signed app already posts them).
    private var enabled: Bool {
        guard Bundle.main.bundleIdentifier != nil else { return false }
        #if DROVER_DEV
        return DevConfig.notificationsEnabled
        #else
        return true
        #endif
    }

    private static let reply = UNTextInputNotificationAction(identifier: "reply", title: "Reply", options: [],
                                                             textInputButtonTitle: "Send", textInputPlaceholder: "Message")
    private static let open = UNNotificationAction(identifier: "open", title: "Open", options: [.foreground])

    private var baseCategories: [UNNotificationCategory] {
        [UNNotificationCategory(identifier: "drover.session", actions: [Self.reply, Self.open], intentIdentifiers: [], options: []),
         UNNotificationCategory(identifier: "drover.info", actions: [Self.open], intentIdentifiers: [], options: [])]
    }

    /// Become the UNUserNotificationCenter delegate and register the categories, once. The app calls this from
    /// its init, before launch finishes, so a Reply or tap that launches the app is delivered here. That covers
    /// this app's alerts and the embedded Safari extension's, which post the same two categories.
    func prepare() {
        guard !prepared, enabled else { return }
        prepared = true
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories(Set(baseCategories))
    }

    /// Request authorization and start the alert feed (prepare() first, if the app has not).
    /// Safe to call again (after reconfigure): the feed task restarts, setup happens once.
    func start() {
        guard enabled else { return }
        prepare()
        if !started {
            started = true
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        }
        feedTask?.cancel()
        usesSSEFallback = false
        feedTask = Task { [weak self] in await self?.runFeed() }
    }

    /// New alerts from the event stream. Used only when the daemon lacks the long-poll op.
    func handle(_ items: [NotifyItem]) {
        guard usesSSEFallback else { return }
        for item in items { post(item) }
    }

    // MARK: feed

    private func runFeed() async {
        var cursor: String?
        var baseline = true
        var backoff = 2.0
        while !Task.isCancelled {
            guard let service = model?.service else { return }
            do {
                // Baseline without waiting: a long poll here would return a fresh alert and swallow it as history.
                let page = try await service.notifications(since: cursor, wait: baseline ? 0 : 25)
                if baseline {
                    for item in page.items { remember(item.id) }
                    baseline = false
                } else {
                    for item in page.items { post(item) }
                }
                if let c = page.cursor { cursor = c }
                backoff = 2
            } catch is CancellationError {
                return
            } catch DroverError.unsupported {
                usesSSEFallback = true
                return
            } catch DroverError.notConfigured {
                try? await Task.sleep(for: .seconds(5))
            } catch {
                try? await Task.sleep(for: .seconds(backoff))
                backoff = min(backoff * 2, 30)
            }
        }
    }

    /// Returns true when the id was new.
    @discardableResult
    private func remember(_ id: String) -> Bool {
        guard seen.insert(id).inserted else { return false }
        seenOrder.append(id)
        if seenOrder.count > 500 {
            let drop = seenOrder.removeFirst()
            seen.remove(drop)
        }
        return true
    }

    // MARK: posting

    func post(_ item: NotifyItem) {
        guard remember(item.id) else { return }
        deliver(item)
    }

    func postTest() {
        let item = NotifyItem(id: "test-\(UUID().uuidString)", at: Date(), category: .needsYou, kind: "test",
                              title: "Test notification", body: "Notifications from Drover look like this.",
                              sessionId: nil, host: nil, tmuxTarget: nil, test: true)
        deliver(item)
    }

    private func deliver(_ item: NotifyItem) {
        guard enabled, let rules = model?.settings.notificationRules else { return }
        let now = Date()
        guard rules.shouldNotify(item, at: now) else { return }
        let c = NotificationContentBuilder.content(for: item)
        let content = UNMutableNotificationContent()
        content.title = c.title
        if let subtitle = c.subtitle { content.subtitle = subtitle }
        content.body = c.body
        content.threadIdentifier = c.threadId
        content.categoryIdentifier = c.categoryId
        // Remember which daemon the alert came from: a reply or an answer after switching servers must not go to the new one.
        var info = c.userInfo
        info["server"] = model?.activeServerURL ?? ""
        content.userInfo = info
        content.sound = nil
        NotificationSounds.play(rules.soundName(for: item.category, at: now))
        let request = UNNotificationRequest(identifier: item.id, content: content, trigger: nil)
        if c.actions.isEmpty {
            add(request)
        } else {
            Task { await register(c); add(request) }
        }
    }

    /// The dialog's category must exist before its notification is shown, or the banner has no actions.
    private func register(_ c: NotificationContentBuilder.Content) async {
        guard dialogCategories[c.categoryId] == nil else { return }
        // An approval request's options answer it by id (the Mac unlocked), with Open and never Reply.
        let required: UNNotificationActionOptions = c.answersApproval ? [.authenticationRequired] : []
        let actions: [UNNotificationAction] = c.actions.map { a in
            UNNotificationAction(identifier: a.id, title: a.title, options: a.destructive ? required.union(.destructive) : required)
        } + (c.answersApproval ? [Self.open] : [Self.reply, Self.open])
        dialogCategories[c.categoryId] = UNNotificationCategory(identifier: c.categoryId, actions: actions, intentIdentifiers: [], options: [])
        dialogOrder.append(c.categoryId)
        while dialogOrder.count > 24 { dialogCategories[dialogOrder.removeFirst()] = nil }
        let center = UNUserNotificationCenter.current()
        center.setNotificationCategories(Set(baseCategories + Array(dialogCategories.values)))
        // setNotificationCategories applies asynchronously; reading them back waits for it.
        _ = await center.notificationCategories()
    }

    private func add(_ request: UNNotificationRequest) {
        guard enabled else { return }
        UNUserNotificationCenter.current().add(request) { _ in }
    }

    private func postLocal(title: String, body: String) {
        PerfLog.note("local notification: \(title): \(body)")
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.categoryIdentifier = "drover.info"
        add(UNNotificationRequest(identifier: "local-\(UUID().uuidString)", content: content, trigger: nil))
    }

    // MARK: actions

    private func reply(sessionId: String, host: String?, text: String) async {
        guard let model else { return }
        let host = model.opHost(host, sessionId: sessionId)
        let session = model.board.sessions.first { ($0.id == sessionId || $0.sessionId == sessionId) && $0.host == host }
            ?? SessionItem(id: sessionId, name: sessionId, host: host, engine: "unknown", status: "unknown",
                           cwd: nil, tmuxTarget: nil, live: true, updatedAt: nil, lane: .idle, waitKind: nil, headline: nil)
        do {
            _ = try await model.service.sendMessage(to: session, text: text)
        } catch {
            postLocal(title: "Reply not delivered", body: error.localizedDescription)
        }
    }

    /// An answer action: the key, on the screen the alert was raised on (`expect`), or not at all.
    private func answer(key: String, info: NotificationAction, requestId: String) async {
        guard let model else { return }
        let id = info.sessionId ?? info.target ?? ""
        let host = model.opHost(info.host, sessionId: info.sessionId)
        let session = model.board.sessions.first { ($0.id == id || $0.sessionId == id) && $0.host == host }
        let target = info.target ?? session?.tmuxTarget
        // As the card does: a Claude session by id (the daemon finds its window), anything else by its window.
        let answerId = session.map { $0.engine == "claude" || target == nil ? id : target ?? id } ?? id
        do {
            let r = try await model.service.answer(id: answerId, host: host, target: target, key: key, expect: info.hash)
            PerfLog.note("notification answer \(key): ok=\(r.ok) reason=\(r.reason ?? "-")")
            // The app's own card follows what the press did.
            if let session { Task { await model.readScreen(session) } }
            if r.ok {
                UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [requestId])
            } else {
                postLocal(title: "Not sent", body: r.reason ?? "The dialog changed since the alert. Open Drover to see it.")
            }
        } catch {
            postLocal(title: "Not sent", body: error.localizedDescription)
        }
        model.scheduleRefresh(after: 0.5)
    }

    /// An approval action: the request answered by its id with that option (via mac); a refusal, or an answer the bot
    /// was not reached with, says so.
    private func approve(choice: Int, info: NotificationAction, requestId: String) async {
        guard let model, let id = info.approvalId, !id.isEmpty else { return }
        let result: Result<ApprovalAnswerResult, Error>
        do { result = .success(try await model.service.answerApproval(id: id, choice: choice)) }
        catch { result = .failure(error) }
        if case .success(let r) = result { model.settle(id, r) }
        let o = ApprovalFormat.outcome(result, botName: info.approvalBot)
        PerfLog.note("notification approval \(choice): \(o.text)")
        if o.isError {
            let decided = if case .success(.decided) = result { true } else { false }
            postLocal(title: decided ? "Answered, not delivered" : "Not answered", body: o.text)
        } else {
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [requestId])
        }
        model.scheduleRefresh(after: 0.5)
    }

    // MARK: UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let action = response.actionIdentifier
        let info = NotificationAction(response.notification.request.content.userInfo)
        let requestId = response.notification.request.identifier
        let text = (response as? UNTextInputNotificationResponse)?.userText
        await MainActor.run { self.route(action: action, info: info, text: text, requestId: requestId) }
    }

    /// What a response asks for. Reply and answer actions act in the background; anything else opens the session.
    func route(action: String, info: NotificationAction, text: String?, requestId: String) {
        switch NotificationResponseRoute.decide(action: action, info: info, text: text, activeServer: model?.activeServerURL) {
        case .refuse:
            postLocal(title: "Not sent", body: "That alert came from another server. Open Drover and answer there.")
        case .reply(let sessionId, let text):
            Task { await self.reply(sessionId: sessionId, host: info.host, text: text) }
        case .answer(let key):
            Task { await self.answer(key: key, info: info, requestId: requestId) }
        case .approve(let choice):
            Task { await self.approve(choice: choice, info: info, requestId: requestId) }
        case .open:
            WindowRouter.shared.openSession(id: info.sessionId, host: info.host)
        case .ignore:
            break
        }
    }
}

/// A notification response -> what to do. Pure (harness-tested).
enum NotificationResponseRoute: Equatable {
    case reply(sessionId: String, text: String)
    case answer(key: String)
    /// An option of a Grok bot's approval request (answered by the request's id).
    case approve(choice: Int)
    /// A tap, Open, or anything unknown: the session in the main window.
    case open
    /// Reply or answer on an alert from another server than the one connected now.
    case refuse
    case ignore

    static func decide(action: String, info: NotificationAction, text: String?, activeServer: String?) -> NotificationResponseRoute {
        let key = NotificationContentBuilder.key(fromAction: action)
        let choice = NotificationContentBuilder.approvalChoice(fromAction: action)
        let acts = action == "reply" || key != nil || choice != nil
        if acts, let server = info.server, server != activeServer { return .refuse }
        if let choice { return info.approvalId?.isEmpty == false ? .approve(choice: choice) : .open }
        if action == "reply" {
            guard let id = info.sessionId, let text, !text.isEmpty else { return .ignore }
            return .reply(sessionId: id, text: text)
        }
        if let key { return info.hash == nil ? .open : .answer(key: key) }
        return .open
    }
}

/// The userInfo a Drover notification carries (NotificationContentBuilder), as plain values.
struct NotificationAction: Sendable, Equatable {
    var sessionId: String?
    var host: String?
    var target: String?
    var hash: String?
    var server: String?
    /// The approval request an approval action answers, and its bot's name.
    var approvalId: String?
    var approvalBot: String?

    init(sessionId: String? = nil, host: String? = nil, target: String? = nil, hash: String? = nil, server: String? = nil,
         approvalId: String? = nil, approvalBot: String? = nil) {
        self.sessionId = sessionId; self.host = host; self.target = target; self.hash = hash; self.server = server
        self.approvalId = approvalId; self.approvalBot = approvalBot
    }

    init(_ info: [AnyHashable: Any]) {
        sessionId = info["sessionId"] as? String
        host = info["host"] as? String
        target = info["target"] as? String
        hash = info["hash"] as? String
        server = info["server"] as? String
        approvalId = info["approvalId"] as? String
        approvalBot = info["approvalBot"] as? String
    }
}
