import Foundation

// Grok bot approvals (CONTRACT.md "Grok bot approvals"): strips and alerts carry the request, a card answers it by
// id, one click only on words shown whole, else a review of the whole request first; notifications never Reply.
@MainActor
enum ApprovalTests {
    static let strip = #"""
    {"key":"local|grok:demo-alpha","id":"grok:demo-alpha","name":"Demo-alpha","host":"local","engine":"grok","lane":"wait",
     "status":"waiting","kind":"session","headline":"Buy the demo plan?","since":"2026-10-27T09:58:00.000Z",
     "ask":{"kind":"decision","label":"asks for your approval","text":"Buy the demo plan?","options":[{"n":1,"label":"Buy it"}]},
     "answer":"approval","moreApprovals":2,
     "approval":{"id":"ap_0123456789ab","bot":"grok:demo-alpha","kind":"purchase","question":"Buy the demo plan?",
      "options":[{"n":1,"label":"Buy it"},{"n":"2","label":"Not now"},{"n":1.5,"label":"half"},{"label":"none"},{"n":1,"label":"again"}],
      "details":"Paid with the card on file.","createdAt":"2026-10-27T09:58:00.000Z","expiresAt":"2099-10-28T09:58:00.000Z",
      "untrusted":true,"complete":true}}
    """#

    static func model(_ service: MockDroverService = MockDroverService()) -> AppModel {
        AppModel(settings: AppSettings(defaults: UserDefaults(suiteName: "harness-\(UUID())")!, group: nil),
                 tokens: MemoryTokenStore("x"), service: service, managerDefaults: UserDefaults(suiteName: "harness-\(UUID())")!)
    }

    static func approval(question: String = "Restart the build box tonight?", details: String? = nil, complete: Bool? = true,
                         labels: [String] = ["Restart", "Skip"], expires: Date = Date(timeIntervalSinceNow: 3600)) -> ApprovalInfo {
        ApprovalInfo(id: "ap_1", bot: "grok:demo-alpha", kind: "action", question: question,
                     options: labels.enumerated().map { ApprovalOption(n: $0.offset + 1, label: $0.element) },
                     details: details, createdAt: nil, expiresAt: expires, complete: complete)
    }

    static func run() async {
        await T.suite("BoardDecoder: approval strips") {
            let s = BoardDecoder.strip(T.json(strip))
            let a = s?.approval
            T.eq(a?.id, "ap_0123456789ab"); T.eq(a?.kind, "purchase"); T.eq(a?.complete, true)
            T.eq(a?.options.map(\.n), [1, 2], "numeric string kept; fractional, missing and repeated numbers dropped")
            T.eq(a?.options.map(\.label), ["Buy it", "Not now"])
            T.eq(a?.details, "Paid with the card on file."); T.check(a?.expiresAt != nil)
            T.eq(s?.answerMode, .approval); T.eq(s?.moreApprovals, 2)
            T.check(s?.answersWithKeys == false, "never the dialog card: answered by id")
            T.eq(s?.keys, [], "no default keys for a request")
            if let s { T.eq(BoardFormat.summaryLine(s), "Buy the demo plan?", "the row shows the question") }
            // complete only as a JSON boolean; missing (an older daemon) or anything else reads as not complete.
            let noComplete = BoardDecoder.approvalInfo(T.json(#"{"id":"ap_1","question":"q","options":[]}"#))
            let odd = BoardDecoder.approvalInfo(T.json(#"{"id":"ap_1","question":"q","options":[],"complete":"true"}"#))
            T.check(noComplete?.isComplete == false && odd?.complete == nil, "missing or malformed: false")
            T.check(BoardDecoder.approvalInfo(T.json(#"{"question":"no id"}"#)) == nil, "an id is required")
            T.check(BoardDecoder.approvalInfo(T.json(#"["not an object"]"#)) == nil)
            let bad = BoardDecoder.strip(T.json(#"{"id":"grok:x","host":"local","lane":"wait","answer":"approval","approval":7}"#))
            T.check(bad != nil && bad?.approval == nil, "a malformed request never drops the strip")
            // The full request as GET /api/approvals?id= gives it.
            let full = BoardDecoder.approvalInfo(T.json(#"""
            {"id":"ap_1","status":"decided","question":"q","options":[{"n":1,"label":"Buy it"}],"details":null,
             "decision":{"n":1,"label":"Buy it","by":"owner"},"via":"ios","botName":"Demo-alpha"}
            """#))
            T.eq(full?.status, "decided"); T.eq(full?.decisionLabel, "Buy it"); T.eq(full?.via, "ios"); T.eq(full?.details, nil)
            if let full { T.eq(ApprovalFormat.closedText(full), "Answered already: \"Buy it\" (ios).") }
            // The shared fixture, as the daemon shapes it.
            let path = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../../../Fixtures/native.board.approval.json").standardizedFileURL
            if let data = try? Data(contentsOf: path), let json = try? JSONValue.parse(data) {
                let snap = BoardDecoder.snapshot(json["result"] ?? .null)
                let bot = snap.sessions.first { $0.approval != nil }
                T.eq(bot?.answerMode, .approval); T.eq(bot?.approval?.options.count, 2); T.eq(bot?.moreApprovals, 1)
                T.check(snap.sessions.contains { $0.answerMode == .reply }, "the session beside it decodes too")
            } else {
                T.fail("Fixtures/native.board.approval.json missing at \(path.path)")
            }
        }

        await T.suite("native.notifications items carry the request") {
            let n = ServerEventMapper.notifyItem(T.json(#"""
            {"id":"ev-1","at":"2026-10-27T09:58:00.000Z","kind":"decision","category":"needs-you","title":"Demo-alpha asks for your approval",
             "body":"Buy? (Buy it / Not now)","sessionId":"grok:demo-alpha","host":"local","answer":"approval",
             "approval":{"id":"ap_1","question":"Buy?","options":[{"n":1,"label":"Buy it"},{"n":2,"label":"Not now"}],"complete":true}}
            """#))
            T.eq(n?.approval?.id, "ap_1"); T.eq(n?.answerMode, .approval); T.eq(n?.keys, [])
        }

        await T.suite("ApprovalFormat.cardMode: one click only on words shown whole") {
            let now = Date()
            func mode(_ a: ApprovalInfo, review: ApprovalReview? = nil, answerable: Bool = true, detailsShown: Bool = true) -> ApprovalCardMode {
                ApprovalFormat.cardMode(summary: a, review: review, answerable: answerable, host: "demo-box", detailsShown: detailsShown, now: now)
            }
            let whole = approval(details: "Tonight at 2 am.")
            T.eq(mode(whole), .answer(whole), "complete, short question, details shown: one click")
            T.eq(mode(whole, detailsShown: false), .review, "a row cannot show the details: review in the chat")
            let plain = approval()
            T.eq(mode(plain, detailsShown: false), .answer(plain), "a row answers a request without details")
            T.eq(mode(approval(complete: false)), .review, "shortened")
            T.eq(mode(approval(complete: nil)), .review, "missing complete reads as false")
            let long = approval(question: String(repeating: "q", count: 121))
            T.eq(mode(long), .review, "a question over 120 characters goes through the review")
            let edge = approval(question: String(repeating: "q", count: 120))
            T.eq(mode(edge), .answer(edge), "120 is fine")
            T.eq(mode(approval(question: String(repeating: "\u{1F44D}", count: 61))), .review,
                 "counted in UTF-16 units, as the web board does: 61 thumbs are 122")
            var full = approval(question: String(repeating: "w", count: 300), details: String(repeating: "d", count: 1500))
            full.status = "pending"
            T.eq(mode(long, review: .loaded(full)), .answer(full), "reviewed: the whole request, however long")
            T.eq(mode(long, review: .loaded(full), detailsShown: false), .review, "a row never answers a reviewed request it cannot show")
            var decided = full; decided.status = "decided"; decided.decisionLabel = "Skip"; decided.via = "web"
            T.eq(mode(long, review: .loaded(decided)), .closed("Answered already: \"Skip\" (web)."))
            T.eq(mode(long, review: .gone), .closed("This request is no longer waiting for an answer."))
            T.eq(mode(long, review: .loading), .review); T.eq(mode(long, review: .failed("x")), .review)
            T.eq(mode(whole, answerable: false), .blocked("demo-box keeps this bot: answer it on demo-box's own Drover board."))
            T.eq(mode(approval(expires: Date(timeIntervalSinceNow: -5))), .blocked("This request expired."))
            T.eq(mode(approval(labels: [])), .blocked("This request offers no options. Answer it on the web board."))
        }

        await T.suite("ApprovalFormat: wording, notification rule") {
            T.check(ApprovalFormat.answersInNotification(approval()), "complete, short, no details, short labels")
            T.check(!ApprovalFormat.answersInNotification(approval(details: "d")), "details: a banner cannot show them whole")
            T.check(!ApprovalFormat.answersInNotification(approval(complete: false)))
            T.check(!ApprovalFormat.answersInNotification(approval(complete: nil)))
            T.check(!ApprovalFormat.answersInNotification(approval(question: String(repeating: "q", count: 121))))
            T.check(!ApprovalFormat.answersInNotification(approval(labels: ["Restart the build box tonight after backups", "Skip"])),
                    "a label a notification action would cut")
            T.check(ApprovalFormat.answersInNotification(approval(labels: [String(repeating: "a", count: 20), "Skip"])), "20 is fine")
            T.check(!ApprovalFormat.answersInNotification(approval(labels: [String(repeating: "a", count: 21), "Skip"])),
                    "over 20 characters: the system cuts action titles")
            T.eq(ApprovalFormat.botName(bot: "grok:alpha"), "Alpha"); T.eq(ApprovalFormat.askedBy(nil), "a Grok bot")
            T.check(ApprovalFormat.isNegative("Not now") && ApprovalFormat.isNegative("Deny") && !ApprovalFormat.isNegative("Nothing"))
            let texts = [
                ApprovalFormat.outcome(.success(.decided(label: "Buy it", delivered: true, queued: false, error: nil)), botName: "Alpha").text,
                ApprovalFormat.outcome(.success(.decided(label: "Buy it", delivered: true, queued: true, error: nil)), botName: "Alpha").text,
                ApprovalFormat.outcome(.success(.decided(label: "Buy it", delivered: false, queued: false, error: "routine 502")), botName: nil).text,
                ApprovalFormat.outcome(.success(.closed(message: "approval ap_1 is expired")), botName: "Alpha").text,
                ApprovalFormat.outcome(.failure(DroverError.server("no approval ap_1 here")), botName: "Alpha").text,
            ]
            T.eq(texts, ["Answered \"Buy it\". Alpha is told now.", "Answered \"Buy it\". Alpha sees it when it checks its inbox.",
                         "Answered \"Buy it\". The bot was not reached (routine 502); it sees the answer when it checks again.",
                         "Not answered: approval ap_1 is expired.", "Not answered: no approval ap_1 here."])
            T.check(!(texts + [ApprovalFormat.reviewNote, ApprovalFormat.detailsInChatNote]).contains { $0.contains("\u{2014}") || $0.contains("\u{2013}") }, "no em dash")
        }

        await T.suite("LiveDroverService.approvalResult") {
            func r(_ status: Int, _ json: String) -> Result<ApprovalAnswerResult, Error> {
                Result { try LiveDroverService.approvalResult(data: Data(json.utf8), status: status) }
            }
            T.eq(try? r(200, #"{"ok":true,"result":{"decision":{"n":2,"label":"Not now"},"delivery":{"ok":true,"queued":true}}}"#).get(),
                 .decided(label: "Not now", delivered: true, queued: true, error: nil))
            T.eq(try? r(200, #"{"ok":true,"result":{"decision":{"label":"Go"},"delivery":{"ok":false,"error":"routine 502"}}}"#).get(),
                 .decided(label: "Go", delivered: false, queued: false, error: "routine 502"))
            T.eq(try? r(409, #"{"ok":false,"error":"approval ap_1 was answered already: Go (ios)"}"#).get(), .closed(message: "approval ap_1 was answered already: Go (ios)"))
            T.eq(try? r(409, "").get(), .closed(message: "This request is no longer waiting for an answer."))
            func error(_ status: Int, _ json: String) -> DroverError? {
                if case .failure(let e) = r(status, json) { return e as? DroverError }
                return nil
            }
            T.eq(error(404, #"{"ok":false,"error":"no approval ap_1 here"}"#), .server("no approval ap_1 here"))
            T.eq(error(400, #"{"ok":false,"error":"choice must be one of its options"}"#), .server("choice must be one of its options"))
            T.eq(error(401, #"{"error":"unauthorized"}"#), .unauthorized)
            T.eq(error(403, #"{"ok":false,"error":"widget token: read-only scope"}"#), .server("This token is read-only. Use the main token in Settings"))
            T.eq(error(502, "<html>"), .http(502, nil))
        }

        await T.suite("NotificationContentBuilder: approval alerts") {
            func item(_ a: ApprovalInfo, host: String? = "local") -> NotifyItem {
                NotifyItem(id: "n1", at: Date(), category: .needsYou, kind: "decision", title: "Demo-alpha asks for your approval",
                           body: "Restart? (Restart / Skip)", sessionId: "grok:demo-alpha", host: host, tmuxTarget: nil,
                           answerMode: .approval, approval: a)
            }
            let c = NotificationContentBuilder.content(for: item(approval()))
            T.eq(c.actions.map(\.id), ["approval:1", "approval:2"]); T.eq(c.actions.map(\.title), ["Restart", "Skip"])
            T.eq(c.actions.map(\.destructive), [false, true]); T.check(c.answersApproval, "Open only besides, never Reply")
            T.check(c.categoryId.hasPrefix("drover.approval.")); T.eq(c.userInfo["approvalId"], "ap_1"); T.eq(c.userInfo["approvalBot"], "Demo-alpha")
            T.eq(c.subtitle, "Asked by Demo-alpha, a Grok bot"); T.eq(c.body, "Restart the build box tonight?")
            T.eq(NotificationContentBuilder.content(for: item(approval())).categoryId, c.categoryId, "the same options share a category")
            // An approval alert whose request did not decode: Open only, never the session category with Reply.
            let bare = NotifyItem(id: "n2", at: Date(), category: .needsYou, kind: "decision", title: "Demo-alpha asks for your approval",
                                  body: "Restart?", sessionId: "grok:demo-alpha", host: "local", tmuxTarget: nil, answerMode: .approval, approval: nil)
            let bc = NotificationContentBuilder.content(for: bare)
            T.eq(bc.categoryId, "drover.info", "undecoded approval: no Reply"); T.check(bc.actions.isEmpty, "no buttons")
            for (a, why) in [(approval(details: "after the backups"), "details"), (approval(complete: false), "shortened"),
                             (approval(complete: nil), "an older daemon")] {
                let o = NotificationContentBuilder.content(for: item(a))
                T.check(o.actions.isEmpty && o.categoryId == "drover.info" && !o.answersApproval && o.userInfo["approvalId"] == nil, "Open only: \(why)")
                T.eq(o.subtitle, "Asked by Demo-alpha, a Grok bot")
            }
            T.eq(NotificationContentBuilder.content(for: item(approval(details: "after the backups"))).body, "Restart the build box tonight?\nafter the backups")
            T.eq(NotificationContentBuilder.content(for: item(approval(), host: "demo-box")).categoryId, "drover.info", "another host's request")
            T.eq(NotificationContentBuilder.approvalChoice(fromAction: "approval:2"), 2)
            T.eq(NotificationContentBuilder.approvalChoice(fromAction: "approval:0"), nil); T.eq(NotificationContentBuilder.key(fromAction: "approval:2"), nil)
        }

        await T.suite("NotificationResponseRoute: approval actions") {
            let info = NotificationAction(sessionId: "grok:demo-alpha", host: "local", server: "http://a", approvalId: "ap_1", approvalBot: "Demo-alpha")
            T.eq(NotificationResponseRoute.decide(action: "approval:2", info: info, text: nil, activeServer: "http://a"), .approve(choice: 2))
            T.eq(NotificationResponseRoute.decide(action: "approval:2", info: info, text: nil, activeServer: "http://b"), .refuse, "another server")
            var none = info; none.approvalId = nil
            T.eq(NotificationResponseRoute.decide(action: "approval:1", info: none, text: nil, activeServer: "http://a"), .open, "no request id: open")
            T.eq(NotificationAction(["approvalId": "ap_9", "approvalBot": "Alpha"]).approvalId, "ap_9")
        }

        await T.suite("AppModel: review, then answer by id") {
            let service = MockDroverService()
            let m = model(service)
            var shortened = MockDroverService.approvalSession
            shortened.approval?.complete = false
            m.apply(board: BoardSnapshot(generatedAt: Date(), hosts: [], sessions: [shortened], usedNativeSummary: true, source: .board))
            let s = m.board.sessions[0]
            T.eq(m.approvalMode(for: s), .review, "shortened: review first")
            await m.answerApproval(s, choice: 1)
            T.eq(service.messagesSent, [], "no click on words that may be shortened")
            await m.reviewApproval(s)
            guard case .answer(let full)? = m.approvalMode(for: s) else { T.fail("reviewed: buttons"); return }
            T.check((full.details?.count ?? 0) > (s.approval?.details?.count ?? 0), "the whole details")
            T.eq(m.approvalMode(for: s, detailsShown: false), .review, "the board row still sends it to the chat")
            await m.answerApproval(s, choice: 1)
            T.eq(service.messagesSent, ["review ap_00000000demo", "approve ap_00000000demo 1"])
            T.eq(m.toast?.text, "Answered \"Buy it\". Demo-alpha is told now."); T.eq(m.toast?.kind, .info)
            T.eq(m.answering[s.key], nil)
            // The board still shows it (a daemon's board can lag an answer): no buttons invite a second answer.
            T.eq(m.approvalMode(for: s), .closed("Answered \"Buy it\"."), "settled until the board drops it")
            await m.answerApproval(s, choice: 2)
            T.eq(service.messagesSent.count, 2, "no second answer sent")
            // An unknown request: closed, said as the daemon says it.
            var other = MockDroverService.approvalSession
            other.approval?.id = "ap_00000000dead"
            other.approval?.complete = true
            other.approval?.details = nil
            m.apply(board: BoardSnapshot(generatedAt: Date(), hosts: [], sessions: [other], usedNativeSummary: true, source: .board))
            await m.answerApproval(m.board.sessions[0], choice: 2)
            T.eq(m.toast?.text, "Not answered: approval ap_00000000dead was answered already: Not now (web)."); T.eq(m.toast?.kind, .error)
            T.check(m.approvalReviews.isEmpty, "reviews of requests the board no longer shows go")
            T.eq(m.approvalMode(for: m.board.sessions[0]), .closed("Not answered: approval ap_00000000dead was answered already: Not now (web)."))
            // Another host keeps its own requests.
            var remote = other; remote.host = "demo-box"; remote.approval?.id = "ap_00000000beef"
            T.eq(m.approvalMode(for: remote), .blocked("demo-box keeps this bot: answer it on demo-box's own Drover board."))
        }
    }
}
