#if DROVER_DEV
import AppKit
import Security
import SwiftUI

// Dev builds only: tools/build-app.sh compiles with -D DROVER_DEV; the Xcode target never does. An
// unentitled ad hoc build cannot read the shared Keychain item, so it reads the daemon's token files, takes
// the server from DROVER_URL, keeps its own defaults, shows no menu bar item and opens nothing unless asked,
// and posts no notifications unless asked. Nothing here prints a token.

enum DevEnvironment {
    static let env = ProcessInfo.processInfo.environment

    static var serverURL: String { env["DROVER_URL"] ?? "http://127.0.0.1:7337" }
    /// The daemon's state folder (token, widget-token).
    static var stateDir: URL {
        if let s = env["DROVER_STATE"], !s.isEmpty { return URL(fileURLWithPath: (s as NSString).expandingTildeInPath) }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/state/drover")
    }
    static var showsMenuBarItem: Bool { env["DROVER_DEV_MENUBAR"] == "1" }
    static var notifications: Bool { env["DROVER_DEV_NOTIFICATIONS"] == "1" }
    static var opensURLs: Bool { env["DROVER_DEV_OPEN"] == "1" }
    static var script: String? { env["DROVER_DEV_SCRIPT"].flatMap { $0.isEmpty ? nil : $0 } }
    static var snapshotDir: URL? { env["DROVER_DEV_SNAPSHOT"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) } }

    /// The live daemon you work with. The harness never presses keys, messages or sweeps there.
    static var isLiveDaemon: Bool {
        guard let u = URLComponents(string: serverURL) else { return true }
        let host = (u.host ?? "").lowercased()
        return (host == "127.0.0.1" || host == "localhost" || host == "::1") && (u.port ?? 80) == 7337
    }
}

/// Tokens from `<state>/token` and `<state>/widget-token`. Read-only.
final class DevTokenStore: TokenStoring, @unchecked Sendable {
    func token(_ kind: TokenKind) -> String? {
        let name = kind == .main ? "token" : "widget-token"
        guard let s = try? String(contentsOf: DevEnvironment.stateDir.appendingPathComponent(name), encoding: .utf8) else { return nil }
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

    func setToken(_ value: String?, for kind: TokenKind) throws {
        throw KeychainError.status(errSecUnimplemented)
    }
}

/// A scripted run of the real app: `DROVER_DEV_SCRIPT="snap:start;answer:1;wait:2;snap:after;quit"` runs the
/// same store calls the popover's buttons make, against the daemon at DROVER_URL, and renders the real
/// PopoverView offscreen to DROVER_DEV_SNAPSHOT (light and dark). Logs carry counts and outcomes only.
@MainActor
enum DevHarness {
    static var opened: [URL] = []

    static func log(_ s: String) {
        FileHandle.standardOutput.write(Data("harness: \(s)\n".utf8))
    }

    static func start(_ model: AppModel) {
        guard let script = DevEnvironment.script else { return }
        Task { await run(script, model) }
    }

    private static func run(_ script: String, _ model: AppModel) async {
        let store = model.store
        log("server \(DevEnvironment.isLiveDaemon ? "live daemon (read only)" : DevEnvironment.serverURL)")
        for _ in 0..<200 where store.summary == nil { try? await Task.sleep(for: .milliseconds(50)) }
        await store.loadManagerHistory()
        log(state(store))
        let actions = model.actions(openSettings: {})
        for raw in script.split(separator: ";") {
            let step = raw.trimmingCharacters(in: .whitespaces)
            let (verb, arg) = split(step)
            let mutating = ["answer", "ask", "sweep", "notify", "approve", "notifyapproval", "reviewapproval"].contains(verb)
            if mutating && DevEnvironment.isLiveDaemon {
                log("refused \(verb): DROVER_URL is the live daemon")
                continue
            }
            switch verb {
            case "snap":
                await snapshot(arg.isEmpty ? "popover" : arg, store: store, actions: actions)
            case "snaprow":
                // snaprow:<row name>[@<file name>]: that waiting row alone (the popover's scroll height hides lower rows).
                let parts = arg.split(separator: "@", maxSplits: 1).map(String.init)
                guard let item = store.summary?.waiting.first(where: { $0.name == parts.first }) else { log("snaprow \(arg): no such row"); continue }
                guard let dir = DevEnvironment.snapshotDir else { log("snaprow: set DROVER_DEV_SNAPSHOT"); continue }
                try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                for dark in [false, true] {
                    let url = dir.appendingPathComponent("\(parts.count > 1 ? parts[1] : "row-\(item.name)")-\(dark ? "dark" : "light").png")
                    await SnapshotRenderer.render(WaitingRow(item: item, store: store, actions: actions).padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading).background(Theme.background).foregroundStyle(Theme.text),
                                                  width: 380, dark: dark, to: url)
                    log("snap \(url.lastPathComponent)")
                }
            case "answer":
                // answer:<key> (the first row offering it), answer:<key>@<row index> or answer:<key>#<row name>
                let byName = arg.split(separator: "#", maxSplits: 1).map(String.init)
                let parts = byName[0].split(separator: "@").map(String.init)
                let key = parts.first ?? ""
                let rows = store.summary?.waiting ?? []
                let item: WaitingItem? = byName.count > 1
                    ? rows.first { $0.name == byName[1] }
                    : parts.count > 1
                    ? Int(parts[1]).flatMap { rows.indices.contains($0) ? rows[$0] : nil }
                    : rows.first { w in store.answerPlan(for: w).buttons.contains { $0.key == key } }
                guard let item else { log("answer \(arg): no such waiting row"); continue }
                log("answer \(arg): row offers \(store.answerPlan(for: item).buttons.map(\.title))")
                await store.answer(item, key: key)
                log("answer \(arg): \(store.answerStates[item.answerKey]?.message ?? "no outcome (key not offered)")")
            case "approve":
                // approve:<n> (the first row with an approval request) or approve:<n>#<row name>: the row's button.
                let parts = arg.split(separator: "#", maxSplits: 1).map(String.init)
                let rows = (store.summary?.waiting ?? []).filter { $0.approval != nil }
                guard let n = Int(parts.first ?? ""), let item = parts.count > 1 ? rows.first(where: { $0.name == parts[1] }) : rows.first else {
                    log("approve \(arg): no such approval row"); continue
                }
                log("approve \(arg): row offers \(describe(store.approvalMode(for: item)))")
                await store.answerApproval(item, choice: n)
                log("approve \(arg): \(store.approvalNotice?.text ?? "no outcome (no such option on offer)")")
            case "reviewapproval":
                // reviewapproval (the first row with an approval request) or reviewapproval:#<row name>: its Review button.
                let name = arg.hasPrefix("#") ? String(arg.dropFirst()) : nil
                let rows = (store.summary?.waiting ?? []).filter { $0.approval != nil }
                guard let item = name.map({ n in rows.first { $0.name == n } }) ?? rows.first else { log("reviewapproval: no approval row"); continue }
                await store.reviewApproval(item)
                let review = item.approval.flatMap { store.approvalReviews[$0.id] }
                switch review {
                case .loaded(let full)?:
                    log("reviewapproval: whole request, status \(full.status ?? "-"), complete \(full.complete.map(String.init) ?? "missing"), details \(full.details?.count ?? 0) chars; row offers \(describe(store.approvalMode(for: item)))")
                default: log("reviewapproval: \(String(describing: review))")
                }
            case "notifyapproval":
                // notifyapproval:<n> (the newest alert of a pending request) or notifyapproval:<n>#<row name> (that row's).
                let parts = arg.split(separator: "#", maxSplits: 1).map(String.init)
                await notifyApproval(choice: Int(parts.first ?? "") ?? 1, row: parts.count > 1 ? parts[1] : nil, model: model)
            case "notify":
                // notify:<key>[+<s>]: the newest alert that carries dialog keys (raised at least <s> seconds after this
                // step started, when given), through the notification action handler.
                let parts = arg.split(separator: "+").map(String.init)
                await notify(key: parts[0], after: parts.count > 1 ? Double(parts[1]) ?? 0 : 0, model: model)
            case "ask":
                await store.askManager(arg)
                log("ask: \(phase(store.manager))")
            case "sweep":
                do { try await store.sweepManager(); log("sweep: requested") } catch { log("sweep: \((error as? DroverError)?.userMessage ?? "failed")") }
            case "wait":
                try? await Task.sleep(for: .seconds(Double(arg) ?? 1))
            case "waitreply":
                let deadline = Date().addingTimeInterval(Double(arg) ?? 30)
                while Date() < deadline, store.manager.busy { try? await Task.sleep(for: .milliseconds(100)) }
                log("reply: \(phase(store.manager)), \(store.manager.reply?.text.count ?? 0) chars")
            case "waitdialog":
                let deadline = Date().addingTimeInterval(Double(arg) ?? 30)
                while Date() < deadline, !(store.summary?.waiting.contains { !store.answerPlan(for: $0).buttons.isEmpty } ?? false) {
                    try? await Task.sleep(for: .milliseconds(200))
                }
                log(state(store))
            case "open":
                // Two clicks in a row, as a double click: one deep link.
                let before = opened.count
                if arg == "manager" {
                    actions.openManager(); actions.openManager()
                } else if let item = store.summary?.waiting.first {
                    actions.openWaiting(item); actions.openWaiting(item)
                }
                log("open \(arg): \(opened.count - before) url(s) for 2 clicks")
            case "log":
                log(state(store))
            case "quit":
                log("quit")
                NSApp.terminate(nil)
            default:
                log("unknown step \(verb)")
            }
        }
    }

    /// The newest native.notifications item with dialog keys, planned as the app would post it, then the
    /// planned button pressed through NotificationController (the code a notification click runs).
    private static func notify(key: String, after: Double, model: AppModel) async {
        guard let base = model.preferences.value.baseURL, let controller = model.notifications else { log("notify: not configured"); return }
        let client = DroverClient(baseURL: base, tokens: model.tokens, transport: URLSessionTransport())
        // An alert raised after this step started (plus `after` seconds), for up to 60 s; else the newest.
        let started = Date().addingTimeInterval(after - 1)
        var page: NotificationsPage?
        for _ in 0..<60 {
            page = try? await client.notifications(since: nil, wait: nil, limit: 50, token: .main)
            if page?.items.contains(where: { $0.keys?.isEmpty == false && $0.hash != nil && (ISODate.parse($0.at) ?? .distantPast) > started }) == true { break }
            try? await Task.sleep(for: .seconds(1))
        }
        guard let page else { log("notify: no page"); return }
        var item = page.items.reversed().first { $0.keys?.isEmpty == false && $0.hash != nil && (ISODate.parse($0.at) ?? .distantPast) > started }
            ?? page.items.reversed().first { $0.keys?.isEmpty == false && $0.hash != nil }
        log("notify: newest dialog alert is \(item.flatMap { ISODate.parse($0.at) }.map { Int(Date().timeIntervalSince($0)) }.map { "\($0) s old" } ?? "missing"), host \(item?.host ?? "none")")
        if item == nil, let w = model.store.summary?.waiting.first(where: { $0.keys?.isEmpty == false && $0.hash != nil }) {
            // No dialog alert in the feed right now: the same fields, as a dialog alert for that row carries them.
            log("notify: no alert carries dialog keys (\(page.items.count) items); using a waiting row's fields")
            var n = NotificationItem(id: "dev-\(UUID().uuidString)", at: ISO8601DateFormatter().string(from: Date()), kind: "decision",
                                     title: "\(w.name) needs a decision", body: w.headline, sessionId: w.id, host: w.host,
                                     category: "needs-you", test: nil)
            n.dialog = w.dialog; n.hash = w.hash; n.keys = w.keys; n.answer = w.answer
            item = n
        }
        guard let item else { log("notify: nothing to answer"); return }
        let planned = NotificationPlanner.plan([item], preferences: model.preferences.value, mutedUntil: nil, now: Date(), alreadyPosted: [])
        guard let note = planned.first else { log("notify: the planner skipped the alert"); return }
        log("notify: alert buttons \(note.actions.map(\.title)), category \(note.categoryID.hasPrefix("drover.dialog.") ? "dialog" : note.categoryID)")
        guard let action = note.actions.first(where: { $0.key == key }) else { log("notify: no \(key) button"); return }
        let outcome = await controller.respond(action: action.identifier, info: controller.userInfo(for: note))
        log("notify \(key): \(outcome?.message ?? "no outcome")")
        // What the session did with it: its last words.
        if let sid = item.sessionId {
            try? await Task.sleep(for: .seconds(2))
            struct Turns: Decodable { var turns: [TranscriptTurn] }
            let t = try? await client.call("sessions.transcript", args: ["id": .string(sid), "host": .string(item.host ?? "local"), "limit": 6], token: .main, as: Turns.self)
            log("notify \(key): the session's last reply: \(t?.turns.last(where: { $0.role == "assistant" && !($0.text ?? "").isEmpty })?.text ?? "none")")
        }
        // An alert from another server is refused before anything is sent.
        var foreign = controller.userInfo(for: note)
        foreign["server"] = "http://127.0.0.1:1"
        let refused = await controller.respond(action: action.identifier, info: foreign)
        log("notify \(key) from another server: \(refused?.message ?? "no outcome")")
    }

    /// The newest native.notifications item with an approval request, planned as the app would post it, then option
    /// `choice` pressed through NotificationController (the code a notification click runs); then the same press on
    /// an alert from another server, which must be refused before anything is sent.
    private static func notifyApproval(choice: Int, row: String?, model: AppModel) async {
        guard let base = model.preferences.value.baseURL, let controller = model.notifications else { log("notifyapproval: not configured"); return }
        let client = DroverClient(baseURL: base, tokens: model.tokens, transport: URLSessionTransport())
        let rows = (model.store.summary?.waiting ?? []).filter { row == nil || $0.name == row }
        let pending = Set(rows.compactMap { $0.approval?.id })
        let page = try? await client.notifications(since: nil, wait: nil, limit: 50, token: .main)
        guard let item = page?.items.reversed().first(where: { $0.approval.map { pending.contains($0.id) } ?? false }) else {
            log("notifyapproval: no alert carries a pending approval request (\(page?.items.count ?? 0) items)"); return
        }
        let planned = NotificationPlanner.plan([item], preferences: model.preferences.value, mutedUntil: nil, now: Date(), alreadyPosted: [])
        guard let note = planned.first else { log("notifyapproval: the planner skipped the alert"); return }
        log("notifyapproval: alert buttons \(note.approvalActions.map(\.title)), reply \(note.canReply), subtitle \(note.subtitle ?? "none"), category \(note.categoryID.hasPrefix(PlannedNotification.approvalCategoryPrefix) ? "approval" : note.categoryID)")
        guard let action = note.approvalActions.first(where: { $0.choice == choice }) else { log("notifyapproval: no option \(choice)"); return }
        func stillPending() async -> Bool {
            await model.store.refresh()
            return (model.store.summary?.waiting ?? []).contains { $0.approval?.id == note.approvalID }
        }
        var foreign = controller.userInfo(for: note)
        foreign["server"] = "http://127.0.0.1:1"
        await controller.respond(action: action.identifier, info: foreign)
        log("notifyapproval from another server: request still pending after it: \(await stillPending())")
        await controller.respond(action: action.identifier, info: controller.userInfo(for: note))
        log("notifyapproval \(choice): answered through the notification action; request still pending: \(await stillPending())")
    }

    private static func describe(_ mode: ApprovalRowMode?) -> String {
        switch mode {
        case .answer(let r)?: "buttons \(r.options.map { ApprovalFormat.title($0) })"
        case .review?: "review first"
        case .blocked(let why)?: "blocked: \(why)"
        case .closed(let why)?: "closed: \(why)"
        case nil: "none"
        }
    }

    private static func split(_ step: String) -> (String, String) {
        guard let i = step.firstIndex(of: ":") else { return (step, "") }
        return (String(step[..<i]), String(step[step.index(after: i)...]))
    }

    private static func phase(_ m: ManagerChat) -> String {
        switch m.reply?.phase {
        case .none: m.sending ? "sending" : "idle"
        case .waiting: "waiting"
        case .streaming: "streaming"
        case .done: "done"
        case .failed(let e): "failed (\(e))"
        }
    }

    private static func state(_ store: MenuBarStore) -> String {
        let s = store.summary
        let rows = (s?.waiting ?? []).map { w -> String in
            if w.approval != nil { return "approval[\(describe(store.approvalMode(for: w)))]" }
            switch store.answerPlan(for: w) {
            case .keys(_, let b): return "keys[\(b.map(\.key).joined(separator: ","))]"
            case .reply: return "reply"
            case .none: return "none"
            }
        }
        return "connection \(store.connection), waiting \(s?.totals.waiting ?? 0) \(rows), working \(s?.totals.working ?? 0), manager \(s?.manager.map { $0.up ? "up" : "down" } ?? "absent") \(phase(store.manager))"
    }

    private static func snapshot(_ name: String, store: MenuBarStore, actions: PopoverActions) async {
        guard let dir = DevEnvironment.snapshotDir else { log("snap \(name): set DROVER_DEV_SNAPSHOT"); return }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for dark in [false, true] {
            let url = dir.appendingPathComponent("\(name)-\(dark ? "dark" : "light").png")
            await SnapshotRenderer.render(PopoverView(store: store, actions: actions), width: 380, dark: dark, to: url)
            log("snap \(url.lastPathComponent)")
        }
    }
}
#endif

#if DROVER_DEV || DROVER_SNAPSHOT
import AppKit
import SwiftUI

/// Offscreen rendering of a SwiftUI view to a PNG (NSHostingView + cacheDisplay), for review without a
/// display grant or screen recording permission.
@MainActor
enum SnapshotRenderer {
    /// Lets SwiftUI lay out (a synchronous turn of the main run loop).
    static func spin(_ view: NSView) {
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.01))
        view.layoutSubtreeIfNeeded()
    }

    static func render<V: View>(_ view: V, width: CGFloat, dark: Bool, to url: URL) async {
        let host = NSHostingView(rootView: view)
        host.frame = CGRect(x: 0, y: 0, width: width, height: 720)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.contentView = host
        for _ in 0..<25 {
            try? await Task.sleep(for: .milliseconds(25))
            spin(host)
        }
        let fit = host.fittingSize
        host.frame = CGRect(x: 0, y: 0, width: width, height: max(120, min(900, fit.height)))
        window.setContentSize(host.frame.size)
        for _ in 0..<6 {
            try? await Task.sleep(for: .milliseconds(25))
            host.layoutSubtreeIfNeeded()
        }
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return }
        host.cacheDisplay(in: host.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: url)
    }
}
#endif
