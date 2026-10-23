#if os(iOS) || os(watchOS)
import SwiftUI
import WidgetKit

/// Lock screen (iOS) and watch face (watchOS) widgets. Designed for vibrant / accented rendering first;
/// the amber tint is only applied in full-colour mode.
struct AccessorySummaryView: View {
    var entry: SummaryEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        content
            .widgetURL(AccessoryModel(entry).url)
    }

    @ViewBuilder private var content: some View {
        switch family {
        case .accessoryCircular: CircularView(model: AccessoryModel(entry))
        case .accessoryRectangular: RectangularView(model: AccessoryModel(entry))
        case .accessoryInline: InlineView(model: AccessoryModel(entry))
        #if os(watchOS)
        case .accessoryCorner: CornerView(model: AccessoryModel(entry))
        #endif
        default: InlineView(model: AccessoryModel(entry))
        }
    }
}

/// Everything the accessory views derive from an entry, in one place.
private struct AccessoryModel {
    let entry: SummaryEntry
    init(_ entry: SummaryEntry) { self.entry = entry }

    var summary: NativeSummary? { entry.summary }
    var waiting: Int { summary?.totals.waiting ?? 0 }
    var working: Int { summary?.totals.working ?? 0 }
    var idle: Int { summary?.totals.idle ?? 0 }
    var top: NativeSummary.WaitingItem? { summary?.waiting.first }
    var range: ClosedRange<Double> { 0...Double(max(waiting + working, 1)) }

    var url: URL {
        if let top { return DroverDeepLink.session(id: top.id, host: top.host).url }
        return DroverDeepLink.board.url
    }

    /// Symbol and messages for the no-data states.
    var noData: (symbol: String, long: String, short: String) {
        switch entry.status {
        case .notConfigured: return ("gearshape", "Open Drover to connect", "Set up Drover")
        case .unauthorized: return ("key", "Token rejected", "Token rejected")
        case .unreachable: return ("antenna.radiowaves.left.and.right.slash", "Offline", "Offline")
        default: return ("ellipsis", "Loading", "Loading")
        }
    }

    var accessibilityLabel: String {
        guard summary != nil else { return noData.long }
        var text: String
        if waiting > 0 {
            text = "\(waiting) waiting on you"
            if let top { text += ". Top: \(top.name), \(top.headline)" }
        } else {
            text = "Nothing waiting, \(working) working"
        }
        switch entry.status {
        case let .cached(fetchedAt):
            text += ", as of \(fetchedAt.formatted(date: .omitted, time: .shortened))"
        case .unauthorized:
            text += ", token rejected"
        default:
            break
        }
        return text
    }
}

private struct CircularView: View {
    let model: AccessoryModel
    @Environment(\.widgetRenderingMode) private var mode

    var body: some View {
        Group {
            if model.summary == nil {
                Image(systemName: model.noData.symbol)
                    .font(.title3)
                    .widgetAccentable()
            } else {
                Gauge(value: Double(model.waiting), in: model.range) {
                    Image(systemName: model.waiting > 0 ? "hourglass" : "checkmark")
                } currentValueLabel: {
                    Text("\(model.waiting)")
                        .font(.system(.title3, design: .rounded, weight: .semibold))
                        .widgetAccentable()
                }
                .gaugeStyle(.accessoryCircularCapacity)
                .tint(mode == .fullColor ? DroverPalette.amber : nil)
            }
        }
        .containerBackground(for: .widget) { AccessoryWidgetBackground() }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(model.accessibilityLabel)
    }
}

private struct RectangularView: View {
    let model: AccessoryModel
    @Environment(\.widgetRenderingMode) private var mode

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            if model.summary == nil {
                Label(model.noData.long, systemImage: model.noData.symbol)
                    .font(.headline)
                    .widgetAccentable()
            } else if model.waiting > 0 {
                Label("\(model.waiting) waiting", systemImage: "hourglass")
                    .font(.headline)
                    .foregroundStyle(mode == .fullColor ? DroverPalette.amber : Color.primary)
                    .widgetAccentable()
                if let top = model.top {
                    // Rectangular fits three lines: a two-line headline only when it still fits with the name line.
                    ViewThatFits(in: .vertical) {
                        topItem(top, headlineLines: 2)
                        topItem(top, headlineLines: 1)
                    }
                }
            } else {
                Label("Nothing waiting", systemImage: "checkmark")
                    .font(.headline)
                    .widgetAccentable()
                Text("\(model.working) working · \(model.idle) idle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .containerBackground(.clear, for: .widget)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(model.accessibilityLabel)
    }
}

extension RectangularView {
    private func topItem(_ top: NativeSummary.WaitingItem, headlineLines: Int) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(top.headline)
                .font(.caption)
                .lineLimit(headlineLines)
                .privacySensitive()
            Text(model.entry.hostFilter == nil ? "\(top.name) · \(top.host)" : top.name)
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }
}

private struct InlineView: View {
    let model: AccessoryModel

    var body: some View {
        ViewThatFits {
            label(long: true)
            label(long: false)
        }
        .containerBackground(.clear, for: .widget)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(model.accessibilityLabel)
    }

    @ViewBuilder private func label(long: Bool) -> some View {
        if model.summary == nil {
            Label(model.noData.short, systemImage: model.noData.symbol)
        } else if model.waiting > 0 {
            Label(long ? "\(model.waiting) waiting" : "\(model.waiting) wait", systemImage: "hourglass")
        } else {
            Label(long ? "Nothing waiting" : "None waiting", systemImage: "checkmark")
        }
    }
}

#if os(watchOS)
private struct CornerView: View {
    let model: AccessoryModel
    @Environment(\.widgetRenderingMode) private var mode

    var body: some View {
        Group {
            if model.summary == nil {
                Image(systemName: model.noData.symbol)
                    .font(.title3)
                    .widgetAccentable()
                    .widgetLabel(model.noData.short)
            } else if model.waiting > 0 {
                Text("\(model.waiting)")
                    .font(.system(.title, design: .rounded, weight: .semibold))
                    .widgetAccentable()
                    .widgetLabel {
                        Gauge(value: Double(model.waiting), in: model.range) {
                            Text("waiting")
                        }
                        .gaugeStyle(.accessoryLinearCapacity)
                        .tint(mode == .fullColor ? DroverPalette.amber : nil)
                    }
            } else {
                Text("\(model.waiting)")
                    .font(.system(.title, design: .rounded, weight: .semibold))
                    .widgetAccentable()
                    .widgetLabel("Nothing waiting")
            }
        }
        .containerBackground(for: .widget) { AccessoryWidgetBackground() }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(model.accessibilityLabel)
    }
}
#endif
#endif
