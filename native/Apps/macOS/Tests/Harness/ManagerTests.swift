import Foundation

// The manager conversation: echoes, streams, finals, races, older daemons, threads.
@MainActor
enum ManagerTests {
    static func turn(_ id: String, _ role: TurnRole, _ text: String, inReplyTo: String? = nil, pending: Bool = false, thread: String = "main") -> TranscriptTurn {
        TranscriptTurn(id: id, role: role, text: text, ts: nil, tools: [], meta: false, pending: pending, inReplyTo: inReplyTo, thread: thread)
    }
    static func stream(_ phase: ManagerStreamEvent.Phase, text: String? = nil, delta: String? = nil, error: String? = nil, thread: String = "main") -> ManagerStreamEvent {
        ManagerStreamEvent(host: "local", thread: thread, turnId: "pending:e1", inReplyTo: "e1", phase: phase, delta: delta, text: text, error: error)
    }
    static func shape(_ c: ManagerConversation) -> [String] {
        c.display.map { "\($0.role == .user ? "u" : $0.role == .assistant ? "a" : "s"):\($0.text)\($0.pending ? "…" : "")" }
    }

    static func run() async {
        await T.suite("ManagerConversation: echo, stream, final") {
            var c = ManagerConversation()
            c.load(TranscriptPage(turns: [turn("m1", .user, "hi"), turn("m2", .assistant, "hello", inReplyTo: "m1")], offset: 2, incremental: false))
            let local = c.echo("who waits?")
            T.eq(shape(c), ["u:hi", "a:hello", "u:who waits?…"], "the message shows at once")
            c.confirm(echo: local, event: "e1")
            T.eq(c.display.last?.id, "e1", "the echo takes the event id")
            c.apply(stream: stream(.start))
            c.apply(stream: stream(.delta, text: "Two", delta: "Two"))
            c.apply(stream: stream(.delta, delta: " sessions"))
            T.eq(shape(c).suffix(2), ["u:who waits?", "a:Two sessions…"], "text so far, after the message it answers")
            T.check(c.isReplying)
            c.apply(turn: turn("e1", .user, "who waits?"))
            T.eq(shape(c).filter { $0.hasPrefix("u:who") }.count, 1, "the turn event replaces the echo, no second copy")
            c.apply(stream: stream(.done, text: "Two sessions wait."))
            c.apply(turn: turn("c9", .assistant, "Two sessions wait.", inReplyTo: "e1"))
            T.eq(shape(c), ["u:hi", "a:hello", "u:who waits?", "a:Two sessions wait."], "the final reply replaces the stream")
            T.check(!c.isReplying)
            c.apply(turn: turn("c9", .assistant, "Two sessions wait.", inReplyTo: "e1"))
            T.eq(c.display.count, 4, "a repeated turn is deduped by id")
        }
        await T.suite("ManagerConversation: the turn event wins the race") {
            var c = ManagerConversation()
            let local = c.echo("status")
            c.apply(turn: turn("e1", .user, "status"))
            T.eq(shape(c), ["u:status"], "matched by text before the id was known")
            c.confirm(echo: local, event: "e1")
            T.eq(shape(c), ["u:status"], "a late confirm adds nothing")
            c.apply(turn: turn("c1", .assistant, "All up.", inReplyTo: "e1"))
            c.apply(stream: stream(.delta, text: "All"))
            T.eq(shape(c), ["u:status", "a:All up."], "a stream after its final reply is ignored")
        }
        await T.suite("ManagerConversation: a transcript read with a pending turn") {
            var c = ManagerConversation()
            c.apply(stream: stream(.delta, text: "Partial reply, longer"))
            c.load(TranscriptPage(turns: [turn("e1", .user, "q"), turn("pending:e1", .assistant, "Partial", inReplyTo: "e1", pending: true)], offset: 1, incremental: false))
            T.eq(shape(c), ["u:q", "a:Partial reply, longer…"], "the newest text of the stream, once")
            c.load(TranscriptPage(turns: [turn("e1", .user, "q"), turn("c1", .assistant, "Full reply", inReplyTo: "e1")], offset: 2, incremental: false))
            T.eq(shape(c), ["u:q", "a:Full reply"], "the final replaces the pending turn and the stream")
        }
        await T.suite("ManagerConversation: errors, other threads, older daemons") {
            var c = ManagerConversation()
            let local = c.echo("fail now")
            c.confirm(echo: local, event: "e1")
            c.apply(stream: stream(.start))
            c.apply(stream: stream(.error, error: "gateway 500"))
            T.eq(shape(c), ["u:fail now", "a:The manager could not answer: gateway 500"])
            T.check(c.display.last?.failed == true)
            c.apply(turn: turn("c1", .system, "The manager did not answer: gateway 500", inReplyTo: "e1"))
            T.eq(shape(c), ["u:fail now", "s:The manager did not answer: gateway 500"], "the recorded failure replaces the stream's")

            var t = ManagerConversation(thread: "release")
            t.apply(turn: turn("x", .user, "elsewhere", thread: "main"))
            t.apply(stream: stream(.delta, text: "nope"))
            T.eq(t.display.count, 0, "another thread's turns and streams stay out")

            var old = ManagerConversation()
            let l2 = old.echo("hello")
            old.confirm(echo: l2, event: "e7")
            old.addInlineReply("Hi there", inReplyTo: "e7")
            T.eq(shape(old), ["u:hello", "a:Hi there"], "an inline reply (no stream) lands as a turn")
            var failed = ManagerConversation()
            let l3 = failed.echo("x")
            failed.fail(echo: l3, error: "offline")
            T.eq(shape(failed), ["u:x", "s:Not delivered: offline"])
            T.check(failed.display.first?.failed == true)
        }
        await T.suite("ManagerConversation keeps its newest turns, never a message or a reply still on its way") {
            var c = ManagerConversation()
            let local = c.echo("still going")
            c.apply(stream: stream(.delta, text: "Partial"))
            for i in 0..<(ManagerConversation.maxTurns + 100) { c.apply(turn: turn("t\(i)", i % 2 == 0 ? .user : .assistant, "n\(i)")) }
            T.eq(c.turns.count, ManagerConversation.maxTurns, "bounded while events keep coming")
            T.eq(c.turns.first?.id, "t100", "the oldest go first")
            T.check(c.display.contains { $0.id == local }, "the message not yet confirmed stays")
            T.check(c.display.contains { $0.id == "pending:e1" && $0.pending }, "and so does the reply streaming in")
            c.load(TranscriptPage(turns: (0..<700).map { turn("r\($0)", .user, "read \($0)") }, offset: 700, incremental: false))
            T.eq(c.turns.count, ManagerConversation.maxTurns, "a read is bounded too")
            T.eq(c.turns.last?.id, "r699")
        }
        await T.suite("ManagerModel: send, stream, final through the app's events") {
            let mock = MockDroverService()
            mock.streamStep = 0
            let m = AppModel(settings: AppSettings(defaults: UserDefaults(suiteName: "harness-\(UUID())")!, group: nil),
                             tokens: MemoryTokenStore("x"), service: mock, managerDefaults: UserDefaults(suiteName: "harness-\(UUID())")!)
            m.start()
            await m.refresh()
            await m.manager.refresh()
            T.eq(m.manager.conversation.display.count, MockDroverService.managerHistory.count)
            T.eq(m.manager.host, "devbox", "the board's manager host")
            m.manager.send("Who is waiting on me?")
            var done = false
            for _ in 0..<200 {
                try? await Task.sleep(for: .milliseconds(10))
                let d = m.manager.conversation.display
                if d.last?.role == .assistant, d.last?.pending == false, d.count == MockDroverService.managerHistory.count + 2 { done = true; break }
            }
            T.check(done, "the reply streamed in and settled: \(shape(m.manager.conversation))")
            let users = m.manager.conversation.display.filter { $0.role == .user && $0.text == "Who is waiting on me?" }
            T.eq(users.count, 2, "the earlier one in the history, and this one once")
            await m.manager.rows.settled()
            T.eq(m.manager.items.count, MockDroverService.managerHistory.count + 2)
            T.check(mock.messagesSent.contains("manager[main]: Who is waiting on me?"))
            m.stop()
        }
        await T.suite("ManagerModel: another server starts over, and the old one's late answers are dropped") {
            let old = MockDroverService()
            let defaults = UserDefaults(suiteName: "harness-\(UUID())")!
            defaults.set("http://127.0.0.1:9", forKey: "drover.serverURL")   // the new server: nothing listens there
            let m = AppModel(settings: AppSettings(defaults: defaults, group: nil), tokens: MemoryTokenStore("x"), service: old,
                             managerDefaults: UserDefaults(suiteName: "harness-\(UUID())")!)
            await m.manager.refresh()
            T.eq(m.manager.conversation.display.count, MockDroverService.managerHistory.count, "the old server's conversation")
            T.eq(m.manager.threads.map(\.thread), ["main", "release"])
            old.managerReadDelay = 0.3
            let late = Task { await m.manager.refresh() }   // still on its way when the server changes
            try await Task.sleep(for: .milliseconds(50))
            m.applyConnectionSettings()
            T.eq(m.manager.conversation.display.count, 0, "a new server: nothing the last one said stays")
            T.eq(m.manager.threads.map(\.thread), [], "nor its threads")
            await late.value
            T.eq(m.manager.conversation.display.count, 0, "its read that lands late is dropped")
            T.eq(m.manager.threads.map(\.thread), [])
            m.stop()
        }
        await T.suite("ManagerModel: a read made before the board named the manager's host is read again from that host") {
            let svc = MockDroverService()
            svc.managerOnlyAt = "box-b"   // this front daemon runs no manager of its own
            let m = AppModel(settings: AppSettings(defaults: UserDefaults(suiteName: "harness-\(UUID())")!, group: nil),
                             tokens: MemoryTokenStore("x"), service: svc, managerDefaults: UserDefaults(suiteName: "harness-\(UUID())")!)
            await m.manager.refreshIfStale()
            T.check(m.manager.error != nil, "before the board: the read goes to the front daemon, which has no manager")
            var b = m.board
            b.manager = ManagerInfo(up: true, host: "box-b", lastNoteAt: nil)
            m.apply(board: b)
            T.eq(m.manager.loadKey, "main|box-b", "the board names the host, so the view's task runs again")
            await m.manager.refreshIfStale()
            T.eq(m.manager.error, nil)
            T.eq(m.manager.conversation.display.count, MockDroverService.managerHistory.count, "the conversation of the manager on its host")
            await m.manager.refreshIfStale()
            T.eq(svc.managerReadHosts, [nil, "box-b"], "the same host again: no transcript read")
            // A read of a host the board no longer names lands late: dropped.
            svc.managerOnlyAt = nil; svc.managerReadDelay = 0.3
            b.manager = ManagerInfo(up: true, host: "box-a", lastNoteAt: nil)
            m.apply(board: b)
            let late = Task { await m.manager.refresh() }
            try await Task.sleep(for: .milliseconds(50))
            b.manager = ManagerInfo(up: true, host: "box-b", lastNoteAt: nil)
            m.apply(board: b)
            await late.value
            T.eq(svc.managerReadHosts.last, "box-a", "the late read asked box-a")
            T.check(m.manager.loadKey == "main|box-b" && m.manager.error == nil, "its answer did not replace the conversation of the host in use")
            m.stop()
        }
        await T.suite("ManagerModel threads") {
            T.check(ManagerModel.isValidThread("main")); T.check(ManagerModel.isValidThread("win-@12")); T.check(ManagerModel.isValidThread("a:b.c_d%e"))
            T.check(!ManagerModel.isValidThread("")); T.check(!ManagerModel.isValidThread("has space")); T.check(!ManagerModel.isValidThread(String(repeating: "x", count: 65)))
            let defaults = UserDefaults(suiteName: "harness-\(UUID())")!
            let m = AppModel(settings: AppSettings(defaults: UserDefaults(suiteName: "harness-\(UUID())")!, group: nil),
                             tokens: MemoryTokenStore("x"), service: MockDroverService(), managerDefaults: defaults)
            await m.manager.refreshThreads()
            T.eq(m.manager.threads.map(\.thread), ["main", "release"])
            m.manager.switchThread("release")
            T.eq(m.manager.thread, "release"); T.eq(defaults.string(forKey: "drover.managerThread"), "release", "remembered")
            m.manager.switchThread("bad name")
            T.eq(m.manager.thread, "release", "an invalid name is refused")
        }
    }
}
