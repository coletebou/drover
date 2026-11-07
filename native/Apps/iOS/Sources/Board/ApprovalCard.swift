import SwiftUI

/// A Grok bot's approval request, on its board row and in its detail: what it asks for (the bot's own words, shown as
/// plain text and never acted on), who asks, and how to answer. One tap answers only words shown whole: a payload the
/// daemon marks `complete` (the card shows its question and details in full). Otherwise Review loads the whole request
/// (`GET /api/approvals?id=`) and the card answers from that. A press answers at once (`POST /api/approvals/answer`,
/// via ios), then the board refreshes: the card goes, or the bot's next request takes its place.
struct ApprovalCard: View {
    let approval: ApprovalRequest
    /// The bot's name ("Alpha"), for "Asked by Alpha, a Grok bot".
    let botName: String?
    /// The waiting item's host: a request is answered on the daemon that keeps its bot.
    let host: String?
    var more: Int = 0
    /// Load the whole request at once when a notification for it opened this card (the bot's detail only).
    var reviewsOnOpen = false
    @Environment(AppModel.self) private var model
    @ScaledMetric(relativeTo: .body) private var minHeight: CGFloat = 44

    private enum Review: Equatable {
        case none, loading, failed(String)
        case loaded(ApprovalRequest)
        /// This daemon keeps no such request any more.
        case gone
    }
    @State private var review: Review = .none
    /// The request the review is about: a review (or a load that comes back late) for any other request is ignored.
    @State private var reviewFor: String?
    private var current: Review { reviewFor == approval.id ? review : .none }

    private var full: ApprovalRequest? { if case .loaded(let r) = current, r.id == approval.id { r } else { nil } }
    /// The words on show: the whole request once reviewed, else the board's.
    private var shown: ApprovalRequest { full ?? approval }

    var body: some View {
        let mode = if let settled = model.settledApprovals[approval.id] {
            ApprovalCardMode.closed(settled)
        } else if current == .gone {
            ApprovalCardMode.closed("This request is no longer waiting for an answer.")
        } else {
            ApprovalFormat.cardMode(summary: approval, full: full, host: host, hasMainToken: model.hasMainToken, now: Date())
        }
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                // Symbol and text side by side: a Label in a List row reserves an icon column (see BadgeLabelStyle).
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "checkmark.seal").accessibilityHidden(true)
                    Text(ApprovalFormat.heading(kind: shown.kind))
                }
                .font(.caption.weight(.semibold)).foregroundStyle(Theme.waiting)
                // String values, never literals: Text does not read them as Markdown, so the bot's words stay plain.
                Text(shown.question).font(.body).foregroundStyle(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                if let details = shown.details {
                    Text(details).font(.footnote).foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .combine)

            switch mode {
            case .blocked(let why), .closed(let why):
                Text(why).font(.footnote).foregroundStyle(Theme.textSecondary)
            case .review:
                reviewPrompt
            case .answer(let request):
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(request.options) { option in button(option, of: request) }
                }
            }

            TimelineView(.periodic(from: .now, by: 60)) { context in
                Text(ApprovalFormat.note(botName: botName, expiresAt: shown.expiresAt?.date, more: more, now: context.date))
                    .font(.caption).foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 2)
        .task(id: model.reviewApprovalID) {
            guard reviewsOnOpen, model.reviewApprovalID == approval.id else { return }
            // Cleared after the load: changing the task's id while it runs would cancel the load it awaits.
            await load()
            if model.reviewApprovalID == approval.id { model.reviewApprovalID = nil }
        }
    }

    /// Shortened words: say so, and load the whole request.
    @ViewBuilder private var reviewPrompt: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(ApprovalFormat.reviewNote).font(.footnote).foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            if case .failed(let why) = current {
                Text(why).font(.footnote).foregroundStyle(Theme.error).fixedSize(horizontal: false, vertical: true)
            }
            Button {
                Haptics.tap()
                Task { await load() }
            } label: {
                HStack(spacing: 8) {
                    Text("Review the request").font(.body.weight(.semibold))
                    Spacer(minLength: 0)
                    if current == .loading { ProgressView().accessibilityLabel("Loading") }
                }
                .frame(maxWidth: .infinity, minHeight: minHeight, alignment: .leading)
            }
            .buttonStyle(.bordered)
            .tint(Theme.waiting)
            .disabled(current == .loading)
            .accessibilityHint("Loads the whole request from Drover, so you can answer it")
        }
    }

    private func load() async {
        let id = approval.id
        reviewFor = id
        review = .loading
        let next: Review
        do {
            if let r = try await model.reviewApproval(id: id), r.id == id { next = .loaded(r) } else { next = .gone }
        } catch {
            next = .failed("Could not load the request: \(error.localizedDescription)")
        }
        // Another load started for another request meanwhile: this result is not its.
        guard reviewFor == id else { return }
        review = next
        if next == .gone { A11y.announce("This request is no longer waiting") }
        else if case .loaded = next { A11y.announce("The whole request is shown") }
    }

    private func button(_ option: ApprovalRequest.Option, of request: ApprovalRequest) -> some View {
        let title = ApprovalFormat.title(option)
        let pressing = model.answeringApprovals[request.id]
        return Button {
            Haptics.tap()
            Task {
                await model.answerApproval(request, option: option, botName: botName)
                if let notice = model.approvalNotice {
                    if notice.isError { Haptics.failure() } else { Haptics.success() }
                    A11y.announce(notice.text)
                }
            }
        } label: {
            HStack(spacing: 8) {
                Text(title).font(.body.weight(.semibold)).multilineTextAlignment(.leading)
                Spacer(minLength: 0)
                if pressing == option.n { ProgressView().accessibilityLabel("Sending") }
            }
            .frame(maxWidth: .infinity, minHeight: minHeight, alignment: .leading)
        }
        // Bordered, so a press is this button's, not a tap that opens the row.
        .buttonStyle(.bordered)
        .tint(Theme.waiting)
        .disabled(pressing != nil)
        .accessibilityLabel("Answer \(title)")
        .accessibilityHint("Tells \(botName ?? "the bot") your answer at once")
    }
}

/// What the last approval answer came to, with a way to dismiss it. On the board above the waiting list, and in the
/// bot's detail, where it outlives the card a decided request leaves behind.
struct ApprovalNoticeView: View {
    let notice: ApprovalNotice
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: notice.isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .foregroundStyle(notice.isError ? Theme.error : Theme.idle)
                .accessibilityHidden(true)
            Text(notice.text).font(.footnote).foregroundStyle(Theme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button("Dismiss", action: dismiss)
                .font(.footnote).buttonStyle(.borderless)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAction(named: "Dismiss", dismiss)
    }
}
