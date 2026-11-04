import Foundation

/// Opt-in check against a running daemon that keeps Grok bots with pending approval requests (a dev world: never the
/// daemon you work with, since it answers a real request). Off unless all three are set:
///   DROVER_LIVE_URL=http://127.0.0.1:7431 DROVER_LIVE_TOKEN_FILE=<world>/state/token DROVER_LIVE_APPROVALS=1
///   (and DROVER_LIVE_WIDGET_TOKEN_FILE=<world>/state/widget-token for the read-only checks)
/// It answers the first pending request on the board the way the board's button does (AppModel.answerApproval, via
/// ios), after reviewing it when its words may be shortened. Reads the tokens from the files and never prints them;
/// prints ids, counts and outcomes only.
extension Suites {
    static var liveSuites: [(String, () async throws -> Void)] { [("approval live", approvalLive)] }

    @MainActor
    static func approvalLive() async throws {
        let env = ProcessInfo.processInfo.environment
        guard env["DROVER_LIVE_APPROVALS"] == "1", let raw = env["DROVER_LIVE_URL"], let base = URL(string: raw),
              let tokenFile = env["DROVER_LIVE_TOKEN_FILE"] else { print("approval live: skipped (set DROVER_LIVE_*)"); return }
        func token(_ file: String) throws -> String {
            try String(contentsOfFile: (file as NSString).expandingTildeInPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let main = try token(tokenFile)
        let api = HTTPDroverAPI(baseURL: base, token: { main })
        let m = AppModel(api: api)
        await m.refreshSummary()
        guard let item = m.summary?.waiting.first(where: { $0.approval != nil && ApprovalFormat.isAnswerable(host: $0.host) }),
              let summary = item.approval else { expect(false, "live: no pending approval request on the board"); return }
        let mode = ApprovalFormat.cardMode(summary: summary, full: nil, host: item.host, hasMainToken: true, now: Date())
        print("approval live: \(summary.id) of \(item.id), complete \(summary.complete.map(String.init) ?? "missing"), question \(summary.question.utf16.count) units, details \(summary.details?.count ?? 0), more \(item.moreApprovals ?? 0), card \(mode == .review ? "review first" : "one tap")")
        // Review: the whole request, as GET /api/approvals?id= gives it (what a shortened card answers from).
        let full = try await m.reviewApproval(id: summary.id)
        expect(full?.id == summary.id && full?.status == "pending", "live: the review finds it pending")
        expect(full?.question == summary.question || !summary.isComplete, "live: a complete payload has the whole question")
        let request: ApprovalRequest
        switch ApprovalFormat.cardMode(summary: summary, full: mode == .review ? full : nil, host: item.host, hasMainToken: true, now: Date()) {
        case .answer(let r): request = r
        default: expect(false, "live: the card offers no buttons"); return
        }
        let option = request.options[0]
        await m.answerApproval(request, option: option, botName: item.botName)
        let notice = m.approvalNotice
        print("approval live: answered \"\(option.label)\" via ios: \(notice?.text ?? "-")")
        expect(notice?.isError == false && notice?.text.hasPrefix("Answered \"\(option.label)\".") == true, "live: decided")
        // The board moves on: this request leaves it (the daemon's fleet cache may hold it for a few seconds).
        var seconds = 0
        while m.summary?.waiting.contains(where: { $0.approval?.id == summary.id }) == true, seconds < 30 {
            try await Task.sleep(for: .seconds(1)); seconds += 1
            await m.refreshSummary()
        }
        expect(m.summary?.waiting.contains { $0.approval?.id == summary.id } != true, "live: the card leaves the board")
        print("approval live: the card left the board \(seconds) s after the answer; next on that row: \(m.summary?.waiting.first { $0.id == item.id }?.approval?.id ?? "none")")
        // A second answer, as another screen pressing late: 409, shown as the daemon says it.
        let again = try await api.answerApproval(id: summary.id, choice: option.n, via: DroverIDs.actor)
        if case .closed(let message) = again { print("approval live: second answer refused: \(message)") }
        expect({ if case .closed = again { true } else { false } }(), "live: a second answer is 409")
        let reviewed = try await m.reviewApproval(id: summary.id)
        expect(reviewed.flatMap(ApprovalFormat.closedText)?.hasPrefix("Answered already: \"\(option.label)\" (ios)") == true,
               "live: the review says it was answered on ios: \(reviewed.flatMap(ApprovalFormat.closedText) ?? "-")")
        // The read-only widget token can neither review nor answer.
        if let widgetFile = env["DROVER_LIVE_WIDGET_TOKEN_FILE"] {
            let widget = try token(widgetFile)
            let ro = HTTPDroverAPI(baseURL: base, token: { widget })
            do { _ = try await ro.answerApproval(id: summary.id, choice: option.n, via: "ios"); expect(false, "live: widget token answered") }
            catch { expect((error as? DroverError) == .forbidden, "live: the widget token gets 403 on answer") }
            do { _ = try await ro.approval(id: summary.id); expect(false, "live: widget token reviewed") }
            catch { expect((error as? DroverError) == .forbidden, "live: the widget token gets 403 on review") }
            print("approval live: the widget token was refused both")
        }
        // The notification feed: which approval alerts would carry buttons here (complete, no details, short).
        let feed = try await api.notifications(since: nil, wait: nil)
        let planned = feed.items.filter { $0.approval != nil }.map(NotificationPlan.planned)
        print("approval live: notification alerts \(planned.map { "\($0.approvalID ?? "-"): \($0.actions.isEmpty ? "open only" : "\($0.actions.count) buttons")" })")
        expect(planned.allSatisfy { $0.categoryID != NotificationPlan.sessionCategory }, "live: no approval alert offers Reply")
    }
}
