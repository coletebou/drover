import Foundation

// The compact board (native.board, and the SSE board event that carries it) and the fleet fallback for older daemons.
@MainActor
enum BoardDecodeTests {
    /// A native.board result, synthetic (shape as the daemon's buildBoard, 2026-10-20).
    static let board = #"""
    {"generatedAt":"2026-10-20T19:09:15.666Z",
     "hosts":[{"name":"local","up":true,"waiting":2,"working":1,"idle":2},
              {"name":"devbox","up":false,"waiting":0,"working":0,"idle":0,"error":"ssh timed out","stale":true}],
     "strips":[
      {"key":"local|s-build","id":"s-build","name":"demo-build","host":"local","engine":"claude","lane":"wait","status":"idle",
       "kind":"session","headline":"Do you want to proceed?","screen":"dialog","tmux":"demo:1","cwd":"~/code/demo",
       "since":"2026-10-20T19:05:45.457Z","tail":["Do you want to proceed?","Esc to cancel"],
       "ask":{"kind":"decision","label":"needs a decision","text":"Do you want to proceed?","options":[{"n":1,"label":"Yes"}]},
       "answer":"keys","dialog":{"question":"Do you want to proceed?","options":[{"n":1,"label":"Yes","selected":true},
       {"n":2,"label":"Yes, and don't ask again"},{"n":3,"label":"No"}]},"hash":"b7b2cd011effcdc8","keys":["1","2","3","Enter","Escape"]},
      {"key":"local|s-held","id":"s-held","name":"demo-held","host":"local","engine":"claude","lane":"wait","status":"idle",
       "kind":"session","headline":"Held message","screen":"idle","tmux":"demo:5","held":true,"heldFrom":"demo-peer",
       "answer":"keys","dialog":{"question":null,"options":[]},"hash":"aa11","keys":["Enter","Escape"]},
      {"key":"local|s-ask","id":"s-ask","name":"demo-ask","host":"local","engine":"codex","lane":"wait","status":"idle",
       "kind":"session","headline":"Should the parser accept trailing commas?","ask":{"kind":"question","label":"asked a question",
       "text":"Should the parser accept trailing commas?"},"answer":"reply"},
      {"key":"local|s-work","id":"s-work","name":"demo-work","host":"local","engine":"claude","lane":"work","status":"busy",
       "kind":"session","headline":"Compiling","screen":"busy","tmux":"demo:3.%7"},
      {"key":"local|demo:9","id":"demo:9","name":"demo-window","host":"local","engine":"claude","lane":"idle","status":"idle",
       "kind":"window","headline":"","tmux":"demo:9","faded":true},
      {"key":"local|demo:8","id":"s-win","name":"demo-winsession","host":"local","engine":"claude","lane":"idle","status":"idle",
       "kind":"window","headline":"","tmux":"demo:8"},
      {"key":"local|manager","id":"manager","name":"manager","host":"local","engine":"openclaw","lane":"idle","status":"ready",
       "kind":"session","headline":"","finished":{"text":"Swept the fleet","ts":"2026-10-20T19:00:00.000Z"}},
      {"id":"broken"}
     ],
     "totals":{"waiting":3,"working":1,"idle":3,"hosts":2},
     "manager":{"up":true,"host":"local","status":"ready","lastNoteAt":"2026-10-20T18:30:15.902Z"}}
    """#

    static func run() async {
        await T.suite("BoardDecoder (native.board)") {
            let b = BoardDecoder.snapshot(T.json(board))
            T.eq(b.source, .board)
            T.eq(b.sessions.count, 7, "the strip without a host is dropped")
            T.eq(b.sessions.map(\.name), ["demo-build", "demo-held", "demo-ask", "demo-work", "demo-window", "demo-winsession", "manager"], "board order kept")
            T.eq(b.hosts.map(\.name), ["local", "devbox"])
            T.check(b.hosts[1].stale && !b.hosts[1].up, "stale, down host")
            T.eq(b.hosts[1].error, "ssh timed out")
            T.eq(b.manager, ManagerInfo(up: true, host: "local", lastNoteAt: JSONValue.string("2026-10-20T18:30:15.902Z").date))

            let build = b.sessions[0]
            T.eq(build.lane, .waiting); T.eq(build.waitKind, .decision)
            T.eq(build.screen, .dialog); T.eq(build.hash, "b7b2cd011effcdc8")
            T.eq(build.keys, ["1", "2", "3", "Enter", "Escape"]); T.eq(build.answerMode, .keys)
            T.eq(build.dialog?.question, "Do you want to proceed?")
            T.eq(build.dialog?.options.map(\.n), [1, 2, 3])
            T.check(build.dialog?.options.first?.selected == true, "selected option")
            T.eq(build.askLabel, "needs a decision")
            T.eq(build.tail, ["Do you want to proceed?", "Esc to cancel"])
            T.check(build.answersWithKeys, "answers with keys")

            let held = b.sessions[1]
            T.check(held.held, "held"); T.eq(held.heldFrom, "demo-peer"); T.eq(held.keys, ["Enter", "Escape"])
            T.eq(held.dialog, nil, "an empty dialog is no dialog")
            T.check(held.answersWithKeys)

            let ask = b.sessions[2]
            T.eq(ask.answerMode, .reply); T.eq(ask.waitKind, .question); T.eq(ask.keys, [])
            T.check(!ask.answersWithKeys, "a question in text is answered with a message")

            let work = b.sessions[3]
            T.eq(work.lane, .working); T.eq(work.tmuxTarget, "demo:3", "pane suffix stripped"); T.check(work.isWorking)

            T.check(b.sessions[4].windowOnly, "a faded window strip has no session")
            T.eq(b.sessions[4].transcriptId, "demo:9")
            T.check(!b.sessions[5].windowOnly, "a window strip whose agent has a session")
            T.eq(b.sessions[5].transcriptId, "s-win")

            let mgr = b.sessions[6]
            T.check(mgr.isManager); T.eq(mgr.finished?.text, "Swept the fleet")
            T.eq(BoardFormat.summaryLine(mgr), "Swept the fleet", "an idle strip shows what finished")
        }
        await T.suite("BoardDecoder without keys (an older daemon's strip)") {
            let s = BoardDecoder.strip(T.json(#"{"id":"x","host":"local","lane":"wait","dialog":{"question":"Pick one","options":[{"n":1,"label":"A"},{"n":2,"label":"B"}]},"hash":"h"}"#))
            T.eq(s?.keys, ["1", "2", "Enter", "Escape"], "the options, Enter and Escape")
            T.eq(s?.answerMode, .keys)
        }
        await T.suite("BoardSnapshot.sameContent ignores generatedAt") {
            let a = BoardDecoder.snapshot(T.json(board))
            var b = a
            b.generatedAt = a.generatedAt.addingTimeInterval(20)
            T.check(a.sameContent(as: b), "only the time differs")
            b.sessions[0].hash = "other"
            T.check(!a.sameContent(as: b), "a new screen hash is a change")
        }
        await T.suite("Fleet fallback carries window dialogs and keys") {
            let fleet = T.json(#"""
            {"hosts":[{"host":"local","ok":true,"sessions":[{"id":"s1","engine":"claude","name":"demo-build","status":"idle","live":true,"tmux":"demo:1.%2"}],
              "windows":[{"target":"demo:1","name":"build","agent":{"sessionId":"s1"},"screen":{"state":"dialog"},
                          "dialog":{"question":"Do you want to proceed?","options":[{"n":1,"label":"Yes","selected":true},{"n":2,"label":"No"}]},
                          "hash":"abc123","tail":["Do you want to proceed?"]}]}]}
            """#)
            let b = BoardBuilder.build(fleet: fleet, native: nil)
            let s = b.sessions.first
            T.eq(s?.lane, .waiting); T.eq(s?.hash, "abc123"); T.eq(s?.keys, ["1", "2", "Enter", "Escape"])
            T.eq(s?.dialog?.options.count, 2); T.eq(s?.screen, .dialog); T.eq(s?.tail, ["Do you want to proceed?"])
            T.eq(b.source, .fleet)
            // With native.summary saying the session is idle, the dialog stays off (native is authoritative).
            let n = BoardBuilder.build(fleet: fleet, native: T.json(#"{"waiting":[],"working":[]}"#))
            T.eq(n.sessions.first?.lane, .idle); T.eq(n.sessions.first?.keys, [], "no buttons for a session that does not wait")
        }
        await T.suite("AppModel.apply(board:) skips boards that did not change") {
            let m = AppModel(settings: AppSettings(defaults: UserDefaults(suiteName: "harness-\(UUID())")!, group: nil),
                             tokens: MemoryTokenStore("x"), service: MockDroverService())
            let a = BoardDecoder.snapshot(T.json(board))
            m.apply(board: a)
            var later = a
            later.generatedAt = a.generatedAt.addingTimeInterval(15)
            m.apply(board: later)
            T.eq(m.board.generatedAt, a.generatedAt, "same content: the old board object stays (no redraw)")
            later.sessions.removeLast()
            m.apply(board: later)
            T.eq(m.board.sessions.count, 6, "a real change lands")
            T.eq(m.managerHost, "local")
        }
    }
}
