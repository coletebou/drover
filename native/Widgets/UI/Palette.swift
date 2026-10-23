import SwiftUI

/// The Drover palette (ui/style.css): graphite neutrals, colour only for state. Dark values first, light second,
/// copied verbatim from the web tokens so contrast matches (ink 10:1, ink-2 7.5:1, ink-3 5.5:1 on graphite).
enum DroverPalette {
    static let bg = Color.drover(dark: 0x16191E, light: 0xEEF0F2)
    static let panel = Color.drover(dark: 0x1C2026, light: 0xF6F7F8)
    static let raised = Color.drover(dark: 0x242931, light: 0xE5E8EC)
    static let line = Color.drover(dark: 0x2E343D, light: 0xD5D9DF)
    static let ink = Color.drover(dark: 0xE9E5DB, light: 0x1F2328)
    static let ink2 = Color.drover(dark: 0xC8C6BF, light: 0x3D444C)
    static let ink3 = Color.drover(dark: 0xABAAA5, light: 0x52575E)
    /// Waiting on you.
    static let amber = Color.drover(dark: 0xE2A73E, light: 0x855A08)
    /// Working, links.
    static let steel = Color.drover(dark: 0x8DB6DF, light: 0x296092)
    /// Idle, ok.
    static let moss = Color.drover(dark: 0x8EBD87, light: 0x336F2F)
    /// Error, host down.
    static let brick = Color.drover(dark: 0xDE8C82, light: 0xA33A2A)
    /// Manager.
    static let lilac = Color.drover(dark: 0xB2A1DB, light: 0x5F479C)
}

/// Serif for titles, monospace for ids, system for body (CONTRACT.md "Design").
enum DroverFont {
    static func title(_ style: Font.TextStyle = .headline) -> Font { .system(style, design: .serif).weight(.semibold) }
    static func mono(_ style: Font.TextStyle = .caption2) -> Font { .system(style, design: .monospaced) }
    static func body(_ style: Font.TextStyle = .caption) -> Font { .system(style) }
}

extension Color {
    static func drover(dark: UInt32, light: UInt32) -> Color {
        #if os(watchOS)
        return Color(hex: dark) // watch faces are always dark
        #elseif os(macOS)
        return Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            return NSColor(Color(hex: isDark ? dark : light))
        })
        #else
        return Color(uiColor: UIColor { traits in
            UIColor(Color(hex: traits.userInterfaceStyle == .dark ? dark : light))
        })
        #endif
    }

    init(hex: UInt32) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255, opacity: 1)
    }
}
