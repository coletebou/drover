#if !os(watchOS)
import SwiftUI
import WidgetKit

/// Home screen, desktop and StandBy views of the fleet summary.
struct HomeSummaryView: View {
    @Environment(\.widgetFamily) private var family
    var entry: SummaryEntry

    var body: some View {
        Group {
            switch family {
            case .systemSmall: SmallSummaryView(entry: entry)
            case .systemMedium: MediumSummaryView(entry: entry)
            default: LargeSummaryView(entry: entry)
            }
        }
        .containerBackground(DroverPalette.bg, for: .widget)
    }
}

// MARK: - Small

struct SmallSummaryView: View {
    @Environment(\.widgetRenderingMode) private var mode
    @Environment(\.showsWidgetContainerBackground) private var showsBackground
    var entry: SummaryEntry

    var body: some View {
        let theme = HomeTheme(mode: mode)
        Group {
            if let summary = entry.summary {
                let totals = summary.totals
                VStack(alignment: .leading, spacing: 2) {
                    if showsBackground {
                        Text(HomeText.hostLabel(entry.hostFilter))
                            .font(DroverFont.mono(.caption2))
                            .foregroundStyle(theme.ink3)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    VStack(alignment: .leading, spacing: 0) {
                        Text("\(totals.waiting)")
                            .font(.system(size: showsBackground ? 56 : 84, design: .serif).weight(.semibold))
                            .foregroundStyle(theme.state(totals.waiting > 0 ? DroverPalette.amber : DroverPalette.moss))
                            .widgetAccentable()
                            .minimumScaleFactor(0.5)
                            .lineLimit(1)
                        Text(totals.waiting > 0 ? "waiting" : "nothing waiting")
                            .font(DroverFont.body(.caption))
                            .foregroundStyle(totals.waiting > 0 ? theme.ink2 : theme.state(DroverPalette.moss))
                            .minimumScaleFactor(0.7)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Text("\(totals.working) working · \(totals.idle) idle")
                        .font(DroverFont.body(.caption))
                        .foregroundStyle(theme.ink2)
                        .minimumScaleFactor(0.7)
                        .lineLimit(1)
                    if entry.status != .live {
                        HomeFootnote(status: entry.status)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
                .accessibilityLabel(HomeText.countsLabel(totals) + HomeText.statusSuffix(entry.status))
            } else {
                VStack(spacing: 0) {
                    HomeEmptyState(status: entry.status)
                }
            }
        }
        .widgetURL(url)
    }

    private var url: URL {
        if let first = entry.summary?.waiting.first {
            return DroverDeepLink.session(id: first.id, host: first.host).url
        }
        return DroverDeepLink.board.url
    }
}

// MARK: - Medium

struct MediumSummaryView: View {
    @Environment(\.widgetRenderingMode) private var mode
    var entry: SummaryEntry

    var body: some View {
        let theme = HomeTheme(mode: mode)
        if let summary = entry.summary {
            VStack(alignment: .leading, spacing: 4) {
                GeometryReader { geo in
                    HStack(alignment: .top, spacing: 12) {
                        counts(summary.totals, theme: theme)
                            .frame(width: geo.size.width * 0.38, alignment: .leading)
                        rows(summary, theme: theme)
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    }
                }
                if entry.status != .live {
                    HomeFootnote(status: entry.status)
                }
            }
            .widgetURL(DroverDeepLink.board.url)
        } else {
            VStack(spacing: 0) {
                HomeEmptyState(status: entry.status)
            }
            .widgetURL(DroverDeepLink.board.url)
        }
    }

    private func counts(_ totals: NativeSummary.Totals, theme: HomeTheme) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(HomeText.hostLabel(entry.hostFilter))
                .font(DroverFont.mono(.caption2))
                .foregroundStyle(theme.ink3)
                .lineLimit(1)
            Text("\(totals.waiting)")
                .font(.system(size: 44, design: .serif).weight(.semibold))
                .foregroundStyle(theme.state(totals.waiting > 0 ? DroverPalette.amber : DroverPalette.moss))
                .widgetAccentable()
                .minimumScaleFactor(0.5)
                .lineLimit(1)
            CountRow(color: DroverPalette.amber, count: totals.waiting, label: "waiting")
            CountRow(color: DroverPalette.steel, count: totals.working, label: "working")
            CountRow(color: DroverPalette.moss, count: totals.idle, label: "idle")
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(HomeText.countsLabel(totals))
    }

    @ViewBuilder
    private func rows(_ summary: NativeSummary, theme: HomeTheme) -> some View {
        if !summary.waiting.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(summary.waiting.prefix(3)) { WaitingRow(item: $0, headlineLines: 1) }
            }
        } else if !summary.working.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("Working")
                    .font(DroverFont.body(.caption))
                    .foregroundStyle(theme.ink3)
                ForEach(summary.working.prefix(3)) { WorkingRow(item: $0) }
            }
        } else {
            Text("All quiet")
                .font(DroverFont.body(.subheadline))
                .foregroundStyle(theme.ink2)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        }
    }
}

// MARK: - Large

struct LargeSummaryView: View {
    @Environment(\.widgetRenderingMode) private var mode
    var entry: SummaryEntry
    private static let rowBudget = 5

    var body: some View {
        let theme = HomeTheme(mode: mode)
        if let summary = entry.summary {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline) {
                    Text("Waiting on you")
                        .font(DroverFont.title(.headline))
                        .foregroundStyle(theme.ink)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(HomeText.hostLabel(entry.hostFilter))
                        .font(DroverFont.mono(.caption2))
                        .foregroundStyle(theme.ink3)
                        .lineLimit(1)
                }
                HStack(spacing: 6) {
                    CountPill(color: DroverPalette.amber, count: summary.totals.waiting, label: "waiting")
                    CountPill(color: DroverPalette.steel, count: summary.totals.working, label: "working")
                    CountPill(color: DroverPalette.moss, count: summary.totals.idle, label: "idle")
                    Spacer(minLength: 0)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(HomeText.countsLabel(summary.totals))

                VStack(alignment: .leading, spacing: 8) {
                    // One budget of 5 rows for both lists, so the large family never clips on small phones:
                    // two-line headlines only while there is room, working rows only in the slots left over.
                    let waitingRows = Array(summary.waiting.prefix(Self.rowBudget))
                    let workingSlots = min(3, Self.rowBudget - waitingRows.count)
                    ForEach(waitingRows) { WaitingRow(item: $0, headlineLines: waitingRows.count > 2 ? 1 : 2) }
                    if summary.waiting.count > waitingRows.count {
                        Text("and \(summary.waiting.count - waitingRows.count) more")
                            .font(DroverFont.body(.caption2))
                            .foregroundStyle(theme.ink3)
                    }
                    if workingSlots > 0, !summary.working.isEmpty {
                        Text("Working")
                            .font(DroverFont.body(.caption))
                            .foregroundStyle(theme.ink3)
                            .padding(.top, 2)
                        ForEach(summary.working.prefix(workingSlots)) { WorkingRow(item: $0) }
                    }
                    if summary.waiting.isEmpty, summary.working.isEmpty {
                        Text("All quiet")
                            .font(DroverFont.body(.subheadline))
                            .foregroundStyle(theme.ink2)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding(.top, 12)
                    }
                }
                Spacer(minLength: 0)
                HostsStrip(summary: summary)
                if entry.status != .live {
                    HomeFootnote(status: entry.status)
                }
            }
            .widgetURL(DroverDeepLink.board.url)
        } else {
            VStack(spacing: 0) {
                HomeEmptyState(status: entry.status)
            }
            .widgetURL(DroverDeepLink.board.url)
        }
    }
}
#endif
