import AppKit
import DroverKit
import SwiftUI

/// Prompts in the content column: Mine / All, a search field (Command F), a host menu, the status line with Sync now,
/// and the list, newest first, paging as it scrolls. Command C copies the selected prompt; j and k move.
struct PromptsListView: View {
    @Environment(AppModel.self) private var model
    @FocusState private var searchFocused: Bool
    @FocusState private var listFocused: Bool

    var body: some View {
        @Bindable var p = model.prompts
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Text("Prompts").font(Theme.titleFont(17)).foregroundStyle(Theme.ink)
                    Spacer()
                    Picker("Scope", selection: $p.scope) {
                        Text("Mine").tag(PromptsQuery.Scope.mine)
                        Text("All").tag(PromptsQuery.Scope.all)
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .fixedSize()
                    .help("Mine: what you typed, queued or sent through Drover. All: every turn, agents and programs too.")
                }
                HStack(spacing: 6) {
                    TextField("Search every prompt (all words must match)", text: $p.search)
                        .textFieldStyle(.roundedBorder)
                        .focused($searchFocused)
                        .onSubmit { model.prompts.reload() }
                        .onExitCommand { searchFocused = false }
                        .accessibilityLabel("Search prompts")
                    Picker("Host", selection: $p.hostFilter) {
                        Text("Every host").tag(String?.none)
                        ForEach(p.hostChoices, id: \.self) { Text($0).tag(String?.some($0)) }
                    }
                    .labelsHidden()
                    .fixedSize()
                    .accessibilityLabel("Host")
                }
                statusRow(p)
            }
            .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 8)
            Divider().overlay(Theme.line)
            notices(p)
            content(p)
        }
        .background(Theme.bg)
        .onAppear { model.prompts.appear() }
        .onChange(of: p.searchFocusRequest) { _, _ in searchFocused = true }
    }

    private func statusRow(_ p: PromptsModel) -> some View {
        HStack(spacing: 6) {
            Text(p.status?.line() ?? p.statusError ?? " ")
                .font(.caption).foregroundStyle(p.statusError == nil ? Theme.ink3 : Theme.brick)
                .lineLimit(2)
                .help(sinkHelp(p.status))
            Spacer(minLength: 4)
            Button {
                Task { await model.prompts.sync() }
            } label: {
                if p.syncing { ProgressView().controlSize(.small) } else { Text("Sync now") }
            }
            .controlSize(.small)
            .disabled(p.syncing || p.unsupported)
            .help("Scan the transcripts now, then push every sink (prompts.sync)")
        }
    }

    private func sinkHelp(_ s: PromptsStatus?) -> String {
        guard let s, !s.sinks.isEmpty else { return "No sinks: the local spool only" }
        return s.sinks.map { k in
            "\(k.name) (\(k.type ?? "sink")): " + (k.lastError.map { "error: \($0)" } ?? k.lastSync.map { "synced \($0.date.formatted())" } ?? "not synced yet")
        }.joined(separator: "\n")
    }

    @ViewBuilder
    private func notices(_ p: PromptsModel) -> some View {
        if let err = p.error {
            Text(err)
                .font(.caption).foregroundStyle(Theme.brick).lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(Theme.wash(Theme.brick))
        }
        if !p.downHosts.isEmpty {
            Text("\(p.downHosts.joined(separator: ", ")) did not answer: \(p.downHosts.count > 1 ? "their" : "its") prompts are missing.")
                .font(.caption).foregroundStyle(Theme.amber).lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(Theme.wash(Theme.amber))
        }
    }

    @ViewBuilder
    private func content(_ p: PromptsModel) -> some View {
        if p.unsupported {
            ContentUnavailableView("This daemon keeps no prompts yet", systemImage: "text.bubble",
                                   description: Text("prompts.list comes with the prompt collector (drover prompts). Update the daemon; the spool then fills from every transcript on the machine."))
        } else if p.records.isEmpty && (p.loading || !p.loaded) {
            ProgressView("Reading prompts").frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if p.records.isEmpty {
            ContentUnavailableView(p.search.isEmpty && p.hostFilter == nil ? "No prompts yet" : "Nothing matches", systemImage: "text.bubble",
                                   description: Text(p.search.isEmpty ? "They appear here as you type them into Claude Code or Codex." : "Every word must appear in the prompt."))
        } else {
            list(p)
        }
    }

    private func list(_ p: PromptsModel) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(p.records) { r in
                        PromptRow(record: r, isSelected: r.id == p.selectedID)
                            .padding(.horizontal, 6)
                            .id(r.id)
                            .onTapGesture {
                                listFocused = true
                                model.prompts.selectedID = r.id
                            }
                            .onAppear { if r.id == p.records.last?.id { model.prompts.loadMore() } }
                    }
                    if p.more || p.loadingMore {
                        HStack { Spacer(); ProgressView().controlSize(.small); Text("Older prompts").font(.caption).foregroundStyle(Theme.ink3); Spacer() }
                            .padding(.vertical, 10)
                            .onAppear { model.prompts.loadMore() }
                    } else {
                        Text("\(p.records.count) prompt\(p.records.count == 1 ? "" : "s")")
                            .font(.caption).foregroundStyle(Theme.ink4)
                            .frame(maxWidth: .infinity).padding(.vertical, 10)
                    }
                }
                .padding(.vertical, 6)
            }
            .focusable()
            .focused($listFocused)
            .focusEffectDisabled()
            .onMoveCommand { dir in
                switch dir {
                case .down: model.prompts.selectNext()
                case .up: model.prompts.selectPrevious()
                default: break
                }
            }
            // Edit > Copy (Command C) with the list focused: the selected prompt, verbatim.
            .onCopyCommand {
                guard let sel = model.prompts.selected else { return [] }
                return [NSItemProvider(object: sel.text as NSString)]
            }
            .onChange(of: p.selectedID) { _, id in
                guard let id else { return }
                withAnimation(.easeInOut(duration: 0.15)) { proxy.scrollTo(id, anchor: nil) }
            }
        }
    }
}

/// One prompt: time, host, engine, project and where it came from, then two lines of its text.
struct PromptRow: View {
    let record: PromptRecord
    let isSelected: Bool
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(PromptsModel.time(record.ts.date)).font(Theme.mono).foregroundStyle(Theme.ink3)
                Text(record.host).font(Theme.mono).foregroundStyle(Theme.ink3).lineLimit(1)
                EngineBadge(engine: record.engine.rawValue)
                if let project = record.project {
                    Text(project).font(.caption).foregroundStyle(Theme.ink2).lineLimit(1).truncationMode(.middle)
                        .help(record.cwd ?? project)
                }
                if let via = record.via, !via.label.isEmpty {
                    Text(record.from.map { "from \($0)" } ?? via.label).font(.caption).foregroundStyle(Theme.ink4).lineLimit(1)
                }
                if record.source != nil {
                    Image(systemName: "externaldrive").font(.caption2).foregroundStyle(Theme.ink4)
                        .help("From a sink's copy: this host did not answer")
                        .accessibilityLabel("from a sink copy")
                }
                Spacer(minLength: 0)
            }
            Text(verbatim: record.text)
                .font(.callout).foregroundStyle(Theme.ink)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(isSelected ? Theme.wash(Theme.steel) : (hovering ? Theme.bg3 : Color.clear)))
        .overlay {
            if isSelected { RoundedRectangle(cornerRadius: 6).stroke(Theme.steel, lineWidth: 1) }
        }
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(record.engine.rawValue) on \(record.host), \(PromptsModel.time(record.ts.date)): \(record.firstLine(max: 200))")
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }
}

/// The engine as a small monospaced capsule (claude, codex, hermes, ...).
struct EngineBadge: View {
    let engine: String
    var body: some View {
        Text(engine)
            .font(Theme.monoSmall)
            .foregroundStyle(Theme.ink2)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(Capsule().fill(Theme.bg4))
            .accessibilityLabel(engine)
    }
}

/// A prompt in the detail column: the whole text, verbatim and selectable (never Markdown), Copy, Open session when
/// that session is on the board, and where and when it was typed.
struct PromptDetailView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let r = model.prompts.selected {
            let strip = model.prompts.session(for: r)
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .center, spacing: 8) {
                    EngineBadge(engine: r.engine.rawValue)
                    Text(r.project ?? r.host).font(Theme.titleFont(20)).foregroundStyle(Theme.ink).lineLimit(1)
                    Spacer()
                    Button("Copy") { model.prompts.copy(r) }
                        .help("Copy the prompt (Command C in the list)")
                    Button("Open session") { model.prompts.openSession(r) }
                        .disabled(strip == nil)
                        .help(strip.map { "Open \($0.name) on the board" } ?? "That session is not on the board now")
                }
                .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 10)
                Divider().overlay(Theme.line)
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        Text(verbatim: r.text)
                            .font(Theme.monoBody)
                            .foregroundStyle(Theme.ink)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                            .background(RoundedRectangle(cornerRadius: 6).fill(Theme.bg2))
                            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.line, lineWidth: 1))
                            .accessibilityLabel("The prompt, verbatim")
                        facts(r, strip: strip)
                    }
                    .padding(16)
                }
            }
            .background(Theme.bg)
        } else {
            ContentUnavailableView("Pick a prompt", systemImage: "text.bubble",
                                   description: Text("Choose one to read it whole. j and k move, Command F searches, Command C copies."))
                .background(Theme.bg)
        }
    }

    private func facts(_ r: PromptRecord, strip: SessionItem?) -> some View {
        let rows: [(String, String?)] = [
            ("When", "\(r.ts.date.formatted(date: .abbreviated, time: .standard)) (\(PromptsStatus.ago(r.ts.date)) ago)"),
            ("Host", r.host + (r.route.map { $0 == r.host ? "" : " (\($0))" } ?? "")),
            ("Engine", r.engine.rawValue),
            ("Folder", r.cwd),
            ("Label", r.label),
            ("Came", r.via.map { $0.label.isEmpty ? "typed" : $0.label } .map { v in r.from.map { "\(v), from \($0)" } ?? v }),
            ("Session", r.session.map { s in strip.map { "\($0.name) · \(s)" } ?? s }),
            ("Source", r.source),
            ("Id", r.id),
        ]
        return Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 12, verticalSpacing: 4) {
            ForEach(rows.filter { $0.1 != nil }, id: \.0) { row in
                GridRow {
                    Text(row.0).font(.caption).foregroundStyle(Theme.ink3)
                    Text(verbatim: row.1 ?? "").font(Theme.mono).foregroundStyle(Theme.ink2).textSelection(.enabled)
                }
            }
        }
    }
}
