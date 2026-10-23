import SwiftUI

struct PopoverView: View {
    let store: MenuBarStore
    let actions: PopoverActions

    @State private var contentHeight: CGFloat = 0
    @State private var showWorking = false
    @State private var refreshing = false

    private static let maxScrollHeight: CGFloat = 380

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
            Divider().overlay(Theme.separator)

            // The manager stays in view above the list, whatever scrolls.
            if store.connection != .unconfigured, store.summary?.manager != nil {
                ManagerBox(store: store, actions: actions)
                    .padding(.horizontal, 12)
                    .padding(.top, 10)
                    .padding(.bottom, 2)
            }

            ScrollView {
                content
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        GeometryReader { proxy in
                            Color.clear.preference(key: HeightKey.self, value: proxy.size.height)
                        })
            }
            .onPreferenceChange(HeightKey.self) { contentHeight = $0 }
            .frame(height: contentHeight > 0 ? min(contentHeight, Self.maxScrollHeight) : Self.maxScrollHeight)

            Divider().overlay(Theme.separator)
            footer
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
        }
        .frame(width: 380)
        .frame(maxHeight: 720)
        .background(Theme.background)
        .foregroundStyle(Theme.text)
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 8) {
            Text("Drover").font(Theme.title)
            connectionPill
            Spacer(minLength: 4)
            // Live means current: the age only matters while polling or offline.
            if let updated = store.lastUpdated, !store.isLive {
                Text("Updated \(RelativeDateTimeFormatter().localizedString(for: updated, relativeTo: Date()))")
                    .font(.caption)
                    .foregroundStyle(Theme.secondaryText)
                    .lineLimit(1)
            }
            Button {
                refreshing = true
                Task {
                    await store.refresh()
                    refreshing = false
                }
            } label: {
                if refreshing {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "arrow.clockwise")
                }
            }
            .buttonStyle(.borderless)
            .disabled(refreshing || store.connection == .unconfigured)
            .accessibilityLabel("Refresh")
            .help("Refresh now")
        }
    }

    private var connectionPill: some View {
        let (label, color) = pillInfo
        return HStack(spacing: 5) {
            Circle().fill(color).frame(width: 7, height: 7).accessibilityHidden(true)
            Text(label).font(.caption).foregroundStyle(Theme.text)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(Capsule().fill(Theme.surface))
        .overlay(Capsule().stroke(Theme.separator))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Connection: \(label)")
    }

    private var pillInfo: (String, Color) {
        switch store.connection {
        case .live: ("Live", Theme.idle)
        case .polling: ("Polling", Theme.working)
        case .connecting: ("Connecting", Theme.secondaryText)
        case .offline: ("Offline", Theme.error)
        case .unauthorized: ("Token rejected", Theme.error)
        case .unconfigured: ("Not set up", Theme.secondaryText)
        }
    }

    // MARK: Content

    @ViewBuilder
    private var content: some View {
        if store.connection == .unconfigured {
            unconfiguredState
        } else {
            VStack(alignment: .leading, spacing: 14) {
                if let error = store.lastError, showsErrorBanner {
                    errorBanner(error)
                }
                waitingSection
                workingSection
                healthSection
                Divider().overlay(Theme.separator)
                QuickActions(store: store, actions: actions)
            }
        }
    }

    private var showsErrorBanner: Bool {
        switch store.connection {
        case .offline, .unauthorized: true
        default: false
        }
    }

    private var unconfiguredState: some View {
        VStack(spacing: 8) {
            Image(systemName: "gearshape")
                .font(.largeTitle)
                .foregroundStyle(Theme.secondaryText)
                .accessibilityHidden(true)
            Text("Connect to Drover").font(Theme.title)
            Text("Add the server address and a token in Settings.")
                .font(.callout)
                .foregroundStyle(Theme.secondaryText)
                .multilineTextAlignment(.center)
            Button("Open settings") { actions.openSettings() }
                .buttonStyle(.borderedProminent)
                .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 20)
    }

    private func errorBanner(_ error: DroverError) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Theme.error)
                .accessibilityHidden(true)
            Text(error.userMessage)
                .font(.callout)
                .foregroundStyle(Theme.error)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.error.opacity(0.12)))
        .accessibilityElement(children: .combine)
    }

    // MARK: Waiting

    private var waitingItems: [WaitingItem] { store.summary?.waiting ?? [] }

    private var waitingSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Waiting on you").font(.subheadline.weight(.semibold))
                Text("\(store.summary?.totals.waiting ?? waitingItems.count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(Theme.secondaryText)
                Spacer()
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)

            if waitingItems.isEmpty {
                Text("Nothing is waiting on you.")
                    .font(.callout)
                    .foregroundStyle(Theme.secondaryText)
            } else {
                ForEach(Array(waitingItems.enumerated()), id: \.element.id) { index, item in
                    if index > 0 { Divider().overlay(Theme.separator) }
                    WaitingRow(item: item, store: store, actions: actions)
                }
            }
        }
    }

    // MARK: Working

    private var workingSection: some View {
        // The manager has its own box above.
        let all = store.summary?.working ?? []
        let items = all.filter { $0.id != AppIdentifiers.managerID }
        let count = max(0, (store.summary?.totals.working ?? all.count) - (all.count - items.count))
        return DisclosureGroup(isExpanded: $showWorking) {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(items.prefix(8)) { item in
                    Button { actions.openWorking(item) } label: {
                        VStack(alignment: .leading, spacing: 1) {
                            HStack(spacing: 6) {
                                Text(item.name).foregroundStyle(Theme.text)
                                Text(item.host).font(Theme.mono).foregroundStyle(Theme.secondaryText)
                            }
                            Text(item.headline)
                                .font(.caption)
                                .foregroundStyle(Theme.secondaryText)
                                .lineLimit(1)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 3)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Open \(item.name) on \(item.host)")
                }
                if items.count > 8 {
                    Text("And \(items.count - 8) more.")
                        .font(.caption)
                        .foregroundStyle(Theme.secondaryText)
                }
            }
            .padding(.top, 4)
        } label: {
            HStack(spacing: 6) {
                Circle().fill(Theme.working).frame(width: 7, height: 7).accessibilityHidden(true)
                Text("\(count) working").font(.subheadline.weight(.semibold))
            }
        }
        .disabled(items.isEmpty)
    }

    // MARK: Health

    /// Host health dots (the manager has its own box above).
    @ViewBuilder
    private var healthSection: some View {
        let hosts = store.summary?.hosts ?? []
        if !hosts.isEmpty {
            FlowLayout(spacing: 12, lineSpacing: 6) {
                ForEach(hosts) { host in
                    HStack(spacing: 5) {
                        Circle().fill(color(for: host)).frame(width: 7, height: 7).accessibilityHidden(true)
                        Text(host.name).font(Theme.mono).foregroundStyle(Theme.secondaryText)
                    }
                    .help(tooltip(for: host))
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(tooltip(for: host))
                }
            }
        }
    }

    private func color(for host: SummaryHost) -> Color {
        if !host.up { return Theme.error }
        if host.waiting > 0 { return Theme.waiting }
        if host.working > 0 { return Theme.working }
        return Theme.idle
    }

    private func tooltip(for host: SummaryHost) -> String {
        host.up
            ? "\(host.name): \(host.waiting) waiting, \(host.working) working, \(host.idle) idle"
            : "\(host.name): down"
    }

    // MARK: Footer

    private var footer: some View {
        HStack {
            Button("Settings\u{2026}") { actions.openSettings() }
                .keyboardShortcut(",", modifiers: .command)
            Spacer()
            Button("Quit") { actions.quit() }
                .keyboardShortcut("q", modifiers: .command)
        }
        .buttonStyle(.borderless)
        .controlSize(.small)
    }
}

private struct HeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

// MARK: - Previews

private extension Summary {
    static let previewEmpty = Summary(
        generatedAt: Summary.preview.generatedAt,
        hosts: Summary.preview.hosts.map { SummaryHost(name: $0.name, up: $0.up, waiting: 0, working: 0, idle: $0.idle) },
        waiting: [], working: [],
        totals: SummaryTotals(waiting: 0, working: 0, idle: 4, hosts: 3),
        manager: Summary.preview.manager)
}

#Preview("Live") {
    PopoverView(store: .preview(.preview), actions: .noop)
}

#Preview("Manager streaming") {
    var chat = ManagerChat()
    chat.beginSend("Who is waiting on me?")
    chat.sent(ManagerSendResult(pending: true, event: "ev-1", turnId: "t-1"))
    chat.apply(ManagerStreamEvent(turnId: "t-1", inReplyTo: "ev-1", phase: "delta",
                                  text: "Two sessions wait on you: **demo-build** needs a decision"))
    return PopoverView(store: .preview(.preview, manager: chat), actions: .noop)
}

#Preview("Cannot act") {
    PopoverView(store: .preview(.preview, canAct: false), actions: .noop)
}

#Preview("Unconfigured") {
    PopoverView(store: .preview(nil, connection: .unconfigured), actions: .noop)
}

#Preview("Offline, stale data") {
    PopoverView(store: .preview(.preview, connection: .offline("Cannot reach the server.")), actions: .noop)
}

#Preview("Empty") {
    PopoverView(store: .preview(.previewEmpty), actions: .noop)
}

#Preview("Menu bar label tones") {
    HStack(spacing: 16) {
        MenuBarLabel(badge: BadgeState(count: 3, tone: .waiting, label: "waiting"))
        MenuBarLabel(badge: BadgeState(count: 0, tone: .working, label: "working"))
        MenuBarLabel(badge: BadgeState(count: 0, tone: .idle, label: "idle"))
        MenuBarLabel(badge: BadgeState(count: 2, tone: .error, label: "error"))
        MenuBarLabel(badge: BadgeState(count: 0, tone: .unconfigured, label: "not set up"))
    }
    .padding()
}
