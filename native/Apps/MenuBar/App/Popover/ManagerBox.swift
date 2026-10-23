import SwiftUI

/// The fleet manager, front and center at the top of the popover: ask it something (Enter sends, the reply
/// streams in), quick prompts, Sweep now, and Open manager for the full conversation.
struct ManagerBox: View {
    let store: MenuBarStore
    let actions: PopoverActions

    @State private var draft = ""
    @State private var expanded = false
    @State private var note: String?
    @State private var noteIsError = false
    @State private var sweeping = false
    @FocusState private var fieldFocused: Bool

    static let quickPrompts = ["Who is waiting on me?", "What finished?"]

    var body: some View {
        if let manager = store.summary?.manager {
            VStack(alignment: .leading, spacing: 7) {
                header(manager)
                if !manager.up {
                    Text("The manager is not running. Open it to see its status.")
                        .font(.callout)
                        .foregroundStyle(Theme.secondaryText)
                } else if !store.canAct {
                    Text("Add the main token in Settings to talk to the manager.")
                        .font(.callout)
                        .foregroundStyle(Theme.secondaryText)
                } else {
                    exchange
                    input
                    prompts
                }
                if let note {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(noteIsError ? Theme.error : Theme.idle)
                        .accessibilityAddTraits(.updatesFrequently)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.surface))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.manager.opacity(0.45)))
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Manager")
        }
    }

    // MARK: Parts

    private func header(_ manager: ManagerState) -> some View {
        HStack(spacing: 6) {
            Circle().fill(manager.up ? Theme.manager : Theme.error).frame(width: 7, height: 7).accessibilityHidden(true)
            Text("Manager").font(.subheadline.weight(.semibold))
            if let host = manager.opHost {
                Text(host).font(Theme.mono).foregroundStyle(Theme.secondaryText)
            }
            if store.manager.busy {
                ProgressView().controlSize(.mini)
                Text(statusText).font(.caption).foregroundStyle(Theme.manager)
            } else if !manager.up {
                Text("down").font(.caption).foregroundStyle(Theme.error)
            }
            Spacer(minLength: 4)
            Button("Open manager") { actions.openManager() }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .help("Open the full conversation with the manager")
        }
        .accessibilityElement(children: .combine)
    }

    private var statusText: String {
        switch store.manager.reply?.phase {
        case .streaming: "writing"
        default: store.manager.sending ? "sending" : "thinking"
        }
    }

    @ViewBuilder
    private var exchange: some View {
        let chat = store.manager
        if !chat.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                if let q = chat.question {
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text(store.asker(q).map { "\($0):" } ?? "You:")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Theme.secondaryText)
                        Text(q.text)
                            .font(.caption)
                            .foregroundStyle(Theme.secondaryText)
                            .lineLimit(2)
                    }
                    .accessibilityElement(children: .combine)
                }
                if let r = chat.reply {
                    reply(r)
                }
            }
        }
    }

    @ViewBuilder
    private func reply(_ r: ManagerReply) -> some View {
        switch r.phase {
        case .failed(let message):
            Text("Not answered: \(message)")
                .font(.callout)
                .foregroundStyle(Theme.error)
                .fixedSize(horizontal: false, vertical: true)
        case .waiting where r.text.isEmpty:
            Text("Thinking\u{2026}").font(.callout).foregroundStyle(Theme.secondaryText)
        default:
            VStack(alignment: .leading, spacing: 2) {
                Text(Self.markdown(r.phase == .streaming ? Self.trailingEllipsis(r.text) : r.text))
                    .font(.callout)
                    .foregroundStyle(Theme.text)
                    .lineLimit(expanded ? 16 : 5)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .accessibilityLabel("Manager: \(r.text)")
                if r.text.count > 240 || r.text.filter({ $0 == "\n" }).count > 4 {
                    Button(expanded ? "Less" : "More") { expanded.toggle() }
                        .buttonStyle(.borderless)
                        .controlSize(.small)
                        .font(.caption)
                }
            }
        }
    }

    private var input: some View {
        HStack(spacing: 6) {
            TextField("Ask the manager", text: $draft)
                .textFieldStyle(.roundedBorder)
                .focused($fieldFocused)
                .onSubmit { ask(draft) }
                .accessibilityLabel("Ask the manager")
            if store.manager.sending {
                ProgressView().controlSize(.small).accessibilityLabel("Sending")
            } else {
                Button("Ask") { ask(draft) }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    private var prompts: some View {
        FlowLayout(spacing: 6, lineSpacing: 6) {
            ForEach(Self.quickPrompts, id: \.self) { p in
                Button(p) { ask(p) }
                    .disabled(store.manager.sending)
                    .help("Ask the manager: \(p)")
            }
            Button { sweep() } label: { Label("Sweep now", systemImage: "arrow.triangle.2.circlepath") }
                .disabled(sweeping)
                .help("Ask the manager to sweep the fleet now")
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
    }

    // MARK: Actions

    @MainActor
    private func ask(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !store.manager.sending else { return }
        if trimmed == draft.trimmingCharacters(in: .whitespacesAndNewlines) { draft = "" }
        expanded = false
        note = nil
        Task { await store.askManager(trimmed) }
    }

    @MainActor
    private func sweep() {
        sweeping = true
        Task {
            do {
                try await store.sweepManager()
                show("Sweep requested. The manager's notes land in its feed.", isError: false)
            } catch {
                show((error as? DroverError)?.userMessage ?? "That did not work.", isError: true)
            }
            sweeping = false
        }
    }

    @MainActor
    private func show(_ text: String, isError: Bool) {
        note = text
        noteIsError = isError
        Task {
            try? await Task.sleep(for: .seconds(4))
            if note == text { note = nil }
        }
    }

    /// The text so far, then an ellipsis: the reply is still being written.
    static func trailingEllipsis(_ s: String) -> String {
        // A loop, not the regex \s+$, which ICU retries from every blank of a run with text after it (20K blanks: 5 s).
        var cut = Substring(s)
        while let last = cut.last, last.isWhitespace { cut = cut.dropLast() }
        let t = String(cut)
        return t.isEmpty ? "\u{2026}" : t + " \u{2026}"
    }

    /// Inline Markdown (bold, code, links) with line breaks kept; plain text when it does not parse.
    static func markdown(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(s)
    }
}
