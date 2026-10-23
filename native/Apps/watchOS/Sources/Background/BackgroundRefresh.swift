import Foundation
import WatchKit

/// Schedules watchOS app refresh tasks; each one queues a background summary download.
enum BackgroundRefresh {
    static let taskID = "drover.refresh"

    static func schedule(after interval: TimeInterval = RefreshPolicy.base) async {
        let date = Date(timeIntervalSinceNow: max(interval, RefreshPolicy.minimum))
        // Only the completion-handler form is imported; bridge it. Errors are ignored: the next
        // foreground or background run schedules again.
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            Task { @MainActor in
                WKApplication.shared().scheduleBackgroundRefresh(withPreferredDate: date,
                                                                 userInfo: taskID as NSString) { _ in done.resume() }
            }
        }
    }

    /// The app refresh task: queue the background download (widget token only) and ask for
    /// the next refresh. The result arrives later through BackgroundSummaryDownload.
    static func run() async {
        await BackgroundSummaryDownload.shared.enqueue()
        let failures = RefreshFailureCounter(defaults: UserDefaults(suiteName: DroverIdentifiers.appGroup) ?? .standard)
        let n = failures.count
        await schedule(after: RefreshPolicy.nextInterval(succeeded: n == 0, consecutiveFailures: n))
    }
}
