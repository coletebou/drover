import Carbon.HIToolbox
import Foundation
import Testing
@testable import MenuBarCore

struct HotkeyTests {
    @Test func displayStrings() {
        #expect(KeyCombo.defaultCombo.displayString == "⌃⌥A")
        #expect(KeyCombo(keyCode: UInt32(kVK_Space), modifiers: [.command, .shift]).displayString == "⇧⌘Space")
        #expect(KeyCombo(keyCode: UInt32(kVK_F5), modifiers: []).displayString == "F5")
        #expect(KeyCombo(keyCode: UInt32(kVK_LeftArrow), modifiers: [.command]).displayString == "⌘←")
        #expect(KeyCombo(keyCode: UInt32(kVK_UpArrow), modifiers: [.option]).displayString == "⌥↑")
        #expect(KeyCombo(keyCode: UInt32(kVK_ANSI_Grave), modifiers: [.control]).displayString == "⌃`")
    }

    @Test func carbonRoundTrip() {
        let combo = KeyCombo(keyCode: 40, modifiers: [.command, .option, .control, .shift])
        #expect(combo.carbonModifiers == UInt32(cmdKey | optionKey | controlKey | shiftKey))
        #expect(KeyCombo(keyCode: 40, carbonModifiers: combo.carbonModifiers) == combo)
        #expect(KeyCombo.defaultCombo.carbonModifiers == UInt32(controlKey | optionKey))
    }

    @Test func cocoaFlags() {
        let cmdShift: UInt = (1 << 20) | (1 << 17)
        #expect(KeyCombo(keyCode: UInt16(kVK_ANSI_K), cocoaModifierFlags: cmdShift)?.modifiers == [.command, .shift])
        let noisy: UInt = (1 << 18) | (1 << 19) | (1 << 16) | (1 << 23)
        #expect(KeyCombo(keyCode: 0, cocoaModifierFlags: noisy)?.modifiers == [.control, .option])
    }

    @Test func validity() {
        #expect(!KeyCombo(keyCode: 0, modifiers: [.shift]).isValidGlobalShortcut)
        #expect(!KeyCombo(keyCode: 0, modifiers: []).isValidGlobalShortcut)
        #expect(KeyCombo(keyCode: UInt32(kVK_F5), modifiers: []).isValidGlobalShortcut)
        #expect(KeyCombo(keyCode: UInt32(kVK_ANSI_K), modifiers: [.command]).isValidGlobalShortcut)
    }

    @Test func codable() throws {
        let data = try JSONEncoder().encode(KeyCombo.defaultCombo)
        #expect(try JSONDecoder().decode(KeyCombo.self, from: data) == .defaultCombo)
    }
}
