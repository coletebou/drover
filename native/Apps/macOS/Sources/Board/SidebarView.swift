import SwiftUI

/// Sidebar: the manager first, then views (All, Waiting on you, Working, Idle) and hosts with counts.
/// Binds `model.sidebarSelection`.
struct SidebarView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        let counts = BoardFormat.laneCounts(model.board.sessions)
        let selection = Binding<SidebarItem?>(
            get: { model.sidebarSelection },
            set: { if let v = $0 { model.sidebarSelection = v } })
        List(selection: selection) {
            Section {
                managerRow.tag(SidebarItem.manager)
            }
            Section("Views") {
                row("All sessions", count: model.board.sessions.count, color: Theme.ink3)
                    .tag(SidebarItem.all)
                ForEach(Lane.allCases) { lane in
                    row(lane.title, count: counts[lane] ?? 0, color: Theme.color(for: lane))
                        .tag(SidebarItem.lane(lane))
                }
            }
            Section("Hosts") {
                ForEach(model.board.hosts) { host in
                    HStack(alignment: .top, spacing: 8) {
                        StateDot(color: host.up ? Theme.moss : Theme.brick).padding(.top, 5)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(host.name).font(.system(.body, design: .monospaced)).foregroundStyle(Theme.ink).lineLimit(1)
                            Text(BoardFormat.hostCaption(host))
                                .font(.caption)
                                .foregroundStyle(host.up ? Theme.ink3 : Theme.brick)
                                .lineLimit(2)
                        }
                    }
                    .tag(SidebarItem.host(host.name))
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(host.name), \(host.up ? "up" : "down"), \(BoardFormat.hostCaption(host))")
                }
            }
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)
        .background(Theme.bg2)
        .safeAreaInset(edge: .bottom, spacing: 0) { footer }
    }

    private var managerRow: some View {
        let m = model.manager
        let color = m.isBusy ? Theme.steel : m.isUp ? Theme.lilac : Theme.ink4
        return HStack(spacing: 8) {
            Image(systemName: "person.crop.circle.badge.checkmark")
                .foregroundStyle(Theme.lilac)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text("Manager").font(Theme.titleFont(15)).foregroundStyle(Theme.ink)
                HStack(spacing: 5) {
                    StateDot(color: color)
                    Text(m.statusText).font(.caption).foregroundStyle(Theme.ink3)
                    if m.thread != "main" { Text(m.thread).font(Theme.mono).foregroundStyle(Theme.ink4).lineLimit(1) }
                }
            }
            Spacer(minLength: 4)
            Button { WindowRouter.shared.toggleManagerPanel() } label: { Image(systemName: "macwindow.on.rectangle") }
                .buttonStyle(.borderless)
                .foregroundStyle(Theme.ink3)
                .help("Floating manager panel (Shift Command M)")
                .accessibilityLabel("Floating manager panel")
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Manager, \(m.statusText)")
    }

    private func row(_ title: String, count: Int, color: Color) -> some View {
        HStack(spacing: 8) {
            Text(title).foregroundStyle(Theme.ink)
            Spacer()
            if count > 0 {
                Text("\(count)")
                    .font(Theme.mono)
                    .foregroundStyle(color)
                    .padding(.horizontal, 6).padding(.vertical, 1)
                    .background(Capsule().fill(Theme.wash(color)))
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title), \(count)")
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                StateDot(color: connectionColor)
                Text(model.connection.label).font(.caption).foregroundStyle(Theme.ink3).lineLimit(1)
                if model.board.source == .fleet {
                    Text("· older daemon").font(.caption).foregroundStyle(Theme.ink4).lineLimit(1)
                        .help("This daemon has no native.board: the board comes from fleet.summary")
                }
            }
            if let err = model.lastError {
                Text(err).font(.caption).foregroundStyle(Theme.brick).lineLimit(3)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Theme.bg2)
        .accessibilityElement(children: .combine)
    }

    private var connectionColor: Color {
        switch model.connection {
        case .live: Theme.moss
        case .connecting, .reconnecting: Theme.amber
        case .notConfigured: Theme.ink4
        case .failed: Theme.brick
        }
    }
}
