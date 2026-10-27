import Foundation

/// Opt-in check against a running daemon that keeps Grok bots with pending approval requests (a dev world, never the
/// daemon you work with: it answers a real request). Off unless set:
///   DROVER_LIVE_URL=http://127.0.0.1:7431 DROVER_LIVE_TOKEN_FILE=<world>/state/token
///   DROVER_LIVE_WIDGET_TOKEN_FILE=<world>/state/widget-token DROVER_LIVE_APPROVALS=1
/// It runs the watch's own flow: refresh with the widget token, review the first request when its words may be
/// shortened, answer it with the main token (via watch), then a late second answer. Never prints a token.
let approvalLiveTests: [TestCase] = [
    TestCase("approval live: the watch answers a real request") {
        let env = ProcessInfo.processInfo.environment
        guard env["DROVER_LIVE_APPROVALS"] == "1", let raw = env["DROVER_LIVE_URL"], let base = URL(string: raw),
              let mainFile = env["DROVER_LIVE_TOKEN_FILE"], let widgetFile = env["DROVER_LIVE_WIDGET_TOKEN_FILE"] else {
            print("     approval live: skipped (set DROVER_LIVE_*)"); return
        }
        func token(_ file: String) throws -> String {
            try String(contentsOfFile: (file as NSString).expandingTildeInPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let cfg = WatchConfig(defaults: scratchDefaults())
        cfg.baseURL = base
        let m = AppModel(vault: MemoryTokenVault(main: try token(mainFile), widget: try token(widgetFile)), config: cfg,
                         cache: SummaryCache(fileURL: scratchFile()), seen: SeenWaitingStore(defaults: scratchDefaults()))
        await m.refresh(allowMainToken: false)
        try expectEqual(m.phase, .loaded, "the widget token reads the summary")
        let item = try m.waiting.first { $0.approval != nil && ApprovalFormat.isAnswerable(host: $0.host) }.unwrapOrThrow()
        let summary = try item.approval.unwrapOrThrow()
        let first = ApprovalFormat.cardMode(summary: summary, full: nil, host: item.host, canAnswer: m.canReply, now: Date())
        print("     approval live: \(summary.id) of \(item.id), complete \(summary.complete.map(String.init) ?? "missing"), details \(summary.details?.count ?? 0), card \(first == .review ? "review first" : "one tap")")
        let full = try await m.reviewApproval(summary).unwrapOrThrow()
        try expectEqual(full.status, "pending")
        let mode = ApprovalFormat.cardMode(summary: summary, full: first == .review ? full : nil, host: item.host, canAnswer: true, now: Date())
        guard case .answer(let request) = mode else { throw TestFailure(description: "no buttons: \(mode)") }
        var flow = ApprovalFlow()
        let n = try flow.press(request.options[0].n).unwrapOrThrow()
        let result: Result<ApprovalAnswerResult, Error>
        do { result = .success(try await m.answerApproval(request, choice: n)) } catch { result = .failure(error) }
        flow.finished(result, botName: item.botName)
        print("     approval live: answered \"\(request.options[0].label)\" via watch: \(flow.phase)")
        guard case .done(let text, false) = flow.phase else { throw TestFailure(description: "not decided: \(flow.phase)") }
        try expect(text.hasPrefix("Answered \"\(request.options[0].label)\"."))
        // A late second press from the same card is never sent; from another screen it is the daemon's 409.
        try expect(flow.press(n) == nil, "the card takes no second answer")
        let (client, main) = (WatchClient(baseURL: base), try token(mainFile))
        let again = try await client.answerApproval(id: summary.id, choice: n, token: main)
        guard case .closed(let message) = again else { throw TestFailure(description: "a second answer was not 409: \(again)") }
        print("     approval live: second answer refused: \(message)")
        let reviewed = try await client.approval(id: summary.id, token: main).unwrapOrThrow()
        try expectEqual(reviewed.status, "decided")
        try expectEqual(reviewed.via, "watch", "recorded as answered on the watch")
        // The widget token cannot answer.
        try await expectThrows(WatchClientError.unauthorized) {
            _ = try await client.answerApproval(id: summary.id, choice: n, token: try token(widgetFile))
        }
    },
]
