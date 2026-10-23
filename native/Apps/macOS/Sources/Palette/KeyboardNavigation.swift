import SwiftUI
import AppKit

/// Holds the event monitor token outside the view value.
private final class MonitorBox: @unchecked Sendable {
    var token: Any?
}

/// Board keyboard navigation: j/k move, Enter opens, r replies. Applied once by ContentView.
struct KeyboardNavigation: ViewModifier {
    @Environment(AppModel.self) private var model
    @State private var box = MonitorBox()

    func body(content: Content) -> some View {
        content
            .onAppear { install() }
            .onDisappear { remove() }
    }

    private func install() {
        guard box.token == nil else { return }
        let model = self.model
        box.token = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            let chars = event.charactersIgnoringModifiers
            let code = event.keyCode
            let flags = event.modifierFlags
            let swallow = MainActor.assumeIsolated {
                handle(characters: chars, keyCode: code, modifiers: flags, model: model)
            }
            return swallow ? nil : event
        }
    }

    /// True when the key was consumed.
    @MainActor private func handle(characters: String?, keyCode: UInt16, modifiers: NSEvent.ModifierFlags, model: AppModel) -> Bool {
        let window = NSApp.keyWindow
        if window?.isSheet ?? false { return false }
        // The floating manager panel types into the manager, never into the board's shortcuts.
        if window is FloatingPanel { return false }
        if let id = window?.identifier?.rawValue, id.localizedCaseInsensitiveContains("settings") { return false }
        guard let action = KeyRouter.action(
            characters: characters, keyCode: keyCode, modifiers: modifiers,
            textInputFocused: KeyRouter.textInputFocused(in: window), paletteOpen: model.isPaletteOpen) else { return false }
        perform(action, on: model)
        return true
    }

    private func remove() {
        if let t = box.token { NSEvent.removeMonitor(t) }
        box.token = nil
    }

    @MainActor private func perform(_ action: NavAction, on model: AppModel) {
        switch action {
        case .next: model.selectNext()
        case .previous: model.selectPrevious()
        case .open:
            if model.selectedSession == nil { model.selectNext() }
            model.detailTab = .chat
        case .reply:
            if model.selectedSession == nil { model.selectNext() }
            model.focusComposer()
        }
    }
}
