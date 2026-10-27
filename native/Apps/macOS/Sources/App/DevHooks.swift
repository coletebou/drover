import AppKit
import SwiftUI

#if DROVER_DEV
/// Test hooks of the dev build only (`droverdev://debug/<action>?...`), so a script can drive the running app and see
/// what it shows without the Screen Recording or Accessibility permissions: the window list, the model, a PNG of a
/// window drawn by the app itself, and the calls its buttons make (a dialog answer, a manager message). SwiftUI builds
/// no accessibility tree without an assistive client, so buttons cannot be pressed from inside. Never compiled into
/// the real app.
@MainActor
enum DevHooks {
    static func run(_ action: String, _ q: [String: String], router: WindowRouter) {
        guard let model = router.model else { return }
        switch action {
        case "close-main":
            router.mainWindow()?.performClose(nil)
        case "notification-tap":
            // What a tap on an alert runs (NotificationCoordinator.route -> WindowRouter.openSession).
            NotificationCoordinatorHook.tap(model: model, sessionId: q["session"], host: q["host"])
        case "panel":
            router.toggleManagerPanel()
        case "select":
            if let name = q["name"], let s = model.board.sessions.first(where: { $0.name == name }) { model.select(s) }
            if let tab = q["tab"].flatMap(DetailTab.init(rawValue:)) { model.detailTab = tab }
            if q["manager"] == "1" { model.showManagerInWindow() }
            if let thread = q["thread"] { model.manager.switchThread(thread) }
        case "send":
            // What the composer's Send runs for a session (sessions.message).
            guard let name = q["name"], let text = q["text"], let s = model.board.sessions.first(where: { $0.name == name }) else { return }
            Task {
                do { let r = try await model.service.sendMessage(to: s, text: text); PerfLog.note("sent to \(name): queued=\(r.queuedBehindTurn)") }
                catch { PerfLog.note("send to \(name) failed: \(error.localizedDescription)") }
            }
        case "notify-check":
            // The newest dialog alert in native.notifications, as its notification would carry it, and (press=<key>)
            // the answer its action would send: everything but UserNotifications' banner and click.
            Task {
                guard let page = try? await model.service.notifications(since: nil, wait: 0),
                      let item = page.items.last(where: { !$0.keys.isEmpty }) else { PerfLog.note("notify-check: no dialog alert"); return }
                let c = NotificationContentBuilder.content(for: item)
                PerfLog.note("notify-check \(item.title): category=\(c.categoryId) actions=\(c.actions.map(\.title)) hash=\(c.userInfo["hash"] ?? "-")")
                guard let key = q["press"] else { return }
                var info = NotificationAction(c.userInfo)
                info.server = model.activeServerURL
                model.notifications.route(action: NotificationContentBuilder.keyPrefix + key, info: info, text: nil, requestId: item.id)
            }
        case "approve":
            // What an approval option runs (AppModel.answerApproval): name=<row>, choice=<n>, where=card (default) or row.
            guard let name = q["name"], let choice = q["choice"].flatMap(Int.init),
                  let s = model.board.sessions.first(where: { $0.name == name }) else { PerfLog.note("approve: no such session"); return }
            let card = q["where"] != "row"
            Task {
                PerfLog.note("approve \(name): the \(card ? "card" : "row") offers \(describe(model.approvalMode(for: s, detailsShown: card)))")
                await model.answerApproval(s, choice: choice, detailsShown: card)
                PerfLog.note("approve \(name) \(choice): toast=\(model.toast?.text ?? "-") notice=\(model.answerNotice[s.key]?.text ?? "-")")
            }
        case "review":
            // What Review runs: the whole request into the card (GET /api/approvals?id=).
            guard let name = q["name"], let s = model.board.sessions.first(where: { $0.name == name }), let a = s.approval else {
                PerfLog.note("review: no such approval row"); return
            }
            Task {
                await model.reviewApproval(s)
                let r = model.approvalReviews[a.id]
                if case .loaded(let full)? = r {
                    PerfLog.note("review \(name): whole request, status \(full.status ?? "-"), complete \(full.complete.map(String.init) ?? "missing"), question \(full.question.utf16.count) chars, details \(full.details?.count ?? 0) chars; card offers \(describe(model.approvalMode(for: s)))")
                } else {
                    PerfLog.note("review \(name): \(String(describing: r))")
                }
            }
        case "notify-approval-check":
            // The newest approval alert in native.notifications as its notification would carry it, and (press=<n>)
            // what its action would answer, through the coordinator's own route.
            Task {
                guard let page = try? await model.service.notifications(since: nil, wait: 0),
                      let item = page.items.last(where: { $0.approval != nil }) else { PerfLog.note("notify-approval-check: no approval alert"); return }
                let c = NotificationContentBuilder.content(for: item)
                PerfLog.note("notify-approval-check \(item.title): category=\(c.categoryId) actions=\(c.actions.map(\.title)) subtitle=\(c.subtitle ?? "-") reply=\(!c.answersApproval && c.categoryId == "drover.session")")
                guard let n = q["press"] else { return }
                var info = NotificationAction(c.userInfo)
                info.server = model.activeServerURL
                model.notifications.route(action: NotificationContentBuilder.approvalPrefix + n, info: info, text: nil, requestId: item.id)
            }
        case "manager-send":
            if let text = q["text"] { model.manager.send(text) }
        case "answer":
            // What a dialog button runs: the card and the board rows answer with the board's hash, Screen's bar
            // with the hash of the capture it read (here: a fresh capture, read the same way).
            guard let name = q["name"], let key = q["key"], let s = model.board.sessions.first(where: { $0.name == name }) else {
                PerfLog.note("answer: no such session"); return
            }
            Task {
                var expect = s.hash
                if q["via"] == "screen", let target = s.tmuxTarget,
                   let c = try? await model.service.capture(target: target, host: s.host, lines: 200) {
                    let reading = c.state == .dialog ? ScreenDialog.read(c.text) : nil
                    PerfLog.note("screen reading hash=\(reading?.hash ?? "-") board hash=\(s.hash ?? "-") keys=\(reading?.keys ?? [])")
                    expect = reading?.hash ?? expect
                }
                // `expect=stale` shows a refusal: the daemon checks the hash against the screen.
                await model.answer(s, key: key, expect: q["expect"] ?? expect)
                let card = model.dialogState(model.session(forKey: s.key) ?? s)
                PerfLog.note("answered \(name) \(key): notice=\(model.answerNotice[s.key]?.text ?? "-") toast=\(model.toast?.text ?? "-") card now=\(card.map { "\($0.dialog?.question ?? "-") \($0.hash ?? "-")" } ?? "none")")
            }
        case "snapshot":
            guard let url = DevSnapshotPath.resolve(q["path"]) else {
                PerfLog.note("snapshot refused: \(q["path"] ?? "-") is not a .png in the temp directory"); return
            }
            let window = q["window"] == "panel" ? NSApp.windows.first(where: { $0 is FloatingPanel }) : router.mainWindow()
            PerfLog.note("snapshot \(url.path): \(window.map { snapshot($0, to: url) } ?? false)")
        case "state":
            let ids = NSApp.windows.map { "\($0.identifier?.rawValue ?? String(describing: type(of: $0))):\($0.isVisible ? "visible" : "hidden")" }
            PerfLog.note("windows \(ids.joined(separator: " "))")
            if let w = router.mainWindow() {
                PerfLog.note("main frame=\(w.frame) content=\(w.contentView?.frame ?? .zero) minSize=\(w.contentMinSize) maxSize=\(w.contentMaxSize) screen=\(w.screen?.visibleFrame ?? .zero)")
            }
            dump(model)
        default:
            PerfLog.note("unknown debug action \(action)")
        }
    }

    static func dump(_ model: AppModel) {
        let b = model.board
        PerfLog.note("board source=\(b.source.rawValue) sessions=\(b.sessions.count) hosts=\(b.hosts.map(\.name)) connection=\(model.connection.label)")
        for s in b.sessions {
            PerfLog.note("  \(s.name) lane=\(s.lane.rawValue) screen=\(s.screen.rawValue) keys=\(s.keys) hash=\(s.hash ?? "-") card=\(model.showsAnswerCard(s))\(s.approval.map { " approval=\($0.id) complete=\($0.complete.map(String.init) ?? "missing") row=\(describe(model.approvalMode(for: s, detailsShown: false))) chat=\(describe(model.approvalMode(for: s)))" } ?? "")")
        }
        PerfLog.note("selected=\(model.selectedSessionKey ?? "-") tab=\(model.detailTab.rawValue) manager=\(model.showsManager)")
        if let s = model.selectedSession {
            let chat = model.chatModel(for: s)
            PerfLog.note("chat \(s.name): turns=\(chat.turns.count) rows=\(chat.items.count) live=\(chat.liveAt != nil)")
            for item in chat.items.suffix(12) { PerfLog.note("  row \(describe(item))") }
            if let notice = model.answerNotice[s.key] { PerfLog.note("  answer notice: \(notice.text)") }
            let card = model.dialogState(s)
            PerfLog.note("  card: \(card.map { "\($0.dialog?.question ?? "-") hash=\($0.hash ?? "-") keys=\($0.keys)" } ?? "none") live=\(model.liveDialogs[s.key].map { "\($0.reading?.hash ?? "no dialog") pressed=\($0.pressed ?? "-")" } ?? "-")")
        }
        let m = model.manager
        PerfLog.note("manager thread=\(m.thread) status=\(m.statusText) rows=\(m.items.count) threads=\(m.threads.map(\.thread))")
        for item in m.items.suffix(6) { PerfLog.note("  manager row \(describe(item))") }
    }

    static func describe(_ mode: ApprovalCardMode?) -> String {
        switch mode {
        case .answer(let r)?: "buttons \(r.options.map { ApprovalFormat.title($0) })"
        case .review?: "review first"
        case .blocked(let why)?: "blocked: \(why)"
        case .closed(let why)?: "closed: \(why)"
        case nil: "none"
        }
    }

    static func describe(_ item: ChatItem) -> String {
        switch item {
        case .user(let u): "user(\(u.sender ?? "you")\(u.pending ? ", pending" : "")): \(u.text.prefix(60))"
        case .text(let t): "text\(t.pending ? "(pending)" : ""): \(Markdown.plain(t.blocks).replacingOccurrences(of: "\n", with: " ").prefix(70))"
        case .tools(let g): "tools: \(g.title)\(g.hasError ? " [error]" : "") rows=\(g.rows.map { "\($0.name)(\($0.summary.prefix(30)))\($0.result == nil ? "?" : "")" })"
        case .notice(let n): "notice: \(n.text.prefix(60))"
        }
    }

    /// The window's content drawn into a PNG by the app itself (cacheDisplay needs no capture permission). Atomic: a
    /// link at `url` is replaced, never written through.
    static func snapshot(_ window: NSWindow, to url: URL) -> Bool {
        guard let view = window.contentView, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return false }
        view.cacheDisplay(in: view.bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else { return false }
        return (try? png.write(to: url, options: .atomic)) != nil
    }
}

/// The notification tap path without UserNotifications (the dev build posts none by default).
@MainActor
enum NotificationCoordinatorHook {
    static func tap(model: AppModel, sessionId: String?, host: String?) {
        model.notifications.route(action: "com.apple.UNNotificationDefaultActionIdentifier",
                                  info: NotificationAction(sessionId: sessionId, host: host, server: model.activeServerURL),
                                  text: nil, requestId: "dev-tap")
    }
}
#endif

/// Where the dev build's snapshot hook may write (`droverdev://debug/snapshot?path=`). That URL can come from any app or
/// web page, so its path is not trusted: only a `.png` in an existing directory under the temp directory (/tmp, or
/// this user's), and the write replaces a link there instead of following it (DevHooks.snapshot). Pure, outside
/// DROVER_DEV for the harness; only the dev build calls it.
enum DevSnapshotPath {
    static let fallback = "/tmp/drover-dev-window.png"

    static func resolve(_ path: String?) -> URL? {
        let url = URL(fileURLWithPath: path ?? fallback).standardizedFileURL
        guard url.pathExtension.lowercased() == "png", let dir = real(url.deletingLastPathComponent().path) else { return nil }
        let roots = ["/tmp", NSTemporaryDirectory()].compactMap(real)
        return roots.contains { dir == $0 || dir.hasPrefix($0 + "/") } ? url : nil
    }

    /// realpath(3): every link resolved (/tmp is /private/tmp), nil when the path does not exist.
    private static func real(_ path: String) -> String? {
        guard let p = realpath(path, nil) else { return nil }
        defer { free(p) }
        return String(cString: p)
    }
}
