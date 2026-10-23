import SwiftUI

/// Answer a session's dialog from here: the question, one button per option (the highlighted one marked), Enter and
/// Esc. One click presses that key at once (`sessions.answer` with the screen hash the buttons were drawn from), and
/// the card then follows the screen (AppModel.answer): the next question, a review screen, or nothing. A "Type
/// something" option opens a field for the text once its press took, for as long as that question is up.
///
/// Styles: `.card` at the bottom of Chat, `.bar` above Screen's pane, `.inline` in a board row.
struct DialogAnswerView: View {
    enum Style { case card, bar, inline }

    let session: SessionItem
    var style: Style = .card
    @Environment(AppModel.self) private var model
    @State private var freeText = ""
    @FocusState private var fieldFocused: Bool
    /// A "Type something" option was picked: the field stays until the text is sent or the question is gone.
    private var typing: Bool { model.typingAnswer[session.key] != nil }

    /// The freshest reading of the screen (a capture or a refusal), else the board's.
    private var state: DialogState? { model.dialogState(session) }
    private var dialog: DialogInfo? { state?.dialog }
    private var held: Bool { state?.held ?? session.held }
    private var expect: String? { state?.hash }
    private var buttons: [AnswerButton] {
        DialogKeys.buttons(dialog: dialog, keys: state?.keys ?? [], held: held)
    }
    private var pressing: String? { model.answering[session.key] }
    private var notice: AnswerNote? { model.answerNotice[session.key] }

    private var title: String {
        if held { return "Held message" + (session.heldFrom.map { " from \($0)" } ?? "") }
        return session.askLabel.map { $0.prefix(1).uppercased() + $0.dropFirst() } ?? "Waiting on you"
    }
    private var question: String? {
        let q = dialog?.question ?? session.askText
        return q?.isEmpty == false ? q : nil
    }

    var body: some View {
        switch style {
        case .card: card
        case .bar: bar
        case .inline: inline
        }
    }

    // MARK: styles

    private var card: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: held ? "envelope.badge" : "hand.raised")
                    .foregroundStyle(Theme.amber)
                    .accessibilityHidden(true)
                Text(title).font(.headline).foregroundStyle(Theme.ink)
                Spacer()
                if pressing != nil { ProgressView().controlSize(.small) }
            }
            if let question {
                Text(question).foregroundStyle(Theme.ink).textSelection(.enabled).lineLimit(6)
            }
            let options = buttons.filter { $0.kind == .option }
            if !options.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(options) { b in optionRow(b) }
                }
            }
            if typing { freeTextField }
            HStack(spacing: 8) {
                ForEach(buttons.filter { $0.kind != .option }) { b in
                    Button { press(b) } label: { Text(b.label).frame(minWidth: 44) }
                        .buttonStyle(AnswerButtonStyle(kind: b.kind, selected: false))
                        .disabled(pressing != nil)
                        .help(help(b))
                }
                Spacer(minLength: 0)
            }
            if let notice { noticeText(notice) }
        }
        .padding(12)
        .background(Theme.wash(Theme.amber), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.amber.opacity(0.55), lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(title). \(question ?? "")")
    }

    private func optionRow(_ b: AnswerButton) -> some View {
        Button { press(b) } label: {
            HStack(spacing: 8) {
                Text(b.label).multilineTextAlignment(.leading).lineLimit(3)
                Spacer(minLength: 4)
                if b.selected {
                    Text("Enter").font(.caption).foregroundStyle(Theme.ink3)
                }
                if pressing == b.key { ProgressView().controlSize(.mini) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(AnswerButtonStyle(kind: .option, selected: b.selected, fill: true))
        .disabled(pressing != nil)
        .help(help(b))
        .accessibilityLabel(b.selected ? "\(b.label), highlighted" : b.label)
    }

    private var bar: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: held ? "envelope.badge" : "hand.raised").foregroundStyle(Theme.amber).accessibilityHidden(true)
                Text(question ?? title).font(.callout.weight(.medium)).foregroundStyle(Theme.ink).lineLimit(2)
                Spacer(minLength: 4)
                if pressing != nil { ProgressView().controlSize(.small) }
            }
            FlowLayout(spacing: 6) {
                ForEach(buttons) { b in
                    Button(short(b, max: 42)) { press(b) }
                        .buttonStyle(AnswerButtonStyle(kind: b.kind, selected: b.selected))
                        .disabled(pressing != nil)
                        .help(help(b))
                }
            }
            if typing { freeTextField }
            if let notice { noticeText(notice) }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Theme.wash(Theme.amber))
    }

    private var inline: some View {
        VStack(alignment: .leading, spacing: 4) {
            FlowLayout(spacing: 5) {
                ForEach(buttons) { b in
                    Button(short(b, max: 22)) { press(b) }
                        .buttonStyle(AnswerButtonStyle(kind: b.kind, selected: b.selected, compact: true))
                        .disabled(pressing != nil)
                        .help(help(b))
                }
            }
            if typing { freeTextField }
            if let notice { noticeText(notice).font(.caption) }
        }
    }

    private func noticeText(_ n: AnswerNote) -> some View {
        Text(n.text).font(.callout).foregroundStyle(n.isError ? Theme.brick : Theme.ink3).textSelection(.enabled).lineLimit(4)
    }

    /// The answer for a "Type something" option, typed into the dialog's own field.
    private var freeTextField: some View {
        HStack(spacing: 8) {
            TextField("Your answer", text: $freeText)
                .textFieldStyle(.roundedBorder)
                .focused($fieldFocused)
                .onSubmit(sendFreeText)
            Button("Send", action: sendFreeText)
                .disabled(freeText.trimmingCharacters(in: .whitespaces).isEmpty)
            Button { model.typingAnswer[session.key] = nil; freeText = "" } label: { Image(systemName: "xmark") }
                .buttonStyle(.borderless).help("Never mind")
        }
        .onAppear { fieldFocused = true }
    }

    private func sendFreeText() {
        let text = freeText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let s = session
        freeText = ""
        Task { await model.sendFreeText(s, text: text) }
    }

    private func short(_ b: AnswerButton, max: Int) -> String {
        b.label.count > max ? String(b.label.prefix(max - 1)) + "…" : b.label
    }

    private func help(_ b: AnswerButton) -> String {
        switch b.kind {
        case .option: "Pick \(b.label) on this dialog (only if it is still the one shown)"
        case .confirm: b.key == "Enter" ? "Press Enter: picks the highlighted option" : "Press \(b.key)"
        case .cancel: b.key == "Escape" ? "Press Escape: cancels the dialog" : "Press \(b.key)"
        case .other: "Press \(b.label)"
        }
    }

    private func press(_ b: AnswerButton) {
        let s = session, expect = self.expect
        Task { await model.answer(s, key: b.key, expect: expect) }
    }
}

struct AnswerButtonStyle: ButtonStyle {
    var kind: AnswerButton.Kind
    var selected: Bool
    var fill = false
    var compact = false
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        let tint: Color = selected ? Theme.amber : (kind == .confirm ? Theme.steel : Theme.ink3)
        configuration.label
            .font(compact ? .caption : .callout)
            .foregroundStyle(enabled ? Theme.ink : Theme.ink4)
            .padding(.horizontal, compact ? 7 : 10).padding(.vertical, compact ? 3 : 5)
            .frame(maxWidth: fill ? .infinity : nil, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 6).fill(configuration.isPressed ? Theme.bg4 : (selected ? Theme.wash(Theme.amber) : Theme.bg2)))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(tint.opacity(selected ? 0.9 : 0.45), lineWidth: selected ? 1.5 : 1))
            .contentShape(RoundedRectangle(cornerRadius: 6))
    }
}

/// Lays children out left to right, wrapping to new lines.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > 0 && x + s.width > width { y += line + spacing; x = 0; line = 0 }
            x += s.width + spacing
            line = max(line, s.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: min(widest, width), height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > bounds.minX && x + s.width > bounds.maxX { y += line + spacing; x = bounds.minX; line = 0 }
            v.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
            x += s.width + spacing
            line = max(line, s.height)
        }
    }
}
