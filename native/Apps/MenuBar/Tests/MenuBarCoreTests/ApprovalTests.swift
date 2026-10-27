import Foundation
import Testing
@testable import MenuBarCore

// Grok bot approvals (CONTRACT.md "Grok bot approvals"): the new fields, the answer route, the row's flow, the
// notification buttons and the wording. Fixtures are synthetic.

private let approvalItemJSON = #"""
{"id":"grok:demo-alpha","name":"Demo-alpha","host":"local","engine":"grok","since":"2026-10-27T09:58:00.000Z",
 "kind":"decision","headline":"Buy the demo plan?","answer":"approval","moreApprovals":1,
 "approval":{"id":"ap_0123456789ab","bot":"grok:demo-alpha","kind":"purchase","question":"Buy the demo plan?",
  "options":[{"n":1,"label":"Buy it"},{"n":"2","label":"Not now"},{"n":"two"},{"n":1,"label":"again"}],
  "details":"Paid with the card on file.","createdAt":"2026-10-27T09:58:00.000Z","expiresAt":"2099-10-28T09:58:00.000Z",
  "untrusted":true}}
"""#

/// The synthetic item, as a summary that marks it `complete` (or not, or as an older daemon that says nothing).
private func approvalItem(complete: Bool? = nil) throws -> WaitingItem {
    let json = complete.map { approvalItemJSON.replacingOccurrences(of: #""untrusted":true"#, with: #""untrusted":true,"complete":\#($0)"#) } ?? approvalItemJSON
    return try JSONDecoder().decode(WaitingItem.self, from: Data(json.utf8))
}

@Suite struct ApprovalDecodingTests {
    @Test func waitingItemCarriesTheRequest() throws {
        let w = try approvalItem()
        #expect(w.kind == .decision, "kind stays decision for older clients")
        #expect(w.answer == .approval)
        #expect(w.moreApprovals == 1)
        let a = try #require(w.approval)
        #expect(a.id == "ap_0123456789ab" && a.bot == "grok:demo-alpha" && a.kind == "purchase")
        #expect(a.options == [ApprovalOption(n: 1, label: "Buy it"), ApprovalOption(n: 2, label: "Not now")])
        #expect(a.details == "Paid with the card on file." && a.expiresDate != nil)
        #expect(w.botName == "Demo-alpha")
        // A dialog's keys and hash never come with it: the row answers by id.
        #expect(AnswerModel.plan(for: w) == .none)
        // complete: missing (an older daemon) or malformed reads as false.
        #expect(a.complete == nil && !a.isComplete)
        #expect(try approvalItem(complete: true).approval?.isComplete == true)
        #expect(try approvalItem(complete: false).approval?.isComplete == false)
        let odd = #"{"id":"ap_1","question":"q","options":[],"complete":"yes"}"#
        #expect(try JSONDecoder().decode(ApprovalInfo.self, from: Data(odd.utf8)).complete == nil)
    }

    @Test func theWholeRequestAsTheReviewGetsIt() throws {
        let json = #"""
        {"keepsBots":true,"items":[{"id":"ap_0123456789ab","status":"decided","kind":"purchase","question":"Buy the demo plan?",
          "options":[{"n":1,"label":"Buy it"}],"details":null,"decision":{"n":1,"label":"Buy it","at":"2026-10-27T10:00:00.000Z","by":"owner"},
          "bot":"grok:demo-alpha","botName":"Demo-alpha","via":"watch","untrusted":true},{"broken":true}]}
        """#
        let lookup = try JSONDecoder().decode(ApprovalLookup.self, from: Data(json.utf8))
        let full = try #require(lookup.items.first)
        #expect(lookup.items.count == 1 && full.status == "decided" && full.decision?.label == "Buy it" && full.via == "watch")
        #expect(full.details == nil)
        #expect(ApprovalFormat.closedText(full) == "Answered already: \"Buy it\" (watch).")
        var w = full
        w.status = "withdrawn"
        #expect(ApprovalFormat.closedText(w) == "The bot withdrew this request.")
        w.status = "pending"
        #expect(ApprovalFormat.closedText(w) == nil)
    }

    @Test func malformedApprovalFieldsAreIgnored() throws {
        let json = #"{"id":"a","name":"demo","host":"local","engine":"grok","kind":"decision","headline":"h","answer":"approval","approval":[1],"moreApprovals":"x"}"#
        let w = try JSONDecoder().decode(WaitingItem.self, from: Data(json.utf8))
        #expect(w.approval == nil && w.moreApprovals == nil && w.answer == .approval)
        let noID = #"{"id":"a","name":"demo","host":"local","engine":"grok","kind":"decision","headline":"h","approval":{"question":"q"}}"#
        #expect(try JSONDecoder().decode(WaitingItem.self, from: Data(noID.utf8)).approval == nil)
    }

    @Test(.enabled(if: SharedFixturesTests.load("native.summary.approval.json") != nil))
    func sharedApprovalSummaryFixture() throws {
        let e = try JSONDecoder().decode(OpEnvelope<Summary>.self, from: #require(SharedFixturesTests.load("native.summary.approval.json")))
        let s = try #require(e.result)
        let bot = try #require(s.waiting.first { $0.approval != nil })
        #expect(bot.answer == .approval && bot.approval?.options.count == 2 && bot.moreApprovals == 1)
        #expect(s.waiting.contains { $0.answer == .reply }, "the session beside it decodes too")
        #expect(BadgeState(summary: s, connection: .live).count == 2)
    }

    @Test(.enabled(if: SharedFixturesTests.load("native.notifications.approval.json") != nil))
    func sharedApprovalNotificationsFixture() throws {
        let e = try JSONDecoder().decode(OpEnvelope<NotificationsPage>.self, from: #require(SharedFixturesTests.load("native.notifications.approval.json")))
        let page = try #require(e.result)
        let n = try #require(page.items.first { $0.approval != nil })
        #expect(n.answer == .approval && n.isNeedsYou && n.approval?.id == "ap_0000000000a1")
        #expect(NotificationPlanner.dialogActions(n).isEmpty, "no dialog keys for a request")
    }

    @Test func summaryWithApprovalRoundTrips() throws {
        var s = Summary.empty
        s.waiting = [try approvalItem()]
        let again = try JSONDecoder().decode(Summary.self, from: JSONEncoder().encode(s))
        #expect(again == s)
    }
}

@Suite struct ApprovalClientTests {
    @Test func postsTheRouteWithTheMainToken() async throws {
        let t = FakeTransport(data: { _ in (200, okBody(#"{"id":"ap_1","status":"decided","decision":{"n":2,"label":"Not now"},"delivery":{"ok":true,"queued":true}}"#)) })
        let r = try await client(t).answerApproval(id: "ap_1", choice: 2)
        #expect(r == .decided(label: "Not now", delivery: ApprovalDelivery(ok: true, queued: true)))
        let req = try #require(t.requests.first)
        #expect(req.url?.absoluteString == "http://127.0.0.1:7337/api/approvals/answer")
        #expect(req.httpMethod == "POST")
        #expect(req.value(forHTTPHeaderField: "Authorization") == "Bearer \(secret)")
        let body = try bodyJSON(req.httpBody)
        #expect(body["id"] as? String == "ap_1" && body["choice"] as? Int == 2 && body["via"] as? String == "menubar")
        #expect(body.count == 3)
        #expect(!(req.url?.absoluteString.contains(secret) ?? true))
        #expect(!String(decoding: req.httpBody ?? Data(), as: UTF8.self).contains(secret))
    }

    @Test func reviewIsAGetWithTheMainToken() async throws {
        let t = FakeTransport(data: { _ in (200, okBody(#"{"keepsBots":true,"items":[{"id":"ap_1","status":"pending","question":"q","options":[{"n":1,"label":"Go"}],"details":"Whole details.","complete":true}]}"#)) })
        let full = try #require(try await client(t).approval(id: "ap_1"))
        #expect(full.details == "Whole details." && full.status == "pending")
        let req = try #require(t.requests.first)
        #expect(req.httpMethod == "GET" && req.httpBody == nil)
        #expect(req.url?.absoluteString == "http://127.0.0.1:7337/api/approvals?id=ap_1")
        #expect(req.value(forHTTPHeaderField: "Authorization") == "Bearer \(secret)")
        let none = FakeTransport(data: { _ in (200, okBody(#"{"keepsBots":true,"items":[]}"#)) })
        #expect(try await client(none).approval(id: "ap_1") == nil)
        let ro = FakeTransport(data: { _ in (403, Data(#"{"ok":false,"error":"widget token: read-only scope"}"#.utf8)) })
        await #expect(throws: DroverError.unauthorized) { _ = try await client(ro).approval(id: "ap_1") }
        await #expect(throws: DroverError.missingToken(.main)) { _ = try await client(t, tokens: [.widget: "w"]).approval(id: "ap_1") }
    }

    @Test func widgetTokenAloneNeverAnswers() async throws {
        let t = FakeTransport(data: { _ in (200, okBody("{}")) })
        await #expect(throws: DroverError.missingToken(.main)) {
            _ = try await client(t, tokens: [.widget: "w"]).answerApproval(id: "ap_1", choice: 1)
        }
        #expect(t.requests.isEmpty)
    }

    @Test func statusesMapAsTheContractSays() throws {
        func r(_ status: Int, _ json: String) throws -> ApprovalAnswerResult {
            try DroverClient.approvalResult(Data(json.utf8), status: status)
        }
        #expect(try r(409, #"{"ok":false,"error":"approval ap_1 was answered already: Buy it (ios)","approval":{}}"#)
                == .closed(message: "approval ap_1 was answered already: Buy it (ios)"))
        #expect(try r(409, "") == .closed(message: "This request is no longer waiting for an answer."))
        #expect(throws: DroverError.server("no approval ap_1 here")) { _ = try r(404, #"{"ok":false,"error":"no approval ap_1 here"}"#) }
        #expect(throws: DroverError.server("choice must be one of its options")) { _ = try r(400, #"{"ok":false,"error":"choice must be one of its options"}"#) }
        #expect(throws: DroverError.unauthorized) { _ = try r(403, #"{"ok":false,"error":"widget token: read-only scope"}"#) }
        #expect(throws: DroverError.unauthorized) { _ = try r(401, #"{"error":"unauthorized"}"#) }
        #expect(throws: DroverError.http(502)) { _ = try r(502, "<html>") }
        #expect(try r(200, #"{"ok":true,"result":{"decision":"odd","delivery":7}}"#) == .decided(label: "", delivery: ApprovalDelivery()))
    }
}

@MainActor
@Suite struct ApprovalStoreTests {
    private func store(_ t: FakeTransport, tokens: [TokenKind: String] = [.main: secret]) -> MenuBarStore {
        MenuBarStore(preferences: { .default }, tokens: StaticTokens(tokens), transport: t)
    }

    nonisolated private static let emptySummary = okBody(#"{"generatedAt":"t","hosts":[],"waiting":[],"working":[],"totals":{"waiting":0,"working":0,"idle":0,"hosts":0}}"#)

    @Test func aCompleteRequestAnswersInOneClickThenRefreshes() async throws {
        let t = FakeTransport(data: { req in
            req.url?.path == "/api/approvals/answer"
                ? (200, okBody(#"{"decision":{"n":1,"label":"Buy it"},"delivery":{"ok":true}}"#))
                : (200, Self.emptySummary)
        })
        let s = store(t)
        let item = try approvalItem(complete: true)
        #expect(s.approvalMode(for: item) == .answer(try #require(item.approval)), "complete, shown whole: one click")
        var long = item
        long.approval?.question = String(repeating: "q", count: 121)
        #expect(s.approvalMode(for: long) == .review, "a question over 120 characters goes through the review")
        var thumbs = item
        thumbs.approval?.question = String(repeating: "\u{1F44D}", count: 61)
        #expect(s.approvalMode(for: thumbs) == .review, "UTF-16 units, as the web board counts")
        await s.answerApproval(item, choice: 1)
        #expect(t.requests.map(\.url?.path) == ["/api/approvals/answer", "/api/op/native.summary"], "answer, then refresh")
        #expect(s.approvalNotice?.text == "Answered \"Buy it\". Demo-alpha is told now." && s.approvalNotice?.isError == false)
        #expect(s.approvalPressing.isEmpty)
        s.dismissApprovalNotice()
        #expect(s.approvalNotice == nil)
    }

    @Test func anAnsweredRequestTheBoardStillListsOffersNoSecondAnswer() async throws {
        let item = try approvalItem(complete: true)
        var stale = Summary.empty
        stale.generatedAt = "t"
        stale.waiting = [item]
        stale.totals.waiting = 1
        let staleBody = okBody(String(decoding: try JSONEncoder().encode(stale), as: UTF8.self))
        let t = FakeTransport(data: { req in
            req.url?.path == "/api/approvals/answer"
                ? (200, okBody(#"{"decision":{"n":1,"label":"Buy it"},"delivery":{"ok":true}}"#))
                : (200, staleBody)
        })
        let s = store(t)
        await s.answerApproval(item, choice: 1)
        #expect(s.approvalMode(for: item) == .closed("Answered \"Buy it\"."), "settled while the board lags")
        await s.answerApproval(item, choice: 2)
        #expect(t.requests.filter { $0.url?.path == "/api/approvals/answer" }.count == 1, "no second answer sent")
    }

    @Test func aShortenedRequestIsReviewedThenAnsweredFromTheWholeOne() async throws {
        let full = #"{"keepsBots":true,"items":[{"id":"ap_0123456789ab","status":"pending","kind":"purchase","question":"Buy the demo plan?","options":[{"n":1,"label":"Buy it"},{"n":2,"label":"Not now"}],"details":"Paid with the card on file. Renews monthly; cancel any time on the demo account page.","bot":"grok:demo-alpha","botName":"Demo-alpha","complete":true}]}"#
        let t = FakeTransport(data: { req in
            switch req.url?.path {
            case "/api/approvals": (200, okBody(full))
            case "/api/approvals/answer": (200, okBody(#"{"decision":{"n":2,"label":"Not now"},"delivery":{"ok":true,"queued":true}}"#))
            default: (200, Self.emptySummary)
            }
        })
        let s = store(t)
        for item in [try approvalItem(complete: false), try approvalItem()] {
            #expect(s.approvalMode(for: item) == .review, "shortened, or an older daemon: review first")
            await s.answerApproval(item, choice: 1)
            #expect(t.requests.isEmpty, "no one-click answer on words that may be shortened")
        }
        let item = try approvalItem(complete: false)
        await s.reviewApproval(item)
        let review = t.requests.first
        #expect(review?.httpMethod == "GET" && review?.url?.absoluteString == "http://127.0.0.1:7337/api/approvals?id=ap_0123456789ab")
        #expect(review?.value(forHTTPHeaderField: "Authorization") == "Bearer \(secret)")
        guard case .answer(let whole)? = s.approvalMode(for: item) else { Issue.record("reviewed: buttons"); return }
        #expect(whole.details == "Paid with the card on file. Renews monthly; cancel any time on the demo account page.")
        await s.answerApproval(item, choice: 2)
        #expect(t.requests.map(\.url?.path) == ["/api/approvals", "/api/approvals/answer", "/api/op/native.summary"])
        #expect(s.approvalNotice?.text == "Answered \"Not now\". Demo-alpha sees it when it checks its inbox.")
        #expect(s.approvalReviews.isEmpty, "the request left the list: its review goes too")
    }

    @Test func aReviewedRequestNoLongerPendingSaysSo() async throws {
        let t = FakeTransport(data: { req in
            req.url?.path == "/api/approvals"
                ? (200, okBody(#"{"keepsBots":true,"items":[{"id":"ap_0123456789ab","status":"decided","question":"q","options":[{"n":1,"label":"Buy it"}],"decision":{"n":1,"label":"Buy it"},"via":"ios"}]}"#))
                : (200, Self.emptySummary)
        })
        let s = store(t)
        let item = try approvalItem(complete: false)
        await s.reviewApproval(item)
        #expect(s.approvalMode(for: item) == .closed("Answered already: \"Buy it\" (ios)."))
        await s.answerApproval(item, choice: 1)
        #expect(t.requests.count == 1, "nothing sent for a decided request")
        let gone = FakeTransport(data: { _ in (200, okBody(#"{"keepsBots":true,"items":[]}"#)) })
        let g = store(gone)
        await g.reviewApproval(item)
        #expect(g.approvalMode(for: item) == .closed("This request is no longer waiting for an answer."))
        let failing = FakeTransport(data: { _ in (502, Data()) })
        let f = store(failing)
        await f.reviewApproval(item)
        #expect(f.approvalReviews["ap_0123456789ab"] == .failed("Could not load the request: The server answered with HTTP 502."))
        #expect(f.approvalMode(for: item) == .review, "still a review to try again")
    }

    @Test func aClosedRequestIsShownAsTheDaemonSaysIt() async throws {
        let t = FakeTransport(data: { req in
            req.url?.path == "/api/approvals/answer"
                ? (409, Data(#"{"ok":false,"error":"approval ap_0123456789ab is withdrawn"}"#.utf8))
                : (200, Self.emptySummary)
        })
        let s = store(t)
        await s.answerApproval(try approvalItem(complete: true), choice: 2)
        #expect(s.approvalNotice == ApprovalNotice(text: "Not answered: approval ap_0123456789ab is withdrawn.", isError: true, at: s.approvalNotice?.at ?? Date()))
        #expect(t.requests.count == 2, "refreshed so the card goes")
    }

    @Test func onlyOfferedOptionsAndOnlyWithTheMainToken() async throws {
        let t = FakeTransport(data: { _ in (200, okBody("{}")) })
        let s = store(t)
        await s.answerApproval(try approvalItem(complete: true), choice: 7)
        #expect(t.requests.isEmpty && s.approvalNotice == nil, "a choice the request does not offer is never sent")
        let ro = store(t, tokens: [.widget: "w"])
        #expect(ro.approvalMode(for: try approvalItem(complete: true)) == .blocked("Add the main token in Settings to answer."))
        await ro.answerApproval(try approvalItem(complete: true), choice: 1)
        await ro.reviewApproval(try approvalItem(complete: false))
        #expect(t.requests.isEmpty, "the widget token never answers or reviews")
        #expect(ro.approvalReviews["ap_0123456789ab"] == .failed("Could not load the request: This needs the main token. Add it in Settings."))
    }
}

@Suite struct ApprovalNotificationTests {
    private func note(host: String = "local", options: String = #"[{"n":1,"label":"Buy it"},{"n":2,"label":"Not now"}]"#,
                      details: String? = nil, complete: String? = "true") throws -> NotificationItem {
        let extra = (details.map { #","details":"\#($0)""# } ?? "") + (complete.map { #","complete":\#($0)"# } ?? "")
        let json = """
        {"id":"n-1","at":"2026-10-27T09:58:00.000Z","kind":"decision","category":"needs-you","title":"Demo-alpha asks for your approval",
         "body":"Buy the demo plan? (Buy it / Not now)","sessionId":"grok:demo-alpha","host":"\(host)","answer":"approval",
         "approval":{"id":"ap_0123456789ab","bot":"grok:demo-alpha","question":"Buy the demo plan?","options":\(options)\(extra)}}
        """
        return try JSONDecoder().decode(NotificationItem.self, from: Data(json.utf8))
    }

    private func plan(_ n: NotificationItem) throws -> PlannedNotification {
        try #require(NotificationPlanner.plan([n], preferences: .default, mutedUntil: nil, now: Date(), alreadyPosted: []).first)
    }

    @Test func aCompleteRequestWithoutDetailsGetsOneButtonPerOptionAndNoReply() throws {
        let p = try plan(try note())
        #expect(!p.canReply && p.actions.isEmpty, "never Reply, which would message the bot")
        #expect(p.approvalActions.map(\.identifier) == ["drover.approval.choice.1", "drover.approval.choice.2"])
        #expect(p.approvalActions.map(\.title) == ["Buy it", "Not now"] && p.approvalActions.map(\.destructive) == [false, true])
        #expect(p.approvalID == "ap_0123456789ab" && p.approvalBot == "Demo-alpha")
        #expect(p.subtitle == "Asked by Demo-alpha, a Grok bot")
        #expect(p.body == "Buy the demo plan?")
        #expect(p.categoryID.hasPrefix(PlannedNotification.approvalCategoryPrefix))
        #expect(p.categoryID != PlannedNotification.waitingCategory)
        #expect(try plan(try note()).categoryID == p.categoryID, "the same options share a category")
    }

    @Test(arguments: [("Card on file.", "true"), (nil, "false"), (nil, nil)] as [(String?, String?)])
    func otherwiseOpenOnly(details: String?, complete: String?) throws {
        // A banner cannot be trusted to show details in full; a shortened or older payload is never answered as shown.
        let p = try plan(try note(details: details, complete: complete))
        #expect(p.approvalActions.isEmpty && p.approvalID == nil && !p.canReply)
        #expect(p.categoryID == PlannedNotification.infoCategory)
        #expect(p.subtitle == "Asked by Demo-alpha, a Grok bot", "still says who asks")
    }

    @Test func anotherHostsRequestGetsOpenOnly() throws {
        let p = try plan(try note(host: "demo-box"))
        #expect(p.approvalActions.isEmpty && p.approvalID == nil && !p.canReply)
        #expect(p.categoryID == PlannedNotification.infoCategory)
    }

    @Test func onlyWhatAnActionShowsWholeAndChoiceParsing() throws {
        let six = (1...6).map { #"{"n":\#($0),"label":"Choice \#($0)"}"# }.joined(separator: ",")
        #expect(try plan(try note(options: "[\(six)]")).approvalActions.isEmpty, "more options than a notification has room for")
        let long = #"[{"n":1,"label":"Restart the build box tonight after the backups"},{"n":2,"label":"Skip"}]"#
        #expect(try plan(try note(options: long)).approvalActions.isEmpty, "a label an action would cut: none, never a cut label")
        let twenty = #"[{"n":1,"label":"Restart the demo box"},{"n":2,"label":"Skip"}]"#
        #expect(try plan(try note(options: twenty)).approvalActions.count == 2, "20 characters are fine")
        let twentyOne = #"[{"n":1,"label":"Restart the demo boxes"},{"n":2,"label":"Skip"}]"#
        #expect(try plan(try note(options: twentyOne)).approvalActions.isEmpty, "over 20: the system cuts action titles")
        let longQuestion = ApprovalInfo(id: "ap_1", question: String(repeating: "q", count: 121), options: [ApprovalOption(n: 1, label: "Go")], complete: true)
        #expect(!ApprovalFormat.answersInNotification(longQuestion), "a question over 120 characters")
        let whole = NotificationPlanner.approvalActions(ApprovalInfo(id: "ap_1", question: "q", options: [ApprovalOption(n: 1, label: String(repeating: "a", count: 60))]))
        #expect(whole.first?.title.count == 60, "labels are never cut")
        #expect(PlannedApprovalAction.choice(fromIdentifier: "drover.approval.choice.3") == 3)
        for id in ["drover.reply", "drover.key.1", "drover.approval.choice.", "drover.approval.choice.0", "drover.approval.choice.x"] {
            #expect(PlannedApprovalAction.choice(fromIdentifier: id) == nil, "\(id)")
        }
        #expect(PlannedAction.key(fromIdentifier: "drover.approval.choice.1") == nil, "not a dialog key either")
    }
}

@Suite struct ApprovalWordingTests {
    @Test func whoAsksAndHowLong() {
        #expect(ApprovalFormat.botName(bot: "grok:alpha") == "Alpha")
        #expect(ApprovalFormat.botName(bot: nil, fallback: "Demo-beta") == "Demo-beta")
        #expect(ApprovalFormat.askedBy("Alpha") == "Alpha, a Grok bot" && ApprovalFormat.askedBy(nil) == "a Grok bot")
        #expect(ApprovalFormat.heading(kind: "purchase") == "Asks to buy" && ApprovalFormat.heading(kind: nil) == "Asks for your approval")
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(ApprovalFormat.standsFor(now.addingTimeInterval(45 * 60), now: now) == "45 min")
        #expect(ApprovalFormat.standsFor(now.addingTimeInterval(6 * 3600), now: now) == "6 h")
        #expect(ApprovalFormat.standsFor(now.addingTimeInterval(7 * 86400), now: now) == "7 days")
        #expect(ApprovalFormat.standsFor(now.addingTimeInterval(-5), now: now) == nil)
        #expect(ApprovalFormat.note(botName: "Alpha", expiresAt: now.addingTimeInterval(6 * 3600), more: 2, now: now)
                == "Asked by Alpha, a Grok bot. These are its words: check them before you answer. Stands for 6 h more. 2 more after this one.")
        #expect(ApprovalFormat.isAnswerable(host: "local") && ApprovalFormat.isAnswerable(host: nil) && !ApprovalFormat.isAnswerable(host: "demo-box"))
        #expect(ApprovalFormat.elsewhere(host: "demo-box") == "demo-box keeps this bot: answer it on demo-box's own Drover board.")
    }

    @Test(arguments: ["Deny", "No", "Not now", "Don't post", "Skip", "never", "Cancel"])
    func negative(_ label: String) { #expect(ApprovalFormat.isNegative(label)) }

    @Test(arguments: ["Approve", "Buy it", "Nothing else", "Notify", "Restart", "Denmark"])
    func notNegative(_ label: String) { #expect(!ApprovalFormat.isNegative(label)) }

    @Test func outcomesInOneLineWithoutEmDashes() {
        let texts = [
            ApprovalFormat.outcome(.success(.decided(label: "Buy it", delivery: ApprovalDelivery(ok: true))), botName: "Alpha"),
            ApprovalFormat.outcome(.success(.decided(label: "Buy it", delivery: ApprovalDelivery(ok: true, queued: true))), botName: "Alpha"),
            ApprovalFormat.outcome(.success(.decided(label: "Buy it", delivery: ApprovalDelivery(ok: false, error: "routine 502"))), botName: nil),
            ApprovalFormat.outcome(.success(.closed(message: "approval ap_1 is expired")), botName: "Alpha"),
            ApprovalFormat.outcome(.failure(DroverError.server("no approval ap_1 here")), botName: "Alpha"),
        ]
        #expect(texts.map(\.text) == [
            "Answered \"Buy it\". Alpha is told now.",
            "Answered \"Buy it\". Alpha sees it when it checks its inbox.",
            "Answered \"Buy it\". The bot was not reached (routine 502); it sees the answer when it checks again.",
            "Not answered: approval ap_1 is expired.",
            "Not answered: no approval ap_1 here.",
        ])
        #expect(texts.map(\.isError) == [false, false, true, true, true])
        #expect(!texts.contains { $0.text.contains("\u{2014}") || $0.text.contains("\u{2013}") })
    }
}
