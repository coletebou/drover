import Foundation

// Transcript turns -> chat rows (ux spec "Chat rendering"): tool calls with summaries, results attached by id, groups and
// their titles, blank text dropped, thinking hidden, Markdown blocks.
@MainActor
enum TranscriptTests {
    static func call(_ id: String?, _ name: String, _ summary: String = "") -> ToolCall { ToolCall(id: id, name: name, summary: summary, input: nil) }
    static func assistant(_ id: String, _ text: String = "", tools: [ToolCall] = []) -> TranscriptTurn {
        TranscriptTurn(id: id, role: .assistant, text: text, ts: nil, tools: tools, meta: false)
    }
    static func result(_ id: String, _ results: [ToolResult]) -> TranscriptTurn {
        TranscriptTurn(id: id, role: .toolResult, text: "", ts: nil, tools: [], meta: false, results: results)
    }
    static func user(_ id: String, _ text: String, meta: Bool = false) -> TranscriptTurn {
        TranscriptTurn(id: id, role: .user, text: text, ts: nil, tools: [], meta: meta)
    }

    static func run() async {
        await T.suite("TranscriptMapper: tool calls and results (new daemon)") {
            let page = TranscriptMapper.page(T.json(#"""
            {"engine":"claude","offset":900,"turns":[
              {"role":"assistant","uuid":"a1","text":"","tools":[{"id":"tu1","name":"Bash","input":{"command":"npm test","description":"Run the unit tests"},"summary":"npm test","description":"Run the unit tests"}]},
              {"role":"tool_result","uuid":"r1","count":1,"text":"[error] old text","results":[{"toolUseId":"tu1","isError":true,"text":"1 failed","chars":5400}]},
              {"role":"user","uuid":"u1","text":"go on","meta":false,"via":"drover","actor":"owner"},
              {"role":"user","uuid":"u2","text":"from a peer","via":"peer","from":"demo-review"},
              {"role":"user","uuid":"u3","text":"","images":2},
              {"role":"assistant","uuid":"a2","text":"x","delta":true},
              {"role":"result","text":"","cost":0.1}
            ]}
            """#))
            T.check(page.incremental, "claude with an offset")
            T.eq(page.turns.count, 6, "the streaming delta is dropped")
            let a = page.turns[0]
            T.eq(a.tools.first, ToolCall(id: "tu1", name: "Bash", summary: "npm test", input: #"{"command":"npm test","description":"Run the unit tests"}"#, description: "Run the unit tests"))
            T.eq(page.turns[1].results, [ToolResult(toolUseId: "tu1", isError: true, text: "1 failed", chars: 5400)], "results[] win over the old text")
            T.eq(page.turns[2].actor, nil, "the owner through Drover reads as you")
            T.eq(page.turns[3].actor, "demo-review", "a peer is named")
            T.eq(page.turns[4].text, "(2 images)")
            T.eq(page.turns[5].role, .system); T.eq(page.turns[5].text, "Finished")
        }
        await T.suite("TranscriptMapper: an older daemon's tools and results") {
            let page = TranscriptMapper.page(T.json(#"""
            {"engine":"claude","offset":10,"turns":[
              {"role":"assistant","uuid":"a1","text":"","tools":[{"name":"Read","input":{"file_path":"/Users/someone/code/demo/src/parser.ts"}},{"name":"Bash","input":"{\"command\":\"npm run build && npm test\",\"description\":\"Build and t…"}]},
              {"role":"tool_result","uuid":"r1","count":2,"text":"file body\n---\n[error] build failed"}
            ]}
            """#))
            let tools = page.turns[0].tools
            T.eq(tools.map(\.summary), ["~/code/demo/src/parser.ts", "npm run build && npm test"], "summaries computed here, home as ~, cut JSON dug out")
            T.eq(tools.map(\.id), [nil, nil])
            T.eq(page.turns[1].results, [ToolResult(toolUseId: nil, isError: false, text: "file body"),
                                         ToolResult(toolUseId: nil, isError: true, text: "build failed")], "old text split per result")
        }
        await T.suite("TranscriptMapper: ids for turns that come without one") {
            let page = TranscriptMapper.page(T.json(#"""
            {"engine":"codex","offset":0,"turns":[
              {"role":"assistant","ts":"2026-10-20T19:00:00.000Z","text":"","tools":[{"id":"c1","name":"shell","input":{"command":["ls"]}}]},
              {"role":"assistant","ts":"2026-10-20T19:00:00.000Z","text":"","tools":[{"id":"c2","name":"shell","input":{"command":["pwd"]}}]},
              {"role":"assistant","ts":"2026-10-20T19:00:01.000Z","text":"same"},
              {"role":"assistant","ts":"2026-10-20T19:00:01.000Z","text":"same"}
            ]}
            """#))
            T.check(!page.incremental, "codex pages are snapshots")
            T.eq(Set(page.turns.map(\.id)).count, 4, "unique ids within a page")
            T.eq(TranscriptMapper.page(T.json(#"{"turns":[{"role":"assistant","ts":"2026-10-20T19:00:01.000Z","text":"same"},{"role":"assistant","ts":"2026-10-20T19:00:01.000Z","text":"same"}]}"#)).turns.map(\.id),
                 page.turns.suffix(2).map(\.id), "the same on every read")
        }
        await T.suite("TranscriptMapper: peer envelopes in user text") {
            let t = TranscriptMapper.turn(T.json(#"{"role":"user","uuid":"u","text":"<cross-session-message from-name=\"drover (owner)\">\nRun the tests\n</cross-session-message>"}"#))
            T.eq(t?.text, "Run the tests"); T.eq(t?.actor, nil)
            let p = TranscriptMapper.turn(T.json(#"{"role":"user","uuid":"u","text":"<cross-session-message from-name=\"demo-review\">\nDone\n</cross-session-message>"}"#))
            T.eq(p?.actor, "demo-review")
            let mcp = TranscriptMapper.turn(T.json(#"{"role":"user","uuid":"u","text":"<cross-session-message from-name=\"drover (mcp)\">\nhi\n</cross-session-message>"}"#))
            T.eq(mcp?.actor, "mcp")
            T.eq(TranscriptMapper.turn(T.json(#"{"role":"user","id":"m","text":"x","user":"drover:mcp:release"}"#))?.actor, "mcp", "manager user field")
        }
        await T.suite("Owner: the name the latest native.summary gives reads as you") {
            @MainActor func who(_ json: String) -> String? { TranscriptMapper.turn(T.json(json))?.actor }
            let alice = #"{"role":"user","uuid":"u","text":"hi","actor":"alice"}"#
            T.eq(who(alice), "alice", "no summary named an owner: alice is someone else")
            Owner.remember(summary: T.json(#"{"owner":"Alice","waiting":[]}"#))
            T.eq(who(alice), nil, "the summary's owner is you, in any case")
            T.eq(who(#"{"role":"user","uuid":"u","text":"x","user":"drover:alice"}"#), nil, "manager user field")
            T.eq(who(#"{"role":"user","uuid":"u","text":"<cross-session-message from-name=\"drover (alice)\">\nhi\n</cross-session-message>"}"#), nil, "peer envelope")
            T.eq(who(#"{"role":"user","uuid":"u","text":"hi","actor":"owner"}"#), nil, "the generic actor still is")
            T.eq(who(#"{"role":"user","uuid":"u","text":"hi","actor":"mcp"}"#), "mcp")
            Owner.remember(summary: T.json(#"{"waiting":[]}"#))
            T.eq(who(alice), "alice", "a summary from an older daemon (no owner) forgets the name")
        }
        await T.suite("ToolSummary, the daemon's rule for daemons that send none") {
            @MainActor func s(_ name: String, _ json: String) -> String { ToolSummary.summary(name: name, input: T.json(json)) }
            T.eq(s("Bash", #"{"command":"npm test\nnpm run lint"}"#), "npm test …")
            T.eq(s("Edit", #"{"file_path":"/home/someone/x.js","old_string":"a"}"#), "~/x.js")
            T.eq(s("Grep", #"{"pattern":"TODO","path":"src"}"#), "\"TODO\" in src")
            T.eq(s("Glob", #"{"pattern":"**/*.swift"}"#), "\"**/*.swift\"")
            T.eq(s("Task", #"{"description":"Review the diff","prompt":"long"}"#), "Review the diff")
            T.eq(s("WebFetch", #"{"url":"https://example.com/a"}"#), "https://example.com/a")
            T.eq(s("WebSearch", #"{"query":"swift layout"}"#), "swift layout")
            T.eq(s("TodoWrite", #"{"todos":[{},{},{}]}"#), "3 items")
            T.eq(s("shell", #"{"command":["bash","-lc","make test"]}"#), "make test", "Codex argv")
            T.eq(s("apply_patch", #"{"input":"*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: src/b.ts\n"}"#), "src/a.ts, src/b.ts")
            T.eq(s("Mystery", #"{"count":3,"target":"thing"}"#), "thing", "the first string field")
            T.check(s("Bash", "{\"command\":\"" + String(repeating: "x", count: 400) + "\"}").count <= 200, "<= 200 chars")
        }
        await T.suite("ChatLayout: a run of tool-only turns is one group") {
            let turns = [
                user("u1", "Run the tests"),
                assistant("a1", tools: [call("t1", "Bash", "npm test")]),
                TranscriptTurn(id: "th", role: .thinking, text: "", ts: nil, tools: [], meta: false),
                result("r1", [ToolResult(toolUseId: "t1", isError: true, text: "2 failed")]),
                assistant("a2", tools: [call("t2", "Read", "src/a.ts")]),
                result("r2", [ToolResult(toolUseId: "t2", isError: false, text: "body")]),
                assistant("a3", tools: [call("t3", "Read", "src/b.ts"), call("t4", "Bash", "npm test")]),
                result("r3", [ToolResult(toolUseId: "t4", isError: false, text: "ok"), ToolResult(toolUseId: "t3", isError: false, text: "b body")]),
                assistant("blank", "   \n"),
                assistant("a4", "Fixed. **Both** pass."),
            ]
            let items = ChatLayout.build(turns).items
            T.eq(items.count, 3, "user, one group, the text (blank text and thinking dropped)")
            guard case .tools(let g) = items[1] else { return T.fail("group") }
            T.eq(g.title, "Ran 2 commands, read 2 files")
            T.eq(g.rows.map(\.name), ["Bash", "Read", "Read", "Bash"])
            T.eq(g.rows.map { $0.result?.text }, ["2 failed", "body", "b body", "ok"], "results by id, whatever their order")
            T.check(g.hasError, "an error marks the group")
            T.check(!g.awaitingResult)
            guard case .text(let t) = items[2] else { return T.fail("text") }
            T.eq(Markdown.plain(t.blocks), "Fixed. Both pass.")
        }
        await T.suite("ChatLayout: text with tools, legacy results, a call still running") {
            let turns = [
                assistant("a1", "Looking.", tools: [call(nil, "Grep", "\"x\" in src")]),
                assistant("a2", tools: [call(nil, "Edit", "src/a.ts")]),
                result("r1", [ToolResult(toolUseId: nil, isError: false, text: "src/a.ts:1")]),
                assistant("a3", tools: [call("t9", "Bash", "npm test")]),
            ]
            let items = ChatLayout.build(turns).items
            T.eq(items.count, 2, "the text, then its calls with the next ones as one group")
            guard case .tools(let g) = items[1] else { return T.fail("group") }
            T.eq(g.title, "Searched once, edited 1 file, ran 1 command")
            T.eq(g.rows.first?.result?.text, "src/a.ts:1", "an id-less result goes to the oldest waiting call")
            T.eq(g.rows[1].result, nil)
            T.check(g.awaitingResult, "the last call has no result yet")
        }
        await T.suite("ChatLayout: meta, notices and slash commands") {
            let turns = [
                user("m", "<system-reminder>x</system-reminder>", meta: true),
                user("c", "<command-name>/clear</command-name>\n<command-args></command-args>"),
                TranscriptTurn(id: "ti", role: .title, text: "demo: parser work", ts: nil, tools: [], meta: false),
                TranscriptTurn(id: "q", role: .queue, text: "enqueue: later", ts: nil, tools: [], meta: false),
                TranscriptTurn(id: "s", role: .system, text: "exited 0", ts: nil, tools: [], meta: false),
            ]
            let hidden = ChatLayout.build(turns).items
            T.eq(hidden.map(\.id), ["c", "s"], "meta, title and queue hidden by default")
            if case .notice(let n) = hidden[0] { T.eq(n.text, "Ran /clear") } else { T.fail("command notice") }
            let shown = ChatLayout.build(turns, options: ChatLayout.Options(showHidden: true)).items
            T.eq(shown.map(\.id), ["m", "c", "ti", "q", "s"])
        }
        await T.suite("ChatLayout group titles") {
            T.eq(ChatLayout.title(["Bash"]), "Ran 1 command")
            T.eq(ChatLayout.title(["Read", "Read", "Bash", "Bash", "Bash"]), "Read 2 files, ran 3 commands")
            T.eq(ChatLayout.title(["Grep", "Glob", "Grep"]), "Searched 3 times")
            T.eq(ChatLayout.title(["Write", "MultiEdit", "NotebookEdit", "Edit"]), "Edited 4 files")
            T.eq(ChatLayout.title(["WebFetch", "WebSearch"]), "Fetched 2 pages")
            T.eq(ChatLayout.title(["Task", "Agent"]), "Ran 2 agents")
            T.eq(ChatLayout.title(["TodoWrite", "TodoWrite"]), "Updated the todo list")
            T.eq(ChatLayout.title(["AskUserQuestion", "Skill", "Skill"]), "Used AskUserQuestion, used Skill 2 times")
            T.eq(ChatLayout.title(["shell", "apply_patch"]), "Ran 1 command, edited 1 file", "Codex names")
        }
        await T.suite("ChatLayout reuses parsed Markdown") {
            let turns = [assistant("a", "**one**"), assistant("b", "two")]
            let first = ChatLayout.build(turns)
            T.eq(first.cache.count, 2)
            let again = ChatLayout.build(turns + [assistant("c", "three")], cache: first.cache)
            T.eq(again.items.count, 3); T.eq(again.cache.count, 3)
            var changed = turns
            changed[1].text = "two, edited"
            let edited = ChatLayout.build(changed, cache: first.cache)
            if case .text(let t) = edited.items[1] { T.eq(Markdown.plain(t.blocks), "two, edited", "a changed text is parsed again") }
        }
        await T.suite("Markdown blocks") {
            let md = """
            # Plan

            Run `npm test` first, then **fix** the [parser](https://example.com/p).
            See https://example.com/docs for more.

            - one
            - two
              continued
              - nested
            1. first
            2. second
            - [x] done
            - [ ] todo

            ```swift
            let x = 1
            ```

            > quoted
            > text

            | a | b |
            |---|:-:|
            | 1 | 2 |

            ---
            tail
            """
            let blocks = Markdown.blocks(md)
            guard blocks.count == 10 else { return T.fail("blocks: \(blocks.count) \(blocks)") }
            if case .heading(let level, let t) = blocks[0] { T.eq(level, 1); T.eq(String(t.characters), "Plan") } else { T.fail("heading") }
            guard case .paragraph(let p) = blocks[1] else { return T.fail("paragraph") }
            T.eq(String(p.characters), "Run npm test first, then fix the parser.\nSee https://example.com/docs for more.", "line breaks kept")
            T.check(p.runs.contains { $0.inlinePresentationIntent?.contains(.code) == true && $0.backgroundColor != nil }, "inline code tinted")
            T.check(p.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true }, "bold")
            T.eq(p.runs.compactMap(\.link).map(\.absoluteString), ["https://example.com/p", "https://example.com/docs"], "Markdown and bare links")
            if case .list(let ordered, let items) = blocks[2] {
                T.check(!ordered); T.eq(items.map { String($0.text.characters) }, ["one", "two\ncontinued", "nested"]); T.eq(items.map(\.depth), [0, 0, 1])
            } else { T.fail("bullets") }
            if case .list(let ordered, let items) = blocks[3] { T.check(ordered); T.eq(items.map(\.marker), ["1.", "2."]) } else { T.fail("numbers") }
            if case .list(_, let items) = blocks[4] { T.eq(items.map(\.checked), [true, false]) } else { T.fail("tasks") }
            if case .code(let lang, let text) = blocks[5] { T.eq(lang, "swift"); T.eq(text, "let x = 1") } else { T.fail("code") }
            if case .quote(let q) = blocks[6] { T.eq(String(q.characters), "quoted\ntext") } else { T.fail("quote") }
            if case .table(let h, let rows) = blocks[7] { T.eq(h.map { String($0.characters) }, ["a", "b"]); T.eq(rows.count, 1) } else { T.fail("table") }
            if case .rule = blocks[8] {} else { T.fail("rule") }
            if case .paragraph(let t) = blocks[9] { T.eq(String(t.characters), "tail") } else { T.fail("tail") }
            // An unclosed fence runs to the end; whitespace-only text has no blocks.
            if case .code(_, let t) = Markdown.blocks("```\nopen\nfence").first { T.eq(t, "open\nfence") } else { T.fail("unclosed fence") }
            T.eq(Markdown.blocks("  \n \n").count, 0)
        }
        await T.suite("ChatModel reads earlier turns on request") {
            let paged = PagedTranscripts(total: 700)
            let chat = ChatModel(key: "studio|s", transcriptId: "s", host: "studio")
            let s = MockDroverService.sessions[0]
            await chat.load(service: paged, session: s)
            T.eq(chat.turns.count, 300); T.check(chat.hasEarlier, "a full first page: more exist")
            await chat.loadEarlier(service: paged, session: s)
            T.eq(chat.turns.count, 600); T.check(chat.hasEarlier)
            await chat.loadEarlier(service: paged, session: s)
            T.eq(chat.turns.count, 700, "all of them"); T.check(!chat.hasEarlier, "a page that is not full: nothing older")
            T.eq(paged.limits, [300, 600, 1000], "doubling, capped at the in-memory cap")
        }
        await T.suite("ChatModel applies live turns and dedupes") {
            let chat = ChatModel(key: "studio|s", transcriptId: "s", host: "studio")
            chat.apply(assistant("x", "first"))
            chat.apply(assistant("x", "first"))
            chat.apply(user("y", "next"))
            await chat.layoutSettled()
            T.eq(chat.turns.map(\.id), ["x", "y"], "the same turn twice is one")
            T.eq(chat.items.count, 2)
            T.check(chat.liveAt != nil, "a live turn marks the chat followed")
        }
    }
}

/// A Claude transcript of `total` turns, served newest-last in pages of `limit`.
final class PagedTranscripts: DroverService, @unchecked Sendable {
    let total: Int
    private let lock = NSLock()
    private var _limits: [Int] = []
    var limits: [Int] { lock.withLock { _limits } }
    init(total: Int) { self.total = total }

    func transcript(of session: SessionItem, since: Int?, limit: Int?) async throws -> TranscriptPage {
        let n = min(total, limit ?? 300)
        lock.withLock { _limits.append(limit ?? 300) }
        let turns = (total - n..<total).map { TranscriptTurn(id: "t\($0)", role: .assistant, text: "turn \($0)", ts: nil, tools: [], meta: false) }
        return TranscriptPage(turns: turns, offset: 9000, incremental: true, sent: n)
    }
    func board() async throws -> BoardSnapshot { .empty }
    func capture(target: String, host: String, lines: Int) async throws -> ScreenCapture { ScreenCapture(target: target, text: "", state: .idle, reason: nil) }
    func sendMessage(to session: SessionItem, text: String) async throws -> MessageResult { MessageResult(queuedBehindTurn: false, reply: nil) }
    func sendToPane(target: String, host: String, text: String, enter: Bool, force: Bool) async throws -> PaneSendResult { PaneSendResult(refused: false, reason: nil) }
    func sendKeys(target: String, host: String, keys: [PaneKey]) async throws {}
    func supportsUploads() async -> Bool { false }
    func upload(for session: SessionItem, fileName: String, mime: String, data: Data) async throws -> String { "" }
    func events(onState: @escaping @Sendable (ConnectionState) -> Void) -> AsyncStream<ServerEvent> { AsyncStream { _ in } }
    func notifications(since cursor: String?, wait: Int) async throws -> NotificationPage { NotificationPage(cursor: nil, items: []) }
    func ping() async throws -> String { "paged" }
}
