import AppKit

/// Opens or closes the menu bar popover from the global hotkey.
@MainActor
enum PopoverToggler {
    /// SwiftUI `MenuBarExtra` has no API to open its window, so this finds the status item button in
    /// the status bar window and clicks it. That relies on AppKit internals of MenuBarExtra and is
    /// the common workaround. If the button is not found, nothing happens.
    static func toggle() {
        NSApp.activate()
        for window in NSApp.windows where String(describing: type(of: window)).contains("NSStatusBarWindow") {
            if let button = findButton(in: window.contentView) {
                button.performClick(nil)
                return
            }
        }
    }

    private static func findButton(in view: NSView?) -> NSStatusBarButton? {
        guard let view else { return nil }
        if let button = view as? NSStatusBarButton { return button }
        for sub in view.subviews {
            if let found = findButton(in: sub) { return found }
        }
        return nil
    }
}
