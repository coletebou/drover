import Foundation

private let t0 = Date(timeIntervalSince1970: 1_791_000_000)
private func ago(_ s: TimeInterval) -> Date { t0.addingTimeInterval(-s) }
private func item(_ id: String, host: String?, since: TimeInterval? = nil, kind: WaitingKind = .question) -> WaitingItem {
    WaitingItem(id: id, name: "n-\(id)", host: host, since: since.map { FlexibleDate(ago($0)) }, kind: kind, headline: "Why?")
}

let listTests: [TestCase] = [
    TestCase("relative: nil, future, boundaries") {
        try expectEqual(ListFormatting.relative(nil, now: t0), "")
        try expectEqual(ListFormatting.relative(t0.addingTimeInterval(30), now: t0), "now")
        try expectEqual(ListFormatting.relative(ago(0), now: t0), "now")
        try expectEqual(ListFormatting.relative(ago(59), now: t0), "now")
        try expectEqual(ListFormatting.relative(ago(60), now: t0), "1m")
        try expectEqual(ListFormatting.relative(ago(3599), now: t0), "59m")
        try expectEqual(ListFormatting.relative(ago(3600), now: t0), "1h")
        try expectEqual(ListFormatting.relative(ago(86399), now: t0), "23h")
        try expectEqual(ListFormatting.relative(ago(86400), now: t0), "1d")
        try expectEqual(ListFormatting.relative(ago(86400 * 3 + 5), now: t0), "3d")
    },
    TestCase("tail: short, exact, long, whitespace") {
        try expectEqual(ListFormatting.tail("  hello \n"), "hello")
        try expectEqual(ListFormatting.tail("abcde", max: 5), "abcde")
        try expectEqual(ListFormatting.tail("abcdefghij", max: 4), "…ghij")
        try expectEqual(ListFormatting.tail("abc   defgh", max: 6), "…defgh")
        try expectEqual(ListFormatting.tail(""), "")
        let long = String(repeating: "x", count: 900)
        try expectEqual(ListFormatting.tail(long).count, 801)
    },
    TestCase("totalsLine: plural, singular, down, hosts fallback") {
        let a = NativeSummary(hosts: [HostSummary(name: "a"), HostSummary(name: "b")],
                              totals: Totals(waiting: 1, working: 2, idle: 3, hosts: 2))
        try expectEqual(ListFormatting.totalsLine(a), "2 working, 3 idle, 2 hosts")
        let b = NativeSummary(hosts: [HostSummary(name: "a")], totals: Totals(working: 1, idle: 1, hosts: 1))
        try expectEqual(ListFormatting.totalsLine(b), "1 working, 1 idle, 1 host")
        let c = NativeSummary(hosts: [HostSummary(name: "a"), HostSummary(name: "b", up: false), HostSummary(name: "c", up: false)],
                              totals: Totals(working: 0, idle: 0, hosts: 3))
        try expectEqual(ListFormatting.totalsLine(c), "0 working, 0 idle, 3 hosts, 2 down")
        let d = NativeSummary(hosts: [HostSummary(name: "a"), HostSummary(name: "b", up: false)], totals: Totals(working: 1, idle: 2))
        try expectEqual(ListFormatting.totalsLine(d), "1 working, 2 idle, 2 hosts, 1 down")
    },
    TestCase("accessibilityLabel: kinds, ages, no since") {
        try expectEqual(ListFormatting.accessibilityLabel(item("a", host: nil, since: 240, kind: .decision), now: t0),
                        "n-a, decision, waiting 4 minutes, Why?")
        try expectEqual(ListFormatting.accessibilityLabel(item("a", host: nil, since: 60, kind: .question), now: t0),
                        "n-a, question, waiting 1 minute, Why?")
        try expectEqual(ListFormatting.accessibilityLabel(item("a", host: nil, since: 10, kind: .finished), now: t0),
                        "n-a, finished, waiting just now, Why?")
        try expectEqual(ListFormatting.accessibilityLabel(item("a", host: nil, since: 7200, kind: .other), now: t0),
                        "n-a, waiting, waiting 2 hours, Why?")
        try expectEqual(ListFormatting.accessibilityLabel(item("a", host: nil, since: 3600), now: t0), "n-a, question, waiting 1 hour, Why?")
        try expectEqual(ListFormatting.accessibilityLabel(item("a", host: nil, since: 86400 * 3), now: t0), "n-a, question, waiting 3 days, Why?")
        try expectEqual(ListFormatting.accessibilityLabel(item("a", host: nil, since: 86400), now: t0), "n-a, question, waiting 1 day, Why?")
        try expectEqual(ListFormatting.accessibilityLabel(item("a", host: nil), now: t0), "n-a, question, Why?")
    },
    TestCase("routing: host match, nil host, local, missing, board, manager") {
        let items = [item("s1", host: "h1"), item("s1", host: "h2"), item("s2", host: nil), item("s3", host: "local")]
        try expectEqual(ListRouting.route(.session(id: "s1", host: "h2"), in: items)?.host, "h2")
        try expect(ListRouting.route(.session(id: "s1", host: nil), in: items) == nil, "omitted host means local, not any host")
        try expectEqual(ListRouting.route(.session(id: "s2", host: nil), in: items)?.id, "s2")
        try expectEqual(ListRouting.route(.session(id: "s3", host: nil), in: items)?.id, "s3")
        try expectEqual(ListRouting.route(.session(id: "s1", host: "h3"), in: items) == nil, true)
        try expectEqual(ListRouting.route(.session(id: "s2", host: "local"), in: items)?.id, "s2")
        try expectEqual(ListRouting.route(.session(id: "s3", host: "local"), in: items)?.id, "s3")
        try expectEqual(ListRouting.route(.session(id: "s2", host: "h1"), in: items) == nil, true)
        try expectEqual(ListRouting.route(.session(id: "zz", host: nil), in: items) == nil, true)
        try expectEqual(ListRouting.route(.board, in: items) == nil, true)
        try expectEqual(ListRouting.route(.manager, in: items) == nil, true)
    },
    TestCase("preview data formats") {
        let s = PreviewData.summary
        try expectEqual(ListFormatting.totalsLine(s), "2 working, 3 idle, 2 hosts")
        try expectEqual(ListFormatting.relative(s.waiting[0].since?.date, now: PreviewData.now), "4m")
        try expect(ListRouting.route(.session(id: "s-demo-docs", host: "demo-box"), in: s.waiting) != nil)
    },
]
