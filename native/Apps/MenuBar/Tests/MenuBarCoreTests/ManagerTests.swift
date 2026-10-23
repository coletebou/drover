import Foundation
import Testing
@testable import MenuBarCore

// The manager box: a question, its reply streamed by SSE `manager` events and settled by `turn` events, with
// the local echo replaced by the server copy and no exchange shown twice.

@Suite struct ManagerChatTests {
    private func stream(_ phase: String, turn: String = "t-1", inReplyTo: String? = "ev-1", delta: String? = nil,
                        text: String? = nil, error: String? = nil, thread: String? = nil) -> ManagerStreamEvent {
        ManagerStreamEvent(host: "local", thread: thread, turnId: turn, inReplyTo: inReplyTo, phase: phase, delta: delta, text: text, error: error)
    }

    @Test func sendThenStreamThenDone() {
        var chat = ManagerChat()
        chat.beginSend("Who is waiting on me?")
        #expect(chat.busy && chat.sending)
        #expect(chat.question == ManagerQuestion(id: nil, text: "Who is waiting on me?", askedBy: nil))
        #expect(chat.reply?.phase == .waiting)

        chat.sent(ManagerSendResult(pending: true, event: "ev-1", turnId: "t-1", thread: "main"))
        #expect(!chat.sending && chat.busy)
        #expect(chat.question?.id == "ev-1")

        chat.apply(stream("start"))
        chat.apply(stream("delta", delta: "Two sessions "))
        chat.apply(stream("delta", delta: "wait on you."))
        #expect(chat.reply?.text == "Two sessions wait on you.")
        #expect(chat.reply?.phase == .streaming)
        // `text` is the reply so far and wins over appending.
        chat.apply(stream("delta", delta: "!", text: "Two sessions wait on you: demo-build."))
        #expect(chat.reply?.text == "Two sessions wait on you: demo-build.")

        chat.apply(stream("done", text: "Two sessions wait on you: demo-build and demo-review."))
        #expect(chat.reply?.phase == .done)
        #expect(chat.reply?.text == "Two sessions wait on you: demo-build and demo-review.")
        #expect(!chat.busy)

        // The settled turn event for the same reply changes nothing and adds no second exchange.
        chat.apply(turn: TranscriptTurn(id: "ev-2", role: "assistant", text: "Two sessions wait on you: demo-build and demo-review.",
                                        thread: "main", inReplyTo: "ev-1", turnId: "t-1"))
        #expect(chat.question?.id == "ev-1")
        #expect(chat.reply?.text == "Two sessions wait on you: demo-build and demo-review.")
    }

    @Test func streamRacingThePostAnswer() {
        var chat = ManagerChat()
        chat.beginSend("What finished?")
        // The daemon streams before the POST returns: nothing to compare yet, the reply in flight takes it.
        chat.apply(stream("start", turn: "t-9", inReplyTo: "ev-9"))
        chat.apply(stream("delta", turn: "t-9", inReplyTo: "ev-9", delta: "demo-docs finished."))
        // And the server copy of the question arrives as a turn event.
        chat.apply(turn: TranscriptTurn(id: "ev-9", role: "user", text: "What finished?", thread: "main"))
        #expect(chat.question?.id == "ev-9")
        chat.sent(ManagerSendResult(pending: true, event: "ev-9", turnId: "t-9"))
        #expect(chat.reply?.text == "demo-docs finished.")
        #expect(chat.reply?.turnId == "t-9")
        chat.apply(stream("done", turn: "t-9", inReplyTo: "ev-9"))
        #expect(chat.reply?.phase == .done && chat.reply?.text == "demo-docs finished.")
    }

    @Test func localEchoIsReplacedNotDuplicated() {
        var chat = ManagerChat()
        chat.beginSend("  Sweep the fleet  ".trimmingCharacters(in: .whitespaces))
        chat.apply(turn: TranscriptTurn(id: "ev-3", role: "user", text: "Sweep the fleet\n", thread: "main"))
        #expect(chat.question == ManagerQuestion(id: "ev-3", text: "Sweep the fleet", askedBy: nil))
        #expect(chat.reply?.phase == .waiting)
        chat.apply(turn: TranscriptTurn(id: "ev-3", role: "user", text: "Sweep the fleet", thread: "main"))
        #expect(chat.question?.id == "ev-3")
        #expect(chat.reply?.phase == .waiting, "a repeated server copy does not reset the reply")
    }

    @Test func someoneElsesQuestionTakesOver() {
        var chat = ManagerChat()
        chat.beginSend("Who is waiting on me?")
        chat.sent(ManagerSendResult(pending: true, event: "ev-1", turnId: "t-1"))
        chat.apply(stream("done", text: "Nobody."))
        chat.apply(turn: TranscriptTurn(id: "ev-5", role: "user", text: "Launch the docs agent", thread: "main", actor: "mcp"))
        #expect(chat.question == ManagerQuestion(id: "ev-5", text: "Launch the docs agent", askedBy: "mcp"))
        #expect(chat.reply == nil)
        chat.apply(stream("start", turn: "t-5", inReplyTo: "ev-5"))
        chat.apply(stream("delta", turn: "t-5", inReplyTo: "ev-5", delta: "Launching."))
        #expect(chat.question?.id == "ev-5")
        #expect(chat.reply?.text == "Launching.")
        #expect(chat.busy)
    }

    @Test func aStrayStreamWithoutItsQuestionShowsAlone() {
        var chat = ManagerChat()
        chat.beginSend("Q1")
        chat.sent(ManagerSendResult(pending: true, event: "ev-1", turnId: "t-1"))
        chat.apply(stream("done", text: "A1"))
        chat.apply(stream("delta", turn: "t-7", inReplyTo: "ev-7", delta: "Another answer"))
        #expect(chat.question == nil)
        #expect(chat.reply?.text == "Another answer")
        // An error for someone else's reply is not shown.
        chat.apply(stream("error", turn: "t-8", inReplyTo: "ev-8", error: "boom"))
        #expect(chat.reply?.text == "Another answer" && chat.reply?.phase == .streaming)
    }

    @Test func errorsEndTheReply() {
        var chat = ManagerChat()
        chat.beginSend("Q")
        chat.sent(ManagerSendResult(pending: true, event: "ev-1", turnId: "t-1"))
        chat.apply(stream("error", error: "gateway 502: bad gateway"))
        #expect(chat.reply?.phase == .failed("gateway 502: bad gateway"))
        #expect(!chat.busy)

        var other = ManagerChat()
        other.beginSend("Q")
        other.sendFailed("Cannot reach the server.")
        #expect(other.reply?.phase == .failed("Cannot reach the server."))
        #expect(other.question?.text == "Q")
        #expect(!other.busy)

        var system = ManagerChat()
        system.beginSend("Q")
        system.sent(ManagerSendResult(pending: true, event: "ev-1", turnId: "t-1"))
        system.apply(turn: TranscriptTurn(role: "system", text: "delivery failed: gateway down", thread: "main"))
        #expect(system.reply?.phase == .failed("delivery failed: gateway down"))
    }

    @Test func olderDaemonAnswersInsideTheCall() {
        var chat = ManagerChat()
        chat.beginSend("Q")
        chat.sent(ManagerSendResult(event: "ev-1", reply: "The whole reply."))
        #expect(chat.reply == ManagerReply(turnId: nil, inReplyTo: "ev-1", text: "The whole reply.", phase: .done))
        #expect(!chat.busy)
    }

    @Test func otherThreadsAreNotShown() {
        var chat = ManagerChat()
        chat.apply(stream("delta", delta: "window thread", thread: "win-3"))
        chat.apply(turn: TranscriptTurn(id: "ev-1", role: "user", text: "only in a window", thread: "win-3"))
        #expect(chat.isEmpty)
    }

    @Test func pendingTurnsStreamToo() {
        var chat = ManagerChat()
        chat.apply(turn: TranscriptTurn(id: "ev-1", role: "user", text: "Q", thread: "main"))
        chat.apply(turn: TranscriptTurn(id: "t-1", role: "assistant", text: "Par", thread: "main", pending: true, inReplyTo: "ev-1"))
        #expect(chat.reply?.phase == .streaming && chat.reply?.text == "Par")
        chat.apply(turn: TranscriptTurn(id: "t-1", role: "assistant", text: "Partial and done.", thread: "main", inReplyTo: "ev-1"))
        #expect(chat.reply?.phase == .done && chat.reply?.text == "Partial and done.")
        // A late pending copy cannot reopen a settled reply.
        chat.apply(turn: TranscriptTurn(id: "t-1", role: "assistant", text: "Par", thread: "main", pending: true, inReplyTo: "ev-1"))
        #expect(chat.reply?.phase == .done && chat.reply?.text == "Partial and done.")
    }

    @Test func seedTakesTheLastExchange() {
        var chat = ManagerChat()
        chat.seed([
            TranscriptTurn(id: "ev-1", role: "user", text: "Old question", thread: "main"),
            TranscriptTurn(id: "ev-2", role: "assistant", text: "Old answer", thread: "main", inReplyTo: "ev-1"),
            TranscriptTurn(id: "ev-3", role: "user", text: "In a window", thread: "win-1"),
            TranscriptTurn(id: "ev-4", role: "user", text: "Newest question", thread: "main", actor: "owner"),
            TranscriptTurn(id: "t-5", role: "assistant", text: "Writing", thread: "main", pending: true),
        ])
        #expect(chat.question == ManagerQuestion(id: "ev-4", text: "Newest question", askedBy: nil))
        #expect(chat.reply?.text == "Writing" && chat.reply?.phase == .streaming)
        #expect(chat.busy)

        var replyOnly = ManagerChat()
        replyOnly.seed([TranscriptTurn(id: "ev-9", role: "assistant", text: "A note", thread: nil)])
        #expect(replyOnly.question == nil && replyOnly.reply?.text == "A note")

        // History never replaces a conversation already on show.
        var busy = ManagerChat()
        busy.beginSend("Now")
        busy.seed([TranscriptTurn(id: "ev-1", role: "user", text: "Old", thread: "main")])
        #expect(busy.question?.text == "Now")
    }

    @Test func catchUpSettlesFromTheTranscript() {
        var chat = ManagerChat()
        chat.beginSend("Who is waiting on me?")
        chat.sent(ManagerSendResult(pending: true, event: "ev-1", turnId: "t-1"))
        chat.catchUp([
            TranscriptTurn(id: "ev-0", role: "user", text: "Earlier", thread: "main"),
            TranscriptTurn(id: "ev-1", role: "user", text: "Who is waiting on me?", thread: "main"),
            TranscriptTurn(id: "t-1", role: "assistant", text: "Nobody", thread: "main", pending: true, inReplyTo: "ev-1"),
        ])
        #expect(chat.reply?.text == "Nobody" && chat.reply?.phase == .streaming)
        chat.catchUp([
            TranscriptTurn(id: "ev-1", role: "user", text: "Who is waiting on me?", thread: "main"),
            TranscriptTurn(id: "t-1", role: "assistant", text: "Nobody waits on you.", thread: "main", inReplyTo: "ev-1"),
        ])
        #expect(chat.reply?.text == "Nobody waits on you." && chat.reply?.phase == .done)
        #expect(chat.question?.id == "ev-1")
    }

    @Test func askedByReadsActorOrOldUserField() throws {
        let old = try JSONDecoder().decode(TranscriptTurn.self, from: Data(#"{"role":"user","text":"hi","user":"drover:mcp"}"#.utf8))
        #expect(old.askedBy == "mcp")
        let mine = try JSONDecoder().decode(TranscriptTurn.self, from: Data(#"{"role":"user","text":"hi","user":"drover:owner"}"#.utf8))
        #expect(mine.askedBy == nil)
        let alias = try JSONDecoder().decode(TranscriptTurn.self, from: Data(#"{"role":"user","text":"hi","actor":"Owner"}"#.utf8))
        #expect(alias.askedBy == nil, "the generic owner actor, in any case")
        let named = try JSONDecoder().decode(TranscriptTurn.self, from: Data(#"{"role":"user","text":"hi","actor":"alice"}"#.utf8))
        #expect(named.askedBy == "alice", "a configured owner name is the store's to read (asker)")
    }
}

@MainActor
@Suite struct StoreManagerTests {
    @Test func askSendsWaitFalseOnTheManagersHost() async throws {
        var s = Summary.preview
        s.manager = ManagerState(up: true, lastNoteAt: nil, host: "demo-box")
        let summary = okBody(String(decoding: try JSONEncoder().encode(s), as: UTF8.self))
        let t = FakeTransport(data: { r in
            switch r.url?.path {
            case "/api/op/native.summary": return (200, summary)
            case "/api/op/sessions.message": return (200, okBody(#"{"ok":true,"pending":true,"event":"ev-1","turnId":"t-1","thread":"main"}"#))
            default: return (404, Data())
            }
        })
        let store = MenuBarStore(preferences: { .default }, tokens: StaticTokens([.main: secret]), transport: t)
        store.sleep = { _ in try await Task.sleep(for: .seconds(60)) }
        await store.refresh()
        await store.askManager("  Who is waiting on me?  ")
        let req = try #require(t.requests(path: "/api/op/sessions.message").first)
        let json = try bodyJSON(req.httpBody)
        #expect(json["id"] as? String == "manager")
        #expect(json["text"] as? String == "Who is waiting on me?")
        #expect(json["wait"] as? Bool == false)
        #expect(json["host"] as? String == "demo-box")
        #expect(json["actor"] as? String == AppIdentifiers.actor)
        // A daemon from before wait:false holds the call until the reply: the request may take minutes.
        #expect(req.timeoutInterval >= 900)
        #expect(store.manager.question?.id == "ev-1")
        #expect(store.manager.busy)
        store.stop()
    }

    @Test func askerReadsTheSummarysOwnerAsYou() throws {
        let store = MenuBarStore(preferences: { .default }, tokens: StaticTokens([.main: secret]), transport: FakeTransport())
        let alice = ManagerQuestion(id: "ev-1", text: "Q", askedBy: "alice")
        let mcp = ManagerQuestion(id: "ev-2", text: "Q", askedBy: "mcp")
        #expect(store.asker(alice) == "alice", "no summary yet: only the generic actor is the owner")
        func stream(_ s: Summary) throws {
            store.handle(SSEEvent(event: "summary", data: String(decoding: try JSONEncoder().encode(s), as: UTF8.self), id: nil))
        }
        var s = Summary.preview
        s.owner = "Alice"
        try stream(s)
        #expect(store.summary?.owner == "Alice")
        #expect(store.asker(alice) == nil, "the summary's owner reads You, in any case")
        #expect(store.asker(mcp) == "mcp")
        #expect(store.asker(ManagerQuestion(id: "ev-3", text: "Q", askedBy: nil)) == nil)
        s.owner = nil
        try stream(s)
        #expect(store.asker(alice) == "alice", "a summary from an older daemon names no owner")
    }

    @Test func summaryDecodesTheOwnerWhenSent() throws {
        let base = #""generatedAt":"2026-10-11T18:00:00Z","hosts":[],"waiting":[],"working":[],"totals":{"waiting":0,"working":0,"idle":0,"hosts":0}"#
        #expect(try JSONDecoder().decode(Summary.self, from: Data("{\(base),\"owner\":\"alice\"}".utf8)).owner == "alice")
        #expect(try JSONDecoder().decode(Summary.self, from: Data("{\(base)}".utf8)).owner == nil, "an older daemon")
    }

    @Test func emptyAskSendsNothing() async {
        let t = FakeTransport(data: { _ in (200, okBody("{}")) })
        let store = MenuBarStore(preferences: { .default }, tokens: StaticTokens([.main: secret]), transport: t)
        await store.askManager(" \n ")
        #expect(t.requests.isEmpty)
        #expect(store.manager.isEmpty)
    }

    @Test func catchUpReadsTheTranscriptWhenNoStreamDelivers() async throws {
        let calls = Counter()
        let t = FakeTransport(data: { r in
            switch r.url?.path {
            case "/api/op/sessions.message": return (200, okBody(#"{"ok":true,"pending":true,"event":"ev-1","turnId":"t-1"}"#))
            case "/api/op/sessions.transcript":
                let n = calls.next()
                let reply = n < 2 ? #"{"id":"t-1","role":"assistant","text":"Work","pending":true,"inReplyTo":"ev-1"}"#
                    : #"{"id":"t-1","role":"assistant","text":"Working on it.","inReplyTo":"ev-1"}"#
                return (200, okBody(#"{"engine":"openclaw","offset":2,"turns":[{"id":"ev-1","role":"user","text":"Q"},\#(reply)]}"#))
            default: return (404, Data())
            }
        })
        let store = MenuBarStore(preferences: { .default }, tokens: StaticTokens([.main: secret]), transport: t)
        store.managerCatchUpInterval = .milliseconds(5)
        await store.askManager("Q")
        for _ in 0..<200 where store.manager.reply?.phase != .done { try await Task.sleep(for: .milliseconds(5)) }
        #expect(store.manager.reply?.text == "Working on it.")
        #expect(store.manager.reply?.phase == .done)
        let reads = t.requests(path: "/api/op/sessions.transcript").count
        try await Task.sleep(for: .milliseconds(50))
        #expect(t.requests(path: "/api/op/sessions.transcript").count == reads, "stops once the reply settles")
    }

    @Test func historyLoadsOncePerConnection() async throws {
        let summary = okBody(String(decoding: try JSONEncoder().encode(Summary.preview), as: UTF8.self))
        let t = FakeTransport(data: { r in
            switch r.url?.path {
            case "/api/op/native.summary": return (200, summary)
            case "/api/op/sessions.transcript":
                return (200, okBody(#"{"engine":"openclaw","offset":2,"turns":[{"id":"ev-1","role":"user","text":"Earlier"},{"id":"ev-2","role":"assistant","text":"Answer"}]}"#))
            default: return (404, Data())
            }
        })
        let store = MenuBarStore(preferences: { .default }, tokens: StaticTokens([.main: secret]), transport: t)
        await store.refresh()
        await store.loadManagerHistory()
        await store.loadManagerHistory()
        #expect(t.requests(path: "/api/op/sessions.transcript").count == 1)
        #expect(store.manager.question?.text == "Earlier")
        #expect(store.manager.reply?.text == "Answer")
    }
}

final class Counter: @unchecked Sendable { // lock guards n
    private let lock = NSLock()
    private var n = 0
    func next() -> Int { lock.withLock { defer { n += 1 }; return n } }
}

@MainActor
@Suite struct ManagerHostTests {
    /// native.summary names no manager host (it is widget-token readable): the board does, asked once.
    @Test func aRemoteManagerIsFoundOnTheBoard() async throws {
        var s = Summary.preview
        s.manager = ManagerState(up: true, lastNoteAt: nil)
        let summary = okBody(String(decoding: try JSONEncoder().encode(s), as: UTF8.self))
        let t = FakeTransport(data: { r in
            switch r.url?.path {
            case "/api/op/native.summary": return (200, summary)
            case "/api/op/native.board": return (200, okBody(#"{"strips":[],"manager":{"up":true,"host":"demo-box","status":"ready"}}"#))
            case "/api/op/sessions.message": return (200, okBody(#"{"ok":true,"pending":true,"event":"ev-1","turnId":"t-1"}"#))
            case "/api/op/sessions.transcript": return (200, okBody(#"{"turns":[]}"#))
            default: return (404, Data())
            }
        })
        let store = MenuBarStore(preferences: { .default }, tokens: StaticTokens([.main: secret]), transport: t)
        store.sleep = { _ in try await Task.sleep(for: .seconds(60)) }
        await store.refresh()
        await store.askManager("Q1")
        store.handle(SSEEvent(event: "manager", data: #"{"host":"demo-box","thread":"main","turnId":"t-1","inReplyTo":"ev-1","phase":"delta","delta":"remote"}"#, id: nil))
        #expect(store.manager.reply?.text == "remote", "the board's host counts for the stream too")
        let bodies = try t.requests(path: "/api/op/sessions.message").map { try bodyJSON($0.httpBody) }
        #expect(bodies.first?["host"] as? String == "demo-box")
        #expect(t.requests(path: "/api/op/native.board").count == 1)
        store.stop()
    }
}

/// Answers each op path from `bodies`; `native.board` waits until `open()`, like a slow host lookup.
final class GatedTransport: HTTPTransport, @unchecked Sendable { // lock guards the mutable state
    private let lock = NSLock()
    private var _requests: [URLRequest] = []
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var isOpen = false
    let bodies: [String: Data]

    init(bodies: [String: Data]) { self.bodies = bodies }

    var requests: [URLRequest] { lock.withLock { _requests } }
    func requests(path: String) -> [URLRequest] { requests.filter { $0.url?.path == path } }

    func open() {
        let ready = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
            isOpen = true
            defer { waiters = [] }
            return waiters
        }
        ready.forEach { $0.resume() }
    }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        lock.withLock { _requests.append(request) }
        if request.url?.path == "/api/op/native.board" {
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                let go = lock.withLock { () -> Bool in
                    if isOpen { return true }
                    waiters.append(c)
                    return false
                }
                if go { c.resume() }
            }
        }
        let body = bodies[request.url?.path ?? ""]
        return (body ?? Data(), FakeTransport.response(request, body == nil ? 404 : 200))
    }

    func lines(for request: URLRequest) async throws -> (AsyncThrowingStream<String, Error>, HTTPURLResponse) {
        throw URLError(.cannotConnectToHost)
    }
}

/// A send whose configuration changes while the manager's host is looked up never reaches the old endpoint, and
/// the box never stays stuck on "sending".
@MainActor
@Suite struct ManagerReconfigureTests {
    final class Prefs: @unchecked Sendable { var value = MenuBarPreferences() } // main actor only

    private func setup() throws -> (MenuBarStore, GatedTransport, Prefs, StaticTokens) {
        var s = Summary.preview
        s.manager = ManagerState(up: true, lastNoteAt: nil)   // no host: the board is asked
        let t = GatedTransport(bodies: [
            "/api/op/native.summary": okBody(String(decoding: try JSONEncoder().encode(s), as: UTF8.self)),
            "/api/op/native.board": okBody(#"{"strips":[],"manager":{"up":true,"host":"local"}}"#),
            "/api/op/sessions.message": okBody(#"{"ok":true,"pending":true,"event":"ev-1","turnId":"t-1"}"#),
        ])
        let prefs = Prefs()
        let tokens = StaticTokens([.main: secret])
        let store = MenuBarStore(preferences: { prefs.value }, tokens: tokens, transport: t)
        store.sleep = { _ in try await Task.sleep(for: .seconds(60)) }
        return (store, t, prefs, tokens)
    }

    private func waitForBoard(_ t: GatedTransport) async throws {
        for _ in 0..<200 where t.requests(path: "/api/op/native.board").isEmpty { try await Task.sleep(for: .milliseconds(5)) }
        #expect(!t.requests(path: "/api/op/native.board").isEmpty)
    }

    @Test func aServerChangeDuringTheLookupDropsTheSend() async throws {
        let (store, t, prefs, _) = try setup()
        await store.refresh()
        let send = Task { await store.askManager("Who is waiting on me?") }
        try await waitForBoard(t)
        prefs.value.serverURL = "https://new.test:1"
        store.reconfigure()
        t.open()
        await send.value
        #expect(t.requests(path: "/api/op/sessions.message").isEmpty, "nothing went to the old server")
        #expect(!store.manager.sending)
        store.stop()
    }

    @Test func aTokenChangeDuringTheLookupFailsTheSendInsteadOfSticking() async throws {
        let (store, t, _, tokens) = try setup()
        // Started, as the app always is: a reconfigure to the same server keeps the conversation on show.
        store.start()
        await store.refresh()
        let send = Task { await store.askManager("Who is waiting on me?") }
        try await waitForBoard(t)
        try tokens.setToken("tok-NEW-456", for: .main)
        store.reconfigure()
        t.open()
        await send.value
        #expect(t.requests(path: "/api/op/sessions.message").isEmpty, "the old token never went out")
        #expect(!store.manager.sending && !store.manager.busy)
        #expect(store.manager.reply?.phase == .failed("The server changed before the message went out. Ask again."))
        // The next ask goes out with the new token.
        await store.askManager("Again")
        let req = try #require(t.requests(path: "/api/op/sessions.message").first)
        #expect(req.value(forHTTPHeaderField: "Authorization") == "Bearer tok-NEW-456")
        store.stop()
    }

    @Test func aSweepDuringAChangeIsNotSentToTheOldServer() async throws {
        let (store, t, prefs, _) = try setup()
        await store.refresh()
        let sweep = Task { () -> Bool in (try? await store.sweepManager()) != nil }
        try await waitForBoard(t)
        prefs.value.serverURL = "https://new.test:1"
        store.reconfigure()
        t.open()
        #expect(await sweep.value == false)
        #expect(t.requests(path: "/api/op/openclaw.sweep").isEmpty)
        store.stop()
    }
}
