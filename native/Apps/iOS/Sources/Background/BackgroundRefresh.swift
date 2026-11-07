import BackgroundTasks
import Foundation
import UserNotifications

/// Opportunistic background work: refresh the widget summary cache and deliver new alerts as local notifications.
///
/// Design notes:
/// - There is no APNs. The daemon has no push server, so alerts can only be pulled while the app gets time.
/// - `BGAppRefreshTask` is opportunistic. iOS decides when it runs: often 15 minutes or more apart, and not
///   at all after the user force-quits the app or while Low Power Mode is on. Foreground polling
///   (`NotificationManager.pollNow`) covers the rest.
/// - Live Activities are out of scope.
enum BackgroundRefresh {
    /// Submits the next refresh request. Resubmitting the same identifier replaces the pending one.
    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: DroverIDs.refreshTaskID)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    /// Body of the app refresh task. Each step tolerates errors on its own; cancellation stops early.
    static func run() async {
        schedule()
        guard let api = AppModel.makeAPI() else { return }
        if Task.isCancelled { return }
        if let summary = try? await api.summary() {
            SummaryCache.store(summary)
            try? await UNUserNotificationCenter.current().setBadgeCount(summary.totals.waiting)
        }
        if Task.isCancelled { return }
        await NotificationPipeline.run(api: api)
    }
}

/// Fetches new alerts and posts them as local notifications. Shared by the refresh task and foreground polling.
/// Single-flight on the main actor: a call made while one runs marks a rerun (so an alert that arrived after
/// the running request was answered is still fetched), and a response is committed only if the stored
/// cursor did not move meanwhile.
@MainActor
enum NotificationPipeline {
    private static let ringKey = "drover.postedNotificationIDs"
    private static var inFlight = false
    private static var rerun = false

    static func run(api: any DroverAPI, settings: SharedSettings = SharedSettings()) async {
        guard !inFlight else { rerun = true; return }
        inFlight = true
        defer { inFlight = false }
        repeat {
            rerun = false
            await once(api: api, settings: settings)
        } while rerun && !Task.isCancelled
    }

    private static func once(api: any DroverAPI, settings: SharedSettings) async {
        let requestCursor = settings.notificationCursor
        guard let feed = try? await api.notifications(since: requestCursor, wait: nil) else { return }
        if Task.isCancelled || settings.notificationCursor != requestCursor { return }
        let defaults = UserDefaults(suiteName: DroverIDs.appGroup) ?? .standard
        let ring = defaults.stringArray(forKey: ringKey) ?? []
        let plan = NotificationPlan.make(feed: feed, storedCursor: requestCursor,
                                         mutedKinds: settings.mutedNotificationKinds, postedRing: ring)
        // Record before posting so an overlapping poll sees the ids as taken.
        defaults.set(plan.postedRing, forKey: ringKey)
        if let cursor = plan.cursor { settings.notificationCursor = cursor }
        let center = UNUserNotificationCenter.current()
        for n in plan.notifications {
            // An approval request's buttons are its own category, which must exist before the banner shows.
            if !n.actions.isEmpty { await NotificationManager.shared.registerApprovalCategory(n) }
            try? await center.add(request(for: n, server: settings.baseURL?.absoluteString))
        }
    }

    /// `server` (the daemon's address, no credentials) rides along on an approval request, so its buttons answer only
    /// the daemon that raised it.
    static func request(for n: PlannedNotification, server: String? = nil) -> UNNotificationRequest {
        let content = UNMutableNotificationContent()
        content.title = n.title
        if let subtitle = n.subtitle { content.subtitle = subtitle }
        content.body = n.body
        content.threadIdentifier = n.threadID
        content.categoryIdentifier = n.categoryID
        var info: [String: String] = ["kind": n.kind]
        if let s = n.sessionId { info["sessionId"] = s }
        if let h = n.host { info["host"] = h }
        if let a = n.approvalID {
            info["approvalId"] = a
            if let bot = n.approvalBot { info["approvalBot"] = bot }
            if let server { info["server"] = server }
        }
        content.userInfo = info
        content.sound = n.playsSound ? .default : nil
        content.interruptionLevel = .active
        return UNNotificationRequest(identifier: n.id, content: content, trigger: nil)
    }
}
