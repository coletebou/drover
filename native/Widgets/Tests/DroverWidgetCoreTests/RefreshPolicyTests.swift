import Foundation
import Testing
@testable import DroverWidgetCore

@Suite struct RefreshPolicyTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func summary(waiting: Int, working: Int) -> NativeSummary {
        var s = SummaryFixtures.empty
        s.totals.waiting = waiting
        s.totals.working = working
        return s
    }

    private func minutes(_ s: NativeSummary?, _ status: SummaryStatus) -> Double {
        RefreshPolicy.nextRefresh(after: now, summary: s, status: status).timeIntervalSince(now) / 60
    }

    @Test func liveAndCached() {
        let cached = SummaryStatus.cached(fetchedAt: now)
        for status in [SummaryStatus.live, cached] {
            #expect(minutes(summary(waiting: 1, working: 2), status) == 5)
            #expect(minutes(summary(waiting: 0, working: 2), status) == 10)
            #expect(minutes(summary(waiting: 0, working: 0), status) == 15)
            #expect(minutes(nil, status) == 15)
        }
    }

    @Test func otherStatusesUseFifteenMinutes() {
        let busy = summary(waiting: 3, working: 3)
        for status in [SummaryStatus.notConfigured, .unauthorized, .unreachable] {
            #expect(minutes(busy, status) == 15)
            #expect(minutes(nil, status) == 15)
        }
    }
}
