import Foundation

private func sending(_ text: String = "yes") -> ReplyFlow {
    var f = ReplyFlow()
    _ = f.tap(.yes)
    if text != "yes" { f = ReplyFlow(); f.dictated(text); _ = f.confirm() }
    return f
}

let repliesTests: [TestCase] = [
    TestCase("canned replies: order, texts, labels, symbols") {
        try expectEqual(CannedReply.allCases.map(\.text), ["yes", "no", "continue", "go ahead", "status?"])
        try expectEqual(CannedReply.allCases.map(\.id), ["yes", "no", "continue", "go ahead", "status?"])
        try expectEqual(CannedReply.allCases.map(\.label), ["Yes", "No", "Continue", "Go ahead", "Status?"])
        try expectEqual(CannedReply.allCases.map(\.symbol), ["checkmark", "xmark", "arrow.right", "play.fill", "questionmark"])
        try expectEqual(CannedReply.allCases.map(\.accessibilityLabel),
                        ["Reply yes", "Reply no", "Reply continue", "Reply go ahead", "Ask for status"])
    },
    TestCase("canned replies: no em dash in any label") {
        for r in CannedReply.allCases {
            try expect(!r.label.contains("\u{2014}") && !r.accessibilityLabel.contains("\u{2014}") && !r.text.contains("\u{2014}"))
        }
    },
    TestCase("clean trims and collapses whitespace") {
        try expectEqual(ReplyFlow.clean("  hello \n\n  world\t\tagain  "), "hello world again")
        try expectEqual(ReplyFlow.clean("   \n\t "), "")
        try expectEqual(ReplyFlow.clean("one"), "one")
    },
    TestCase("clean caps at 2000 characters") {
        try expectEqual(ReplyFlow.clean(String(repeating: "a", count: 2500)).count, 2000)
        try expectEqual(ReplyFlow.clean(String(repeating: "a", count: 2000)).count, 2000)
        let spaced = String(repeating: "a", count: 1999) + " bbb"
        let c = ReplyFlow.clean(spaced)
        try expect(c.count <= 2000 && !c.hasSuffix(" "))
    },
    TestCase("dictated moves idle to confirming with cleaned text") {
        var f = ReplyFlow()
        f.dictated("  do   the\nthing ")
        try expectEqual(f.phase, .confirming("do the thing"))
        try expect(!f.isBusy)
    },
    TestCase("dictated with blank text stays idle") {
        var f = ReplyFlow()
        f.dictated("   ")
        try expectEqual(f.phase, .idle)
    },
    TestCase("dictated while sending is ignored") {
        var f = sending()
        f.dictated("other")
        try expectEqual(f.phase, .sending("yes"))
    },
    TestCase("confirm sends the confirming text") {
        var f = ReplyFlow()
        f.dictated("hello")
        try expectEqual(f.confirm(), "hello")
        try expectEqual(f.phase, .sending("hello"))
        try expect(f.isBusy)
    },
    TestCase("confirm from idle, sending, sent returns nil") {
        var f = ReplyFlow()
        try expectEqual(f.confirm(), nil)
        try expectEqual(f.phase, .idle)
        var s = sending()
        try expectEqual(s.confirm(), nil)
        try expectEqual(s.phase, .sending("yes"))
        s.succeeded()
        try expectEqual(s.confirm(), nil)
        try expectEqual(s.phase, .sent("yes"))
    },
    TestCase("cancel from confirming and failed returns to idle") {
        var f = ReplyFlow()
        f.dictated("x")
        f.cancel()
        try expectEqual(f.phase, .idle)
        var g = sending()
        g.failed("boom")
        g.cancel()
        try expectEqual(g.phase, .idle)
    },
    TestCase("cancel from idle, sending and sent does nothing") {
        var f = ReplyFlow()
        f.cancel()
        try expectEqual(f.phase, .idle)
        var s = sending()
        s.cancel()
        try expectEqual(s.phase, .sending("yes"))
        s.succeeded()
        s.cancel()
        try expectEqual(s.phase, .sent("yes"))
    },
    TestCase("tap sends canned text at once") {
        var f = ReplyFlow()
        try expectEqual(f.tap(.goAhead), "go ahead")
        try expectEqual(f.phase, .sending("go ahead"))
        try expect(f.isBusy)
    },
    TestCase("tap while sending returns nil and keeps phase") {
        var f = ReplyFlow()
        _ = f.tap(.yes)
        try expectEqual(f.tap(.no), nil)
        try expectEqual(f.phase, .sending("yes"))
    },
    TestCase("tap from sent, failed and confirming replaces the phase") {
        var f = sending()
        f.succeeded()
        try expectEqual(f.tap(.no), "no")
        f.failed("x")
        try expectEqual(f.tap(.status), "status?")
        var g = ReplyFlow()
        g.dictated("typed")
        try expectEqual(g.tap(.proceed), "continue")
        try expectEqual(g.phase, .sending("continue"))
    },
    TestCase("succeeded and failed from sending") {
        var f = sending()
        f.succeeded()
        try expectEqual(f.phase, .sent("yes"))
        try expect(!f.isBusy)
        var g = sending()
        g.failed("Server unreachable")
        try expectEqual(g.phase, .failed(text: "yes", message: "Server unreachable"))
        try expect(!g.isBusy)
    },
    TestCase("succeeded and failed from other phases do nothing") {
        var f = ReplyFlow()
        f.failed("x")
        try expectEqual(f.phase, .idle)
        f.succeeded()
        try expectEqual(f.phase, .idle)
        var c = ReplyFlow()
        c.dictated("a")
        c.failed("x")
        c.succeeded()
        try expectEqual(c.phase, .confirming("a"))
    },
    TestCase("retry from failed returns the original text") {
        var f = ReplyFlow()
        f.dictated("long answer")
        _ = f.confirm()
        f.failed("Server error 500")
        try expectEqual(f.retry(), "long answer")
        try expectEqual(f.phase, .sending("long answer"))
    },
    TestCase("retry from non-failed phases returns nil") {
        var f = ReplyFlow()
        try expectEqual(f.retry(), nil)
        var s = sending()
        try expectEqual(s.retry(), nil)
        s.succeeded()
        try expectEqual(s.retry(), nil)
        try expectEqual(s.phase, .sent("yes"))
    },
    TestCase("reset returns to idle from any phase") {
        var f = sending()
        f.reset()
        try expectEqual(f.phase, .idle)
        var g = sending()
        g.succeeded()
        g.reset()
        try expectEqual(g.phase, .idle)
    },
]
