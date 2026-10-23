import AppKit
import SwiftUI

/// The floating manager: an NSPanel above every app (and every Space), toggled with Cmd-Shift-M or the app menu and
/// opened by `drover://manager`. It does not activate Drover, so it can sit over a terminal while you type into it.
/// Its frame is remembered (autosave name). The conversation is the main window's (one ManagerModel).
@MainActor
final class ManagerPanelController {
    private var panel: FloatingPanel?

    var isVisible: Bool { panel?.isVisible ?? false }

    func toggle(_ model: AppModel) {
        if isVisible { panel?.orderOut(nil) } else { show(model) }
    }

    func show(_ model: AppModel) {
        let panel = self.panel ?? make(model)
        self.panel = panel
        panel.orderFrontRegardless()
        panel.makeKey()
        model.manager.focusComposer()
        Task { await model.manager.refresh() }
    }

    private func make(_ model: AppModel) -> FloatingPanel {
        let panel = FloatingPanel(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 620),
            styleMask: [.titled, .closable, .resizable, .fullSizeContentView, .nonactivatingPanel, .utilityWindow],
            backing: .buffered, defer: false)
        panel.title = "Manager"
        panel.titlebarAppearsTransparent = true
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = false
        panel.isReleasedWhenClosed = false
        panel.isMovableByWindowBackground = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.minSize = NSSize(width: 340, height: 360)
        panel.onToggle = { [weak self, weak model] in
            guard let self, let model else { return }
            self.toggle(model)
        }
        let host = NSHostingView(rootView: ManagerView(compact: true).environment(model))
        host.sizingOptions = []
        panel.contentView = host
        // Remembered across launches; the first time, the right edge of the screen.
        if !panel.setFrameUsingName(Self.autosave) {
            if let screen = NSScreen.main?.visibleFrame {
                panel.setFrameOrigin(NSPoint(x: screen.maxX - 440, y: screen.maxY - 640))
            }
        }
        panel.setFrameAutosaveName(Self.autosave)
        return panel
    }

    static let autosave = "DroverManagerPanel"
}

/// Takes key without activating the app (`.nonactivatingPanel`), and answers Cmd-Shift-M and Cmd-W itself: while
/// another app is active, Drover's menu does not see them.
final class FloatingPanel: NSPanel {
    var onToggle: (() -> Void)?

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let key = event.charactersIgnoringModifiers?.lowercased()
        if flags == [.command, .shift], key == "m" { onToggle?(); return true }
        if flags == .command, key == "w" { orderOut(nil); return true }
        return super.performKeyEquivalent(with: event)
    }

    override func cancelOperation(_ sender: Any?) { orderOut(nil) }
}
