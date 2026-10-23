import AppKit
import SwiftUI

/// One chat row. Expansion state lives in `ChatRows` (keyed by row id), so a lazily recycled row keeps it.
struct ChatItemView: View {
    let item: ChatItem
    let rows: ChatRows
    /// The newest row: a run of calls still going shows its latest calls under its line.
    var isLast = false

    var body: some View {
        switch item {
        case .user(let m): UserBubble(message: m)
        case .text(let t): AssistantTextView(text: t, rows: rows)
        case .tools(let g): ToolGroupView(group: g, rows: rows, isLast: isLast)
        case .notice(let n): NoticeView(notice: n)
        }
    }
}

struct UserBubble: View {
    let message: UserMessage

    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 48)
            VStack(alignment: .trailing, spacing: 3) {
                Text(message.text)
                    .foregroundStyle(Theme.ink)
                    .textSelection(.enabled)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(Theme.bg3, in: RoundedRectangle(cornerRadius: 10))
                    .overlay {
                        if message.failed { RoundedRectangle(cornerRadius: 10).stroke(Theme.brick, lineWidth: 1) }
                    }
                    .opacity(message.pending ? 0.7 : 1)
                HStack(spacing: 6) {
                    if message.pending { Text("Sending").font(.caption2).foregroundStyle(Theme.ink4) }
                    Text(message.sender ?? "you").font(.caption2.weight(.medium)).foregroundStyle(Theme.ink3)
                    if let ts = message.ts { Stamp(date: ts) }
                }
            }
            .frame(maxWidth: 620, alignment: .trailing)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(message.sender ?? "You"): \(message.text)")
    }
}

struct Stamp: View {
    let date: Date
    var body: some View {
        Text(date, format: .dateTime.hour().minute()).font(.caption2).foregroundStyle(Theme.ink4)
    }
}

// MARK: assistant text

struct AssistantTextView: View {
    let text: AssistantText
    let rows: ChatRows

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if text.blocks.isEmpty && text.pending {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Thinking").font(.callout).foregroundStyle(Theme.ink3)
                }
            }
            ForEach(Array(text.blocks.enumerated()), id: \.offset) { i, block in
                MarkdownBlockView(block: block, id: "\(text.id)#\(i)", rows: rows)
            }
            HStack(spacing: 6) {
                if text.pending && !text.blocks.isEmpty { ProgressView().controlSize(.mini) }
                if let ts = text.ts { Stamp(date: ts) }
            }
        }
        .foregroundStyle(text.failed ? Theme.brick : Theme.ink)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct MarkdownBlockView: View {
    let block: MarkdownBlock
    let id: String
    let rows: ChatRows

    var body: some View {
        switch block {
        case .paragraph(let a):
            Text(a).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .heading(let level, let a):
            Text(a)
                .font(level <= 1 ? Theme.titleFont(19) : level == 2 ? Theme.titleFont(17) : .headline)
                .textSelection(.enabled)
                .padding(.top, level <= 2 ? 4 : 2)
                .accessibilityAddTraits(.isHeader)
        case .list(_, let items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Group {
                            if let checked = item.checked {
                                Image(systemName: checked ? "checkmark.square" : "square").foregroundStyle(Theme.ink3)
                            } else {
                                Text(item.marker ?? "•").foregroundStyle(Theme.ink3).monospacedDigit()
                            }
                        }
                        .frame(minWidth: 14, alignment: .trailing)
                        Text(item.text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.leading, CGFloat(item.depth) * 18)
                }
            }
        case .code(let language, let text):
            CodeBlockView(language: language, text: text, id: id, rows: rows)
        case .quote(let a):
            HStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 1).fill(Theme.line2).frame(width: 3)
                Text(a).foregroundStyle(Theme.ink2).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
        case .rule:
            Divider().overlay(Theme.line)
        case .table(let header, let body):
            ScrollView(.horizontal, showsIndicators: false) {
                Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 5) {
                    GridRow { ForEach(Array(header.enumerated()), id: \.offset) { _, c in Text(c).fontWeight(.semibold) } }
                    Divider().overlay(Theme.line).gridCellUnsizedAxes(.horizontal)
                    ForEach(Array(body.enumerated()), id: \.offset) { _, row in
                        GridRow { ForEach(Array(row.enumerated()), id: \.offset) { _, c in Text(c).textSelection(.enabled) } }
                    }
                }
                .padding(10)
            }
            .background(Theme.bg2, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.line, lineWidth: 1))
        }
    }
}

struct CodeBlockView: View {
    let language: String?
    let text: String
    let id: String
    let rows: ChatRows
    static let collapsedLines = 30

    var body: some View {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        let long = lines.count > Self.collapsedLines
        let all = rows.showAll.contains(id)
        let shown = long && !all ? lines.prefix(Self.collapsedLines).joined(separator: "\n") : text
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(language ?? "code").font(.caption2).foregroundStyle(Theme.ink4)
                Spacer()
                Button { copy(text) } label: { Image(systemName: "doc.on.doc") }
                    .buttonStyle(.plain).foregroundStyle(Theme.ink3).help("Copy")
                    .accessibilityLabel("Copy code")
            }
            .padding(.horizontal, 10).padding(.top, 6)
            ScrollView(.horizontal, showsIndicators: true) {
                Text(shown)
                    .font(Theme.monoSmall)
                    .foregroundStyle(Theme.ink)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: true)
                    .padding(.horizontal, 10).padding(.vertical, 8)
            }
            if long {
                Button(all ? "Show less" : "Show all \(lines.count) lines") { rows.toggleShowAll(id) }
                    .buttonStyle(.plain).font(.caption).foregroundStyle(Theme.steel)
                    .padding(.horizontal, 10).padding(.bottom, 8)
            }
        }
        .background(Theme.codeWash, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.line, lineWidth: 1))
    }

    private func copy(_ s: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
    }
}

// MARK: tool calls

struct ToolGroupView: View {
    let group: ToolGroup
    let rows: ChatRows
    var isLast = false
    @Environment(\.chatSessionWorking) private var working
    /// Expanded, a long run shows its newest calls first and the rest on request.
    static let pageSize = 40
    static let liveTail = 3

    var body: some View {
        let expanded = rows.expanded.contains(group.id)
        let live = isLast && working && !expanded
        VStack(alignment: .leading, spacing: 0) {
            Button { rows.toggleExpanded(group.id) } label: {
                HStack(spacing: 8) {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                        .foregroundStyle(Theme.ink3)
                    Image(systemName: group.hasError ? "exclamationmark.triangle.fill" : "wrench.and.screwdriver")
                        .font(.caption)
                        .foregroundStyle(group.hasError ? Theme.brick : Theme.ink3)
                        .accessibilityHidden(true)
                    Text(group.title).font(.callout).foregroundStyle(Theme.ink2)
                    if group.hasError {
                        Text("error").font(.caption.weight(.medium)).foregroundStyle(Theme.brick)
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(Capsule().fill(Theme.wash(Theme.brick)))
                    }
                    if group.awaitingResult && working { ProgressView().controlSize(.mini) }
                    Spacer(minLength: 6)
                    if !expanded && !live, let last = group.rows.last {
                        Text(last.summary).font(Theme.mono).foregroundStyle(Theme.ink4).lineLimit(1).truncationMode(.middle)
                            .frame(maxWidth: 260, alignment: .trailing)
                    }
                    if let ts = group.ts { Stamp(date: ts) }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 10).padding(.vertical, 7)
            .accessibilityLabel("\(group.title)\(group.hasError ? ", with an error" : ""), \(expanded ? "expanded" : "collapsed")")
            if expanded {
                Divider().overlay(Theme.line)
                let all = rows.showAll.contains(group.id)
                let hidden = all ? 0 : max(0, group.rows.count - Self.pageSize)
                VStack(alignment: .leading, spacing: 10) {
                    if hidden > 0 {
                        Button("Show \(hidden) earlier call\(hidden == 1 ? "" : "s")") { rows.toggleShowAll(group.id) }
                            .buttonStyle(.plain).font(.caption).foregroundStyle(Theme.steel)
                    }
                    ForEach(group.rows.suffix(group.rows.count - hidden)) { row in
                        ToolRowView(row: row, rows: rows, running: row.result == nil && working)
                    }
                }
                .padding(10)
            } else if live {
                // Still going: the latest calls, as they happen.
                Divider().overlay(Theme.line)
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(group.rows.suffix(Self.liveTail)) { row in
                        ToolRowView(row: row, rows: rows, running: row.result == nil, compact: true)
                    }
                }
                .padding(.horizontal, 10).padding(.vertical, 8)
            }
        }
        .background(Theme.bg2, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(group.hasError ? Theme.brick.opacity(0.5) : Theme.line, lineWidth: 1))
    }
}

struct ToolRowView: View {
    let row: ToolRow
    let rows: ChatRows
    var running: Bool
    /// One line, no result (a live run's latest calls).
    var compact = false
    static let collapsedLines = 8

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(row.name).font(Theme.mono.weight(.semibold)).foregroundStyle(row.isError ? Theme.brick : Theme.ink)
                Text(row.summary.isEmpty ? (row.input ?? "") : row.summary)
                    .font(Theme.mono).foregroundStyle(Theme.ink2)
                    .lineLimit(compact ? 1 : 3).truncationMode(.middle)
                    .textSelection(.enabled)
                if let d = row.description, !compact {
                    Text(d).font(.caption).foregroundStyle(Theme.ink4).lineLimit(1)
                }
                Spacer(minLength: 0)
                if running { ProgressView().controlSize(.mini) }
                else if compact && row.isError { Text("error").font(.caption2).foregroundStyle(Theme.brick) }
            }
            .help(row.description ?? row.summary)
            if !compact, let r = row.result, !r.text.isEmpty { result(r) }
        }
    }

    @ViewBuilder private func result(_ r: ToolResult) -> some View {
        let lines = r.text.split(separator: "\n", omittingEmptySubsequences: false)
        let long = lines.count > Self.collapsedLines || r.text.count > 900
        let all = rows.showAll.contains(row.id)
        let shown = long && !all ? String(lines.prefix(Self.collapsedLines).joined(separator: "\n").prefix(900)) : r.text
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .top, spacing: 6) {
                if r.isError {
                    Text("Error").font(.caption2.weight(.semibold)).foregroundStyle(Theme.brick)
                }
                Text(shown)
                    .font(Theme.monoSmall)
                    .foregroundStyle(r.isError ? Theme.brick : Theme.ink3)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if long {
                Button(all ? "Show less" : "Show all (\(lines.count) lines)") { rows.toggleShowAll(row.id) }
                    .buttonStyle(.plain).font(.caption).foregroundStyle(Theme.steel)
            }
            if all || !long, let chars = r.chars, chars > r.text.count {
                Text("Output cut at \(r.text.count.formatted()) of \(chars.formatted()) characters")
                    .font(.caption2).foregroundStyle(Theme.ink4)
            }
        }
        .padding(.leading, 10)
        .overlay(alignment: .leading) { Rectangle().fill(r.isError ? Theme.brick.opacity(0.6) : Theme.line2).frame(width: 2) }
    }
}

struct NoticeView: View {
    let notice: Notice
    var body: some View {
        Text(notice.text)
            .font(notice.kind == .title ? Theme.titleFont(13) : .caption)
            .foregroundStyle(Theme.ink3)
            .multilineTextAlignment(.center)
            .lineLimit(notice.kind == .system ? 6 : 3)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity)
    }
}

/// "Working" at the bottom of a chat while the session works.
struct WorkingLine: View {
    var label = "Working"
    var body: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(label).font(.callout).foregroundStyle(Theme.steel)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
    }
}

extension EnvironmentValues {
    /// The chat's session is working (a call without a result is still running).
    @Entry var chatSessionWorking: Bool = false
}

extension ChatRows {
    func toggleExpanded(_ id: String) {
        if expanded.contains(id) { expanded.remove(id) } else { expanded.insert(id) }
    }
    func toggleShowAll(_ id: String) {
        if showAll.contains(id) { showAll.remove(id) } else { showAll.insert(id) }
    }
}
