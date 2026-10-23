import Foundation

/// Incremental Server-Sent Events parser (WHATWG rules that matter here: `event:`, `data:` joined by
/// newlines, blank line dispatches, `:` comments ignored, `id:`/`retry:` tolerated).
///
/// `skipData` names events whose payload the app never reads (an older daemon's 1.3 MB `fleet` every 20 s): they
/// still dispatch, with empty data, and their data lines are dropped unread (`isSkipping` lets the reader skip them
/// before building a String).
struct SSEParser: Sendable {
    struct Message: Equatable, Sendable {
        var event: String
        var data: String
    }

    var skipData: Set<String> = []
    private var event = ""
    private var data: [String] = []
    private var sawData = false

    init(skipData: Set<String> = []) { self.skipData = skipData }

    /// True while the current event's data is being dropped.
    var isSkipping: Bool { !event.isEmpty && skipData.contains(event) }

    /// Feed one line without its terminator. Returns a message when the line completes one.
    mutating func feed(line raw: String) -> Message? {
        let line = raw.hasSuffix("\r") ? String(raw.dropLast()) : raw
        if line.isEmpty {
            defer { event = ""; data = []; sawData = false }
            guard sawData else { return nil }
            return Message(event: event.isEmpty ? "message" : event, data: data.joined(separator: "\n"))
        }
        if line.hasPrefix(":") { return nil }
        let field: Substring, value: Substring
        if let colon = line.firstIndex(of: ":") {
            field = line[..<colon]
            var v = line[line.index(after: colon)...]
            if v.hasPrefix(" ") { v = v.dropFirst() }
            value = v
        } else {
            field = Substring(line); value = ""
        }
        switch field {
        case "event": event = String(value)
        case "data":
            sawData = true
            if !isSkipping { data.append(String(value)) }
        default: break
        }
        return nil
    }

    /// A data line of a skipped event, dropped without decoding it.
    mutating func skippedDataLine() { sawData = true }
}

/// Maps a raw SSE message to a ServerEvent, decoding its JSON where it runs (the SSE delegate queue, never the main
/// actor). Unknown names pass through as `.unknown`.
enum ServerEventMapper {
    /// What the Mac app subscribes to (ux spec "SSE: topics"). Older daemons ignore `topics` and send everything.
    static let topics = ["board", "alerts", "turn", "manager", "mutation", "settings"]
    /// Events whose data is never read: decoding them would be wasted work.
    static let skipData: Set<String> = ["fleet", "snapshot", "probe", "codex", "headless", "summary", "pair", "botauth"]

    static func map(_ m: SSEParser.Message) -> ServerEvent {
        let json: JSONValue = skipData.contains(m.event) || m.data.isEmpty ? .null : ((try? JSONValue.parse(Data(m.data.utf8))) ?? .null)
        switch m.event {
        case "hello": return .hello(host: json["host"]?.text, topics: json["topics"] != nil)
        case "mutation":
            let args = json["args"]
            return .mutation(op: json["op"]?.text ?? "", sessionId: (args?["id"] ?? args?["session"])?.text)
        case "alerts": return .alerts(json["items"]?.array.compactMap(notifyItem) ?? [])
        case "turn":
            let thread = json["thread"]?.text
            return .turn(TurnEvent(sessionId: json["id"]?.text, host: json["host"]?.text, thread: thread,
                                   turn: json["turn"].flatMap { TranscriptMapper.turn($0, thread: thread) }))
        case "board":
            // The event carries the native.board result; a daemon that wraps it as { result } works too.
            let r = json["strips"] != nil ? json : (json["result"] ?? json)
            guard r["strips"] != nil else { return .unknown(name: m.event) }
            return .board(BoardDecoder.snapshot(r))
        case "manager":
            return managerEvent(json).map(ServerEvent.manager) ?? .unknown(name: m.event)
        case "settings": return .settings
        case "snapshot", "fleet", "probe", "notify", "summary": return .changed(name: m.event)
        default: return .unknown(name: m.event)
        }
    }

    static func managerEvent(_ json: JSONValue) -> ManagerStreamEvent? {
        guard let turnId = (json["turnId"] ?? json["id"])?.text,
              let phase = json["phase"]?.text.flatMap(ManagerStreamEvent.Phase.init(rawValue:)) else { return nil }
        return ManagerStreamEvent(host: json["host"]?.text, thread: json["thread"]?.text ?? "main", turnId: turnId,
                                  inReplyTo: json["inReplyTo"]?.text, phase: phase, delta: json["delta"]?.string,
                                  text: json["text"]?.string, error: json["error"]?.text)
    }

    /// One alert (core/notify.js shape) or one `native.notifications` item.
    static func notifyItem(_ v: JSONValue) -> NotifyItem? {
        guard let title = v["title"]?.text else { return nil }
        // SSE `alerts` may include muted ones (native.notifications already drops them).
        if let muted = v["muted"], muted != .null, muted.bool != false { return nil }
        let id = v["id"]?.text ?? v["key"]?.text ?? "\(title)|\(v["ts"]?.string ?? "")"
        let dialog = BoardDecoder.dialogInfo(v["dialog"])
        let held = v["held"].map { $0.isPresent && $0.bool != false } ?? (v["category"]?.text == "held")
        let answer = v["answer"]?.text.flatMap(AnswerMode.init(rawValue:))
        var keys = v["keys"]?.strings ?? []
        // A dialog alert from a daemon that predates `keys`: what every dialog takes.
        if keys.isEmpty, answer != .reply, v["hash"]?.text != nil, dialog != nil || held { keys = held ? ["Enter", "Escape"] : DialogKeys.defaultKeys(dialog) }
        return NotifyItem(
            id: id,
            at: (v["ts"] ?? v["at"])?.date ?? Date(),
            category: NotifyCategory(wire: v["category"]?.text),
            kind: v["kind"]?.text ?? "",
            title: title,
            body: v["body"]?.string ?? v["message"]?.string ?? "",
            sessionId: v["sessionId"]?.text,
            host: v["host"]?.text,
            tmuxTarget: (v["target"] ?? v["tmuxTarget"] ?? v["tmux"])?.text,
            test: v["test"]?.bool ?? false,
            dialog: dialog,
            hash: v["hash"]?.text,
            keys: keys,
            answerMode: answer ?? (keys.isEmpty ? nil : .keys),
            held: held
        )
    }
}
