import Foundation

// Logic tests of Grok bot approvals: decoding, the answer request, the outcome wording, notification buttons.
extension Suites {
    static var approvalSuites: [(String, () async throws -> Void)] {
        [("approval decoding", approvalDecoding), ("approval request", approvalRequest),
         ("approval http", approvalHTTP), ("approval wording", approvalWording),
         ("approval notifications", approvalNotifications), ("approval model", approvalModel)]
    }

    static let approvalSummaryJSON = """
    {"generatedAt":"2026-10-27T10:00:00.000Z","hosts":[{"name":"local","up":true,"waiting":2,"working":0,"idle":0}],
     "waiting":[
      {"id":"grok:demo-alpha","name":"Demo-alpha","host":"local","engine":"grok","since":"2026-10-27T09:58:00.000Z",
       "kind":"decision","headline":"Buy the demo plan?","answer":"approval","moreApprovals":2,
       "approval":{"id":"ap_0123456789ab","bot":"grok:demo-alpha","kind":"purchase","question":"Buy the demo plan?",
        "options":[{"n":1,"label":"Buy it"},{"n":"2","label":"Not now"},{"n":"x","label":"bad"},{"label":"no n"},{"n":1,"label":"dupe"}],
        "details":"Paid with the card on file.","createdAt":"2026-10-27T09:58:00.000Z","expiresAt":"2026-10-28T09:58:00.000Z",
        "untrusted":true}},
      {"id":"s-demo-build","name":"demo-build","host":"local","engine":"claude","kind":"decision","headline":"Allow?",
       "answer":"keys","approval":"not an object","moreApprovals":"two"}],
     "working":[],"totals":{"waiting":2,"working":0,"idle":0,"hosts":1},"manager":{"up":false,"lastNoteAt":null}}
    """

    static func approvalDecoding() throws {
        let s = try decode(NativeSummary.self, approvalSummaryJSON)
        expect(s.waiting.count == 2, "both waiting items decode")
        let w = s.waiting[0]
        expect(w.answer == "approval" && w.kind == "decision" && w.engine == .grok && w.moreApprovals == 2, "answer, kind, engine, more")
        let a = w.approval
        expect(a?.id == "ap_0123456789ab" && a?.bot == "grok:demo-alpha" && a?.kind == "purchase", "approval id, bot, kind")
        expect(a?.options == [.init(n: 1, label: "Buy it"), .init(n: 2, label: "Not now")],
               "numeric string n kept, malformed and duplicate options dropped: \(a?.options ?? [])")
        expect(a?.details == "Paid with the card on file." && a?.untrusted == true, "details and untrusted")
        expect(a?.expiresAt?.date == LooseDate.parse("2026-10-28T09:58:00.000Z"), "expiry")
        expect(w.botName == "Demo-alpha", "bot name from grok:<name>")
        let other = s.waiting[1]
        expect(other.approval == nil && other.moreApprovals == nil && other.answer == "keys", "malformed answer fields ignored")
        // The widget cache file is re-encoded from the model: it round-trips with the new fields.
        let rt = try JSONDecoder().decode(NativeSummary.self, from: JSONEncoder().encode(s))
        expect(rt == s, "summary with an approval round-trips")

        // An approval without an id (or not an object) is absent, the item still decodes.
        let noID = try decode(NativeSummary.WaitingItem.self, #"{"id":"grok:x","approval":{"question":"q","options":[]}}"#)
        expect(noID.approval == nil && noID.id == "grok:x", "approval without id dropped")
        let empty = try decode(NativeSummary.WaitingItem.self, #"{"id":"grok:x","approval":{"id":""}}"#)
        expect(empty.approval == nil, "empty approval id dropped")
        let bare = try decode(NativeSummary.WaitingItem.self, #"{"id":"grok:x","approval":{"id":"ap_1"}}"#)
        expect(bare.approval?.question == "" && bare.approval?.options.isEmpty == true, "an id is all it needs")
        // Older shapes keep decoding exactly as before.
        let old = try decode(NativeSummary.WaitingItem.self, #"{"id":"abc","name":"demo","since":1791000000000,"kind":"question"}"#)
        expect(old.answer == nil && old.approval == nil && old.since != nil, "older item")

        // complete: missing (an older daemon) reads as false; a malformed one too.
        expect(a?.complete == nil && a?.isComplete == false, "no complete: not answered as shown")
        let whole = try decode(ApprovalRequest.self, #"{"id":"ap_1","question":"q","options":[],"complete":true}"#)
        let odd = try decode(ApprovalRequest.self, #"{"id":"ap_1","question":"q","options":[],"complete":"yes"}"#)
        expect(whole.isComplete && !odd.isComplete && odd.complete == nil, "complete true, and a malformed one")
        // The full request as GET /api/approvals?id= gives it (core/bots/approvals.js ownerView).
        let lookup = try decode(ApprovalLookup.self, """
        {"keepsBots":true,"items":[{"id":"ap_0123456789ab","status":"decided","kind":"purchase","question":"Buy the demo plan?",
          "options":[{"n":1,"label":"Buy it"},{"n":2,"label":"Not now"}],"details":null,"createdAt":"2026-10-27T09:58:00.000Z",
          "expiresAt":"2026-10-28T09:58:00.000Z","decision":{"n":2,"label":"Not now","at":"2026-10-27T10:00:00.000Z","by":"owner"},
          "bot":"grok:demo-alpha","botName":"Demo-alpha","via":"ios","source":"grok:demo-alpha","untrusted":true}, {"no":"id"}]}
        """)
        let full = lookup.items.first
        expect(lookup.keepsBots == true && lookup.items.count == 1, "one request, the malformed entry dropped")
        expect(full?.status == "decided" && full?.botName == "Demo-alpha" && full?.decision?.label == "Not now" && full?.via == "ios",
               "status, name, answer, via")
        expect(full?.details == nil, "details null reads as none")
        expect(full.flatMap(ApprovalFormat.closedText) == "Answered already: \"Not now\" (ios).", "what it says")

        let feed = try decode(NotificationFeed.self, """
        {"cursor":"c1.x","items":[
         {"id":"n1","at":"2026-10-27T09:58:00.000Z","kind":"decision","category":"needs-you","title":"Demo-alpha asks for your approval",
          "body":"Buy the demo plan? (Buy it / Not now)","sessionId":"grok:demo-alpha","host":"local","answer":"approval",
          "approval":{"id":"ap_0123456789ab","bot":"grok:demo-alpha","kind":"purchase","question":"Buy the demo plan?",
           "options":[{"n":1,"label":"Buy it"},{"n":2,"label":"Not now"}],"untrusted":true}},
         {"id":"n2","title":"t","approval":["bad"],"answer":7}]}
        """)
        expect(feed.items.count == 2, "feed decodes")
        expect(feed.items[0].approval?.options.count == 2 && feed.items[0].answer == "approval", "feed item approval")
        expect(feed.items[1].approval == nil && feed.items[1].answer == nil, "malformed feed fields ignored")
    }

    static func approvalRequest() throws {
        let base = URL(string: "http://127.0.0.1:7337")!
        let req = try HTTPDroverAPI.approvalAnswerRequest(baseURL: base, token: "tok-SECRET-1", id: "ap_0123456789ab", choice: 2, via: "ios")
        expect(req.url?.absoluteString == "http://127.0.0.1:7337/api/approvals/answer", "route, not an op: \(req.url?.absoluteString ?? "")")
        expect(req.httpMethod == "POST", "POST")
        expect(req.value(forHTTPHeaderField: "Authorization") == "Bearer tok-SECRET-1", "bearer header")
        expect(req.value(forHTTPHeaderField: "Content-Type") == "application/json", "json body")
        let body = try JSONSerialization.jsonObject(with: req.httpBody ?? Data()) as? [String: Any]
        expect(body?["id"] as? String == "ap_0123456789ab" && body?["choice"] as? Int == 2 && body?["via"] as? String == "ios"
               && body?.count == 3, "body is {id, choice, via}")
        expect(!(req.url?.absoluteString.contains("SECRET") ?? true), "no token in the URL")
        expect(!(String(data: req.httpBody ?? Data(), encoding: .utf8) ?? "SECRET").contains("SECRET"), "no token in the body")
        let path = try HTTPDroverAPI.approvalAnswerRequest(baseURL: URL(string: "https://box.example.ts.net:8446/drover")!,
                                                           token: "t", id: "ap_1", choice: 1, via: "ios-notification")
        expect(path.url?.absoluteString == "https://box.example.ts.net:8446/drover/api/approvals/answer", "base path kept")

        func result(_ json: String, _ status: Int) throws -> ApprovalAnswerResult {
            try HTTPDroverAPI.approvalAnswerResult(Data(json.utf8), status: status)
        }
        let ok = try result(#"{"ok":true,"result":{"id":"ap_1","status":"decided","decision":{"n":2,"label":"Not now","at":"2026-10-27T10:00:00.000Z","by":"owner","via":"ios"},"delivery":{"ok":true,"queued":true,"via":"inbox"}}}"#, 200)
        expect(ok == .decided(label: "Not now", delivery: ApprovalDelivery(ok: true, queued: true, error: nil)), "200 decided")
        let odd = try result(#"{"ok":true,"result":{"decision":"weird","delivery":[1]}}"#, 200)
        expect(odd == .decided(label: "", delivery: ApprovalDelivery()), "odd result fields read as absent")
        let closed = try result(#"{"ok":false,"error":"approval ap_1 was answered already: Approve (web)","approval":{"id":"ap_1"}}"#, 409)
        expect(closed == .closed(message: "approval ap_1 was answered already: Approve (web)"), "409 closed with the daemon's words")
        let bodiless = try result("", 409)
        expect(bodiless == .closed(message: "This request is no longer waiting for an answer."), "409 without a body")
        func throwsError(_ json: String, _ status: Int) -> DroverError? {
            do { _ = try result(json, status); return nil } catch { return error as? DroverError }
        }
        expect(throwsError(#"{"ok":false,"error":"no approval ap_1 here"}"#, 404) == .server("no approval ap_1 here"), "404 says why")
        expect(throwsError(#"{"ok":false,"error":"choice must be the number of one of its options: 1 Buy it, 2 Not now"}"#, 400)
               == .server("choice must be the number of one of its options: 1 Buy it, 2 Not now"), "400 says why")
        expect(throwsError(#"{"ok":false,"error":"widget token: read-only scope"}"#, 403) == .forbidden, "403 widget token")
        expect(throwsError(#"{"error":"unauthorized"}"#, 401) == .unauthorized, "401")
        expect(throwsError("<html>", 502) == .http(502), "502 without JSON")
        expect(throwsError(#"{"ok":false,"error":"boom"}"#, 200) == .server("boom"), "200 with ok false")
    }

    /// The live client against a stubbed URLSession: the request it sends and what it makes of the answers.
    static func approvalHTTP() async throws {
        let api = HTTPDroverAPI(baseURL: URL(string: "http://127.0.0.1:7337")!, token: { "tok-SECRET-2" },
                                session: ApprovalStub.session())
        ApprovalStub.reply = (200, #"{"ok":true,"result":{"id":"ap_1","status":"decided","decision":{"n":1,"label":"Buy it"},"delivery":{"ok":true}}}"#)
        let r = try await api.answerApproval(id: "ap_1", choice: 1, via: DroverIDs.actor)
        expect(r == .decided(label: "Buy it", delivery: ApprovalDelivery(ok: true)), "decided over HTTP")
        let sent = ApprovalStub.recorded.last
        expect(sent?.url == "http://127.0.0.1:7337/api/approvals/answer" && sent?.method == "POST", "sent to the route")
        expect(sent?.auth == "Bearer tok-SECRET-2", "with the main token")
        let body = try JSONSerialization.jsonObject(with: sent?.body ?? Data()) as? [String: Any]
        expect(body?["via"] as? String == "ios" && body?["choice"] as? Int == 1, "via ios")
        ApprovalStub.reply = (409, #"{"ok":false,"error":"approval ap_1 is expired","approval":{"id":"ap_1","status":"expired"}}"#)
        let late = try await api.answerApproval(id: "ap_1", choice: 1, via: DroverIDs.notificationVia)
        expect(late == .closed(message: "approval ap_1 is expired"), "409 over HTTP is a result")
        let body2 = try JSONSerialization.jsonObject(with: ApprovalStub.recorded.last?.body ?? Data()) as? [String: Any]
        expect(body2?["via"] as? String == "ios-notification", "notification via")
        // The review: GET /api/approvals?id=, main token, the one request or nil.
        let lookupReq = HTTPDroverAPI.approvalLookupRequest(baseURL: URL(string: "http://127.0.0.1:7337")!, token: "tok-SECRET-2", id: "ap_1")
        expect(lookupReq.url?.absoluteString == "http://127.0.0.1:7337/api/approvals?id=ap_1" && lookupReq.httpMethod == "GET"
               && lookupReq.httpBody == nil, "GET with the id in the query")
        expect(lookupReq.value(forHTTPHeaderField: "Authorization") == "Bearer tok-SECRET-2", "bearer header, not the URL")
        ApprovalStub.reply = (200, #"{"ok":true,"result":{"keepsBots":true,"items":[{"id":"ap_1","status":"pending","question":"Restart?","options":[{"n":1,"label":"Restart"}],"details":"Tonight at 2 am, after the backups.","complete":true}]}}"#)
        let found = try await api.approval(id: "ap_1")
        expect(found?.id == "ap_1" && found?.status == "pending" && found?.details == "Tonight at 2 am, after the backups.", "the whole request")
        expect(ApprovalStub.recorded.last?.method == "GET" && ApprovalStub.recorded.last?.url == "http://127.0.0.1:7337/api/approvals?id=ap_1", "sent as GET")
        ApprovalStub.reply = (200, #"{"ok":true,"result":{"keepsBots":true,"items":[]}}"#)
        let missing = try await api.approval(id: "ap_1")
        expect(missing == nil, "not kept here: nil")
        ApprovalStub.reply = (403, #"{"ok":false,"error":"widget token: read-only scope"}"#)
        do { _ = try await api.approval(id: "ap_1"); expect(false, "403 throws") }
        catch { expect((error as? DroverError) == .forbidden, "the widget token cannot review") }
        let none = HTTPDroverAPI(baseURL: URL(string: "http://127.0.0.1:7337")!, token: { nil }, session: ApprovalStub.session())
        let before = ApprovalStub.recorded.count
        do { _ = try await none.answerApproval(id: "ap_1", choice: 1, via: "ios"); expect(false, "no token throws") }
        catch { expect((error as? DroverError) == .notConfigured && ApprovalStub.recorded.count == before, "no token, no request") }
        do { _ = try await UnconfiguredDroverAPI().answerApproval(id: "ap_1", choice: 1, via: "ios"); expect(false, "unconfigured throws") }
        catch { expect((error as? DroverError) == .notConfigured, "unconfigured never answers") }
    }

    static func approvalWording() {
        expect(ApprovalFormat.botName(bot: "grok:alpha") == "Alpha", "grok:alpha")
        expect(ApprovalFormat.botName(bot: "GROK:demo-beta") == "Demo-beta", "prefix case")
        expect(ApprovalFormat.botName(bot: nil, fallback: "Demo-gamma") == "Demo-gamma", "fallback to the item name")
        expect(ApprovalFormat.botName(bot: "  ", fallback: nil) == nil, "nothing to name")
        expect(ApprovalFormat.askedBy("Alpha") == "Alpha, a Grok bot" && ApprovalFormat.askedBy(nil) == "a Grok bot", "asked by")
        expect(ApprovalFormat.heading(kind: "purchase") == "Asks to buy" && ApprovalFormat.heading(kind: "post") == "Asks for your approval", "heading")
        expect(ApprovalFormat.title(.init(n: 3, label: "  ")) == "Option 3", "label fallback")
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        expect(ApprovalFormat.standsFor(now.addingTimeInterval(40 * 60), now: now) == "40 min", "minutes")
        expect(ApprovalFormat.standsFor(now.addingTimeInterval(20), now: now) == "1 min", "at least a minute")
        expect(ApprovalFormat.standsFor(now.addingTimeInterval(5 * 3600), now: now) == "5 h", "hours")
        expect(ApprovalFormat.standsFor(now.addingTimeInterval(3 * 86400), now: now) == "3 days", "days")
        expect(ApprovalFormat.standsFor(now.addingTimeInterval(-1), now: now) == nil && ApprovalFormat.standsFor(nil, now: now) == nil, "expired, none")
        let note = ApprovalFormat.note(botName: "Alpha", expiresAt: now.addingTimeInterval(5 * 3600), more: 2, now: now)
        expect(note == "Asked by Alpha, a Grok bot. These are its words: check them before you answer. Stands for 5 h more. 2 more after this one.", note)
        expect(ApprovalFormat.note(botName: nil, expiresAt: nil, more: 0, now: now)
               == "Asked by a Grok bot. These are its words: check them before you answer.", "short note")
        expect(ApprovalFormat.isAnswerable(host: nil) && ApprovalFormat.isAnswerable(host: "local") && ApprovalFormat.isAnswerable(host: ""),
               "the daemon's own bots")
        expect(!ApprovalFormat.isAnswerable(host: "demo-box"), "another host keeps its own requests")
        expect(ApprovalFormat.elsewhere(host: "demo-box") == "demo-box keeps this bot: answer it on demo-box's own Drover board.", "elsewhere")
        for l in ["Deny", "No", "no, thanks", "Not now", "Don't buy", "Do not post", "Skip", "Reject", "Cancel it", "never"] {
            expect(ApprovalFormat.isNegative(l), "negative: \(l)")
        }
        for l in ["Approve", "Buy it", "Nothing to add", "Notify me", "Restart", "Yes", "Denmark"] {
            expect(!ApprovalFormat.isNegative(l), "not negative: \(l)")
        }
        let told = ApprovalFormat.outcome(.success(.decided(label: "Buy it", delivery: ApprovalDelivery(ok: true))), botName: "Alpha")
        expect(told.text == "Answered \"Buy it\". Alpha is told now." && !told.isError, told.text)
        let queued = ApprovalFormat.outcome(.success(.decided(label: "Buy it", delivery: ApprovalDelivery(ok: true, queued: true))), botName: "Alpha")
        expect(queued.text == "Answered \"Buy it\". Alpha sees it when it checks its inbox." && !queued.isError, queued.text)
        let missed = ApprovalFormat.outcome(.success(.decided(label: "Buy it", delivery: ApprovalDelivery(ok: false, error: "routine 502"))), botName: nil)
        expect(missed.text == "Answered \"Buy it\". The bot was not reached (routine 502); it sees the answer when it checks again." && missed.isError, missed.text)
        let closed = ApprovalFormat.outcome(.success(.closed(message: "approval ap_1 is withdrawn")), botName: "Alpha")
        expect(closed.text == "Not answered: approval ap_1 is withdrawn." && closed.isError, closed.text)
        let failed = ApprovalFormat.outcome(.failure(DroverError.server("no approval ap_1 here")), botName: "Alpha")
        expect(failed.text == "Not answered: no approval ap_1 here." && failed.isError, failed.text)
        let all = [told.text, queued.text, missed.text, closed.text, failed.text, note, ApprovalFormat.elsewhere(host: "x")]
        expect(!all.contains { $0.contains("\u{2014}") || $0.contains("\u{2013}") }, "no em or en dashes in the copy")
        let item = try? decode(NativeSummary.self, approvalSummaryJSON).waiting
        expect(item.map { $0.map(BoardFormat.waitingLabel) } == ["Approval", "Decision"], "board badge")
    }

    static func approvalNotifications() throws {
        let feed = try decode(NotificationFeed.self, """
        {"cursor":"c2","items":[
         {"id":"n1","kind":"decision","category":"needs-you","title":"Demo-alpha asks for your approval","body":"Buy? (Buy it / Not now)",
          "sessionId":"grok:demo-alpha","host":"local","answer":"approval",
          "approval":{"id":"ap_0123456789ab","bot":"grok:demo-alpha","question":"Buy the demo plan?","complete":true,
           "options":[{"n":1,"label":"Buy it"},{"n":2,"label":"Not now"}]}},
         {"id":"n2","kind":"decision","category":"needs-you","title":"Demo-beta asks for your approval","sessionId":"grok:demo-beta",
          "host":"demo-box","answer":"approval","approval":{"id":"ap_00000000beef","bot":"grok:demo-beta","question":"Post it?",
           "complete":true,"options":[{"n":1,"label":"Post"},{"n":2,"label":"Deny"}]}},
         {"id":"n3","kind":"decision","category":"needs-you","title":"Demo-gamma asks","sessionId":"grok:demo-gamma","host":"local",
          "approval":{"id":"ap_00000000cafe","question":"Q","complete":true,"options":[{"n":1,"label":"Buy it"},{"n":2,"label":"Not now"}]}},
         {"id":"n4","kind":"decision","category":"needs-you","title":"demo-build needs you","sessionId":"s1","host":"local"},
         {"id":"n5","kind":"decision","category":"needs-you","title":"Demo-alpha asks for your approval","sessionId":"grok:demo-alpha",
          "host":"local","approval":{"id":"ap_0000000000d5","question":"Buy it?","details":"Card on file.","complete":true,
           "options":[{"n":1,"label":"Buy it"},{"n":2,"label":"Not now"}]}},
         {"id":"n6","kind":"decision","category":"needs-you","title":"Demo-alpha asks for your approval","sessionId":"grok:demo-alpha",
          "host":"local","approval":{"id":"ap_0000000000d6","question":"Buy it?","complete":false,
           "options":[{"n":1,"label":"Buy it"},{"n":2,"label":"Not now"}]}},
         {"id":"n7","kind":"decision","category":"needs-you","title":"Demo-alpha asks for your approval","sessionId":"grok:demo-alpha",
          "host":"local","approval":{"id":"ap_0000000000d7","question":"Buy it?","options":[{"n":1,"label":"Buy it"},{"n":2,"label":"Not now"}]}}]}
        """)
        let plan = NotificationPlan.make(feed: feed, storedCursor: "c1", mutedKinds: [], postedRing: [])
        expect(plan.notifications.count == 7, "all seven planned")
        let a = plan.notifications[0]
        expect(a.subtitle == "Asked by Demo-alpha, a Grok bot", "who asks: \(a.subtitle ?? "-")")
        expect(a.body == "Buy the demo plan?", "the question: \(a.body)")
        expect(a.approvalID == "ap_0123456789ab" && a.approvalBot == "Demo-alpha" && a.sessionId == "grok:demo-alpha", "answers by id")
        expect(a.actions.map(\.identifier) == ["drover.approval.choice.1", "drover.approval.choice.2"], "complete, no details: one action per option")
        expect(a.actions.map(\.title) == ["Buy it", "Not now"] && a.actions.map(\.destructive) == [false, true], "titles, destructive")
        expect(a.categoryID.hasPrefix(NotificationPlan.approvalCategoryPrefix) && a.categoryID != NotificationPlan.sessionCategory,
               "its own category, never the one with Reply")
        expect(a.playsSound, "a decision plays the sound")
        let remote = plan.notifications[1]
        expect(remote.actions.isEmpty && remote.approvalID == nil && remote.categoryID == NotificationPlan.infoCategory,
               "another host's request: Open only, no buttons that would 404, no Reply")
        expect(remote.subtitle == "Asked by Demo-beta, a Grok bot", "still says who asks")
        expect(plan.notifications[2].categoryID == a.categoryID, "same options share a category")
        expect(plan.notifications[3].categoryID == NotificationPlan.sessionCategory && plan.notifications[3].actions.isEmpty, "others unchanged")
        // A banner cannot be trusted to show details in full, and a shortened or older payload is never answered as shown:
        // no buttons, Open only, and a tap opens the app reviewing the whole request (approvalId in userInfo).
        for (i, why) in [(4, "complete, with details"), (5, "complete false"), (6, "complete missing")] {
            let n = plan.notifications[i]
            expect(n.actions.isEmpty && n.categoryID == NotificationPlan.infoCategory, "no buttons: \(why)")
            expect(n.approvalID != nil && n.subtitle != nil, "reviewed on tap: \(why)")
        }
        expect(plan.notifications[4].body == "Buy it?\nCard on file.", "details still in the body")
        expect(NotificationPlan.answersInNotification(ApprovalRequest(id: "x", question: "q", options: [], complete: true)), "the rule")
        expect(!NotificationPlan.answersInNotification(ApprovalRequest(id: "x", question: "q", options: [], details: "d", complete: true)), "details")
        expect(!NotificationPlan.answersInNotification(ApprovalRequest(id: "x", question: "q", options: [])), "missing complete")
        let other = NotificationPlan.approvalActions(ApprovalRequest(id: "x", question: "q", options: [.init(n: 1, label: "Restart"), .init(n: 2, label: "Skip")]))
        expect(NotificationPlan.approvalCategory(other) != a.categoryID, "other options, other category")
        let many = ApprovalRequest(id: "x", question: "q", options: (1...6).map { .init(n: $0, label: "Choice \($0)") }, complete: true)
        expect(!NotificationPlan.answersInNotification(many), "more options than a notification has room for: none")
        let longLabel = ApprovalRequest(id: "x", question: "q", options: [.init(n: 1, label: String(repeating: "a", count: 41)), .init(n: 2, label: "No")],
                                        complete: true)
        expect(!NotificationPlan.answersInNotification(longLabel), "a label an action would cut: no buttons, never a cut label")
        expect(NotificationPlan.approvalActions(longLabel).first?.title.count == 41, "labels are never cut")
        let longQuestion = ApprovalRequest(id: "x", question: String(repeating: "q", count: 121), options: [.init(n: 1, label: "Go")], complete: true)
        expect(!NotificationPlan.answersInNotification(longQuestion), "a question over 120 characters: review in the app")
        // An approval alert whose request did not decode is still one: Open only, never the category with Reply.
        let bare = try decode(NotificationFeed.self, """
        {"cursor":"c3","items":[{"id":"b1","kind":"decision","category":"needs-you","title":"Demo-alpha asks for your approval",
          "sessionId":"grok:demo-alpha","host":"local","answer":"approval","approval":"not a request"}]}
        """)
        let b = NotificationPlan.make(feed: bare, storedCursor: "c2", mutedKinds: [], postedRing: []).notifications
        expect(b.count == 1 && b[0].categoryID == NotificationPlan.infoCategory && b[0].actions.isEmpty, "undecoded approval: Open only, no Reply")
        // Category ids encode the actions one to one: option sets that read alike once joined still get their own.
        let x = [PlannedApprovalAction(identifier: "c.1", title: "a=b", choice: 1, destructive: false)]
        let y = [PlannedApprovalAction(identifier: "c.1=a", title: "b", choice: 1, destructive: false)]
        expect(NotificationPlan.approvalCategory(x) != NotificationPlan.approvalCategory(y), "no two option sets share a category")
        expect(NotificationPlan.approvalCategory(x) == NotificationPlan.approvalCategory(x), "the same set keeps its category")
        expect(NotificationPlan.answersInNotification(ApprovalRequest(id: "x", question: String(repeating: "q", count: 120),
                                                                      options: [.init(n: 1, label: String(repeating: "a", count: 20))], complete: true)),
               "120 and 20 are fine")
        expect(!NotificationPlan.answersInNotification(ApprovalRequest(id: "x", question: "q",
                                                                       options: [.init(n: 1, label: String(repeating: "a", count: 21))], complete: true)),
               "a label over 20 characters: the system would cut the action title")
        expect(NotificationPlan.approvalChoice(fromAction: "drover.approval.choice.2") == 2, "choice parsed")
        for id in ["drover.reply", "drover.open", "drover.approval.choice.", "drover.approval.choice.x", "drover.approval.choice.0", "drover.approval.2"] {
            expect(NotificationPlan.approvalChoice(fromAction: id) == nil, "not a choice: \(id)")
        }
        // Categories kept across launches: newest last, deduped, capped.
        let s1 = ApprovalCategorySpec(identifier: "drover.approval.a", actions: a.actions)
        let s2 = ApprovalCategorySpec(identifier: "drover.approval.b", actions: other)
        expect(ApprovalCategorySpec.adding(s1, to: [s1, s2]).map(\.identifier) == ["drover.approval.b", "drover.approval.a"], "moved to the end")
        let full = (0..<24).map { ApprovalCategorySpec(identifier: "drover.approval.\($0)", actions: []) }
        let capped = ApprovalCategorySpec.adding(s1, to: full)
        expect(capped.count == 24 && capped.first?.identifier == "drover.approval.1" && capped.last == s1, "oldest dropped past the cap")
        let rt = try JSONDecoder().decode([ApprovalCategorySpec].self, from: JSONEncoder().encode(capped))
        expect(rt == capped, "specs persist")
    }

    /// What a card offers: one tap only on words shown whole, else a review first (CONTRACT.md `complete`).
    static func approvalCardModes() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let opts: [ApprovalRequest.Option] = [.init(n: 1, label: "Approve"), .init(n: 2, label: "Deny")]
        let later = LooseDate(now.addingTimeInterval(3600))
        let whole = ApprovalRequest(id: "ap_1", question: "Restart?", options: opts, details: "Tonight.", expiresAt: later, complete: true)
        let cut = ApprovalRequest(id: "ap_1", question: "Restart?", options: opts, details: "Tonight, after the…", expiresAt: later, complete: false)
        let old = ApprovalRequest(id: "ap_1", question: "Restart?", options: opts, expiresAt: later)
        func mode(_ s: ApprovalRequest, full: ApprovalRequest? = nil, host: String? = "local", main: Bool = true) -> ApprovalCardMode {
            ApprovalFormat.cardMode(summary: s, full: full, host: host, hasMainToken: main, now: now)
        }
        expect(mode(whole) == .answer(whole), "complete and shown whole: one tap")
        expect(mode(cut) == .review, "shortened: review first")
        expect(mode(old) == .review, "missing complete (an older daemon) counts as false")
        let long = ApprovalRequest(id: "ap_1", question: String(repeating: "q", count: 121), options: opts, expiresAt: later, complete: true)
        expect(mode(long) == .review, "a question over 120 characters goes through the review")
        let edge = ApprovalRequest(id: "ap_1", question: String(repeating: "q", count: 120), options: opts, expiresAt: later, complete: true)
        expect(mode(edge) == .answer(edge), "120 is fine")
        let thumbs = ApprovalRequest(id: "ap_1", question: String(repeating: "\u{1F44D}", count: 61), options: opts, expiresAt: later, complete: true)
        expect(mode(thumbs) == .review, "counted in UTF-16 units, as the web board does: 61 thumbs are 122")
        var reviewedLong = long
        reviewedLong.status = "pending"
        expect(mode(long, full: reviewedLong) == .answer(reviewedLong), "reviewed: the whole request answers, however long")
        var full = cut
        full.details = "Tonight, after the backups finish; about ten minutes of downtime."
        full.complete = true
        full.status = "pending"
        expect(mode(cut, full: full) == .answer(full), "reviewed: answered from the whole request")
        var decided = full
        decided.status = "decided"; decided.decision = .init(n: 2, label: "Deny"); decided.via = "web"
        expect(mode(cut, full: decided) == .closed("Answered already: \"Deny\" (web)."), "reviewed and answered elsewhere")
        var withdrawn = full; withdrawn.status = "withdrawn"
        expect(mode(cut, full: withdrawn) == .closed("The bot withdrew this request."), "withdrawn")
        var expiredFull = full; expiredFull.status = "expired"
        expect(mode(cut, full: expiredFull) == .closed("This request expired."), "expired on review")
        var odd = full; odd.status = "archived"
        expect(mode(cut, full: odd) == .closed("This request is archived."), "anything new is said as it is")
        let past = ApprovalRequest(id: "ap_1", question: "q", options: opts, expiresAt: LooseDate(now.addingTimeInterval(-1)), complete: true)
        expect(mode(past) == .blocked("This request expired."), "expired before review")
        expect(mode(ApprovalRequest(id: "ap_1", question: "q", options: [], complete: true)) == .blocked("This request offers no options. Answer it on the Drover board."), "nothing to press")
        expect(mode(whole, host: "demo-box") == .blocked("demo-box keeps this bot: answer it on demo-box's own Drover board."), "another host")
        expect(mode(whole, main: false) == .blocked("Read-only token: add the main token in Settings to answer."), "read-only token")
        expect(ApprovalFormat.reviewNote == "This preview may be shortened. Review the whole request before you answer.", "review note")
    }

    /// The board's flow with the mock daemon: review, then a press answers by id and says what came of it.
    @MainActor
    static func approvalModel() async {
        approvalCardModes()
        let m = AppModel.preview()
        await m.refreshSummary()
        guard let item = m.summary?.waiting.first(where: { $0.approval != nil }), let summary = item.approval else {
            expect(false, "mock summary has an approval"); return
        }
        expect(m.approvalItem(for: item.ref)?.approval?.id == summary.id, "found by ref")
        expect(m.approvalItem(for: SessionRef(id: item.id, host: "demo-box")) == nil, "same id on another host is another session")
        expect(item.botName == "Demo-alpha" && item.moreApprovals == 1, "bot name, one more behind")
        expect(ApprovalFormat.cardMode(summary: summary, full: nil, host: item.host, hasMainToken: m.hasMainToken, now: Date()) == .review,
               "the mock's shortened request asks for a review")
        let reviewed = try? await m.reviewApproval(id: summary.id)
        guard let approval = reviewed ?? nil else { expect(false, "the review loads the whole request"); return }
        expect(approval.isComplete && approval.status == "pending" && (approval.details?.count ?? 0) > (summary.details?.count ?? 0),
               "the whole request, longer than the preview")
        let gone = try? await m.reviewApproval(id: "ap_00000000dead")
        expect(gone == .some(nil), "a request this daemon does not keep reviews as gone")
        await m.answerApproval(approval, option: approval.options[0], botName: item.botName)
        expect(m.approvalNotice?.text == "Answered \"Buy it\". Demo-alpha is told now." && m.approvalNotice?.isError == false,
               "answered: \(m.approvalNotice?.text ?? "-")")
        expect(m.answeringApprovals.isEmpty, "the press is over")
        // The mock board still lists it (as a daemon's board can for a few seconds): the card holds no buttons for it.
        expect(m.settledApprovals[approval.id] == "Answered \"Buy it\".", "settled until the board drops it")
        let answered = ApprovalRequest(id: "ap_00000000dead", question: "q", options: [.init(n: 1, label: "Approve")])
        await m.answerApproval(answered, option: answered.options[0], botName: "Demo-alpha")
        expect(m.approvalNotice?.isError == true && m.approvalNotice?.text.hasPrefix("Not answered: approval ap_00000000dead was answered already") == true,
               "409 shown: \(m.approvalNotice?.text ?? "-")")
        expect(m.settledApprovals["ap_00000000dead"] == nil && m.settledApprovals[approval.id] != nil,
               "a request the board does not list is let go; one it still lists stays settled")
        m.dismissApprovalNotice()
        expect(m.approvalNotice == nil, "dismissed")
    }
}

/// URLProtocol stub for the approval route: records each request, answers with `reply`.
final class ApprovalStub: URLProtocol, @unchecked Sendable {
    struct Recorded: Sendable { let url: String; let method: String; let auth: String?; let body: Data }
    nonisolated(unsafe) static var reply: (Int, String) = (200, "{}")
    nonisolated(unsafe) static var recorded: [Recorded] = []

    static func session() -> URLSession {
        let c = URLSessionConfiguration.ephemeral
        c.protocolClasses = [ApprovalStub.self]
        return URLSession(configuration: c)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = request.httpBody ?? Data()
        if body.isEmpty, let s = request.httpBodyStream {
            s.open()
            var buf = [UInt8](repeating: 0, count: 4096)
            while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; body.append(buf, count: n) }
            s.close()
        }
        Self.recorded.append(Recorded(url: request.url?.absoluteString ?? "", method: request.httpMethod ?? "GET",
                                      auth: request.value(forHTTPHeaderField: "Authorization"), body: body))
        let (status, json) = Self.reply
        let resp = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                   headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(json.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
