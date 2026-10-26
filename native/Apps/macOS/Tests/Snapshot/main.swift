import AppKit
import DroverKit
import SwiftUI

// Renders ContentView on MockDroverService data into PNGs. Slices may add scenes to `scenes` below. Whole-window
// scenes come out as a window screenshot (WindowShot): title bar, toolbar, rounded corners and a shadow.
@MainActor
func spin(_ view: NSView) {
    RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.02))
    view.layoutSubtreeIfNeeded()
}

@MainActor
func render<V: View>(_ view: V, size: CGSize, dark: Bool, window framed: Bool, to url: URL) async {
    let host = NSHostingView(rootView: view)
    host.frame = CGRect(origin: .zero, size: size)
    // A whole window lays out like the app's: the content runs under the title bar and toolbar.
    let style: NSWindow.StyleMask = framed ? [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView] : [.titled, .resizable]
    let window = NSWindow(contentRect: host.frame, styleMask: style, backing: .buffered, defer: false)
    window.title = "Drover"
    window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
    window.contentView = host
    window.layoutIfNeeded()
    // Let SwiftUI run `.task`s (yield the main actor) and lay out lists (spin the run loop).
    for _ in 0..<30 {
        try? await Task.sleep(for: .milliseconds(30))
        spin(host)
    }
    let shot = framed ? host.superview ?? host : host
    let lights = WindowShot.lights(of: window, in: shot)
    WindowShot.flatten(shot, window: window, dark: dark)
    guard let rep = shot.bitmapImageRepForCachingDisplay(in: shot.bounds) else { return }
    shot.cacheDisplay(in: shot.bounds, to: rep)
    let png = framed ? WindowShot.png(rep, lights: lights, dark: dark) : rep.representation(using: .png, properties: [:])
    try? png?.write(to: url)
    print("wrote \(url.path)")
}

/// A model on mock data with its event stream started, so the connection reads Live and manager replies stream in.
@MainActor
func makeModel(service: MockDroverService = MockDroverService(), configure: (AppModel) -> Void = { _ in }) async -> AppModel {
    let model = AppModel(settings: AppSettings(defaults: UserDefaults(suiteName: "snapshot-\(UUID())")!, group: nil),
                         tokens: MemoryTokenStore("mock"), service: service)
    await model.refresh()
    model.start()
    configure(model)
    return model
}

/// No token yet, pairing with a scripted daemon that shows `code` and then never answers.
@MainActor
func makePairingModel(code: String = "482913") async -> AppModel {
    let expires = Date.now.addingTimeInterval(118).formatted(.iso8601)
    let daemon = MockPairingTransport([MockPairingTransport.created(code: code, expiresAt: expires), .hang])
    let model = AppModel(settings: AppSettings(defaults: UserDefaults(suiteName: "snapshot-\(UUID())")!, group: nil),
                         tokens: MemoryTokenStore(nil), widgetTokens: MemoryTokenStore(),
                         service: LiveDroverService(baseURL: nil, tokens: MemoryTokenStore(nil)),
                         pairing: PairingController(makeClient: { PairingClient(baseURL: $0, transport: daemon, clock: MockPairingClock(now: .now)) }))
    model.startPairing()
    for _ in 0..<200 where model.pairing.phase.code == nil { try? await Task.sleep(for: .milliseconds(5)) }
    return model
}

/// A pair link for another daemon than the one in use: its sheet before the click, or (clicked) with the code showing.
@MainActor
func makePairLinkModel(clicked: Bool) async -> AppModel {
    let expires = Date.now.addingTimeInterval(118).formatted(.iso8601)
    let daemon = MockPairingTransport([MockPairingTransport.created(code: "482913", expiresAt: expires), .hang])
    let model = AppModel(settings: AppSettings(defaults: UserDefaults(suiteName: "snapshot-\(UUID())")!, group: nil),
                         tokens: MemoryTokenStore("mock"), service: MockDroverService(),
                         pairing: PairingController(makeClient: { PairingClient(baseURL: $0, transport: daemon, clock: MockPairingClock(now: .now)) }))
    model.open(.pair(URL(string: "http://100.64.0.7:7337")!))
    if clicked {
        model.confirmPairLink()
        for _ in 0..<200 where model.pairing.phase.code == nil { try? await Task.sleep(for: .milliseconds(5)) }
    }
    return model
}

@MainActor
func main() async {
    _ = NSApplication.shared
    NSApp.setActivationPolicy(.prohibited)
    let out = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? ".build/snapshots")
    typealias Scene = (name: String, size: CGSize, window: Bool, make: () async -> AnyView)
    // The app's default width; taller than its default 820, so a chat with its tool run or a dialog card fits whole.
    let main = CGSize(width: 1280, height: 900)
    let scenes: [Scene] = [
        ("board", main, true, {
            // The board's dialog for demo-build as a card. The pane is not read (the window counts as hidden): the
            // mock's draws a boxed prompt, and that reading would put the card away.
            let m = await makeModel { $0.select(MockDroverService.sessions[0]); $0.isMainWindowVisible = false }
            return AnyView(ContentView().environment(m))
        }),
        ("screen", main, true, {
            let m = await makeModel { $0.select(MockDroverService.sessions[0]); $0.detailTab = .screen }
            return AnyView(ContentView().environment(m))
        }),
        ("chat-tools", main, true, {
            // demo-docs: no dialog, so the chat fills the column; its first tool run expanded.
            let m = await makeModel { $0.select(MockDroverService.sessions[2]) }
            let chat = m.chatModel(for: MockDroverService.sessions[2])
            await chat.load(service: m.service, session: MockDroverService.sessions[2])
            await chat.layoutSettled()
            if let g = chat.items.first(where: { if case .tools = $0 { true } else { false } }) { chat.rows.expanded.insert(g.id) }
            return AnyView(ContentView().environment(m))
        }),
        ("chat-dialog", main, true, {
            // The card with the field a "Type something" option opens, on an AskUserQuestion reading. The pane is not read
            // here (the window counts as hidden): the mock's draws a boxed prompt, and that reading would close the field.
            let s = MockDroverService.sessions[0]
            let m = await makeModel { $0.select(s) }
            let ask = ScreenDialog.read("Should the review cover the test fixtures too?\n\n  1. Yes, all of them (Recommended)\n  2. Only the new ones\n  3. No, skip fixtures\n❯ 4. Type something.\n\nEnter to select · ↑/↓ to navigate · Esc to cancel")
            m.isMainWindowVisible = false
            m.liveDialogs[s.key] = LiveDialog(reading: ask, at: Date())
            m.typingAnswer[s.key] = FreeTextField(question: ask?.dialog.question, option: 4)
            return AnyView(ContentView().environment(m))
        }),
        ("manager", main, true, {
            // The mock's history, then a quick prompt whose reply streams in over the event stream.
            let mock = MockDroverService()
            mock.streamStep = 0
            let m = await makeModel(service: mock) { $0.sidebarSelection = .manager }
            await m.manager.refresh()
            m.manager.send(ManagerModel.quickPrompts[2].text)
            for _ in 0..<300 where m.manager.isBusy || m.manager.items.count < 4 { try? await Task.sleep(for: .milliseconds(10)) }
            return AnyView(ContentView().environment(m))
        }),
        ("manager-panel", CGSize(width: 420, height: 620), false, {
            let m = await makeModel()
            await m.manager.refresh()
            return AnyView(ManagerView(compact: true).environment(m))
        }),
        ("info", main, true, {
            let m = await makeModel { $0.select(MockDroverService.sessions[2]); $0.detailTab = .info }
            return AnyView(ContentView().environment(m))
        }),
        ("sidebar", CGSize(width: 260, height: 600), false, {
            // Standalone, at a width of its own (in a window it is the floating panel WindowShot draws).
            let m = await makeModel { $0.sidebarSelection = .lane(.waiting) }
            return AnyView(SidebarView().environment(m))
        }),
        ("settings", CGSize(width: 620, height: 560), false, {
            let m = await makeModel()
            return AnyView(SettingsView().environment(m))
        }),
        ("palette", CGSize(width: 640, height: 440), false, {
            let m = await makeModel()
            return AnyView(CommandPalette().environment(m))
        }),
        ("pairing-board", main, true, {
            AnyView(ContentView().environment(await makePairingModel()))
        }),
        ("pairing-settings", CGSize(width: 620, height: 560), false, {
            AnyView(SettingsView().environment(await makePairingModel()))
        }),
        ("pair-link", CGSize(width: 500, height: 220), false, {
            let m = await makePairLinkModel(clicked: false)
            return AnyView(PairLinkSheet(url: m.pairLink!).environment(m))
        }),
        ("pair-link-code", CGSize(width: 500, height: 360), false, {
            let m = await makePairLinkModel(clicked: true)
            return AnyView(PairLinkSheet(url: m.pairLink!).environment(m))
        }),
    ]
    for s in scenes {
        for dark in [false, true] {
            await render(await s.make(), size: s.size, dark: dark, window: s.window,
                         to: out.appending(path: "\(s.name)-\(dark ? "dark" : "light").png"))
        }
    }
}

await main()
