import DroverKit
import SwiftUI

/// Board: Waiting on you / Working / Idle strips for `model.visibleSessions`. Binds `model.selectedSessionKey`.
struct BoardView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            if let err = model.lastError {
                Text(err)
                    .font(.caption).foregroundStyle(Theme.brick)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(Theme.wash(Theme.brick))
                    .accessibilityLabel("Error: \(err)")
            }
            if model.connection == .notConfigured && model.board.sessions.isEmpty {
                // Pairing starts here on its own at launch when the daemon is on this Mac (AppModel.pairIfUnconfigured).
                ContentUnavailableView {
                    Label("Connect to Drover", systemImage: "network")
                } description: {
                    if model.pairing.phase == .idle {
                        Text("Pair with the daemon, or add the server URL and token in Settings.")
                    } else {
                        PairingStatus(centered: true)
                    }
                } actions: {
                    // One row when it fits the column; two while a code shows its four buttons.
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 10) {
                            PairingButtons()
                            SettingsLink { Text("Open settings") }
                        }
                        VStack(spacing: 10) {
                            HStack(spacing: 10) { PairingButtons(part: .approve) }
                            HStack(spacing: 10) {
                                PairingButtons(part: .control)
                                SettingsLink { Text("Open settings") }
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                lanes
            }
        }
        .background(Theme.bg)
        .toolbar {
            ToolbarItem {
                Button {
                    Task { await model.refresh() }
                } label: {
                    if model.isRefreshing {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "arrow.clockwise")
                    }
                }
                .help("Refresh")
                .accessibilityLabel("Refresh")
            }
        }
    }

    private var lanes: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                    ForEach(Lane.allCases) { lane in
                        let items = model.sessions(in: lane)
                        Section {
                            if items.isEmpty {
                                Text("Nothing here")
                                    .font(.caption).foregroundStyle(Theme.ink4)
                                    .padding(.horizontal, 16).padding(.vertical, 6)
                            }
                            ForEach(items, id: \.key) { s in
                                SessionRow(session: s, isSelected: s.key == model.selectedSessionKey)
                                    .padding(.horizontal, 6)
                                    .id(s.key)
                                    .onTapGesture {
                                        // Leave the composer so the board's j/k/r keys apply again.
                                        NSApp.keyWindow?.makeFirstResponder(nil)
                                        model.select(s)
                                    }
                            }
                        } header: {
                            header(lane, count: items.count)
                        }
                    }
                }
                .padding(.bottom, 12)
            }
            .onChange(of: model.selectedSessionKey) { _, key in
                guard let key else { return }
                withAnimation(.easeInOut(duration: 0.2)) { proxy.scrollTo(key, anchor: nil) }
            }
        }
    }

    private func header(_ lane: Lane, count: Int) -> some View {
        HStack(spacing: 8) {
            RoundedRectangle(cornerRadius: 1.5).fill(Theme.color(for: lane)).frame(width: 3, height: 16)
            Text(lane.title).font(Theme.titleFont(15)).foregroundStyle(Theme.ink)
            Text("\(count)").font(Theme.mono).foregroundStyle(Theme.ink3)
            Spacer()
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bg)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityLabel("\(lane.title), \(count)")
    }
}
