import Foundation
import Testing
@testable import DroverWidgetCore

@Suite struct EntryResolverTests {
    private let fetchedAt = Date(timeIntervalSince1970: 1_700_000_000)
    private var fresh: FetchResult {
        FetchResult(summary: SummaryFixtures.sample, resultJSON: Data(SummaryFixtures.sampleJSON.utf8))
    }
    private var cache: (summary: NativeSummary, fetchedAt: Date) { (SummaryFixtures.empty, fetchedAt) }

    @Test func noCredentials() {
        let withCache = EntryResolver.resolve(fetch: nil, cache: cache, hostFilter: nil)
        #expect(withCache.summary == SummaryFixtures.empty)
        #expect(withCache.status == .cached(fetchedAt: fetchedAt))
        let without = EntryResolver.resolve(fetch: nil, cache: nil, hostFilter: nil)
        #expect(without.summary == nil)
        #expect(without.status == .notConfigured)
    }

    @Test func success() {
        let r = EntryResolver.resolve(fetch: .success(fresh), cache: cache, hostFilter: nil)
        #expect(r.summary == SummaryFixtures.sample)
        #expect(r.status == .live)
    }

    @Test func unauthorized() {
        let withCache = EntryResolver.resolve(fetch: .failure(.unauthorized), cache: cache, hostFilter: nil)
        #expect(withCache.summary == SummaryFixtures.empty)
        #expect(withCache.status == .unauthorized)
        let without = EntryResolver.resolve(fetch: .failure(.unauthorized), cache: nil, hostFilter: nil)
        #expect(without.summary == nil)
        #expect(without.status == .unauthorized)
    }

    @Test func otherFailures() {
        for error in [SummaryFetchError.transport, .http(500), .server("x"), .decoding] {
            let withCache = EntryResolver.resolve(fetch: .failure(error), cache: cache, hostFilter: nil)
            #expect(withCache.summary == SummaryFixtures.empty)
            #expect(withCache.status == .cached(fetchedAt: fetchedAt))
            let without = EntryResolver.resolve(fetch: .failure(error), cache: nil, hostFilter: nil)
            #expect(without.summary == nil)
            #expect(without.status == .unreachable)
        }
    }

    @Test func hostFilterApplied() {
        let live = EntryResolver.resolve(fetch: .success(fresh), cache: nil, hostFilter: "demo-mac")
        #expect(live.summary == SummaryFixtures.sample.filtered(host: "demo-mac"))
        #expect(live.summary?.hosts.map(\.name) == ["demo-mac"])
        let cached = EntryResolver.resolve(fetch: .failure(.transport), cache: (SummaryFixtures.sample, fetchedAt), hostFilter: "demo-box-1")
        #expect(cached.summary?.hosts.map(\.name) == ["demo-box-1"])
    }
}
