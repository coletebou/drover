import SwiftUI
import UIKit

struct ChatView: View {
    let store: ChatStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var nearBottom = true
    @State private var didInitialScroll = false

    private static let bottomID = "chat-bottom"

    private var itemCount: Int { store.visibleTurns.count + store.pending.count }
    private var assistantCount: Int { store.visibleTurns.filter { $0.role == "assistant" }.count }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if let error = store.error {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote).foregroundStyle(Theme.error)
                    }
                    ForEach(store.visibleTurns) { turn in
                        ChatTurnRow(turn: turn)
                    }
                    ForEach(store.pending) { p in
                        ChatPendingBubble(pending: p)
                    }
                    Color.clear.frame(height: 1).id(Self.bottomID)
                        .onAppear { nearBottom = true }
                        .onDisappear { nearBottom = false }
                }
                .padding(.horizontal)
                .padding(.vertical, 8)
            }
            .scrollDismissesKeyboard(.interactively)
            .overlay {
                if store.isLoading && !store.hasLoaded {
                    ProgressView("Loading transcript")
                } else if store.hasLoaded && itemCount == 0 && store.error == nil {
                    ContentUnavailableView("No messages yet", systemImage: "text.bubble",
                                           description: Text("This session has no transcript to show."))
                }
            }
            .onChange(of: store.hasLoaded) { _, loaded in
                guard loaded, !didInitialScroll else { return }
                didInitialScroll = true
                scrollToBottom(proxy, animated: false)
            }
            .onChange(of: assistantCount) { old, new in
                // One change per poll, so this announces at most once per poll.
                guard didInitialScroll, new > old, UIAccessibility.isVoiceOverRunning else { return }
                A11y.announce("New reply")
            }
            .onChange(of: itemCount) { _, _ in
                guard didInitialScroll, nearBottom else { return }
                scrollToBottom(proxy, animated: !reduceMotion)
            }
        }
        .background(Theme.background)
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool) {
        // Wait one layout pass so the new rows exist.
        DispatchQueue.main.async {
            if animated {
                withAnimation { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
            } else {
                proxy.scrollTo(Self.bottomID, anchor: .bottom)
            }
        }
    }
}

/// Renders one transcript turn according to its role.
struct ChatTurnRow: View {
    let turn: Turn
    @ScaledMetric(relativeTo: .body) private var bubblePad: CGFloat = 12

    private var text: String { (turn.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
    private var time: String? { turn.ts?.date.relativeLabel }

    var body: some View {
        switch turn.role {
        case "user":
            ChatBubble(speaker: "You", text: text, time: time, alignsTrailing: true, tools: [], fill: Theme.surfaceRaised)
        case "assistant":
            ChatBubble(speaker: "Assistant", text: text, time: time, alignsTrailing: false, tools: turn.toolNames,
                       fill: Theme.surface)
        case "tool_result", "tool":
            ChatToolRow(text: text, tools: turn.toolNames, time: time)
        case "thinking":
            Text("Thinking")
                .font(.caption).italic().foregroundStyle(Theme.textSecondary)
                .accessibilityLabel("Assistant is thinking")
        case "title", "queue":
            Text(text)
                .font(.caption).foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
        default:
            ChatBubble(speaker: "Assistant", text: text, time: time, alignsTrailing: false, tools: [], fill: Theme.surface)
        }
    }
}

struct ChatBubble: View {
    let speaker: String
    let text: String
    let time: String?
    let alignsTrailing: Bool
    let tools: [String]
    let fill: Color
    @ScaledMetric(relativeTo: .body) private var pad: CGFloat = 12

    static func rendered(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(s)
    }

    var body: some View {
        VStack(alignment: alignsTrailing ? .trailing : .leading, spacing: 4) {
            if !tools.isEmpty {
                Text(tools.joined(separator: ", "))
                    .font(Theme.mono(.caption2)).foregroundStyle(Theme.textSecondary)
            }
            Text(Self.rendered(text))
                .font(.body).foregroundStyle(Theme.textPrimary)
                .textSelection(.enabled)
                .padding(pad)
                .background(fill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Theme.separator, lineWidth: 0.5))
            if let time {
                Text(time).font(.caption2).foregroundStyle(Theme.textSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: alignsTrailing ? .trailing : .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(speaker)\(time.map { ", \($0)" } ?? ""): \(text)\(tools.isEmpty ? "" : ". Tools: \(tools.joined(separator: ", "))")")
    }
}

struct ChatToolRow: View {
    let text: String
    let tools: [String]
    let time: String?
    @Environment(\.dynamicTypeSize) private var typeSize

    private var firstLine: String {
        let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
        return line.isEmpty ? "Tool output" : line
    }

    var body: some View {
        DisclosureGroup {
            Text(text)
                .font(Theme.mono(.caption)).foregroundStyle(Theme.textPrimary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 4)
        } label: {
            Text(firstLine)
                .font(Theme.mono(.caption)).foregroundStyle(Theme.textSecondary)
                .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
        }
        .tint(Theme.textSecondary)
        .accessibilityLabel("Tool\(time.map { ", \($0)" } ?? ""): \(firstLine)")
        .accessibilityHint("Shows or hides the full output")
    }
}

struct ChatPendingBubble: View {
    let pending: ChatPending
    @ScaledMetric(relativeTo: .body) private var pad: CGFloat = 12

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            Text(ChatBubble.rendered(pending.text))
                .font(.body).foregroundStyle(Theme.textPrimary)
                .padding(pad)
                .background(Theme.surfaceRaised.opacity(0.7), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            Text(pending.statusLabel)
                .font(.caption2).foregroundStyle(pending.status == .queued ? Theme.waiting : Theme.textSecondary)
                .multilineTextAlignment(.trailing)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("You, \(pending.statusLabel): \(pending.text)")
    }
}
