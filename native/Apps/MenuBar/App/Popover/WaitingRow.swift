import SwiftUI

/// One session waiting on you: the question, then what answers it. A dialog gets one button per key the
/// daemon listed (each option with its label, then Enter and Esc), pressed with `sessions.answer` on the
/// screen the row shows; a question asked in text gets Reply. A daemon from before dialog keys gets Open and
/// Reply only: there are no fixed chips, since a key the dialog does not take presses nothing.
struct WaitingRow: View {
    let item: WaitingItem
    let store: MenuBarStore
    let actions: PopoverActions

    @State private var replying = false
    @State private var text = ""
    @State private var sending = false
    @State private var errorText: String?
    @FocusState private var fieldFocused: Bool

    private var icon: String {
        switch item.kind {
        case .decision: "checklist"
        case .question: "questionmark.bubble"
        default: "bell"
        }
    }

    private var age: String? {
        guard let d = item.sinceDate else { return nil }
        return RelativeDateTimeFormatter().localizedString(for: d, relativeTo: Date())
    }

    var body: some View {
        if let approval = item.approval {
            // One view per request: the bot's next request starts afresh, and a press on the last one's buttons ends with it.
            ApprovalRow(item: item, approval: approval, store: store, actions: actions).id(approval.id)
        } else {
            sessionRow
        }
    }

    @ViewBuilder
    private var sessionRow: some View {
        let plan = store.answerPlan(for: item)
        let state = store.answerState(for: item)
        let awaiting = store.isAwaitingScreen(item)
        VStack(alignment: .leading, spacing: 6) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: icon)
                        .foregroundStyle(Theme.waiting)
                        .accessibilityHidden(true)
                    Text(item.name).foregroundStyle(Theme.text)
                    Spacer(minLength: 4)
                    if let age {
                        Text(age).font(.caption).foregroundStyle(Theme.secondaryText)
                    }
                }
                Text("\(item.host) \u{00B7} \(item.engine)")
                    .font(Theme.mono)
                    .foregroundStyle(Theme.secondaryText)
                Text(question(plan))
                    .font(.callout)
                    .foregroundStyle(Theme.text)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)

            if case .keys(_, let buttons) = plan, !awaiting {
                FlowLayout(spacing: 6, lineSpacing: 6) {
                    ForEach(buttons) { b in keyButton(b, pressing: state?.pressing) }
                }
                .help(store.canAct ? "" : "Add the main token in Settings to answer.")
            }

            HStack(spacing: 6) {
                Button("Open") { actions.openWaiting(item) }
                    .help("Open \(item.name)")
                if offersReply(plan) {
                    Button(replying ? "Cancel" : "Reply") { toggleReply() }
                        .disabled(!store.canAct)
                        .help(store.canAct ? "Reply to \(item.name)" : "Add the main token in Settings to reply.")
                }
                Spacer(minLength: 4)
                if let pressing = state?.pressing {
                    ProgressView().controlSize(.small)
                    Text("Sending \(AnswerOutcome.keyName(pressing))")
                        .font(.caption)
                        .foregroundStyle(Theme.secondaryText)
                }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)

            if replying {
                HStack(spacing: 6) {
                    TextField("Reply to \(item.name)", text: $text)
                        .textFieldStyle(.roundedBorder)
                        .focused($fieldFocused)
                        .disabled(sending || !store.canAct)
                        .onSubmit { send(text) }
                        .onExitCommand { collapse() }
                    if sending {
                        ProgressView().controlSize(.small)
                            .accessibilityLabel("Sending")
                    } else {
                        Button("Send") { send(text) }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                            .disabled(!store.canAct || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }

            if let message = state?.message {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(state?.isError == true ? Theme.error : Theme.idle)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.updatesFrequently)
            } else if let errorText {
                Text(errorText).font(.caption).foregroundStyle(Theme.error)
            }
        }
        .padding(.vertical, 6)
    }

    private func question(_ plan: AnswerPlan) -> String {
        if case .keys(let q?, _) = plan, !q.isEmpty { return q }
        return item.headline
    }

    /// A dialog answers to keys; a question in text, or a row without keys (older daemon), takes a reply.
    private func offersReply(_ plan: AnswerPlan) -> Bool {
        if case .keys = plan { return false }
        return true
    }

    private func keyButton(_ b: AnswerButton, pressing: String?) -> some View {
        Button { press(b.key) } label: {
            HStack(spacing: 3) {
                if b.selected {
                    // Claude Code's highlight marker: the option Enter picks.
                    Text("\u{203A}").fontWeight(.bold).accessibilityHidden(true)
                }
                Text(b.title).fontWeight(b.selected ? .semibold : .regular).lineLimit(1)
            }
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .disabled(!store.canAct || pressing != nil)
        .help(b.help)
        .accessibilityLabel(b.accessibilityLabel)
        .accessibilityValue(b.selected ? "highlighted" : "")
    }

    @MainActor
    private func press(_ key: String) {
        Task { await store.answer(item, key: key) }
    }

    @MainActor
    private func toggleReply() {
        if replying { collapse() } else {
            replying = true
            fieldFocused = true
        }
    }

    @MainActor
    private func collapse() {
        replying = false
        errorText = nil
    }

    @MainActor
    private func send(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !sending, store.canAct else { return }
        sending = true
        errorText = nil
        Task {
            do {
                try await store.reply(to: item, text: trimmed)
                text = ""
                replying = false
            } catch {
                errorText = (error as? DroverError)?.userMessage ?? "Could not send."
            }
            sending = false
        }
    }
}
