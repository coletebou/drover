import SwiftUI

/// A Grok bot's approval request in the waiting list: what it asks for (the bot's own words, shown as plain text in
/// full and never acted on), who asks, and how to answer. One click answers only words shown whole (a `complete`
/// payload); otherwise Review loads the whole request (`GET /api/approvals?id=`) and the row answers from that. A press
/// answers by id (`POST /api/approvals/answer`, via menubar); the outcome shows above the list, since a decided request
/// leaves it. No Reply: a message would go to the bot instead of answering the request.
struct ApprovalRow: View {
    let item: WaitingItem
    let approval: ApprovalInfo
    let store: MenuBarStore
    let actions: PopoverActions

    private var age: String? {
        guard let d = item.sinceDate else { return nil }
        return RelativeDateTimeFormatter().localizedString(for: d, relativeTo: Date())
    }

    /// The words on show: the whole request once reviewed, else the summary's.
    private var shown: ApprovalInfo {
        if case .loaded(let full)? = store.approvalReviews[approval.id] { return full }
        return approval
    }

    var body: some View {
        let pressing = store.approvalPressing[approval.id]
        let mode = store.approvalMode(for: item) ?? .review
        VStack(alignment: .leading, spacing: 6) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "checkmark.seal")
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
                Text(ApprovalFormat.heading(kind: shown.kind))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.waiting)
                // String values, never literals: Text does not read them as Markdown, so the bot's words stay plain.
                // In full: a click answers what is on show.
                Text(shown.question.isEmpty ? item.headline : shown.question)
                    .font(.callout)
                    .foregroundStyle(Theme.text)
                    .fixedSize(horizontal: false, vertical: true)
                if let details = shown.details {
                    Text(details)
                        .font(.caption)
                        .foregroundStyle(Theme.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .combine)

            switch mode {
            case .blocked(let why), .closed(let why):
                Text(why).font(.caption).foregroundStyle(Theme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            case .review:
                reviewPrompt
            case .answer(let request):
                // One button per option, each label whole: they wrap, never cut.
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(request.options) { option in optionButton(option, pressing: pressing) }
                }
            }

            Text(ApprovalFormat.note(botName: item.botName, expiresAt: shown.expiresDate,
                                     more: item.moreApprovals ?? 0, now: Date()))
                .font(.caption)
                .foregroundStyle(Theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 6) {
                Button("Open") { actions.openWaiting(item) }
                    .help("Open \(item.name)")
                Spacer(minLength: 4)
                if let pressing, let option = shown.options.first(where: { $0.n == pressing }) {
                    ProgressView().controlSize(.small)
                    Text("Sending \(ApprovalFormat.title(option))")
                        .font(.caption)
                        .foregroundStyle(Theme.secondaryText)
                        .lineLimit(1)
                }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(.vertical, 6)
    }

    /// Shortened words: say so, and load the whole request.
    @ViewBuilder private var reviewPrompt: some View {
        let review = store.approvalReviews[approval.id]
        VStack(alignment: .leading, spacing: 4) {
            Text(ApprovalFormat.reviewNote).font(.caption).foregroundStyle(Theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            if case .failed(let why)? = review {
                Text(why).font(.caption).foregroundStyle(Theme.error).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 6) {
                Button("Review the request") { Task { await store.reviewApproval(item) } }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(review == .loading)
                    .help("Load the whole request from Drover, then answer it")
                if review == .loading { ProgressView().controlSize(.small) }
            }
        }
    }

    private func optionButton(_ option: ApprovalOption, pressing: Int?) -> some View {
        let title = ApprovalFormat.title(option)
        return Button { Task { await store.answerApproval(item, choice: option.n) } } label: {
            Text(title).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .disabled(pressing != nil)
        .help("Answer \(title): \(item.botName ?? "the bot") is told at once")
        .accessibilityLabel("Answer \(title)")
    }
}

/// What the last approval answer came to, above the waiting list.
struct ApprovalNoticeLine: View {
    let notice: ApprovalNotice
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: notice.isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .foregroundStyle(notice.isError ? Theme.error : Theme.idle)
                .accessibilityHidden(true)
            Text(notice.text)
                .font(.caption)
                .foregroundStyle(Theme.text)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            Button(action: dismiss) { Image(systemName: "xmark") }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .accessibilityLabel("Dismiss")
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill((notice.isError ? Theme.error : Theme.idle).opacity(0.12)))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.updatesFrequently)
    }
}
