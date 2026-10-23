import SwiftUI

/// The manager's chat: in the main window's detail column, and (compact) in the floating panel. Status, thread picker,
/// the conversation with its streaming reply, quick prompts, and a composer that sends with `wait: false`.
struct ManagerView: View {
    /// The floating panel: a tighter header, no "open in panel" button.
    var compact = false
    @Environment(AppModel.self) private var model
    @State private var newThread = ""
    @State private var addingThread = false

    var body: some View {
        let m = model.manager
        VStack(spacing: 0) {
            header(m)
            Divider().overlay(Theme.line)
            if let err = m.error {
                Text(err).font(.callout).foregroundStyle(Theme.brick)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(Theme.wash(Theme.brick))
            }
            ChatTranscriptView(rows: m.rows, working: m.isBusy && !m.items.contains(where: Self.isStreaming),
                               workingLabel: "The manager is answering",
                               emptyText: m.isLoading ? "Loading" : "Ask the manager about the fleet: who waits on you, what finished, what each machine is doing.",
                               resetKey: m.thread)
            Divider().overlay(Theme.line)
            quickPrompts(m)
            ManagerComposer(compact: compact)
        }
        .background(Theme.bg)
        .task(id: m.loadKey) { await m.refreshIfStale() }
    }

    private static func isStreaming(_ item: ChatItem) -> Bool {
        if case .text(let t) = item { return t.pending }
        return false
    }

    private func header(_ m: ManagerModel) -> some View {
        let color = m.isBusy ? Theme.steel : m.isUp ? Theme.lilac : Theme.ink4
        return HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Manager").font(Theme.titleFont(compact ? 17 : 20)).foregroundStyle(Theme.ink)
                HStack(spacing: 6) {
                    StateDot(color: color)
                    Text(m.statusText).font(.caption).foregroundStyle(Theme.ink3)
                    if let host = m.host { Text("· \(host)").font(Theme.mono).foregroundStyle(Theme.ink4) }
                }
            }
            .padding(.leading, compact ? 64 : 0)   // clear of the panel's window buttons
            Spacer(minLength: 8)
            threadPicker(m)
            if !compact {
                Button { WindowRouter.shared.toggleManagerPanel() } label: { Image(systemName: "macwindow.on.rectangle") }
                    .help("Floating manager panel (Shift Command M)")
                    .accessibilityLabel("Floating manager panel")
            } else {
                Button {
                    model.showManagerInWindow()
                    WindowRouter.shared.showMain()
                } label: { Image(systemName: "arrow.up.left.and.arrow.down.right") }
                    .help("Open the manager in the main window")
                    .accessibilityLabel("Open in the main window")
            }
        }
        .buttonStyle(.borderless)
        .padding(.horizontal, 16).padding(.top, compact ? 8 : 14).padding(.bottom, 10)
    }

    private func threadPicker(_ m: ManagerModel) -> some View {
        Menu {
            ForEach(m.threads.isEmpty ? [ManagerThread(thread: "main", turns: 0)] : m.threads) { t in
                Button {
                    m.switchThread(t.thread)
                } label: {
                    Text(t.thread == m.thread ? "✓ \(t.thread)" : t.thread)
                    if let last = t.lastText, !last.isEmpty { Text(last) }
                }
            }
            if m.threadsSupported {
                Divider()
                Button("New thread") { newThread = ""; addingThread = true }
            }
        } label: {
            Label(m.thread, systemImage: "bubble.left.and.bubble.right")
                .font(.callout)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("Conversation: main is shared by every client")
        .popover(isPresented: $addingThread, arrowEdge: .bottom) {
            VStack(alignment: .leading, spacing: 8) {
                Text("New thread").font(.headline)
                TextField("Name, for example release", text: $newThread)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 240)
                    .onSubmit(createThread)
                let valid = ManagerModel.isValidThread(newThread)
                Text(valid || newThread.isEmpty ? "Letters, digits and _ . : @ % -, up to 64." : "That name has characters a thread cannot have.")
                    .font(.caption).foregroundStyle(valid || newThread.isEmpty ? Theme.ink3 : Theme.brick)
                HStack {
                    Spacer()
                    Button("Cancel") { addingThread = false }
                    Button("Start") { createThread() }.keyboardShortcut(.defaultAction).disabled(!valid)
                }
            }
            .padding(14)
        }
    }

    private func createThread() {
        guard ManagerModel.isValidThread(newThread) else { return }
        model.manager.switchThread(newThread)
        addingThread = false
    }

    private func quickPrompts(_ m: ManagerModel) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            FlowLayout(spacing: 6) {
                ForEach(ManagerModel.quickPrompts, id: \.title) { p in
                    Button(p.title) { m.send(p.text) }
                        .buttonStyle(QuickPromptStyle())
                        .help("Ask: \(p.text)")
                }
                Button { m.sweep() } label: {
                    HStack(spacing: 4) {
                        if m.sweeping { ProgressView().controlSize(.mini) }
                        Text("Sweep now")
                    }
                }
                .buttonStyle(QuickPromptStyle())
                .disabled(m.sweeping)
                .help("The manager looks over the fleet now (openclaw.sweep)")
            }
            if let note = m.notice {
                Text(note).font(.caption).foregroundStyle(note.hasPrefix("Sweep failed") ? Theme.brick : Theme.ink3).lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12).padding(.top, 8)
    }
}

struct QuickPromptStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.caption)
            .foregroundStyle(enabled ? Theme.ink2 : Theme.ink4)
            .padding(.horizontal, 9).padding(.vertical, 4)
            .background(Capsule().fill(configuration.isPressed ? Theme.bg4 : Theme.bg2))
            .overlay(Capsule().strokeBorder(Theme.lilac.opacity(0.45), lineWidth: 1))
            .contentShape(Capsule())
    }
}

/// The manager's composer: Return sends, Shift-Return adds a line.
struct ManagerComposer: View {
    var compact = false
    @Environment(AppModel.self) private var model
    @FocusState private var focused: Bool

    var body: some View {
        @Bindable var m = model.manager
        HStack(alignment: .bottom, spacing: 8) {
            ZStack(alignment: .topLeading) {
                TextEditor(text: $m.draft)
                    .font(.body)
                    .scrollContentBackground(.hidden)
                    .focused($focused)
                    .padding(.horizontal, 4).padding(.vertical, 4)
                    .onKeyPress(.return, phases: .down) { press in
                        if press.modifiers.contains(.shift) { return .ignored }
                        send()
                        return .handled
                    }
                    .onKeyPress(.escape) {
                        focused = false
                        return .handled
                    }
                if m.draft.isEmpty {
                    Text("Message the manager")
                        .foregroundStyle(Theme.ink4)
                        .padding(.horizontal, 9).padding(.vertical, 4)
                        .allowsHitTesting(false)
                }
            }
            .frame(height: editorHeight(m.draft))
            .background(Theme.bg2, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(focused ? Theme.lilac.opacity(0.7) : Theme.line, lineWidth: 1))
            Button { send() } label: { Image(systemName: "paperplane.fill") }
                .buttonStyle(.bordered)
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(m.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .help("Send (Return)")
                .accessibilityLabel("Send to the manager")
        }
        .padding(12)
        .onChange(of: model.manager.focusRequest) { _, _ in focused = true }
        .onAppear { if compact { focused = true } }
    }

    private func editorHeight(_ text: String) -> CGFloat {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).count
        return min(140, max(40, CGFloat(lines) * 20 + 12))
    }

    private func send() {
        let m = model.manager
        let text = m.draft
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        m.draft = ""
        m.send(text)
    }
}
