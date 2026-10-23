import Foundation

/// The single source of the app's colour values, plus WCAG 2.x contrast maths so tests can prove them.
/// Foundation only: `Theme` builds its dynamic colours from these hex values.
enum Palette {
    struct Scheme: Sendable {
        let background, surface, surfaceRaised, separator: UInt32
        let textPrimary, textSecondary: UInt32
        let waiting, working, idle, error, manager: UInt32

        /// State colours in a stable order: name, hex.
        var stateColors: [(name: String, hex: UInt32)] {
            [("waiting", waiting), ("working", working), ("idle", idle), ("error", error), ("manager", manager)]
        }
    }

    static let light = Scheme(
        background: 0xF4F4F2, surface: 0xFFFFFF, surfaceRaised: 0xECECE9, separator: 0xD4D5D2,
        textPrimary: 0x1C1D1F, textSecondary: 0x4A4D52,
        waiting: 0x8A5A00, working: 0x3D5A73, idle: 0x4C6A2E, error: 0x9A3324, manager: 0x6B4E8C)

    static let dark = Scheme(
        background: 0x141517, surface: 0x1E2023, surfaceRaised: 0x2A2D31, separator: 0x3A3E43,
        textPrimary: 0xECEDEE, textSecondary: 0xA9ADB3,
        waiting: 0xF0B44C, working: 0x8FB3D1, idle: 0xA3C27A, error: 0xEE8B78, manager: 0xC3A8E6)

    /// Opacity of the state colour in `StateBadge`'s background.
    static let badgeOpacity = 0.12

    // MARK: WCAG 2.x

    /// sRGB channels in 0...1.
    typealias RGB = (r: Double, g: Double, b: Double)

    static func rgb(_ hex: UInt32) -> RGB {
        (Double((hex >> 16) & 0xFF) / 255, Double((hex >> 8) & 0xFF) / 255, Double(hex & 0xFF) / 255)
    }

    /// `foreground` at `alpha` composited over opaque `background`.
    static func composite(_ foreground: RGB, alpha: Double, over background: RGB) -> RGB {
        (foreground.r * alpha + background.r * (1 - alpha),
         foreground.g * alpha + background.g * (1 - alpha),
         foreground.b * alpha + background.b * (1 - alpha))
    }

    private static func linear(_ c: Double) -> Double {
        c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
    }

    static func luminance(_ c: RGB) -> Double {
        0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b)
    }

    static func contrast(_ a: RGB, _ b: RGB) -> Double {
        let (hi, lo) = (max(luminance(a), luminance(b)), min(luminance(a), luminance(b)))
        return (hi + 0.05) / (lo + 0.05)
    }

    static func contrast(_ a: UInt32, _ b: UInt32) -> Double { contrast(rgb(a), rgb(b)) }

    /// Contrast of a state colour used as text on its own badge background (12% over `base`).
    static func badgeContrast(state: UInt32, over base: UInt32) -> Double {
        let bg = composite(rgb(state), alpha: badgeOpacity, over: rgb(base))
        return contrast(rgb(state), bg)
    }
}
