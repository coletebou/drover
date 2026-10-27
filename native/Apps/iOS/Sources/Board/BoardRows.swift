import SwiftUI

/// Totals header: counts with text labels, plus when the data was generated.
struct BoardTotalsHeader: View {
    let summary: NativeSummary?
    let fallbackDate: Date?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let t = summary?.totals {
                BoardAdaptiveStack(spacing: 12) {
                    BoardCount(value: t.waiting, label: "waiting", state: .waiting)
                    BoardCount(value: t.working, label: "working", state: .working)
                    BoardCount(value: t.idle, label: "idle", state: .idle)
                    BoardCount(value: t.hosts, label: t.hosts == 1 ? "host" : "hosts", state: nil)
                }
            } else {
                Text("No data yet").font(.subheadline).foregroundStyle(Theme.textSecondary)
            }
            if let date = summary?.generatedAt?.date ?? fallbackDate {
                Text("Updated \(date.relativeLabel)").font(.footnote).foregroundStyle(Theme.textSecondary)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

private struct BoardCount: View {
    let value: Int
    let label: String
    let state: BoardState?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("\(value)").font(Theme.title(.title)).foregroundStyle(state.map(Theme.color(for:)) ?? Theme.textPrimary)
            Text(label).font(.caption).foregroundStyle(Theme.textSecondary)
        }
        .accessibilityElement(children: .combine)
    }
}

struct BoardWaitingRow: View {
    let item: NativeSummary.WaitingItem
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .body) private var minHeight: CGFloat = 44

    var body: some View {
        if let approval = item.approval {
            // A Grok bot's approval request: its card answers it here, one button per option (no reply: a message
            // would go to the bot instead of answering).
            VStack(alignment: .leading, spacing: 8) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(item.title).font(Theme.title(.headline)).foregroundStyle(Theme.textPrimary)
                    badges
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(spokenHeader)
                // One view per request: the bot's next request starts afresh, and a press on the last one's buttons ends with it.
                ApprovalCard(approval: approval, botName: item.botName, host: item.host, more: item.moreApprovals ?? 0)
                    .id(approval.id)
            }
            .frame(maxWidth: .infinity, minHeight: minHeight, alignment: .leading)
            .accessibilityElement(children: .contain)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                Text(item.title).font(Theme.title(.headline)).foregroundStyle(Theme.textPrimary)
                if let h = item.headline, !h.isEmpty {
                    Text(h).font(.subheadline).foregroundStyle(Theme.textPrimary).lineLimit(typeSize.isAccessibilitySize ? nil : 2)
                }
                badges
            }
            .frame(maxWidth: .infinity, minHeight: minHeight, alignment: .leading)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(spoken)
        }
    }

    private var badges: some View {
        BoardAdaptiveStack(spacing: 8) {
            StateBadge(state: .waiting, text: BoardFormat.waitingLabel(item))
            MonoText(text: item.ref.displayHost)
            if let e = item.engine { Text(e.label).font(.caption).foregroundStyle(Theme.textSecondary) }
            if let since = item.since?.date { Text(since.relativeLabel).font(.caption).foregroundStyle(Theme.textSecondary) }
        }
    }

    private var spoken: String {
        var parts = ["\(item.title), waiting on you", ""]
        parts[1] = BoardFormat.kindLabel(item.kind).lowercased() + (item.headline.map { ": \($0)" } ?? "")
        parts.append("on \(item.ref.displayHost)")
        if let e = item.engine { parts.append(e.label) }
        if let s = item.since?.date { parts.append(s.relativeLabel) }
        return parts.joined(separator: ", ")
    }

    private var spokenHeader: String {
        var parts = ["\(item.title), asks for your approval", "on \(item.ref.displayHost)"]
        if let s = item.since?.date { parts.append(s.relativeLabel) }
        return parts.joined(separator: ", ")
    }
}

struct BoardWorkingRow: View {
    let item: NativeSummary.WorkingItem
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .body) private var minHeight: CGFloat = 44

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(item.title).font(Theme.title(.headline)).foregroundStyle(Theme.textPrimary)
            if let h = item.headline, !h.isEmpty {
                Text(h).font(.subheadline).foregroundStyle(Theme.textPrimary).lineLimit(typeSize.isAccessibilitySize ? nil : 2)
            }
            BoardAdaptiveStack(spacing: 8) {
                StateBadge(state: .working)
                MonoText(text: item.ref.displayHost)
                if let e = item.engine { Text(e.label).font(.caption).foregroundStyle(Theme.textSecondary) }
            }
        }
        .frame(maxWidth: .infinity, minHeight: minHeight, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(spoken)
    }

    private var spoken: String {
        var parts = ["\(item.title), working"]
        if let h = item.headline, !h.isEmpty { parts.append(h) }
        parts.append("on \(item.ref.displayHost)")
        if let e = item.engine { parts.append(e.label) }
        return parts.joined(separator: ", ")
    }
}

struct BoardHostRow: View {
    let host: NativeSummary.HostSummary
    @ScaledMetric(relativeTo: .body) private var minHeight: CGFloat = 44

    var body: some View {
        BoardAdaptiveStack(spacing: 8) {
            HStack(spacing: 8) {
                StatusDot(color: host.up ? Theme.idle : Theme.error)
                Text(host.name).font(Theme.mono(.subheadline)).foregroundStyle(Theme.textPrimary)
                Text(BoardFormat.hostStatus(host)).font(.subheadline.weight(.semibold))
                    .foregroundStyle(host.up ? Theme.idle : Theme.error)
            }
            Text(BoardFormat.countsSentence(host)).font(.caption).foregroundStyle(Theme.textSecondary)
        }
        .frame(maxWidth: .infinity, minHeight: minHeight, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Host \(host.name), \(BoardFormat.hostStatus(host)), \(BoardFormat.countsSentence(host))")
    }
}

struct BoardManagerRow: View {
    let manager: NativeSummary.ManagerHealth
    @ScaledMetric(relativeTo: .body) private var minHeight: CGFloat = 44

    var body: some View {
        BoardAdaptiveStack(spacing: 8) {
            StateBadge(state: .manager, text: BoardFormat.managerLabel(up: manager.up))
            if let d = manager.lastNoteAt?.date {
                Text("Last note \(d.relativeLabel)").font(.caption).foregroundStyle(Theme.textSecondary)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.textSecondary).accessibilityHidden(true)
        }
        .frame(maxWidth: .infinity, minHeight: minHeight, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(BoardFormat.managerLabel(up: manager.up))\(manager.lastNoteAt.map { ", last note \($0.date.relativeLabel)" } ?? "")")
        .accessibilityHint("Opens the manager tab")
        .accessibilityAddTraits(.isButton)
    }
}
