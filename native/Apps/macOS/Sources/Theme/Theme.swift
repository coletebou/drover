import SwiftUI
import AppKit

/// Design tokens copied from Drover `ui/style.css` (dark first, light variant), which its
/// test/contrast.test.js holds to WCAG AA: ink >= 10:1, ink2 >= 7:1, ink3 >= 5.2:1, ink4 and states >= 4.5:1.
/// Colour encodes state only. Use these, never raw system accent colours, for state.
enum Theme {
    // Surfaces
    static let bg = dynamic(dark: 0x16191E, light: 0xEEF0F2)
    static let bg2 = dynamic(dark: 0x1C2026, light: 0xF6F7F8)
    static let bg3 = dynamic(dark: 0x242931, light: 0xE5E8EC)
    static let bg4 = dynamic(dark: 0x2C323B, light: 0xDDE1E6)
    static let line = dynamic(dark: 0x2E343D, light: 0xD5D9DF)
    static let line2 = dynamic(dark: 0x3A414C, light: 0xC2C8D0)
    // Text
    static let ink = dynamic(dark: 0xE9E5DB, light: 0x1F2328)
    static let ink2 = dynamic(dark: 0xC8C6BF, light: 0x3D444C)
    static let ink3 = dynamic(dark: 0xABAAA5, light: 0x52575E)
    static let ink4 = dynamic(dark: 0x9C9C95, light: 0x5B626C)
    // State
    static let amber = dynamic(dark: 0xE2A73E, light: 0x855A08)   // waiting on you
    static let steel = dynamic(dark: 0x8DB6DF, light: 0x296092)   // working, links
    static let moss = dynamic(dark: 0x8EBD87, light: 0x336F2F)    // idle, ok
    static let brick = dynamic(dark: 0xDE8C82, light: 0xA33A2A)   // dialog, error
    static let lilac = dynamic(dark: 0xB2A1DB, light: 0x5F479C)   // manager

    /// Inline code and code blocks: a surface a step off the chat's.
    static let codeWash = dynamic(dark: 0x242931, light: 0xE3E6EA)

    // AppKit twins, for the Screen's NSTextView (computed: NSColor is not Sendable).
    static var nsBg2: NSColor { nsDynamic(dark: 0x1C2026, light: 0xF6F7F8) }
    static var nsInk: NSColor { nsDynamic(dark: 0xE9E5DB, light: 0x1F2328) }
    static var nsSelection: NSColor { nsDynamic(dark: 0x3A414C, light: 0xC9D3DE) }

    static func color(for lane: Lane) -> Color {
        switch lane {
        case .waiting: amber
        case .working: steel
        case .idle: moss
        }
    }

    /// Tinted background for a state colour (web `--*-bg`, ~14% alpha).
    static func wash(_ c: Color) -> Color { c.opacity(0.14) }

    static func titleFont(_ size: CGFloat = 17) -> Font {
        // Charter ships with macOS; fall back to the system serif design.
        NSFont(name: "Charter", size: size) != nil ? .custom("Charter", size: size) : .system(size: size, design: .serif)
    }
    static let mono = Font.system(.caption, design: .monospaced)
    static let monoBody = Font.system(.body, design: .monospaced)
    static let monoSmall = Font.system(size: 11.5, design: .monospaced)

    private static func dynamic(dark: UInt32, light: UInt32) -> Color {
        Color(nsColor: nsDynamic(dark: dark, light: light))
    }

    private static func nsDynamic(dark: UInt32, light: UInt32) -> NSColor {
        NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua, .vibrantDark, .vibrantLight]).map { $0 == .darkAqua || $0 == .vibrantDark } ?? false
            return NSColor(rgb: isDark ? dark : light)
        }
    }
}

private extension NSColor {
    convenience init(rgb: UInt32) {
        self.init(srgbRed: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255,
                  blue: CGFloat(rgb & 0xFF) / 255, alpha: 1)
    }
}

/// Small state dot used in lists.
struct StateDot: View {
    var color: Color
    var body: some View {
        Circle().fill(color).frame(width: 8, height: 8).accessibilityHidden(true)
    }
}
