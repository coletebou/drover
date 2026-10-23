import AppKit
import SwiftUI

/// The `MenuBarExtra` label. Menu bar labels render as template images, so colour has to be baked
/// into a non-template image. Only waiting and error are coloured; the rest stay monochrome.
struct MenuBarLabel: View {
    let badge: BadgeState

    var body: some View {
        HStack(spacing: 3) {
            Image(nsImage: Self.image(for: badge.tone))
            if badge.count > 0 {
                Text("\(badge.count)")
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(badge.accessibilityLabel)
    }

    static func symbolName(for tone: BadgeTone) -> String {
        switch tone {
        case .waiting: "circle.hexagongrid.fill"
        case .error: "exclamationmark.triangle"
        case .unconfigured: "gearshape"
        case .working, .idle: "circle.hexagongrid"
        }
    }

    /// Fixed mid-tone colours that read on both light and dark menu bars.
    private static func tint(for tone: BadgeTone) -> NSColor? {
        switch tone {
        case .waiting: NSColor(srgbRed: 0.886, green: 0.655, blue: 0.243, alpha: 1)
        case .error: NSColor(srgbRed: 0.87, green: 0.35, blue: 0.30, alpha: 1)
        default: nil
        }
    }

    static func image(for tone: BadgeTone) -> NSImage {
        let base = NSImage(systemSymbolName: symbolName(for: tone), accessibilityDescription: nil)
            ?? NSImage(size: NSSize(width: 16, height: 16))
        guard let color = tint(for: tone) else {
            base.isTemplate = true
            return base
        }
        let config = NSImage.SymbolConfiguration(paletteColors: [color])
        let tinted = base.withSymbolConfiguration(config) ?? base
        tinted.isTemplate = false
        return tinted
    }
}
