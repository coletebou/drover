import Foundation

/// What Chat draws, one row per item, built from transcript turns by `ChatLayout` (ux spec "Chat rendering").
enum ChatItem: Identifiable, Hashable, Sendable {
    case user(UserMessage)
    case text(AssistantText)
    case tools(ToolGroup)
    case notice(Notice)

    var id: String {
        switch self {
        case .user(let m): m.id
        case .text(let t): t.id
        case .tools(let g): g.id
        case .notice(let n): n.id
        }
    }
}

struct UserMessage: Hashable, Sendable {
    var id: String
    var text: String
    /// nil: the owner ("you"). Else who sent it (`mcp`, a bot, another session).
    var sender: String?
    var ts: Date?
    var meta: Bool
    var pending: Bool
    var failed: Bool
}

struct AssistantText: Hashable, Sendable {
    var id: String
    var blocks: [MarkdownBlock]
    var ts: Date?
    /// A manager reply still streaming.
    var pending: Bool
    var failed: Bool
}

/// One tool call with its result (attached by `toolUseId`, or in order on daemons that predate ids).
struct ToolRow: Hashable, Sendable, Identifiable {
    var id: String
    var name: String
    var summary: String
    var input: String?
    /// Bash's own one-line purpose, when the agent gave one.
    var description: String? = nil
    var result: ToolResult?
    var isError: Bool { result?.isError ?? false }
}

/// A run of tool-only assistant turns: "Ran 3 commands, read 2 files", expandable to one row per call.
struct ToolGroup: Hashable, Sendable {
    var id: String
    var rows: [ToolRow]
    var title: String
    var hasError: Bool
    var ts: Date?
    /// The last call has no result yet (still running while the session works).
    var awaitingResult: Bool
}

struct Notice: Hashable, Sendable {
    enum Kind: Sendable { case queue, title, system }
    var id: String
    var kind: Kind
    var text: String
    var ts: Date?
}

/// Turns -> chat items. Pure: runs off the main actor (ChatModel), with a Markdown cache so an update only parses the
/// turns it has not seen.
enum ChatLayout {
    struct Options: Sendable {
        /// Meta user turns, queued messages and titles (Settings > General).
        var showHidden = false
    }

    /// turn id -> (text, blocks), carried between builds.
    typealias Cache = [String: (text: String, blocks: [MarkdownBlock])]

    static func build(_ turns: [TranscriptTurn], options: Options = Options(), cache: Cache = [:]) -> (items: [ChatItem], cache: Cache) {
        // Pass 1: every result, keyed by its call. A result without an id takes the oldest call still waiting.
        var results: [String: ToolResult] = [:]
        var waiting: [String] = []
        for t in turns {
            if t.role == .assistant {
                for (i, call) in t.tools.enumerated() { waiting.append(callKey(call, t, i)) }
            } else if t.role == .toolResult {
                for r in t.results {
                    if let id = r.toolUseId {
                        results[id] = r
                        if let at = waiting.firstIndex(of: id) { waiting.remove(at: at) }
                    } else if !waiting.isEmpty {
                        results[waiting.removeFirst()] = r
                    }
                }
            }
        }

        // Pass 2: items.
        var items: [ChatItem] = []
        var newCache: Cache = [:]
        var group: ToolGroup?
        func close() {
            guard var g = group else { return }
            g.title = title(g.rows.map(\.name))
            g.hasError = g.rows.contains(where: \.isError)
            g.awaitingResult = g.rows.last?.result == nil
            items.append(.tools(g))
            group = nil
        }
        for t in turns {
            let blank = t.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            switch t.role {
            case .user:
                if blank || (t.meta && !options.showHidden) { continue }
                close()
                if let notice = commandNotice(t) { items.append(.notice(notice)); continue }
                items.append(.user(UserMessage(id: t.id, text: t.text.trimmingCharacters(in: .newlines), sender: t.actor,
                                               ts: t.ts, meta: t.meta, pending: t.pending, failed: t.failed)))
            case .assistant:
                if !blank || (t.pending && t.tools.isEmpty) {
                    close()
                    let blocks: [MarkdownBlock]
                    if let hit = cache[t.id], hit.text == t.text { blocks = hit.blocks } else { blocks = Markdown.blocks(t.text) }
                    newCache[t.id] = (t.text, blocks)
                    items.append(.text(AssistantText(id: t.id, blocks: blocks, ts: t.ts, pending: t.pending, failed: t.failed)))
                }
                if !t.tools.isEmpty {
                    if group == nil { group = ToolGroup(id: "tools-\(t.id)", rows: [], title: "", hasError: false, ts: t.ts, awaitingResult: false) }
                    for (i, call) in t.tools.enumerated() {
                        let key = callKey(call, t, i)
                        group?.rows.append(ToolRow(id: key, name: call.name, summary: call.summary, input: call.input,
                                                   description: call.description, result: results[key]))
                    }
                }
            case .toolResult, .thinking:
                // Results are attached to their calls; thinking is not shown. Neither ends a run of calls.
                continue
            case .title, .queue:
                guard options.showHidden, !blank else { continue }
                close()
                items.append(.notice(Notice(id: t.id, kind: t.role == .title ? .title : .queue, text: t.text, ts: t.ts)))
            case .system, .other:
                guard !blank else { continue }
                close()
                items.append(.notice(Notice(id: t.id, kind: .system, text: t.text, ts: t.ts)))
            }
        }
        close()
        return (items, newCache)
    }

    private static func callKey(_ call: ToolCall, _ t: TranscriptTurn, _ i: Int) -> String { call.id ?? "\(t.id)#\(i)" }

    /// Claude Code's slash-command echoes (`<command-name>/clear</command-name>`) read as notices, not as messages.
    private static func commandNotice(_ t: TranscriptTurn) -> Notice? {
        let s = t.text
        guard s.hasPrefix("<command-name>") || s.hasPrefix("<local-command-stdout>") || s.hasPrefix("<command-message>") else { return nil }
        func inner(_ tag: String) -> String? {
            guard let a = s.range(of: "<\(tag)>"), let b = s.range(of: "</\(tag)>", range: a.upperBound..<s.endIndex) else { return nil }
            return String(s[a.upperBound..<b.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if let name = inner("command-name") {
            let args = inner("command-args").flatMap { $0.isEmpty ? nil : " \($0)" } ?? ""
            return Notice(id: t.id, kind: .system, text: "Ran \(name)\(args)", ts: t.ts)
        }
        if let out = inner("local-command-stdout") { return out.isEmpty ? nil : Notice(id: t.id, kind: .system, text: out, ts: t.ts) }
        return Notice(id: t.id, kind: .system, text: inner("command-message") ?? s, ts: t.ts)
    }

    // MARK: group titles

    enum Verb: Hashable {
        case commands, reads, edits, searches, fetches, agents, todos
        case other(String)
    }

    static func verb(_ name: String) -> Verb {
        switch name {
        case "Bash", "shell", "local_shell", "bash", "exec_command", "container.exec", "unified_exec": .commands
        case "Read", "NotebookRead", "read_file", "view_image": .reads
        case "Edit", "MultiEdit", "Write", "NotebookEdit", "apply_patch", "str_replace_based_edit_tool": .edits
        case "Grep", "Glob", "grep", "glob", "search": .searches
        case "WebFetch", "WebSearch", "web_search", "web_fetch": .fetches
        case "Task", "Agent": .agents
        case "TodoWrite", "update_plan": .todos
        default: .other(name)
        }
    }

    /// "Ran 3 commands, read 2 files", in the order the verbs first appear.
    static func title(_ names: [String]) -> String {
        var order: [Verb] = []
        var counts: [Verb: Int] = [:]
        for n in names {
            let v = verb(n)
            if counts[v] == nil { order.append(v) }
            counts[v, default: 0] += 1
        }
        let parts = order.map { v -> String in
            let n = counts[v] ?? 0
            switch v {
            case .commands: return n == 1 ? "ran 1 command" : "ran \(n) commands"
            case .reads: return n == 1 ? "read 1 file" : "read \(n) files"
            case .edits: return n == 1 ? "edited 1 file" : "edited \(n) files"
            case .searches: return n == 1 ? "searched once" : "searched \(n) times"
            case .fetches: return n == 1 ? "fetched 1 page" : "fetched \(n) pages"
            case .agents: return n == 1 ? "ran 1 agent" : "ran \(n) agents"
            case .todos: return "updated the todo list"
            case .other(let name): return n == 1 ? "used \(name)" : "used \(name) \(n) times"
            }
        }
        let s = parts.joined(separator: ", ")
        return s.prefix(1).uppercased() + s.dropFirst()
    }
}
