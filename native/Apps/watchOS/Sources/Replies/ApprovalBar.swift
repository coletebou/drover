import SwiftUI

/// A Grok bot's approval request on the watch: what it asks (the bot's own words, plain text), who asks, and how to
/// answer, by its id with the main token (via watch). One tap only on words shown whole (a `complete` payload);
/// otherwise Review loads the whole request first. Without the main token it is read-only. No canned replies here: a
/// message would go to the bot instead of answering the request.
struct ApprovalBar: View {
    let item: WaitingItem
    let approval: ApprovalRequest
    @Environment(AppModel.self) private var model
    @State private var flow = ApprovalFlow()
    @State private var full: ApprovalRequest?
    @State private var reviewing = false
    @State private var reviewError: String?
    /// The whole request is no longer kept by this daemon.
    @State private var gone = false

    /// The words on show: the whole request once reviewed, else the summary's.
    private var shown: ApprovalRequest { full ?? approval }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(ApprovalFormat.heading(kind: shown.kind))
                .font(.caption2).foregroundStyle(Palette.amber)
            // String values: Text shows them as they are, never as Markdown.
            Text(shown.question).font(.body).foregroundStyle(Palette.ink)
            if let details = shown.details {
                Text(details).font(.footnote).foregroundStyle(Palette.ink2)
            }
            TimelineView(.periodic(from: .now, by: 60)) { context in
                Text(ApprovalFormat.note(botName: item.botName, expiresAt: shown.expiresAt?.date,
                                         more: item.moreApprovals ?? 0, now: context.date))
                    .font(.caption2).foregroundStyle(Palette.ink3)
            }
            answers.padding(.top, 4)
        }
    }

    @ViewBuilder private var answers: some View {
        // Answered or closed already (this card says so in its own words below): no buttons until the summary drops it.
        let settled = flow.phase == .idle ? model.settledApprovals[approval.id] : nil
        let mode = if let settled {
            ApprovalCardMode.closed(settled)
        } else if gone {
            ApprovalCardMode.closed("This request is no longer waiting for an answer.")
        } else {
            ApprovalFormat.cardMode(summary: approval, full: full, host: item.host, canAnswer: model.canReply, now: Date())
        }
        switch mode {
        case .blocked(let why) where !model.canReply:
            HStack(spacing: 6) {
                Image(systemName: "iphone")
                Text(why)
            }
            .font(.footnote).foregroundStyle(Palette.ink3)
        case .blocked(let why), .closed(let why):
            Text(why).font(.footnote).foregroundStyle(Palette.ink3)
        case .review:
            VStack(alignment: .leading, spacing: 6) {
                Text(ApprovalFormat.reviewNote).font(.caption2).foregroundStyle(Palette.ink3)
                Button {
                    Haptics.click()
                    review()
                } label: {
                    HStack(spacing: 6) {
                        Text("Review").font(.footnote.weight(.semibold))
                        Spacer(minLength: 0)
                        if reviewing { ProgressView().frame(width: 18, height: 18) }
                    }
                }
                .buttonStyle(.bordered)
                .tint(Palette.amber)
                .disabled(reviewing)
                .accessibilityLabel("Review the whole request")
                if let reviewError { Text(reviewError).font(.footnote).foregroundStyle(Palette.brick) }
            }
        case .answer(let request):
            VStack(spacing: 6) {
                if flow.showsButtons {
                    ForEach(request.options) { option in button(option, of: request) }
                }
                phaseView
            }
        }
    }

    private func review() {
        reviewing = true
        reviewError = nil
        Task {
            do {
                if let r = try await model.reviewApproval(approval) { full = r } else { gone = true }
            } catch {
                reviewError = (error as? WatchClientError)?.message ?? "Could not load the request"
                Haptics.failure()
            }
            reviewing = false
        }
    }

    private func button(_ option: ApprovalRequest.Option, of request: ApprovalRequest) -> some View {
        let title = ApprovalFormat.title(option)
        return Button {
            Haptics.click()
            if let n = flow.press(option.n) { answer(n, request) }
        } label: {
            HStack(spacing: 6) {
                // The whole label, wrapped: never cut.
                Text(title).font(.footnote.weight(.semibold)).multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                if flow.sending == option.n { ProgressView().frame(width: 18, height: 18) }
            }
        }
        .buttonStyle(.bordered)
        .tint(Palette.amber)
        .disabled(flow.isBusy)
        .accessibilityLabel("Answer \(title)")
    }

    @ViewBuilder private var phaseView: some View {
        switch flow.phase {
        case .idle, .sending:
            EmptyView()
        case .done(let text, let isError):
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: isError ? "exclamationmark.circle.fill" : "checkmark.circle.fill")
                    .foregroundStyle(isError ? Palette.brick : Palette.moss)
                Text(text).font(.footnote).foregroundStyle(Palette.ink)
            }
        case .failed(let text):
            Text(text).font(.footnote).foregroundStyle(Palette.brick)
        }
    }

    private func answer(_ n: Int, _ request: ApprovalRequest) {
        Task {
            let result: Result<ApprovalAnswerResult, Error>
            do { result = .success(try await model.answerApproval(request, choice: n)) }
            catch { result = .failure(error) }
            flow.finished(result, botName: item.botName)
            if case .done(_, false) = flow.phase { Haptics.success() } else { Haptics.failure() }
        }
    }
}

#Preview("Approval") {
    ScrollView { ApprovalBar(item: PreviewData.approvalItem, approval: PreviewData.approvalItem.approval!) }
        .environment(AppModel.preview())
}

#Preview("Approval, not paired") {
    ScrollView { ApprovalBar(item: PreviewData.approvalItem, approval: PreviewData.approvalItem.approval!) }
        .environment(AppModel.preview(canReply: false))
}
