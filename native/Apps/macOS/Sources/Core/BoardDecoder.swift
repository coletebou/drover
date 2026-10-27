import Foundation

/// `native.board` result (and the SSE `board` event, which carries the same object) -> BoardSnapshot. Pure.
///
/// `{ generatedAt, hosts: [{ name, up, waiting, working, idle, error?, stale? }], strips: [...], totals,
///    manager: { up, host?, lastNoteAt } }`, strips in board order (ux spec "native.board").
enum BoardDecoder {
    static func snapshot(_ r: JSONValue, now: Date = Date()) -> BoardSnapshot {
        let hosts = r["hosts"]?.array.compactMap(host) ?? []
        let sessions = r["strips"]?.array.compactMap(strip) ?? []
        let m = r["manager"]
        let manager = ManagerInfo(up: m?["up"]?.bool ?? false, host: m?["host"]?.text, lastNoteAt: m?["lastNoteAt"]?.date)
        return BoardSnapshot(generatedAt: r["generatedAt"]?.date ?? now, hosts: hosts, sessions: sessions,
                             usedNativeSummary: true, manager: manager, source: .board)
    }

    static func host(_ h: JSONValue) -> HostItem? {
        guard let name = (h["name"] ?? h["host"])?.text else { return nil }
        return HostItem(name: name, up: h["up"]?.bool ?? true, waiting: h["waiting"]?.int ?? 0,
                        working: h["working"]?.int ?? 0, idle: h["idle"]?.int ?? 0, error: h["error"]?.text,
                        stale: h["stale"].map { $0.isPresent && $0.bool != false } ?? false)
    }

    static func strip(_ s: JSONValue) -> SessionItem? {
        guard let id = s["id"]?.text, let host = s["host"]?.text else { return nil }
        let lane: Lane = switch s["lane"]?.text {
        case "wait": .waiting
        case "work": .working
        default: .idle
        }
        let kind = s["kind"]?.text ?? "session"
        let sessionId = s["sessionId"]?.text
        let ask = s["ask"]
        let askKind = ask?["kind"]?.text
        let dialog = dialogInfo(s["dialog"])
        let held = s["held"]?.bool ?? false
        var keys = s["keys"]?.strings ?? []
        let answer = s["answer"]?.text.flatMap(AnswerMode.init(rawValue:))
        let approval = approvalInfo(s["approval"])
        // A daemon without `keys` (the fleet fallback has none either): the options and Enter / Escape.
        if keys.isEmpty, answer != .reply, approval == nil, dialog != nil || held { keys = DialogKeys.defaultKeys(dialog) }
        let finished = s["finished"].flatMap { f -> FinishedNote? in
            guard let t = f["text"]?.text else { return nil }
            return FinishedNote(text: t, at: f["ts"]?.date)
        }
        return SessionItem(
            id: id,
            name: s["name"]?.text ?? s["windowName"]?.text ?? String(id.prefix(8)),
            host: host,
            engine: s["engine"]?.text ?? "unknown",
            status: s["status"]?.text?.lowercased() ?? (lane == .working ? "busy" : "idle"),
            cwd: s["cwd"]?.text,
            tmuxTarget: s["tmux"]?.text.map(BoardBuilder.stripPane),
            live: true,
            updatedAt: s["since"]?.date,
            lane: lane,
            waitKind: lane == .waiting ? (askKind == "question" ? .question : .decision) : nil,
            headline: (s["headline"]?.text ?? ask?["text"]?.text ?? s["tail"]?.strings.last).map { String($0.prefix(140)) },
            // A window strip whose agent matched no session is drawn faded; one with a session has it as `id`.
            windowOnly: kind == "window" && (s["faded"]?.bool ?? (sessionId == nil && id.contains(":"))),
            sessionId: sessionId != id ? sessionId : nil,
            screen: s["screen"]?.text.flatMap(ScreenState.init(rawValue:)) ?? .unknown,
            dialog: dialog,
            hash: s["hash"]?.text,
            keys: keys,
            answerMode: approval != nil ? .approval : answer ?? (lane == .waiting && !keys.isEmpty ? .keys : nil),
            held: held,
            heldFrom: s["heldFrom"]?.text,
            askLabel: ask?["label"]?.text,
            askText: ask?["text"]?.text,
            tail: s["tail"]?.strings ?? [],
            finished: finished,
            windowName: s["windowName"]?.text,
            approval: approval,
            moreApprovals: max(0, s["moreApprovals"]?.int ?? 0))
    }

    /// `approval {id, bot, kind, question, options[{n, label}], details?, createdAt, expiresAt}` on strips and alerts.
    /// An id is all it needs; a malformed or repeated option is dropped; anything else malformed reads as absent.
    static func approvalInfo(_ v: JSONValue?) -> ApprovalInfo? {
        guard let v, v.object != nil, let id = v["id"]?.text else { return nil }
        var seen = Set<Int>()
        let options = (v["options"]?.array ?? []).compactMap { o -> ApprovalOption? in
            let n: Int?
            switch o["n"] {
            case .number(let d)?: n = d == d.rounded() ? Int(exactly: d) : nil
            case .string(let s)?: n = Int(s.trimmingCharacters(in: .whitespaces))
            default: n = nil
            }
            guard let n, n >= 1, seen.insert(n).inserted else { return nil }
            return ApprovalOption(n: n, label: o["label"]?.string ?? "")
        }
        // complete only as a JSON boolean: anything else (or nothing, an older daemon) reads as not complete.
        let complete: Bool? = if case .bool(let b)? = v["complete"] { b } else { nil }
        return ApprovalInfo(id: id, bot: v["bot"]?.text, kind: v["kind"]?.text, question: v["question"]?.string ?? "",
                            options: options, details: v["details"]?.text, createdAt: v["createdAt"]?.date,
                            expiresAt: v["expiresAt"]?.date, complete: complete, status: v["status"]?.text,
                            decisionLabel: v["decision"]?["label"]?.text, via: v["via"]?.text)
    }

    static func dialogInfo(_ v: JSONValue?) -> DialogInfo? {
        guard let v, v.object != nil else { return nil }
        let options = v["options"]?.array.compactMap { o -> DialogOption? in
            guard let n = o["n"]?.int, let label = o["label"]?.text else { return nil }
            return DialogOption(n: n, label: label, selected: o["selected"]?.bool ?? false)
        } ?? []
        let question = v["question"]?.text
        if question == nil && options.isEmpty { return nil }
        return DialogInfo(question: question, options: options)
    }
}
