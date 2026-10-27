import SwiftUI
import UIKit

/// The board: what is waiting on you, what is working, host health and the manager.
struct BoardView: View {
    @Environment(AppModel.self) private var model
    @ScaledMetric(relativeTo: .body) private var rowMin: CGFloat = 44

    var body: some View {
        @Bindable var model = model
        NavigationSplitView {
            sidebar(selection: $model.boardSelection)
                .navigationTitle("Board")
        } detail: {
            if let ref = model.boardSelection {
                // A new identity per session, so chat, screen and draft state never carry over.
                SessionDetailView(ref: ref).id(ref)
            } else {
                ContentUnavailableView("Pick a session", systemImage: "rectangle.stack",
                                       description: Text("Choose a session from the board to read it and reply."))
            }
        }
        .task { if model.summary == nil { await model.refreshSummary() } }
        .onChange(of: model.summary?.totals.waiting) { old, new in
            if BoardFormat.waitingIncreased(from: old, to: new) { Haptics.warning() }
        }
    }

    @ViewBuilder
    private func sidebar(selection: Binding<SessionRef?>) -> some View {
        if model.connection == .unconfigured {
            ContentUnavailableView {
                Label("Connect to Drover", systemImage: "network")
            } description: {
                Text("Add your daemon address and token in Settings.")
            } actions: {
                Button("Open Settings") { model.selectedTab = .settings }
                    .buttonStyle(.borderedProminent)
            }
        } else {
            List(selection: selection) {
                Section {
                    if let err = model.summaryError, model.summary != nil {
                        Text("Showing cached data: \(err)")
                            .font(.footnote).foregroundStyle(Theme.error)
                            .accessibilityLabel("Showing cached data: \(err)")
                    }
                    BoardTotalsHeader(summary: model.summary, fallbackDate: model.lastRefresh)
                    if model.connection == .readOnly {
                        Text("Read-only token: add the main token in Settings to reply.")
                            .font(.footnote).foregroundStyle(Theme.textSecondary)
                    }
                }
                if let summary = model.summary {
                    waitingSection(summary)
                    if !summary.working.isEmpty { workingSection(summary) }
                    if !summary.hosts.isEmpty { hostsSection(summary) }
                    if let manager = summary.manager { managerSection(manager) }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .refreshable { await model.refreshAll() }
            .overlay {
                if model.summary == nil && model.summaryError == nil {
                    ProgressView("Loading").foregroundStyle(Theme.textSecondary)
                } else if model.summary == nil, let err = model.summaryError {
                    ContentUnavailableView("Could not load the board", systemImage: "exclamationmark.triangle",
                                           description: Text(err))
                }
            }
        }
    }

    private func waitingSection(_ summary: NativeSummary) -> some View {
        Section("Waiting on you") {
            if let notice = model.approvalNotice { approvalNoticeRow(notice) }
            if summary.waiting.isEmpty {
                Text("Nothing is waiting on you").font(.subheadline).foregroundStyle(Theme.textSecondary)
                    .frame(minHeight: rowMin, alignment: .leading)
            }
            ForEach(summary.waiting) { item in
                BoardWaitingRow(item: item)
                    .tag(item.ref)
                    .listRowBackground(Theme.surface)
                    .swipeActions(edge: .trailing) {
                        Button("Open") { open(item.ref) }.tint(Theme.working)
                        Button("Copy session id") { copy(item.id) }.tint(Theme.manager)
                    }
                    .contextMenu {
                        Button("Open", systemImage: "arrow.up.right.square") { open(item.ref) }
                        Button("Copy session id", systemImage: "doc.on.doc") { copy(item.id) }
                    }
                    .accessibilityAction(named: "Open") { open(item.ref) }
                    .accessibilityAction(named: "Copy session id") { copy(item.id) }
            }
        }
    }

    /// What the last approval answer came to; it stays while the board refreshes (a closed request's card goes).
    private func approvalNoticeRow(_ notice: ApprovalNotice) -> some View {
        ApprovalNoticeView(notice: notice) { model.dismissApprovalNotice() }
            .frame(minHeight: rowMin, alignment: .leading)
            .listRowBackground(Theme.surface)
    }

    private func workingSection(_ summary: NativeSummary) -> some View {
        Section("Working") {
            ForEach(summary.working) { item in
                BoardWorkingRow(item: item)
                    .tag(item.ref)
                    .listRowBackground(Theme.surface)
                    .contextMenu {
                        Button("Open", systemImage: "arrow.up.right.square") { open(item.ref) }
                        Button("Copy session id", systemImage: "doc.on.doc") { copy(item.id) }
                    }
                    .accessibilityAction(named: "Open") { open(item.ref) }
                    .accessibilityAction(named: "Copy session id") { copy(item.id) }
            }
        }
    }

    private func hostsSection(_ summary: NativeSummary) -> some View {
        Section("Hosts") {
            ForEach(summary.hosts) { host in
                BoardHostRow(host: host).listRowBackground(Theme.surface)
            }
        }
    }

    private func managerSection(_ manager: NativeSummary.ManagerHealth) -> some View {
        Section("Manager") {
            Button { model.selectedTab = .manager } label: { BoardManagerRow(manager: manager) }
                .buttonStyle(.plain)
                .listRowBackground(Theme.surface)
        }
    }

    private func open(_ ref: SessionRef) {
        Haptics.tap()
        model.boardSelection = ref
    }

    private func copy(_ id: String) {
        UIPasteboard.general.string = id
        Haptics.success()
        A11y.announce("Session id copied")
    }
}

#Preview("Board") {
    BoardView().environment(AppModel.preview())
}

#Preview("Board, large text, dark") {
    BoardView().environment(AppModel.preview())
        .dynamicTypeSize(.accessibility3)
        .preferredColorScheme(.dark)
}
