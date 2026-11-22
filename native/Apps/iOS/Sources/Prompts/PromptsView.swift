import DroverKit
import SwiftUI
import UIKit

/// The Prompts tab: every prompt typed into Claude Code or Codex on any machine, newest first. Mine or All at the
/// top, a search field (every word must match, asked of the daemon), pull to refresh, the next page at the end. A
/// prompt opens whole, verbatim and selectable (never Markdown), with Copy and Open session.
struct PromptsView: View {
    @Environment(AppModel.self) private var model
    @State private var selection: String?

    var body: some View {
        NavigationSplitView {
            sidebar
                .navigationTitle("Prompts")
                .navigationBarTitleDisplayMode(.inline)
        } detail: {
            if let id = selection, let p = model.prompts.record(id: id) {
                PromptDetailView(record: p).id(id)
            } else {
                ContentUnavailableView("Pick a prompt", systemImage: "text.bubble",
                                       description: Text("Choose one to read it whole and copy it."))
            }
        }
    }

    @ViewBuilder
    private var sidebar: some View {
        @Bindable var store = model.prompts
        if !model.hasMainToken {
            ContentUnavailableView {
                Label("Main token needed", systemImage: "key")
            } description: {
                Text("Reading prompts needs the main token. Add it in Settings.")
            } actions: {
                Button("Open Settings") { model.selectedTab = .settings }
                    .buttonStyle(.borderedProminent)
            }
        } else {
            List(selection: $selection) {
                statusSection(store)
                Section {
                    ForEach(store.records) { p in
                        PromptRow(record: p)
                            .tag(p.id)
                            .listRowBackground(Theme.surface)
                            .swipeActions(edge: .trailing) {
                                Button("Copy") { copy(p) }.tint(Theme.working)
                            }
                            .contextMenu {
                                Button("Copy", systemImage: "doc.on.doc") { copy(p) }
                                if let ref = store.sessionRef(for: p) {
                                    Button("Open session", systemImage: "arrow.up.right.square") { open(ref) }
                                }
                            }
                            .accessibilityAction(named: "Copy") { copy(p) }
                            .task { if p.id == store.records.last?.id { await store.loadMore() } }
                    }
                    if store.more || store.loadingMore {
                        HStack {
                            Spacer()
                            ProgressView()
                            Text("Older prompts").font(.footnote).foregroundStyle(Theme.textSecondary)
                            Spacer()
                        }
                        .listRowBackground(Theme.surface)
                        .task { await store.loadMore() }
                    }
                }
                if let err = store.error {
                    Section { Text(err).font(.footnote).foregroundStyle(Theme.error) }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .searchable(text: $store.search, prompt: "Search every prompt")
            .refreshable {
                await store.reload()
                await store.refreshStatus()
            }
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Picker("Prompts", selection: $store.scope) {
                        Text("Mine").tag(PromptsQuery.Scope.mine)
                        Text("All").tag(PromptsQuery.Scope.all)
                    }
                    .pickerStyle(.segmented)
                    .fixedSize()
                    .accessibilityLabel("Which prompts")
                    .accessibilityHint("Mine: what you typed or sent through Drover. All: agents and programs too.")
                }
            }
            .overlay { overlay(store) }
            .task { await store.appear() }
        }
    }

    @ViewBuilder
    private func statusSection(_ store: PromptsStore) -> some View {
        Section {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(store.syncNote ?? store.status?.line() ?? "Reading the spool")
                    .font(.footnote).foregroundStyle(Theme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button {
                    Task {
                        await store.sync()
                        A11y.announce(store.syncNote ?? "Synced")
                    }
                } label: {
                    if store.syncing { ProgressView() } else { Text("Sync now") }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(store.syncing || store.unsupported)
                .accessibilityHint("Scans the transcripts now, then pushes every sink")
            }
            if !store.downHosts.isEmpty {
                Text("\(store.downHosts.joined(separator: ", ")) did not answer: \(store.downHosts.count > 1 ? "their" : "its") prompts are missing.")
                    .font(.footnote).foregroundStyle(Theme.waiting)
            }
        }
        .listRowBackground(Theme.surface)
    }

    @ViewBuilder
    private func overlay(_ store: PromptsStore) -> some View {
        if store.unsupported {
            ContentUnavailableView("This daemon keeps no prompts yet", systemImage: "text.bubble",
                                   description: Text("Update Drover on the Mac: the prompt spool fills from every transcript there."))
        } else if store.records.isEmpty && (store.loading || !store.loaded) {
            ProgressView("Reading prompts").foregroundStyle(Theme.textSecondary)
        } else if store.records.isEmpty && store.error == nil {
            if store.search.trimmingCharacters(in: .whitespaces).isEmpty {
                ContentUnavailableView("No prompts yet", systemImage: "text.bubble",
                                       description: Text("They appear here as you type them into Claude Code or Codex."))
            } else {
                ContentUnavailableView.search(text: store.search)
            }
        }
    }

    private func copy(_ p: PromptRecord) {
        UIPasteboard.general.string = p.text
        Haptics.success()
        A11y.announce("Prompt copied")
    }

    private func open(_ ref: SessionRef) {
        Haptics.tap()
        model.open(ref, in: .sessions)
    }
}

/// One prompt: when, where and with what, then two lines of its text.
struct PromptRow: View {
    let record: PromptRecord
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .body) private var minHeight: CGFloat = 44

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(PromptsStore.meta(record))
                .font(Theme.mono(.caption)).foregroundStyle(Theme.textSecondary)
                .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
            Text(verbatim: record.text)
                .font(.subheadline).foregroundStyle(Theme.textPrimary)
                .lineLimit(typeSize.isAccessibilitySize ? 4 : 2)
        }
        .frame(maxWidth: .infinity, minHeight: minHeight, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(PromptsStore.meta(record)): \(record.firstLine(max: 200))")
    }
}

/// A prompt whole: verbatim, selectable, monospaced; Copy, Open session (when the session is on the board), and
/// where and when it was typed.
struct PromptDetailView: View {
    let record: PromptRecord
    @Environment(AppModel.self) private var model

    var body: some View {
        let ref = model.prompts.sessionRef(for: record)
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(verbatim: record.text)
                    .font(Theme.mono(.body))
                    .foregroundStyle(Theme.textPrimary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Theme.surface))
                    .accessibilityLabel("The prompt, verbatim: \(record.text)")
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) { buttons(ref) }
                    VStack(alignment: .leading, spacing: 10) { buttons(ref) }
                }
                facts(ref)
            }
            .padding()
        }
        .background(Theme.background)
        .navigationTitle(record.project ?? record.host)
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func buttons(_ ref: SessionRef?) -> some View {
        Button {
            UIPasteboard.general.string = record.text
            Haptics.success()
            A11y.announce("Prompt copied")
        } label: {
            Label("Copy", systemImage: "doc.on.doc")
        }
        .buttonStyle(.borderedProminent)
        Button {
            if let ref { Haptics.tap(); model.open(ref, in: .sessions) }
        } label: {
            Label("Open session", systemImage: "arrow.up.right.square")
        }
        .buttonStyle(.bordered)
        .disabled(ref == nil)
        .accessibilityHint(ref == nil ? "That session is not on the board now" : "Opens it under Agents, List")
    }

    private func facts(_ ref: SessionRef?) -> some View {
        let rows: [(String, String?)] = [
            ("When", "\(record.ts.date.formatted(date: .abbreviated, time: .shortened)) (\(record.ts.date.relativeLabel))"),
            ("Host", record.host),
            ("Engine", record.engine.rawValue),
            ("Folder", record.cwd),
            ("Label", record.label),
            ("Came", record.via.map { $0.label.isEmpty ? "typed" : $0.label }.map { v in record.from.map { "\(v), from \($0)" } ?? v }),
            ("Session", record.session),
            ("Source", record.source),
        ]
        return VStack(alignment: .leading, spacing: 6) {
            ForEach(rows.filter { $0.1 != nil }, id: \.0) { row in
                VStack(alignment: .leading, spacing: 1) {
                    Text(row.0).font(.caption).foregroundStyle(Theme.textSecondary)
                    Text(verbatim: row.1 ?? "").font(Theme.mono(.footnote)).foregroundStyle(Theme.textPrimary).textSelection(.enabled)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }
}
