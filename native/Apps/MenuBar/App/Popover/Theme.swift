import AppKit
import SwiftUI

/// Palette from the web UI (web/ui/*.css): graphite neutrals, state-only colour.
/// Contrast ratios are WCAG 2.x against `background`, computed from the hex values below.
enum Theme {
    private static func hex(_ v: UInt32) -> NSColor {
        NSColor(
            srgbRed: CGFloat((v >> 16) & 0xFF) / 255,
            green: CGFloat((v >> 8) & 0xFF) / 255,
            blue: CGFloat(v & 0xFF) / 255,
            alpha: 1)
    }

    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            return hex(isDark ? dark : light)
        })
    }

    /// Light #eef0f2, dark #16191e.
    static let background = dynamic(light: 0xEEF0F2, dark: 0x16191E)
    /// Raised panel. Light #f6f7f8, dark #1c2026.
    static let surface = dynamic(light: 0xF6F7F8, dark: 0x1C2026)
    /// Body text. Light #1f2328 is 13.83:1, dark #e9e5db is 14.01:1 (both >= 7:1).
    static let text = dynamic(light: 0x1F2328, dark: 0xE9E5DB)
    /// Secondary text. Light #52575e is 6.37:1, dark #abaaa5 is 7.57:1 (both >= 4.5:1).
    static let secondaryText = dynamic(light: 0x52575E, dark: 0xABAAA5)
    /// Hairline. Light #d5d9df, dark #2e343d.
    static let separator = dynamic(light: 0xD5D9DF, dark: 0x2E343D)

    /// Needs you. Light #855a08, dark #e2a73e.
    static let waiting = dynamic(light: 0x855A08, dark: 0xE2A73E)
    /// Working. Light #296092, dark #8db6df.
    static let working = dynamic(light: 0x296092, dark: 0x8DB6DF)
    /// Idle, ok. Light #336f2f, dark #8ebd87.
    static let idle = dynamic(light: 0x336F2F, dark: 0x8EBD87)
    /// Error, down. Light #a33a2a, dark #de8c82.
    static let error = dynamic(light: 0xA33A2A, dark: 0xDE8C82)
    /// Manager. Light #5f479c, dark #b2a1db.
    static let manager = dynamic(light: 0x5F479C, dark: 0xB2A1DB)

    static func color(for tone: BadgeTone) -> Color {
        switch tone {
        case .waiting: waiting
        case .working: working
        case .idle: idle
        case .error: error
        case .unconfigured: secondaryText
        }
    }

    static let title = Font.system(.headline, design: .serif)
    static let mono = Font.system(.caption, design: .monospaced)
}
