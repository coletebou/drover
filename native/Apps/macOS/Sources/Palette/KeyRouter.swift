import AppKit

enum NavAction: Equatable {
    case next, previous, open, reply
}

/// Pure decision for the board's single-key shortcuts. Arrows are left to the lists.
enum KeyRouter {
    static func action(characters: String?, keyCode: UInt16, modifiers: NSEvent.ModifierFlags,
                       textInputFocused: Bool, paletteOpen: Bool) -> NavAction? {
        if paletteOpen || textInputFocused { return nil }
        if !modifiers.intersection([.command, .control, .option]).isEmpty { return nil }
        if keyCode == 36 || keyCode == 76 { return .open }
        switch characters?.lowercased() {
        case "j": return .next
        case "k": return .previous
        case "r": return .reply
        default: return nil
        }
    }

    /// True when the key window's first responder is a text field or field editor.
    @MainActor static func textInputFocused(in window: NSWindow?) -> Bool {
        guard let r = window?.firstResponder else { return false }
        return r is NSText || r is NSTextField
    }
}
