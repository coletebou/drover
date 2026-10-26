import SwiftUI
import UIKit

/// The web UI's graphite palette. Colour is used only for state. Every pair meets WCAG AA:
/// body text >= 7:1, secondary >= 4.5:1, state text colours >= 4.5:1 on surface, background and badge tint.
enum Theme {
    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
    }

    // Graphite neutrals. Hex values live in Palette, where tests check their contrast.
    static let background = dynamic(light: Palette.light.background, dark: Palette.dark.background)
    static let surface = dynamic(light: Palette.light.surface, dark: Palette.dark.surface)
    static let surfaceRaised = dynamic(light: Palette.light.surfaceRaised, dark: Palette.dark.surfaceRaised)
    static let separator = dynamic(light: Palette.light.separator, dark: Palette.dark.separator)
    static let textPrimary = dynamic(light: Palette.light.textPrimary, dark: Palette.dark.textPrimary)
    static let textSecondary = dynamic(light: Palette.light.textSecondary, dark: Palette.dark.textSecondary)

    // State colours (text-safe on surface, background and their own badge tint)
    static let waiting = dynamic(light: Palette.light.waiting, dark: Palette.dark.waiting)   // amber
    static let working = dynamic(light: Palette.light.working, dark: Palette.dark.working)   // steel
    static let idle = dynamic(light: Palette.light.idle, dark: Palette.dark.idle)            // moss
    static let error = dynamic(light: Palette.light.error, dark: Palette.dark.error)         // brick
    static let manager = dynamic(light: Palette.light.manager, dark: Palette.dark.manager)   // lilac

    static func color(for state: BoardState) -> Color {
        switch state {
        case .waiting: waiting
        case .working: working
        case .idle: idle
        case .error: error
        case .manager: manager
        }
    }

    /// Serif for titles, as on the web board. Built on text styles so Dynamic Type scales it.
    static func title(_ style: Font.TextStyle = .title2) -> Font { .system(style, design: .serif).weight(.semibold) }
    /// Monospace for ids, hosts, tmux targets and screen captures.
    static func mono(_ style: Font.TextStyle = .caption) -> Font { .system(style, design: .monospaced) }
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

/// A small state pill: symbol plus text, so state never relies on colour alone.
struct StateBadge: View {
    let state: BoardState
    var text: String? = nil

    var body: some View {
        Label(text ?? state.label, systemImage: state.symbol)
            .labelStyle(BadgeLabelStyle())
            .font(.caption.weight(.semibold))
            .foregroundStyle(Theme.color(for: state))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Theme.color(for: state).opacity(Palette.badgeOpacity), in: Capsule())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(text ?? state.label)
    }
}

/// Symbol and text side by side. In a List the default style reserves an icon column, which widened every badge
/// in a row and wrapped "Question" mid-word on a phone.
private struct BadgeLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            configuration.icon
            configuration.title
        }
    }
}

/// Round dot for host health; paired with a text label by callers.
struct StatusDot: View {
    let color: Color
    @ScaledMetric(relativeTo: .caption) private var size: CGFloat = 8
    var body: some View {
        Circle().fill(color).frame(width: size, height: size).accessibilityHidden(true)
    }
}

/// Monospaced, selectable id text (session ids, hosts, tmux targets).
struct MonoText: View {
    let text: String
    var style: Font.TextStyle = .caption
    var body: some View {
        Text(text).font(Theme.mono(style)).foregroundStyle(Theme.textSecondary).textSelection(.enabled)
            .lineLimit(1).truncationMode(.middle)
            .accessibilityLabel(text)
    }
}

/// VoiceOver announcements for outcomes that arrive asynchronously and would otherwise be missed.
enum A11y {
    @MainActor static func announce(_ message: String) {
        AccessibilityNotification.Announcement(message).post()
    }
}

extension Date {
    /// "3 min ago" style, for since/updated labels.
    var relativeLabel: String { formatted(.relative(presentation: .named, unitsStyle: .abbreviated)) }
}
