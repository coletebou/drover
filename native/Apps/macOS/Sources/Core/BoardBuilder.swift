import Foundation

/// Pure mapping from daemon JSON to a BoardSnapshot, for daemons without `native.board` (BoardDecoder handles that).
/// Kept free of I/O so the harness can test it.
///
/// Inputs:
/// - `fleet`: `fleet.summary` result `{ ts, hosts:[{ host, ok, error?, sessions:[...], windows:[{ target, agent:{sessionId},
///   screen:{state}, dialog?, hash?, held?, tail? }] }] }`
/// - `native`: optional `native.summary` result (CONTRACT.md). When present its waiting/working lists win.
///
/// Lanes follow the web UI (Drover ui/lanes.js), which `native.summary` also uses:
/// - With `native` present it is authoritative: in native.waiting -> waiting (kind + headline), in native.working ->
///   working, anything else idle.
/// - Without it (older daemons): its tmux window shows a dialog -> waiting (decision); status `busy`, window busy,
///   or a Codex thread `active`/`running` -> working; else idle. Statuses like `blocked` do NOT mean waiting on you.
/// Only live sessions are shown (plus any session native lists). A window's dialog, hash and held message ride along,
/// so the answer buttons work on these daemons too (keys: the option digits, Enter, Escape).
enum BoardBuilder {

    private struct Window {
        var state: ScreenState
        var target: String
        var dialog: DialogInfo?
        var hash: String?
        var held: Bool
        var heldFrom: String?
        var tail: [String]
        var name: String?
    }

    static func build(fleet: JSONValue, native: JSONValue?, now: Date = Date()) -> BoardSnapshot {
        var waitingByKey: [String: (WaitKind?, String?)] = [:]
        var workingByKey: [String: String?] = [:]
        /// native items by key, to add the ones no session record matches (agents seen only as tmux windows).
        var nativeItems: [String: (Lane, JSONValue)] = [:]
        var consumed = Set<String>()
        if let native {
            for w in native["waiting"]?.array ?? [] {
                guard let id = w["id"]?.text else { continue }
                let key = "\(w["host"]?.text ?? "")|\(id)"
                waitingByKey[key] = (w["kind"]?.text.flatMap(WaitKind.init(rawValue:)), w["headline"]?.text)
                nativeItems[key] = (.waiting, w)
            }
            for w in native["working"]?.array ?? [] {
                guard let id = w["id"]?.text else { continue }
                let key = "\(w["host"]?.text ?? "")|\(id)"
                workingByKey[key] = w["headline"]?.text
                if nativeItems[key] == nil { nativeItems[key] = (.working, w) }
            }
        }

        var hosts: [HostItem] = []
        var sessions: [SessionItem] = []
        for h in fleet["hosts"]?.array ?? [] {
            guard let hostName = h["host"]?.text else { continue }
            var windowBySession: [String: Window] = [:]
            for w in h["windows"]?.array ?? [] {
                guard let sid = w["agent"]?["sessionId"]?.text, let target = w["target"]?.text else { continue }
                var state = w["screen"]?["state"]?.text.flatMap(ScreenState.init(rawValue:)) ?? .unknown
                // A held peer message waits on you like a dialog does (web ui/lanes.js).
                let held = w["held"].map { $0.isPresent && $0.bool != false } ?? false
                if held { state = .dialog }
                windowBySession[sid] = Window(state: state, target: target, dialog: BoardDecoder.dialogInfo(w["dialog"]),
                                              hash: w["hash"]?.text, held: held, heldFrom: w["heldFrom"]?.text,
                                              tail: w["tail"]?.strings ?? [], name: w["name"]?.text)
            }
            var counts = (waiting: 0, working: 0, idle: 0)
            for s in h["sessions"]?.array ?? [] {
                guard let id = (s["id"] ?? s["sessionId"] ?? s["threadId"])?.text else { continue }
                let status = s["status"]?.text?.lowercased() ?? "unknown"
                let live = s["live"]?.bool ?? (s["alive"]?.bool ?? false)
                // native.* items carry `sessionId ?? id`; match either.
                let keys = Set([id, s["sessionId"]?.text].compactMap { $0 }.map { "\(hostName)|\($0)" })
                let nativeWait = keys.lazy.compactMap { waitingByKey[$0] }.first
                let nativeWork = keys.lazy.compactMap { workingByKey[$0] }.first
                guard live || nativeWait != nil || nativeWork != nil else { continue }
                consumed.formUnion(keys)
                let window = windowBySession[id] ?? s["sessionId"]?.text.flatMap { windowBySession[$0] }
                let engine = s["engine"]?.text ?? s["kind"]?.text ?? "unknown"
                var lane: Lane = .idle
                var kind: WaitKind?
                var headline: String?
                if let w = nativeWait {
                    lane = .waiting; kind = w.0 ?? .decision; headline = w.1
                } else if let wk = nativeWork {
                    lane = .working; headline = wk
                } else if native == nil {
                    if window?.state == .dialog {
                        lane = .waiting; kind = .decision
                    } else if status == "busy" || window?.state == .busy
                                || (engine == "codex" && (status.contains("active") || status.contains("running"))) {
                        lane = .working
                    }
                }
                switch lane {
                case .waiting: counts.waiting += 1
                case .working: counts.working += 1
                case .idle: counts.idle += 1
                }
                let tmux = (s["tmux"]?.text).map(stripPane) ?? window?.target
                var item = SessionItem(
                    id: id,
                    name: s["name"]?.text ?? s["slug"]?.text ?? s["preview"]?.text.map { String($0.prefix(40)) } ?? String(id.prefix(8)),
                    host: hostName,
                    engine: engine,
                    status: status,
                    cwd: s["cwd"]?.text,
                    tmuxTarget: tmux,
                    live: live,
                    updatedAt: (s["statusUpdatedAt"] ?? s["updatedAt"] ?? s["mtime"] ?? s["startedAt"])?.date,
                    lane: lane,
                    waitKind: kind,
                    headline: headline.map { String($0.prefix(140)) }
                )
                if let window { apply(window, to: &item, waiting: lane == .waiting) }
                sessions.append(item)
            }
            // Window-only agents (no session record): native lists them with the tmux target as id.
            for (key, (lane, w)) in nativeItems where !consumed.contains(key) && w["host"]?.text == hostName {
                guard let id = w["id"]?.text else { continue }
                consumed.insert(key)
                // Its id is the agent's session id when the window knows one, else the tmux target itself.
                let window = windowBySession[id]
                let target = window?.target ?? (id.contains(":") ? id : nil)
                if lane == .waiting { counts.waiting += 1 } else { counts.working += 1 }
                var item = SessionItem(
                    id: id, name: w["name"]?.text ?? id, host: hostName, engine: w["engine"]?.text ?? "unknown",
                    status: lane == .waiting ? "waiting" : "busy", cwd: nil,
                    tmuxTarget: target, live: true, updatedAt: w["since"]?.date, lane: lane,
                    waitKind: lane == .waiting ? (w["kind"]?.text.flatMap(WaitKind.init(rawValue:)) ?? .decision) : nil,
                    headline: w["headline"]?.text.map { String($0.prefix(140)) }, windowOnly: window == nil)
                if let window { apply(window, to: &item, waiting: lane == .waiting) }
                sessions.append(item)
            }
            hosts.append(HostItem(name: hostName, up: h["ok"]?.bool ?? true,
                                  waiting: counts.waiting, working: counts.working, idle: counts.idle,
                                  error: h["error"]?.text))
        }
        sessions.sort(by: order)
        let m = native?["manager"]
        let managerUp = m?["up"]?.bool ?? sessions.contains { $0.isManager && $0.live }
        let managerHost = sessions.first(where: \.isManager)?.host
        return BoardSnapshot(generatedAt: fleet["ts"]?.date ?? now, hosts: hosts, sessions: sessions,
                             usedNativeSummary: native != nil,
                             manager: ManagerInfo(up: managerUp, host: managerHost, lastNoteAt: m?["lastNoteAt"]?.date),
                             source: .fleet)
    }

    /// A window's screen facts onto its session; the dialog only while the session waits on it.
    private static func apply(_ w: Window, to item: inout SessionItem, waiting: Bool) {
        item.screen = w.state
        item.tail = w.tail
        item.windowName = w.name
        guard waiting, w.state == .dialog || w.held else { return }
        item.dialog = w.dialog
        item.hash = w.hash
        item.held = w.held
        item.heldFrom = w.heldFrom
        item.keys = w.held ? ["Enter", "Escape"] : DialogKeys.defaultKeys(w.dialog)
        item.answerMode = .keys
    }

    /// `work:3.%12` -> `work:3` (the server's own normalisation for window targets).
    static func stripPane(_ t: String) -> String {
        guard let r = t.range(of: #"\.%\d+$"#, options: .regularExpression) else { return t }
        return String(t[..<r.lowerBound])
    }

    /// Lane order, then most recently updated first, then name.
    static func order(_ a: SessionItem, _ b: SessionItem) -> Bool {
        let la = Lane.allCases.firstIndex(of: a.lane)!, lb = Lane.allCases.firstIndex(of: b.lane)!
        if la != lb { return la < lb }
        let ta = a.updatedAt ?? .distantPast, tb = b.updatedAt ?? .distantPast
        if ta != tb { return ta > tb }
        return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
    }
}
