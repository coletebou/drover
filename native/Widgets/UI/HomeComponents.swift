#if !os(watchOS)
import SwiftUI
import WidgetKit

/// Colour policy for the home widgets: full colour uses the Drover palette, accented and vibrant rendering
/// uses system hierarchical styles so the system can tint them.
struct HomeTheme {
    var accented: Bool

    init(mode: WidgetRenderingMode) { accented = mode != .fullColor }

    var ink: AnyShapeStyle { accented ? AnyShapeStyle(.primary) : AnyShapeStyle(DroverPalette.ink) }
    var ink2: AnyShapeStyle { accented ? AnyShapeStyle(.secondary) : AnyShapeStyle(DroverPalette.ink2) }
    var ink3: AnyShapeStyle { accented ? AnyShapeStyle(.secondary) : AnyShapeStyle(DroverPalette.ink3) }
    /// A state colour (amber, steel, moss, brick, lilac) in full colour, plain primary otherwise.
    func state(_ color: Color) -> AnyShapeStyle { accented ? AnyShapeStyle(.primary) : AnyShapeStyle(color) }
}

enum HomeText {
    static func countsLabel(_ t: NativeSummary.Totals) -> String {
        "\(t.waiting) waiting, \(t.working) working, \(t.idle) idle"
    }

    static func rowLabel(_ item: NativeSummary.WaitingItem) -> String {
        let kind = item.waitingKind == .other ? "question" : item.waitingKind.rawValue
        return "\(item.name) on \(item.host), \(kind): \(item.headline)"
    }

    static func hostLabel(_ filter: String?) -> String { filter ?? "All hosts" }

    /// Spoken after the counts when the data is not live (the footnote is inside a combined element).
    static func statusSuffix(_ status: SummaryStatus) -> String {
        switch status {
        case .live: ""
        case let .cached(fetchedAt): ", as of \(fetchedAt.formatted(date: .omitted, time: .shortened))"
        case .notConfigured: ", open Drover to connect"
        case .unauthorized: ", widget token rejected"
        case .unreachable: ", daemon unreachable"
        }
    }
}

struct StateDot: View {
    @Environment(\.widgetRenderingMode) private var mode
    var color: Color
    var size: CGFloat = 7

    var body: some View {
        Circle()
            .fill(HomeTheme(mode: mode).state(color))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// One count line: dot in the state colour and "3 waiting".
struct CountRow: View {
    @Environment(\.widgetRenderingMode) private var mode
    var color: Color
    var count: Int
    var label: String

    var body: some View {
        HStack(spacing: 6) {
            StateDot(color: color)
            Text("\(count) \(label)")
                .font(DroverFont.body(.caption))
                .foregroundStyle(HomeTheme(mode: mode).ink2)
                .lineLimit(1)
        }
    }
}

/// A count pill for the large widget header.
struct CountPill: View {
    @Environment(\.widgetRenderingMode) private var mode
    var color: Color
    var count: Int
    var label: String

    var body: some View {
        let theme = HomeTheme(mode: mode)
        HStack(spacing: 5) {
            StateDot(color: color)
            Text("\(count)")
                .font(DroverFont.title(.subheadline))
                .foregroundStyle(theme.ink)
                .minimumScaleFactor(0.5)
                .lineLimit(1)
            Text(label)
                .font(DroverFont.body(.caption2))
                .foregroundStyle(theme.ink2)
                .lineLimit(1)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(accentedBackground(theme), in: Capsule())
    }

    private func accentedBackground(_ theme: HomeTheme) -> AnyShapeStyle {
        theme.accented ? AnyShapeStyle(.secondary.opacity(0.2)) : AnyShapeStyle(DroverPalette.panel)
    }
}

struct WaitingRow: View {
    @Environment(\.widgetRenderingMode) private var mode
    var item: NativeSummary.WaitingItem
    var headlineLines: Int = 1

    var body: some View {
        let theme = HomeTheme(mode: mode)
        Link(destination: DroverDeepLink.session(id: item.id, host: item.host).url) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: item.waitingKind == .decision ? "arrow.triangle.branch" : "questionmark.bubble")
                    .font(DroverFont.body(.caption))
                    .foregroundStyle(theme.state(DroverPalette.amber))
                    .widgetAccentable()
                    .frame(width: 16)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(item.name)
                        .font(DroverFont.mono(.caption))
                        .foregroundStyle(theme.ink)
                        .lineLimit(1)
                    Text(item.headline)
                        .font(DroverFont.body(.caption))
                        .foregroundStyle(theme.ink2)
                        .lineLimit(headlineLines)
                }
                Spacer(minLength: 4)
                VStack(alignment: .trailing, spacing: 1) {
                    Text(item.host)
                        .font(DroverFont.mono(.caption2))
                        .foregroundStyle(theme.ink3)
                        .lineLimit(1)
                    if let since = item.since {
                        Text(since, style: .relative)
                            .font(DroverFont.body(.caption2))
                            .foregroundStyle(theme.ink3)
                            .lineLimit(1)
                            .multilineTextAlignment(.trailing)
                    }
                }
                .frame(maxWidth: 80, alignment: .trailing)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(HomeText.rowLabel(item))
    }
}

struct WorkingRow: View {
    @Environment(\.widgetRenderingMode) private var mode
    var item: NativeSummary.WorkingItem

    var body: some View {
        let theme = HomeTheme(mode: mode)
        Link(destination: DroverDeepLink.session(id: item.id, host: item.host).url) {
            HStack(spacing: 8) {
                StateDot(color: DroverPalette.steel)
                    .frame(width: 16)
                Text(item.name)
                    .font(DroverFont.mono(.caption))
                    .foregroundStyle(theme.ink)
                    .lineLimit(1)
                    .layoutPriority(1)
                Text(item.headline)
                    .font(DroverFont.body(.caption))
                    .foregroundStyle(theme.ink2)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text(item.host)
                    .font(DroverFont.mono(.caption2))
                    .foregroundStyle(theme.ink3)
                    .lineLimit(1)
                    .frame(maxWidth: 80, alignment: .trailing)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(item.name) on \(item.host), working: \(item.headline)")
    }
}

/// Small caption shown at the bottom when the data is not live.
struct HomeFootnote: View {
    @Environment(\.widgetRenderingMode) private var mode
    var status: SummaryStatus

    var body: some View {
        let theme = HomeTheme(mode: mode)
        switch status {
        case .live:
            EmptyView()
        case let .cached(fetchedAt):
            HStack(spacing: 3) {
                Text("As of")
                Text(fetchedAt, style: .time)
            }
            .font(DroverFont.body(.caption2))
            .foregroundStyle(theme.ink3)
            .lineLimit(1)
        case .notConfigured:
            Text("Open Drover to connect")
                .font(DroverFont.body(.caption2))
                .foregroundStyle(theme.ink3)
                .lineLimit(1)
        case .unauthorized:
            Text("Widget token rejected")
                .font(DroverFont.body(.caption2))
                .foregroundStyle(theme.state(DroverPalette.brick))
                .lineLimit(1)
        case .unreachable:
            Text("Daemon unreachable")
                .font(DroverFont.body(.caption2))
                .foregroundStyle(theme.state(DroverPalette.brick))
                .lineLimit(1)
        }
    }
}

/// Body shown when there is no summary at all: a symbol and the status message.
struct HomeEmptyState: View {
    @Environment(\.widgetRenderingMode) private var mode
    var status: SummaryStatus

    var body: some View {
        let theme = HomeTheme(mode: mode)
        VStack(spacing: 6) {
            Image(systemName: symbol)
                .font(.title2)
                .foregroundStyle(isError ? theme.state(DroverPalette.brick) : theme.ink3)
                .accessibilityHidden(true)
            Text(message)
                .font(DroverFont.body(.caption))
                .multilineTextAlignment(.center)
                .foregroundStyle(isError ? theme.state(DroverPalette.brick) : theme.ink2)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }

    private var isError: Bool {
        switch status {
        case .unauthorized, .unreachable: true
        default: false
        }
    }

    private var symbol: String {
        switch status {
        case .unauthorized: "key"
        case .notConfigured: "gearshape"
        default: "antenna.radiowaves.left.and.right.slash"
        }
    }

    private var message: String {
        switch status {
        case .unauthorized: "Widget token rejected"
        case .notConfigured: "Open Drover to connect"
        case .unreachable: "Daemon unreachable"
        case .cached, .live: "No data yet"
        }
    }
}

/// Hosts with an up or down dot, plus the manager when it is up. Drops hosts when space runs out.
struct HostsStrip: View {
    var summary: NativeSummary

    var body: some View {
        ViewThatFits(in: .horizontal) {
            strip(max: 6)
            strip(max: 3)
            strip(max: 1)
        }
    }

    private func strip(max: Int) -> some View {
        HStack(spacing: 10) {
            ForEach(Array(summary.hosts.prefix(max))) { host in
                HostChip(host: host)
            }
            if summary.manager?.up == true {
                ManagerChip()
            }
            Spacer(minLength: 0)
        }
        .fixedSize(horizontal: true, vertical: false)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct HostChip: View {
    @Environment(\.widgetRenderingMode) private var mode
    var host: NativeSummary.Host

    var body: some View {
        HStack(spacing: 4) {
            StateDot(color: host.up ? DroverPalette.moss : DroverPalette.brick, size: 6)
            Text(host.name)
                .font(DroverFont.mono(.caption2))
                .foregroundStyle(HomeTheme(mode: mode).ink3)
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(host.name), \(host.up ? "up" : "down")")
    }
}

private struct ManagerChip: View {
    @Environment(\.widgetRenderingMode) private var mode

    var body: some View {
        HStack(spacing: 4) {
            StateDot(color: DroverPalette.lilac, size: 6)
            Text("manager")
                .font(DroverFont.body(.caption2))
                .foregroundStyle(HomeTheme(mode: mode).ink3)
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
    }
}
#endif
