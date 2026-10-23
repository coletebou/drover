import SwiftUI

/// Drover dark palette (ui/style.css). The watch is always dark. Colour only for state:
/// amber waiting, steel working, moss idle, brick error, lilac manager.
enum Palette {
    static let background = Color(hex: 0x16191E)
    static let card = Color(hex: 0x1C2026)
    static let cardRaised = Color(hex: 0x242931)
    static let ink = Color(hex: 0xE9E5DB)      // body text, 13.9:1 on background
    static let ink2 = Color(hex: 0xC8C6BF)     // secondary text, 10.6:1
    static let ink3 = Color(hex: 0xABAAA5)     // tertiary text, 7.6:1
    static let amber = Color(hex: 0xE2A73E)
    static let steel = Color(hex: 0x8DB6DF)
    static let moss = Color(hex: 0x8EBD87)
    static let brick = Color(hex: 0xDE8C82)
    static let lilac = Color(hex: 0xB2A1DB)

    /// Titles use the serif design, ids the monospaced design (matching the web UI).
    static func title(_ style: Font.TextStyle = .headline) -> Font { .system(style, design: .serif) }
    static func mono(_ style: Font.TextStyle = .caption2) -> Font { .system(style, design: .monospaced) }
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

extension WaitingKind {
    var label: String {
        switch self {
        case .decision: return "Decision"
        case .question: return "Question"
        case .finished: return "Finished"
        case .other: return "Waiting"
        }
    }

    var symbol: String {
        switch self {
        case .decision: return "arrow.triangle.branch"
        case .question: return "questionmark.bubble"
        case .finished: return "checkmark.circle"
        case .other: return "hourglass"
        }
    }

    /// Waiting is amber; finished sessions are idle (moss).
    var tint: Color { self == .finished ? Palette.moss : Palette.amber }
}
