import Foundation

private let approvalJSON = """
{"id":"grok:demo-alpha","name":"Demo-alpha","host":"local","engine":"grok","since":"2026-10-27T09:58:00.000Z",
 "kind":"decision","headline":"Buy the demo plan?","answer":"approval","moreApprovals":2,
 "approval":{"id":"ap_0123456789ab","bot":"grok:demo-alpha","kind":"purchase","question":"Buy the demo plan?",
  "options":[{"n":1,"label":"Buy it"},{"n":"2","label":"Not now"},{"n":0,"label":"zero"},{"label":"none"},{"n":2,"label":"dupe"}],
  "details":"Paid with the card on file.","createdAt":"2026-10-27T09:58:00.000Z","expiresAt":"2026-10-28T09:58:00.000Z",
  "untrusted":true}}
"""

@MainActor private func approvalModel(main: String?) -> AppModel {
    let cfg = WatchConfig(defaults: scratchDefaults())
    cfg.baseURL = URL(string: "http://127.0.0.1:7337")
    return AppModel(vault: MemoryTokenVault(main: main, widget: "widget-tok"), config: cfg,
                    cache: SummaryCache(fileURL: scratchFile()), seen: SeenWaitingStore(defaults: scratchDefaults()),
                    session: StubURLProtocol.session())
}

let approvalTests: [TestCase] = [
    TestCase("approval: a waiting item decodes its request, malformed options dropped") {
        let w = try JSONDecoder().decode(WaitingItem.self, from: Data(approvalJSON.utf8))
        try expectEqual(w.kind, .decision, "kind stays decision for older watches")
        try expectEqual(w.answer, "approval")
        try expectEqual(w.moreApprovals, 2)
        let a = try w.approval.unwrapOrThrow()
        try expectEqual(a.id, "ap_0123456789ab")
        try expectEqual(a.options, [.init(n: 1, label: "Buy it"), .init(n: 2, label: "Not now")])
        try expectEqual(a.details, "Paid with the card on file.")
        try expect(a.expiresAt != nil && a.createdAt != nil)
        try expectEqual(w.botName, "Demo-alpha")
    },
    TestCase("approval: malformed answer fields never fail the summary") {
        let json = """
        {"waiting":[{"id":"a","answer":3,"approval":"no","moreApprovals":"two"},
                    {"id":"b","approval":{"question":"no id"}},{"id":"c","approval":{"id":""}},
                    {"id":"d","approval":{"id":"ap_1"}}],"totals":{"waiting":4}}
        """
        let s = try JSONDecoder().decode(NativeSummary.self, from: Data(json.utf8))
        try expectEqual(s.waiting.map(\.id), ["a", "b", "c", "d"])
        try expect(s.waiting[0].answer == nil && s.waiting[0].approval == nil && s.waiting[0].moreApprovals == nil)
        try expect(s.waiting[1].approval == nil && s.waiting[2].approval == nil, "no id, no request")
        try expectEqual(s.waiting[3].approval?.question, "", "an id is all it needs")
        try expectEqual(s.waiting[3].approval?.options, [])
    },
    TestCase("approval: the repo's approval fixture decodes") {
        let data = try repoFixture("native.summary.approval.json")
        let s = try JSONDecoder().decode(NativeSummary.self, from: try WatchClient.unwrap(data, status: 200))
        let item = try s.waiting.first { $0.approval != nil }.unwrapOrThrow()
        try expectEqual(item.answer, "approval")
        try expect(item.approval?.options.count ?? 0 >= 2, "two to four options")
        try expect(s.waiting.contains { $0.approval == nil }, "a session beside it decodes too")
    },
    TestCase("approval client: POST /api/approvals/answer, bearer header, body {id, choice, via: watch}") {
        StubURLProtocol.responses["answer"] = (200, Data(#"{"ok":true,"result":{"id":"ap_1","status":"decided","decision":{"n":2,"label":"Not now"},"delivery":{"ok":true,"queued":true}}}"#.utf8))
        let client = WatchClient(baseURL: URL(string: "http://127.0.0.1:7337")!, session: StubURLProtocol.session())
        let r = try await client.answerApproval(id: "ap_1", choice: 2, token: "tok-SECRET-3")
        try expectEqual(r, .decided(label: "Not now", told: true, queued: true))
        let sent = try StubURLProtocol.recorded.first.unwrapOrThrow()
        try expectEqual(sent.url.absoluteString, "http://127.0.0.1:7337/api/approvals/answer")
        try expectEqual(sent.method, "POST")
        try expectEqual(sent.headers["Authorization"], "Bearer tok-SECRET-3")
        let body = try JSONSerialization.jsonObject(with: sent.body) as? [String: Any]
        try expectEqual(body?["id"] as? String, "ap_1")
        try expectEqual(body?["choice"] as? Int, 2)
        try expectEqual(body?["via"] as? String, "watch")
        try expectEqual(body?.count, 3)
        try expect(!sent.url.absoluteString.contains("SECRET") && !(String(data: sent.body, encoding: .utf8) ?? "").contains("SECRET"))
    },
    TestCase("approval client: 409 closed, 404 and 400 say why, 401 and 403 rejected, delivery failures") {
        func result(_ status: Int, _ json: String) throws -> ApprovalAnswerResult {
            try WatchClient.approvalResult(Data(json.utf8), status: status, redacting: "tok-SECRET-4")
        }
        try expectEqual(try result(409, #"{"ok":false,"error":"approval ap_1 was answered already: Buy it (ios)"}"#),
                        .closed(message: "approval ap_1 was answered already: Buy it (ios)"))
        try expectEqual(try result(409, #"{"ok":false,"error":"bad tok-SECRET-4"}"#), .closed(message: "bad [redacted]"))
        try expectEqual(try result(409, "not json"), .closed(message: "This request is no longer waiting for an answer"))
        try expect(throws: WatchClientError.server("no approval ap_1 here")) { _ = try result(404, #"{"ok":false,"error":"no approval ap_1 here"}"#) }
        try expect(throws: WatchClientError.server("choice must be one of its options")) { _ = try result(400, #"{"ok":false,"error":"choice must be one of its options"}"#) }
        try expect(throws: WatchClientError.unauthorized) { _ = try result(401, #"{"error":"unauthorized"}"#) }
        try expect(throws: WatchClientError.unauthorized) { _ = try result(403, #"{"ok":false,"error":"widget token: read-only scope"}"#) }
        try expect(throws: WatchClientError.http(502)) { _ = try result(502, "<html>") }
        try expectEqual(try result(200, #"{"ok":true,"result":{"decision":{"label":"Buy it"},"delivery":{"ok":false,"error":"routine 502"}}}"#),
                        .decided(label: "Buy it", told: false, queued: false))
        try expectEqual(try result(200, #"{"ok":true,"result":{"decision":"odd"}}"#), .decided(label: "", told: true, queued: false))
    },
    TestCase("approval model: needs the main token, answers, then refreshes") {
        let ro = approvalModel(main: nil)
        let a = ApprovalRequest(id: "ap_1", question: "q", options: [.init(n: 1, label: "Approve"), .init(n: 2, label: "Deny")])
        try await expectThrows(WatchClientError.missingToken(.main)) { _ = try await ro.answerApproval(a, choice: 1) }
        try expect(StubURLProtocol.recorded.isEmpty, "the widget token never answers")
        StubURLProtocol.responses["answer"] = (200, Data(#"{"ok":true,"result":{"decision":{"n":1,"label":"Approve"},"delivery":{"ok":true}}}"#.utf8))
        StubURLProtocol.responses["native.summary"] = (200, envelope(#"{"waiting":[],"totals":{}}"#))
        let m = approvalModel(main: "main-tok")
        let r = try await m.answerApproval(a, choice: 1)
        try expectEqual(r, .decided(label: "Approve", told: true, queued: false))
        try expectEqual(StubURLProtocol.recorded.map(\.url.lastPathComponent), ["answer", "native.summary"], "answer, then refresh")
        try expectEqual(StubURLProtocol.recorded.first?.headers["Authorization"], "Bearer main-tok")
        try expectEqual(m.phase, .loaded)
    },
    TestCase("approval: complete decodes, missing or malformed reads as false; the full request's fields") {
        let w = try JSONDecoder().decode(WaitingItem.self, from: Data(approvalJSON.utf8))
        try expect(w.approval?.complete == nil && w.approval?.isComplete == false, "no complete: not answered as shown")
        let whole = try JSONDecoder().decode(ApprovalRequest.self, from: Data(#"{"id":"ap_1","question":"q","options":[],"complete":true}"#.utf8))
        let odd = try JSONDecoder().decode(ApprovalRequest.self, from: Data(#"{"id":"ap_1","question":"q","options":[],"complete":"yes"}"#.utf8))
        try expect(whole.isComplete && !odd.isComplete)
        let full = try JSONDecoder().decode(ApprovalRequest.self, from: Data(#"""
        {"id":"ap_1","status":"decided","question":"q","options":[{"n":1,"label":"Buy it"}],"details":null,
         "decision":{"n":1,"label":"Buy it","by":"owner"},"via":"ios","botName":"Demo-alpha"}
        """#.utf8))
        try expectEqual(full.status, "decided")
        try expectEqual(full.decisionLabel, "Buy it")
        try expectEqual(full.via, "ios")
        try expect(full.details == nil)
        try expectEqual(ApprovalFormat.closedText(full), "Answered already: \"Buy it\" (ios).")
        let rt = try JSONDecoder().decode(ApprovalRequest.self, from: JSONEncoder().encode(full))
        try expectEqual(rt, full, "round trip keeps the answer")
    },
    TestCase("approval card: one tap only on words shown whole, else review first") {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let opts: [ApprovalRequest.Option] = [.init(n: 1, label: "Approve"), .init(n: 2, label: "Deny")]
        let later = FlexibleDate(now.addingTimeInterval(3600))
        let whole = ApprovalRequest(id: "ap_1", question: "Restart?", options: opts, details: "Tonight.", expiresAt: later, complete: true)
        let cut = ApprovalRequest(id: "ap_1", question: "Restart?", options: opts, expiresAt: later, complete: false)
        let old = ApprovalRequest(id: "ap_1", question: "Restart?", options: opts, expiresAt: later)
        func mode(_ s: ApprovalRequest, full: ApprovalRequest? = nil, host: String? = "local", main: Bool = true) -> ApprovalCardMode {
            ApprovalFormat.cardMode(summary: s, full: full, host: host, canAnswer: main, now: now)
        }
        try expectEqual(mode(whole), .answer(whole))
        try expectEqual(mode(cut), .review)
        try expectEqual(mode(old), .review, "missing complete counts as false")
        let long = ApprovalRequest(id: "ap_1", question: String(repeating: "q", count: 121), options: opts, expiresAt: later, complete: true)
        try expectEqual(mode(long), .review, "a question over 120 characters goes through the review")
        let edge = ApprovalRequest(id: "ap_1", question: String(repeating: "q", count: 120), options: opts, expiresAt: later, complete: true)
        try expectEqual(mode(edge), .answer(edge), "120 is fine")
        let thumbs = ApprovalRequest(id: "ap_1", question: String(repeating: "\u{1F44D}", count: 61), options: opts, expiresAt: later, complete: true)
        try expectEqual(mode(thumbs), .review, "UTF-16 units, as the web board counts")
        var full = cut
        full.details = "Tonight at 2 am, after the backups."
        full.status = "pending"
        try expectEqual(mode(cut, full: full), .answer(full), "answered from the whole request")
        var withdrawn = full
        withdrawn.status = "withdrawn"
        try expectEqual(mode(cut, full: withdrawn), .closed("The bot withdrew this request."))
        try expectEqual(mode(whole, main: false), .blocked("Answer on your iPhone"), "read-only without the main token")
        try expectEqual(mode(whole, host: "demo-box"), .blocked("demo-box keeps this bot: answer it there."))
        let past = ApprovalRequest(id: "ap_1", question: "q", options: opts, expiresAt: FlexibleDate(now.addingTimeInterval(-1)), complete: true)
        try expectEqual(mode(past), .blocked("This request expired."))
    },
    TestCase("approval client: review is GET /api/approvals?id= with the main token") {
        StubURLProtocol.responses["approvals"] = (200, envelope(#"{"keepsBots":true,"items":[{"id":"ap_1","status":"pending","question":"Restart?","options":[{"n":1,"label":"Restart"}],"details":"Tonight at 2 am.","complete":true},{"bad":1}]}"#))
        let client = WatchClient(baseURL: URL(string: "http://127.0.0.1:7337")!, session: StubURLProtocol.session())
        let full = try await client.approval(id: "ap_1", token: "tok-SECRET-5").unwrapOrThrow()
        try expectEqual(full.details, "Tonight at 2 am.")
        try expectEqual(full.status, "pending")
        let sent = try StubURLProtocol.recorded.last.unwrapOrThrow()
        try expectEqual(sent.method, "GET")
        try expectEqual(sent.url.absoluteString, "http://127.0.0.1:7337/api/approvals?id=ap_1")
        try expectEqual(sent.headers["Authorization"], "Bearer tok-SECRET-5")
        try expect(!sent.url.absoluteString.contains("SECRET"))
        StubURLProtocol.responses["approvals"] = (200, envelope(#"{"keepsBots":true,"items":[]}"#))
        let missing = try await client.approval(id: "ap_1", token: "t")
        try expect(missing == nil, "not kept here")
        StubURLProtocol.responses["approvals"] = (403, Data(#"{"ok":false,"error":"widget token: read-only scope"}"#.utf8))
        try await expectThrows(WatchClientError.unauthorized) { _ = try await client.approval(id: "ap_1", token: "t") }
    },
    TestCase("approval model: review needs the main token; the preview reviews offline") {
        let ro = approvalModel(main: nil)
        try await expectThrows(WatchClientError.missingToken(.main)) { _ = try await ro.reviewApproval(PreviewData.approvalItem.approval!) }
        try expect(StubURLProtocol.recorded.isEmpty)
        let full = try await AppModel.preview().reviewApproval(PreviewData.approvalItem.approval!).unwrapOrThrow()
        try expect(full.isComplete && full.status == "pending")
    },
    TestCase("approval model: an answered request the summary still lists is settled, then let go") {
        StubURLProtocol.responses["answer"] = (200, Data(#"{"ok":true,"result":{"decision":{"n":1,"label":"Approve"},"delivery":{"ok":true}}}"#.utf8))
        StubURLProtocol.responses["native.summary"] = (200, envelope(#"{"waiting":[{"id":"grok:demo-alpha","name":"Demo-alpha","host":"local","kind":"decision","approval":{"id":"ap_1","question":"q","options":[{"n":1,"label":"Approve"}],"complete":true}}],"totals":{"waiting":1}}"#))
        let m = approvalModel(main: "main-tok")
        let a = ApprovalRequest(id: "ap_1", question: "q", options: [.init(n: 1, label: "Approve")], complete: true)
        _ = try await m.answerApproval(a, choice: 1)
        try expectEqual(m.settledApprovals["ap_1"], "Answered \"Approve\".", "the summary still lists it: settled")
        StubURLProtocol.responses["native.summary"] = (200, envelope(#"{"waiting":[],"totals":{}}"#))
        await m.refresh()
        try expect(m.settledApprovals.isEmpty, "dropped from the summary: let go")
        try expectEqual(ApprovalFormat.settledText(.closed(message: "approval ap_1 is expired.")), "Not answered: approval ap_1 is expired.")
    },
    TestCase("approval model: the preview answers offline with the option's label") {
        let m = AppModel.preview()
        let item = try m.waiting.first { $0.approval != nil }.unwrapOrThrow()
        let r = try await m.answerApproval(try item.approval.unwrapOrThrow(), choice: 2)
        try expectEqual(r, .decided(label: "Not now", told: true, queued: false))
    },
    TestCase("approval flow: one press at a time, no second answer once decided") {
        var f = ApprovalFlow()
        try expectEqual(f.press(1), 1)
        try expect(f.isBusy && f.sending == 1)
        try expectEqual(f.press(2), nil, "busy")
        f.finished(.failure(WatchClientError.transport("Server unreachable")), botName: "Alpha")
        try expectEqual(f.phase, .failed("Not answered: Server unreachable."))
        try expect(f.showsButtons && !f.isBusy, "try again")
        try expectEqual(f.press(2), 2)
        f.finished(.success(.decided(label: "Deny", told: true, queued: false)), botName: "Alpha")
        try expectEqual(f.phase, .done(text: "Answered \"Deny\". Alpha is told now.", isError: false))
        try expect(!f.showsButtons)
        try expectEqual(f.press(1), nil, "decided: no second answer")
        var g = ApprovalFlow()
        _ = g.press(1)
        g.finished(.success(.closed(message: "approval ap_1 is expired")), botName: nil)
        try expectEqual(g.phase, .done(text: "Not answered: approval ap_1 is expired.", isError: true))
        var h = ApprovalFlow()
        h.finished(.success(.decided(label: "x", told: true, queued: false)), botName: nil)
        try expectEqual(h.phase, .idle, "nothing pressed, nothing finished")
    },
    TestCase("approval wording: who asks, how long, outcomes, no em dash") {
        try expectEqual(ApprovalFormat.botName(bot: "grok:alpha"), "Alpha")
        try expectEqual(ApprovalFormat.botName(bot: nil, fallback: "Demo-beta"), "Demo-beta")
        try expectEqual(ApprovalFormat.askedBy("Alpha"), "Asked by Alpha, a Grok bot")
        try expectEqual(ApprovalFormat.askedBy(nil), "Asked by a Grok bot")
        try expectEqual(ApprovalFormat.heading(kind: "purchase"), "Asks to buy")
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        try expectEqual(ApprovalFormat.standsFor(now.addingTimeInterval(30 * 60), now: now), "30 min")
        try expectEqual(ApprovalFormat.standsFor(now.addingTimeInterval(3 * 3600), now: now), "3 h")
        try expectEqual(ApprovalFormat.standsFor(now.addingTimeInterval(4 * 86400), now: now), "4 days")
        try expect(ApprovalFormat.standsFor(now, now: now) == nil)
        let note = ApprovalFormat.note(botName: "Alpha", expiresAt: now.addingTimeInterval(3 * 3600), more: 1, now: now)
        try expectEqual(note, "Asked by Alpha, a Grok bot. These are its words: check them before you answer. Stands for 3 h more. 1 more after this one.")
        try expect(ApprovalFormat.isAnswerable(host: nil) && ApprovalFormat.isAnswerable(host: "local"))
        try expect(!ApprovalFormat.isAnswerable(host: "demo-box"))
        let expired = ApprovalRequest(id: "x", question: "q", options: [], expiresAt: FlexibleDate(Date(timeIntervalSince1970: 1)))
        try expect(ApprovalFormat.isExpired(expired, now: now) && !ApprovalFormat.isExpired(ApprovalRequest(id: "y", question: "q", options: []), now: now))
        let texts = [
            ApprovalFormat.outcome(.success(.decided(label: "Buy it", told: true, queued: false)), botName: "Alpha").text,
            ApprovalFormat.outcome(.success(.decided(label: "Buy it", told: true, queued: true)), botName: "Alpha").text,
            ApprovalFormat.outcome(.success(.decided(label: "Buy it", told: false, queued: false)), botName: nil).text,
            ApprovalFormat.outcome(.failure(WatchClientError.missingToken(.main)), botName: "Alpha").text,
            note,
        ]
        try expectEqual(texts[0], "Answered \"Buy it\". Alpha is told now.")
        try expectEqual(texts[1], "Answered \"Buy it\". Alpha sees it when it checks its inbox.")
        try expectEqual(texts[2], "Answered \"Buy it\". The bot was not reached; it sees the answer when it checks again.")
        try expectEqual(texts[3], "Not answered: Pair with iPhone to reply.")
        try expect(!texts.contains { $0.contains("\u{2014}") || $0.contains("\u{2013}") }, "no em or en dash")
    },
    TestCase("approval list: badge, spoken label, the background notification says who asks") {
        let item = PreviewData.approvalItem
        try expectEqual(ListFormatting.kindLabel(item), "Approval")
        try expectEqual(ListFormatting.kindLabel(WaitingItem(id: "a", name: "a", kind: .decision)), "Decision")
        try expectEqual(ListFormatting.kindLabel(WaitingItem(id: "a", name: "a", kind: .other)), "Waiting")
        let t0 = Date(timeIntervalSince1970: 1_791_000_000)
        var spoken = item
        spoken.since = FlexibleDate(t0.addingTimeInterval(-120))
        try expectEqual(ListFormatting.accessibilityLabel(spoken, now: t0),
                        "Demo-alpha, approval, waiting 2 minutes, Buy the demo plan, 1 month, $9.99 on the demo store?")
        let n = try NotificationContent.make(for: [item]).unwrapOrThrow()
        try expectEqual(n.title, "Demo-alpha, a Grok bot")
        try expectEqual(n.body, "Asks to buy: Buy the demo plan, 1 month, $9.99 on the demo store?")
        try expectEqual(n.link, DeepLink.session(id: "grok:demo-alpha", host: "local").url)
        try expect(!n.title.contains("\u{2014}") && !n.body.contains("\u{2014}"))
    },
]
