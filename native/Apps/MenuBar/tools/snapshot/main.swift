import AppKit
import SwiftUI

// tools/snapshot.sh: the popover on synthetic data (CONTRACT.md: no company data), one PNG per scene and
// appearance. Stores are previews: nothing touches the network.

/// The preview summary with its times moved to just before the render (the fixed dates read "1 week ago" in a picture).
func recent(_ s: Summary, now: Date = Date()) -> Summary {
    let iso = ISO8601DateFormatter()
    let shift = now.timeIntervalSince(iso.date(from: s.generatedAt) ?? now)
    let moved = { (t: String?) in t.flatMap(iso.date(from:)).map { iso.string(from: $0.addingTimeInterval(shift)) } }
    var r = s
    r.generatedAt = iso.string(from: now)
    r.waiting = s.waiting.map { var w = $0; w.since = moved(w.since) ?? w.since; return w }
    if var m = r.manager { m.lastNoteAt = moved(m.lastNoteAt) ?? m.lastNoteAt; r.manager = m }
    return r
}

@MainActor
func scenes() -> [(String, @MainActor () -> MenuBarStore)] {
    let preview = recent(.preview)
    var done = ManagerChat()
    done.beginSend("Who is waiting on me?")
    done.sent(ManagerSendResult(pending: true, event: "ev-1", turnId: "t-1"))
    done.apply(ManagerStreamEvent(turnId: "t-1", inReplyTo: "ev-1", phase: "done",
                                  text: "Two sessions wait on you. **demo-build** asks to run `npm test`; **demo-review** asked whether the review covers the fixtures."))

    var streaming = ManagerChat()
    streaming.beginSend("What finished?")
    streaming.sent(ManagerSendResult(pending: true, event: "ev-2", turnId: "t-2"))
    streaming.apply(ManagerStreamEvent(turnId: "t-2", inReplyTo: "ev-2", phase: "delta", text: "demo-docs finished the README section"))

    var thinking = ManagerChat()
    thinking.beginSend("Sweep the fleet and tell me what is stuck")

    let row = preview.waiting[0]
    func withState(_ state: @escaping @MainActor () -> RowAnswerState) -> @MainActor () -> MenuBarStore {
        { let s = MenuBarStore.preview(preview, manager: done); s.previewAnswerState(row, state()); return s }
    }

    var legacy = preview
    legacy.waiting = legacy.waiting.map { var w = $0; w.dialog = nil; w.keys = nil; w.hash = nil; w.answer = nil; return w }
    legacy.manager = ManagerState(up: false, lastNoteAt: nil)

    var remote = preview
    remote.manager = ManagerState(up: true, lastNoteAt: nil, host: "demo-box")

    return [
        ("dialog", { MenuBarStore.preview(preview, manager: done) }),
        ("manager-streaming", { MenuBarStore.preview(remote, manager: streaming) }),
        ("manager-thinking", { MenuBarStore.preview(preview, manager: thinking) }),
        ("answer-sending", withState { RowAnswerState(pressing: "2", at: Date()) }),
        ("answer-sent", withState { RowAnswerState(pressing: nil, message: "Sent 1.", isError: false, answeredHash: row.hash, at: Date()) }),
        ("answer-refused", withState {
            RowAnswerState(pressing: nil, message: "Not sent: the screen changed since you read it; read it again.", isError: true, answeredHash: nil, at: Date())
        }),
        ("older-daemon", { MenuBarStore.preview(legacy, connection: .polling) }),
        ("widget-token-only", { MenuBarStore.preview(preview, connection: .polling, canAct: false) }),
        ("offline", { MenuBarStore.preview(preview, connection: .offline("Cannot reach the server.")) }),
    ]
}

@main
struct SnapshotMain {
    @MainActor
    static func main() async {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let out = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? ".build/snapshots")
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        for (name, make) in scenes() {
            for dark in [false, true] {
                let store = make()
                let url = out.appendingPathComponent("\(name)-\(dark ? "dark" : "light").png")
                await SnapshotRenderer.render(PopoverView(store: store, actions: .noop), width: 380, dark: dark, to: url)
                print("wrote \(url.path)")
            }
        }
        exit(0)
    }
}
