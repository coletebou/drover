import SwiftUI

/// Answer a Grok bot's approval request from here: what it asks for (the bot's own words, shown as plain text and never
/// acted on), who asks, and how to answer. One click answers only words shown whole: a payload the daemon marks
/// `complete`, its question unclipped (ApprovalFormat.showsWhole) and its details on show in full. Otherwise Review loads
/// the whole request (`GET /api/approvals?id=`) and the card answers from that. A press answers by id (`POST
/// /api/approvals/answer`, via mac, AppModel.answerApproval); the board then drops the card or shows the bot's next
/// request. Never a reply: a message would go to the bot instead of answering the request.
///
/// Styles: `.card` at the bottom of Chat (question and details in full), `.inline` in a board row (no details: a row
/// with details reviews in the chat).
struct ApprovalAnswerView: View {
    enum Style { case card, inline }

    let session: SessionItem
    let approval: ApprovalInfo
    var style: Style = .card
    @Environment(AppModel.self) private var model

    private var pressing: String? { model.answering[session.key] }
    private var notice: AnswerNote? { model.answerNotice[session.key] }
    private var botName: String? { ApprovalFormat.botName(bot: approval.bot, fallback: session.name) }
    private var review: ApprovalReview? { model.approvalReviews[approval.id] }
    /// The words on show: the whole request once reviewed, else the board's.
    private var shown: ApprovalInfo { if case .loaded(let full)? = review { full } else { approval } }
    private var detailsShown: Bool { style == .card }
    private var mode: ApprovalCardMode {
        model.approvalMode(for: session, detailsShown: detailsShown) ?? .review
    }

    var body: some View {
        switch style {
        case .card: card
        case .inline: inline
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "checkmark.seal").foregroundStyle(Theme.amber).accessibilityHidden(true)
                Text(ApprovalFormat.heading(kind: shown.kind)).font(.headline).foregroundStyle(Theme.ink)
                Spacer()
                if pressing != nil || review == .loading { ProgressView().controlSize(.small) }
            }
            // String values: Text shows them as they are, never as Markdown. In full: a click answers what is on show.
            Text(shown.question.isEmpty ? (session.headline ?? "") : shown.question)
                .foregroundStyle(Theme.ink).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            if let details = shown.details {
                Text(details).font(.callout).foregroundStyle(Theme.ink2).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            answers(compact: false)
            noteText.font(.caption)
            if let notice { noticeText(notice) }
        }
        .padding(12)
        .background(Theme.wash(Theme.amber), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.amber.opacity(0.55), lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(ApprovalFormat.heading(kind: shown.kind)), asked by \(ApprovalFormat.askedBy(botName))")
    }

    private var inline: some View {
        VStack(alignment: .leading, spacing: 4) {
            answers(compact: true)
            noteText.font(.caption2).fixedSize(horizontal: false, vertical: true)
            if let notice { noticeText(notice).font(.caption) }
        }
    }

    @ViewBuilder
    private func answers(compact: Bool) -> some View {
        switch mode {
        case .blocked(let why), .closed(let why):
            Text(why).font(compact ? .caption : .callout).foregroundStyle(Theme.ink3).fixedSize(horizontal: false, vertical: true)
        case .review:
            reviewPrompt(compact: compact)
        case .answer(let request):
            // One button per option, each label whole: they wrap, never cut.
            VStack(alignment: .leading, spacing: compact ? 4 : 5) {
                ForEach(request.options) { option in optionRow(option, compact: compact) }
            }
        }
    }

    @ViewBuilder
    private func reviewPrompt(compact: Bool) -> some View {
        // A row holds back a whole request only for its details, which the chat shows; anything else may be shortened.
        let why = style == .inline && ApprovalFormat.showsWhole(approval) && approval.details != nil
            ? ApprovalFormat.detailsInChatNote : ApprovalFormat.reviewNote
        VStack(alignment: .leading, spacing: 5) {
            Text(why).font(compact ? .caption : .callout).foregroundStyle(Theme.ink3)
                .fixedSize(horizontal: false, vertical: true)
            if case .failed(let why)? = review {
                Text(why).font(.caption).foregroundStyle(Theme.brick).fixedSize(horizontal: false, vertical: true)
            }
            Button("Review the request") {
                let s = session
                if style == .inline {
                    // The chat shows the whole request with its details: review it there.
                    model.select(s)
                }
                Task { await model.reviewApproval(s) }
            }
            .buttonStyle(AnswerButtonStyle(kind: .confirm, selected: false, compact: compact))
            .disabled(review == .loading)
            .help("Load the whole request from Drover, then answer it")
        }
    }

    private func optionRow(_ option: ApprovalOption, compact: Bool) -> some View {
        let title = ApprovalFormat.title(option)
        return Button { press(option) } label: {
            HStack(spacing: 8) {
                Text(title).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                if pressing == AppModel.approvalPress(option.n) { ProgressView().controlSize(.mini) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(AnswerButtonStyle(kind: .option, selected: false, fill: true, compact: compact))
        .disabled(pressing != nil)
        .help(help(title))
        .accessibilityLabel("Answer \(title)")
    }

    private var noteText: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            Text(ApprovalFormat.note(botName: botName, expiresAt: shown.expiresAt, more: session.moreApprovals, now: context.date))
                .foregroundStyle(Theme.ink3)
        }
    }

    private func noticeText(_ n: AnswerNote) -> some View {
        Text(n.text).font(.callout).foregroundStyle(n.isError ? Theme.brick : Theme.ink3).textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func help(_ title: String) -> String {
        "Answer \(title): \(botName ?? "the bot") is told at once"
    }

    private func press(_ option: ApprovalOption) {
        let s = session, shownInFull = detailsShown
        Task { await model.answerApproval(s, choice: option.n, detailsShown: shownInFull) }
    }
}
