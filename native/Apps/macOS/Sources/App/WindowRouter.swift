import AppKit
import SwiftUI

/// The app's windows: one main window (the `Window` scene "main") and the floating manager panel. Every way in, a
/// `drover://` URL (menu bar Open, widgets, the Safari extension), a notification tap, a Dock click, routes here, so
/// nothing ever opens a second main window: the one window is brought forward, or reopened when it was closed.
///
/// URLs arrive through our own `kAEGetURL` handler (AppDelegate), not SwiftUI's `onOpenURL`: with that, SwiftUI never
/// sees a URL and so never opens a window for one (a `WindowGroup` opens a new window per URL).
@MainActor
final class WindowRouter {
    static let shared = WindowRouter()

    weak var model: AppModel?
    /// SwiftUI's openWindow, captured from the main window's content (it keeps working after the window closes).
    var openMainWindow: OpenWindowAction?
    let panel = ManagerPanelController()
    /// URLs that arrived before the model existed (a cold launch by URL).
    private var pendingURLs: [URL] = []
    /// A show asked before the window had appeared once.
    private var showWhenReady = false
    private weak var observedWindow: NSWindow?

    static let mainWindowID = "main"

    func attach(_ model: AppModel) {
        self.model = model
        let urls = pendingURLs
        pendingURLs = []
        for u in urls { handle(url: u) }
    }

    /// The main window, open or closed (SwiftUI keeps its NSWindow after a close).
    func mainWindow() -> NSWindow? {
        NSApp.windows.first { w in
            guard let id = w.identifier?.rawValue else { return false }
            return id == Self.mainWindowID || id.hasPrefix("\(Self.mainWindowID)-")
        }
    }

    /// Bring the one main window forward; reopen it when it was closed.
    func showMain() {
        if let w = mainWindow(), w.isVisible || w.isMiniaturized {
            if w.isMiniaturized { w.deminiaturize(nil) }
            w.makeKeyAndOrderFront(nil)
        } else if let open = openMainWindow {
            open(id: Self.mainWindowID)
        } else {
            // Launching: the Window scene opens on its own; activate once it is there.
            showWhenReady = true
        }
        activate()
    }

    /// The main window's content appeared (at launch, or reopened).
    func mainWindowAppeared(open: OpenWindowAction, window: NSWindow?) {
        openMainWindow = open
        if let window, window !== observedWindow {
            observedWindow = window
            NotificationCenter.default.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, let w = self.observedWindow else { return }
                    self.model?.isMainWindowVisible = w.occlusionState.contains(.visible) && w.isVisible
                }
            }
        }
        model?.isMainWindowVisible = true
        if showWhenReady {
            showWhenReady = false
            activate()
        }
    }

    func mainWindowClosed() {
        model?.isMainWindowVisible = false
    }

    // MARK: routes

    func handle(url: URL) {
        guard let model else { pendingURLs.append(url); return }
        guard let route = model.open(url: url) else { return }
        PerfLog.note("route \(route)")
        switch route {
        case .debug(let action, let query): debug(action, query)
        case .manager(inWindow: false): panel.show(model)
        default: showMain()
        }
    }

    /// A notification was tapped (or its Open action chosen): the session, in the one window.
    func openSession(id: String?, host: String?) {
        guard let model else { return }
        if let id { model.reveal(sessionId: id, host: host); model.detailTab = .chat }
        showMain()
    }

    func toggleManagerPanel() {
        guard let model else { return }
        panel.toggle(model)
    }

    func activate() {
        #if DROVER_DEV
        guard DevConfig.activates else { return }
        #endif
        NSApp.activate()
    }

    // MARK: dev build test hooks (droverdev://debug/<action>, DevHooks.swift)

    private func debug(_ action: String, _ query: [String: String]) {
        #if DROVER_DEV
        DevHooks.run(action, query, router: self)
        #endif
    }
}

/// Hands the hosting NSWindow to a closure once the view is in one.
struct WindowReader: NSViewRepresentable {
    var onWindow: (NSWindow) -> Void

    func makeNSView(context: Context) -> NSView { Probe(onWindow: onWindow) }
    func updateNSView(_ nsView: NSView, context: Context) {}

    final class Probe: NSView {
        let onWindow: (NSWindow) -> Void
        init(onWindow: @escaping (NSWindow) -> Void) { self.onWindow = onWindow; super.init(frame: .zero) }
        required init?(coder: NSCoder) { nil }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let window { onWindow(window) }
        }
    }
}
