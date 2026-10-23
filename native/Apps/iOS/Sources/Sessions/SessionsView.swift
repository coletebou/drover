import SwiftUI

/// Every session on every up host, grouped by host, with search and a state filter.
struct SessionsView: View {
    @Environment(AppModel.self) private var model
    @State private var filter: SessionsFilter = .live
    @State private var query = ""

    var body: some View {
        @Bindable var model = model
        NavigationSplitView {
            sidebar(selection: $model.sessionsSelection)
                .navigationTitle("Sessions")
        } detail: {
            if let ref = model.sessionsSelection {
                // A new identity per session, so chat, screen and draft state never carry over.
                SessionDetailView(ref: ref).id(ref)
            } else {
                ContentUnavailableView("Pick a session", systemImage: "rectangle.stack",
                                       description: Text("Choose a session to read it and reply."))
            }
        }
        .task { if model.sessions.isEmpty && model.hasMainToken { await model.refreshSessions() } }
    }

    @ViewBuilder
    private func sidebar(selection: Binding<SessionRef?>) -> some View {
        if !model.hasMainToken {
            ContentUnavailableView {
                Label("Main token needed", systemImage: "key")
            } description: {
                Text("Listing sessions needs the main token. Add it in Settings.")
            } actions: {
                Button("Open Settings") { model.selectedTab = .settings }
                    .buttonStyle(.borderedProminent)
            }
        } else {
            let groups = SessionsFilter.apply(model.sessions, filter: filter, query: query) { model.boardState(for: $0) }
            List(selection: selection) {
                ForEach(groups, id: \.host) { group in
                    Section {
                        ForEach(group.sessions) { s in
                            SessionsRow(session: s, state: model.boardState(for: s.ref))
                                .tag(s.ref)
                                .listRowBackground(Theme.surface)
                        }
                    } header: {
                        Text(group.host).font(Theme.mono(.footnote)).foregroundStyle(Theme.textSecondary)
                            .accessibilityAddTraits(.isHeader)
                    }
                }
                if let err = model.sessionsError {
                    Section {
                        Text(err).font(.footnote).foregroundStyle(Theme.error)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .searchable(text: $query, prompt: "Search sessions")
            .refreshable { await model.refreshSessions() }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Picker("Filter", selection: $filter) {
                            ForEach(SessionsFilter.allCases) { Text($0.label).tag($0) }
                        }
                    } label: {
                        Label("Filter: \(filter.label)", systemImage: "line.3.horizontal.decrease.circle")
                    }
                    .accessibilityLabel("Filter")
                    .accessibilityValue(filter.label)
                    .accessibilityHint("Chooses which sessions to list")
                }
            }
            .overlay {
                if groups.isEmpty && model.sessionsError == nil {
                    if model.sessions.isEmpty {
                        ContentUnavailableView("No sessions", systemImage: "tray",
                                               description: Text("Pull to refresh."))
                    } else {
                        ContentUnavailableView.search(text: query)
                    }
                }
            }
        }
    }
}

struct SessionsRow: View {
    let session: SessionInfo
    let state: BoardState
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .body) private var minHeight: CGFloat = 44

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(session.title).font(Theme.title(.headline)).foregroundStyle(Theme.textPrimary)
            BoardAdaptiveStack(spacing: 8) {
                StateBadge(state: state)
                Text(session.engine.label).font(.caption).foregroundStyle(Theme.textSecondary)
                if let dir = SessionsFilter.lastPathComponent(session.cwd) {
                    Text(dir).font(.caption).foregroundStyle(Theme.textSecondary)
                        .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
                }
            }
            if session.tmux != nil || !session.isLive {
                BoardAdaptiveStack(spacing: 8) {
                    if let t = session.tmux { MonoText(text: t) }
                    if !session.isLive { Text("not live").font(.caption).foregroundStyle(Theme.textSecondary) }
                }
            }
        }
        .frame(maxWidth: .infinity, minHeight: minHeight, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken)
    }

    private var spoken: String {
        var parts = [session.title, state.label.lowercased(), session.engine.label]
        if let dir = SessionsFilter.lastPathComponent(session.cwd) { parts.append("in \(dir)") }
        if let t = session.tmux { parts.append("tmux \(t)") }
        if !session.isLive { parts.append("not live") }
        return parts.joined(separator: ", ")
    }
}

#Preview("Sessions") {
    SessionsView().environment(AppModel.preview())
}

#Preview("Sessions, large text, dark") {
    SessionsView().environment(AppModel.preview())
        .dynamicTypeSize(.accessibility3)
        .preferredColorScheme(.dark)
}
