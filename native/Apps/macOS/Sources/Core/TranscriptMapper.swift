import Foundation
import os

/// The fleet's owner as the daemon names them. This app writes as the generic actor `owner`, which the daemon records
/// as its configured owner (`DROVER_OWNER`), so a turn from either name is the owner's own and reads "you". The
/// configured name comes from the latest `native.summary` (`owner`); a daemon from before that field sends none, and
/// then only `owner` is the owner.
enum Owner {
    /// The actor this app sends on writes.
    static let alias = "owner"
    private static let configured = OSAllocatedUnfairLock<String?>(initialState: nil)

    /// Keep the owner a `native.summary` result names; a summary that names none forgets it.
    static func remember(summary: JSONValue) {
        let name = summary["owner"]?.text?.trimmingCharacters(in: .whitespaces).lowercased()
        configured.withLock { $0 = name?.isEmpty == false ? name : nil }
    }

    /// `owner`, or the name the latest summary gave (case-insensitive, as the daemon compares them).
    static func isOwner(_ actor: String) -> Bool {
        let a = actor.lowercased()
        return a == alias || a == configured.withLock { $0 }
    }
}

/// `sessions.transcript` result (and `turn` event payloads) -> TranscriptTurn. Pure apart from the owner's name
/// (`Owner`), harness-tested.
///
/// New daemons send tool calls as `{ id, name, input, summary }` and tool results as `results[]`
/// (`{ toolUseId, isError, text }`). Older ones send `{ name, input }` (input cut to 300 chars of JSON) and one
/// `text` per result turn, results joined by `\n---\n` with an `[error] ` prefix: the mapper fills the summary in
/// itself and splits the old text, so tool calls read the same on either.
enum TranscriptMapper {
    static func page(_ r: JSONValue) -> TranscriptPage {
        let thread = r["thread"]?.text
        var turns = r["turns"]?.array.enumerated().compactMap { i, t in turn(t, index: i, thread: thread) } ?? []
        // Ids made here (Codex and headless turns carry none) could repeat within a page: number the repeats, the
        // same way on every read, so rows keep stable, unique ids.
        var seen: [String: Int] = [:]
        for i in turns.indices {
            let n = seen[turns[i].id, default: 0]
            seen[turns[i].id] = n + 1
            if n > 0 { turns[i].id += "~\(n)" }
        }
        // Only Claude transcripts have a monotonic byte offset. Headless (last 300 events), Codex (offset 0) and
        // the OpenClaw manager (turns in the thread) return snapshots: re-read them whole.
        let incremental = r["engine"]?.text == "claude" && r["headless"]?.bool != true && (r["offset"]?.int ?? 0) > 0
        return TranscriptPage(turns: turns, offset: r["offset"]?.int, incremental: incremental, sent: r["turns"]?.array.count)
    }

    /// One turn. nil for turns that never render (empty thinking, streaming deltas).
    static func turn(_ t: JSONValue, index: Int = 0, thread: String? = nil) -> TranscriptTurn? {
        let wire = t["role"]?.text ?? ""
        var role = TurnRole(rawValue: wire) ?? .other
        if wire == "result" { role = .system }
        // Headless Codex streams deltas and then the whole message (item/completed): keep only the whole one.
        if t["delta"]?.bool == true { return nil }
        let tools = t["tools"]?.array.compactMap(toolCall) ?? []
        var text = t["text"]?.string ?? ""
        if role == .thinking && text.isEmpty && tools.isEmpty { return nil }
        var results: [ToolResult] = []
        if role == .toolResult {
            let wireResults = t["results"]?.array.compactMap(toolResult) ?? []
            results = wireResults.isEmpty ? legacyResults(text) : wireResults
        }
        var actor = actorName(t)
        if role == .user, let env = PeerEnvelope.parse(text) {
            text = env.body
            if actor == nil { actor = env.actor }
        }
        if wire == "result" { text = text.isEmpty ? "Finished" : text }
        if role == .user, text.isEmpty, let n = t["images"]?.int, n > 0 { text = n == 1 ? "(an image)" : "(\(n) images)" }
        let ts = t["ts"]?.date
        let content = text + tools.map { $0.id ?? $0.name }.joined() + results.map { $0.toolUseId ?? "" }.joined()
        let id = t["id"]?.text ?? t["uuid"]?.text ?? "\(role.rawValue)#\(t["ts"]?.string ?? "-")#\(fnv(content))#\(ts == nil ? String(index) : "")"
        return TranscriptTurn(
            id: id, role: role, text: text, ts: ts, tools: tools, meta: t["meta"]?.bool ?? false, results: results,
            actor: actor, pending: t["pending"]?.bool ?? false, inReplyTo: t["inReplyTo"]?.text,
            thread: t["thread"]?.text ?? thread, failed: t["error"].map { $0.isPresent && $0.bool != false } ?? false)
    }

    static func toolCall(_ v: JSONValue) -> ToolCall? {
        if let name = v.text, v.object == nil { return ToolCall(id: nil, name: name, summary: "", input: nil) }
        guard let name = v["name"]?.text else { return nil }
        let input = v["input"]
        let summary = v["summary"]?.text ?? ToolSummary.summary(name: name, input: input)
        return ToolCall(id: v["id"]?.text, name: name, summary: String(summary.prefix(200)),
                        input: input.flatMap { $0.isPresent ? $0.compactJSON : nil }, description: v["description"]?.text)
    }

    static func toolResult(_ v: JSONValue) -> ToolResult? {
        guard v.object != nil else { return nil }
        return ToolResult(toolUseId: (v["toolUseId"] ?? v["tool_use_id"])?.text, isError: v["isError"]?.bool ?? false,
                          text: v["text"]?.string ?? "", chars: v["chars"]?.int)
    }

    /// Old daemons: results joined by `\n---\n`, each prefixed `[error] ` when it failed.
    static func legacyResults(_ text: String) -> [ToolResult] {
        guard !text.isEmpty else { return [] }
        return text.components(separatedBy: "\n---\n").map { part in
            let err = part.hasPrefix("[error] ")
            return ToolResult(toolUseId: nil, isError: err, text: err ? String(part.dropFirst(8)) : part)
        }
    }

    /// Who sent a user turn: nil for the owner, else the name. A message relayed through the inbox says `via: "drover"`
    /// with the `actor` who typed it, or `via: "peer"` with the session it came `from`; the manager's turns carry
    /// `actor` or `user` (`drover:<owner>`, `drover:mcp:<thread>`).
    static func actorName(_ t: JSONValue) -> String? {
        if t["via"]?.text == "peer" { return t["from"]?.text ?? "another session" }
        guard var a = (t["actor"] ?? t["user"])?.text else { return nil }
        if a.hasPrefix("drover:") { a = String(a.dropFirst(7)) }
        if let colon = a.firstIndex(of: ":") { a = String(a[..<colon]) }   // drover:<actor>:<thread>
        return a.isEmpty || Owner.isOwner(a) ? nil : a
    }

    /// FNV-1a, for ids of turns the daemon sends without one (stable across runs, unlike `hashValue`).
    static func fnv(_ s: String) -> String {
        var h: UInt64 = 0xcbf29ce484222325
        for b in s.utf8 { h ^= UInt64(b); h = h &* 0x100000001b3 }
        return String(h, radix: 36)
    }
}

/// A message another session (or Drover for the owner) delivered through Claude's peer inbox:
/// `<cross-session-message from-name="drover (owner)">\nbody\n</cross-session-message>` (core/claude.js peerEnvelope).
enum PeerEnvelope {
    static let tag = "cross-session-message"

    static func parse(_ text: String) -> (actor: String?, body: String)? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("<\(tag)"), trimmed.hasSuffix("</\(tag)>"),
              let open = trimmed.firstIndex(of: ">") else { return nil }
        let head = trimmed[trimmed.startIndex..<open]
        var from: String?
        if let r = head.range(of: #"from-name="([^"]*)""#, options: .regularExpression) {
            from = String(head[r].dropFirst("from-name=\"".count).dropLast())
        }
        var body = String(trimmed[trimmed.index(after: open)..<trimmed.index(trimmed.endIndex, offsetBy: -("</\(tag)>".count))])
        body = body.replacingOccurrences(of: "<\\/\(tag)", with: "</\(tag)").trimmingCharacters(in: .newlines)
        return (actor(from), body)
    }

    /// `drover` and `drover (<the owner>)` are the owner through Drover; `drover (mcp)` is the MCP server; anything
    /// else names a session.
    static func actor(_ from: String?) -> String? {
        guard let from, !from.isEmpty else { return nil }
        if from == "drover" { return nil }
        if from.hasPrefix("drover (") && from.hasSuffix(")") {
            let who = String(from.dropFirst(8).dropLast())
            return Owner.isOwner(who) ? nil : who
        }
        return from
    }
}

/// One plain line per tool call, the daemon's rule (ux spec "Transcript tool calls"), for daemons that send none.
enum ToolSummary {
    static func summary(name: String, input: JSONValue?) -> String {
        guard let input, input.isPresent else { return "" }
        let s: String
        switch name {
        case "Bash", "shell", "local_shell", "bash", "exec_command", "container.exec":
            s = command(input)
        case "Read", "Edit", "MultiEdit", "Write", "NotebookEdit", "NotebookRead":
            s = field(input, ["file_path", "notebook_path", "path"])
        case "Grep", "Glob":
            let pattern = field(input, ["pattern"]), path = field(input, ["path"])
            s = pattern.isEmpty ? path : path.isEmpty ? "\"\(pattern)\"" : "\"\(pattern)\" in \(path)"
        case "Task", "Agent":
            s = field(input, ["description", "prompt"])
        case "WebFetch":
            s = field(input, ["url"])
        case "WebSearch":
            s = field(input, ["query"])
        case "TodoWrite":
            let n = input["todos"]?.array.count ?? 0
            s = n == 1 ? "1 item" : "\(n) items"
        case "apply_patch":
            s = patchFiles(field(input, ["input", "patch"]))
        default:
            s = firstString(input)
        }
        return String(shortenHome(oneLine(s)).prefix(200))
    }

    private static func command(_ input: JSONValue) -> String {
        if let argv = (input["command"] ?? input["cmd"])?.array, !argv.isEmpty {
            let parts = argv.compactMap(\.string)
            // ["bash", "-lc", "npm test"] -> npm test
            if parts.count >= 3, ["bash", "sh", "zsh"].contains((parts[0] as NSString).lastPathComponent), parts[1].hasPrefix("-") {
                return parts[2...].joined(separator: " ")
            }
            return parts.joined(separator: " ")
        }
        return field(input, ["command", "cmd"])
    }

    /// `input[key]` for the first key present. A string input is the old daemon's JSON cut to 300 chars: dig the
    /// value out of the text.
    static func field(_ input: JSONValue, _ keys: [String]) -> String {
        if case .string(let raw) = input {
            for k in keys {
                let pattern = "\"\(k)\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)"
                if let r = raw.range(of: pattern, options: .regularExpression) {
                    let m = String(raw[r])
                    guard let q = m.range(of: ":\\s*\"", options: .regularExpression) else { continue }
                    return unescape(String(m[q.upperBound...]))
                }
            }
            return ""
        }
        for k in keys { if let v = input[k]?.text { return v } }
        return ""
    }

    private static func firstString(_ input: JSONValue) -> String {
        if case .string(let raw) = input {
            guard let r = raw.range(of: #":\s*"((?:[^"\\]|\\.)*)"#, options: .regularExpression) else { return "" }
            let m = String(raw[r])
            guard let q = m.firstIndex(of: "\"") else { return "" }
            return unescape(String(m[m.index(after: q)...]).replacingOccurrences(of: "\"", with: ""))
        }
        guard let o = input.object else { return input.text ?? "" }
        for k in o.keys.sorted() { if let v = o[k]?.text, case .string = o[k] { return v } }
        return ""
    }

    private static func patchFiles(_ patch: String) -> String {
        let files = patch.split(separator: "\n").compactMap { line -> String? in
            for p in ["*** Update File: ", "*** Add File: ", "*** Delete File: "] where line.hasPrefix(p) { return String(line.dropFirst(p.count)) }
            return nil
        }
        return files.joined(separator: ", ")
    }

    private static func unescape(_ s: String) -> String {
        s.replacingOccurrences(of: "\\n", with: " ").replacingOccurrences(of: "\\\"", with: "\"")
            .replacingOccurrences(of: "\\\\", with: "\\")
    }

    static func oneLine(_ s: String) -> String {
        let first = s.split(separator: "\n", omittingEmptySubsequences: true).first.map(String.init) ?? ""
        let more = s.contains("\n") && first.count < s.trimmingCharacters(in: .whitespacesAndNewlines).count
        return first.trimmingCharacters(in: .whitespaces) + (more ? " …" : "")
    }

    /// `/Users/<name>/x` and `/home/<name>/x` -> `~/x`.
    static func shortenHome(_ s: String) -> String {
        s.replacingOccurrences(of: #"/(?:Users|home)/[^/\s]+"#, with: "~", options: .regularExpression)
    }
}
