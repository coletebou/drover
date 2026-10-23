import Foundation
import SwiftUI

/// Assistant text as Markdown blocks (ux spec "Chat rendering" 2): paragraphs, headings, lists, fenced code, quotes,
/// rules and tables. Inline syntax (code, bold, italics, links) is Foundation's Markdown parser on each block's text.
/// Pure and Sendable: ChatLayout parses off the main actor and caches per turn.
enum MarkdownBlock: Hashable, Sendable {
    case paragraph(AttributedString)
    case heading(level: Int, AttributedString)
    case list(ordered: Bool, items: [ListItem])
    case code(language: String?, text: String)
    case quote(AttributedString)
    case rule
    case table(header: [AttributedString], rows: [[AttributedString]])

    struct ListItem: Hashable, Sendable {
        /// Nesting depth, 0 at the left margin.
        var depth: Int
        /// "1." for ordered items, nil for bullets.
        var marker: String?
        var text: AttributedString
        /// `- [ ]` / `- [x]` task items.
        var checked: Bool?
    }
}

enum Markdown {
    static func blocks(_ text: String) -> [MarkdownBlock] {
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var out: [MarkdownBlock] = []
        var para: [String] = []
        var i = 0

        func flushPara() {
            guard !para.isEmpty else { return }
            out.append(.paragraph(inline(para.joined(separator: "\n"))))
            para = []
        }

        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { flushPara(); i += 1; continue }

            if let fence = fenceOpen(line) {
                flushPara()
                var body: [String] = []
                i += 1
                while i < lines.count, !isFenceClose(lines[i], fence.marker) { body.append(lines[i]); i += 1 }
                i += 1   // the closing fence (or the end)
                let indent = fence.indent
                let code = body.map { l in String(l.dropFirst(min(indent, l.prefix { $0 == " " }.count))) }
                out.append(.code(language: fence.language, text: code.joined(separator: "\n")))
                continue
            }
            if let h = heading(trimmed) {
                flushPara()
                out.append(.heading(level: h.level, inline(h.text)))
                i += 1; continue
            }
            if isRule(trimmed) {
                flushPara()
                out.append(.rule)
                i += 1; continue
            }
            if trimmed.hasPrefix(">") {
                flushPara()
                var quoted: [String] = []
                while i < lines.count {
                    let t = lines[i].trimmingCharacters(in: .whitespaces)
                    guard t.hasPrefix(">") else { break }
                    var rest = t.dropFirst()
                    if rest.hasPrefix(" ") { rest = rest.dropFirst() }
                    quoted.append(String(rest))
                    i += 1
                }
                out.append(.quote(inline(quoted.joined(separator: "\n"))))
                continue
            }
            if trimmed.contains("|"), i + 1 < lines.count, isTableSeparator(lines[i + 1]) {
                flushPara()
                let header = cells(line).map(inline)
                var rows: [[AttributedString]] = []
                i += 2
                while i < lines.count, lines[i].contains("|"), !lines[i].trimmingCharacters(in: .whitespaces).isEmpty {
                    var r = cells(lines[i]).map(inline)
                    if r.count < header.count { r += Array(repeating: AttributedString(), count: header.count - r.count) }
                    rows.append(Array(r.prefix(max(header.count, 1))))
                    i += 1
                }
                out.append(.table(header: header, rows: rows))
                continue
            }
            if listItem(line) != nil {
                flushPara()
                // Raw text per item first (continuation lines join it), inline-parsed once at the end.
                var raw: [(depth: Int, marker: String?, text: String, checked: Bool?)] = []
                var baseIndent: Int?
                while i < lines.count {
                    let l = lines[i]
                    if let item = listItem(l) {
                        let base = baseIndent ?? item.indent
                        // Bullets after numbers (or the other way round) at the list's own depth start a new list.
                        if let first = raw.first, item.indent <= base, (first.marker == nil) != (item.marker == nil) { break }
                        baseIndent = base
                        raw.append((max(0, (item.indent - base) / 2), item.marker, item.text, item.checked))
                        i += 1
                    } else if !raw.isEmpty, !l.trimmingCharacters(in: .whitespaces).isEmpty,
                              l.prefix(while: { $0 == " " }).count >= 2, fenceOpen(l) == nil {
                        // A continuation line of the last item.
                        raw[raw.count - 1].text += "\n" + l.trimmingCharacters(in: .whitespaces)
                        i += 1
                    } else {
                        break
                    }
                }
                let items = raw.map { MarkdownBlock.ListItem(depth: $0.depth, marker: $0.marker, text: inline($0.text), checked: $0.checked) }
                out.append(.list(ordered: raw.first?.marker != nil, items: items))
                continue
            }
            para.append(line)
            i += 1
        }
        flushPara()
        return out
    }

    // MARK: block syntax

    private static func fenceOpen(_ line: String) -> (marker: String, language: String?, indent: Int)? {
        let indent = line.prefix { $0 == " " }.count
        guard indent <= 3 else { return nil }
        let t = line.dropFirst(indent)
        for m in ["```", "~~~"] where t.hasPrefix(m) {
            let run = t.prefix { $0 == m.first }
            let info = t.dropFirst(run.count).trimmingCharacters(in: .whitespaces)
            if m == "```" && info.contains("`") { return nil }
            return (String(run), info.isEmpty ? nil : String(info.split(separator: " ").first ?? ""), indent)
        }
        return nil
    }

    private static func isFenceClose(_ line: String, _ marker: String) -> Bool {
        let t = line.trimmingCharacters(in: .whitespaces)
        guard let c = marker.first, t.hasPrefix(marker) else { return false }
        return t.allSatisfy { $0 == c }
    }

    private static func heading(_ t: String) -> (level: Int, text: String)? {
        let hashes = t.prefix { $0 == "#" }.count
        guard (1...6).contains(hashes) else { return nil }
        let rest = t.dropFirst(hashes)
        guard rest.isEmpty || rest.hasPrefix(" ") else { return nil }
        var text = rest.trimmingCharacters(in: .whitespaces)
        while text.hasSuffix("#") { text = String(text.dropLast()).trimmingCharacters(in: .whitespaces) }
        return (hashes, text)
    }

    private static func isRule(_ t: String) -> Bool {
        let compact = t.replacingOccurrences(of: " ", with: "")
        guard compact.count >= 3, let c = compact.first, "-*_".contains(c) else { return false }
        return compact.allSatisfy { $0 == c }
    }

    private static func isTableSeparator(_ line: String) -> Bool {
        let t = line.trimmingCharacters(in: .whitespaces)
        return t.contains("|") && t.contains("-") && t.allSatisfy { "|-: ".contains($0) }
    }

    private static func cells(_ line: String) -> [String] {
        var t = line.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("|") { t.removeFirst() }
        if t.hasSuffix("|") { t.removeLast() }
        return t.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private static func listItem(_ line: String) -> (indent: Int, marker: String?, text: String, checked: Bool?)? {
        let indent = line.prefix { $0 == " " }.count
        let t = line.dropFirst(indent)
        var marker: String?
        var rest: Substring
        if let first = t.first, "-*+".contains(first), t.dropFirst().first == " " {
            rest = t.dropFirst(2)
            if isRule(String(t)) { return nil }
        } else {
            let digits = t.prefix { $0.isNumber }
            guard (1...3).contains(digits.count) else { return nil }
            let after = t.dropFirst(digits.count)
            guard let p = after.first, p == "." || p == ")", after.dropFirst().first == " " else { return nil }
            marker = "\(digits)."
            rest = after.dropFirst(2)
        }
        var checked: Bool?
        if rest.hasPrefix("[ ] ") { checked = false; rest = rest.dropFirst(4) }
        else if rest.hasPrefix("[x] ") || rest.hasPrefix("[X] ") { checked = true; rest = rest.dropFirst(4) }
        return (indent, marker, String(rest), checked)
    }

    // MARK: inline

    /// Inline Markdown (code, bold, italics, links, kept line breaks), bare URLs made links. Inline code gets a tint.
    static func inline(_ s: String) -> AttributedString {
        let opts = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace,
                                                           failurePolicy: .returnPartiallyParsedIfPossible)
        var a = (try? AttributedString(markdown: s, options: opts)) ?? AttributedString(s)
        for run in a.runs where run.inlinePresentationIntent?.contains(.code) == true {
            a[run.range].backgroundColor = Theme.codeWash
        }
        linkBareURLs(&a)
        return a
    }

    private static let urlPattern = try? NSRegularExpression(pattern: #"https?://[^\s<>()\[\]"'`]+[^\s<>()\[\]"'`.,;:!?]"#)

    private static func linkBareURLs(_ a: inout AttributedString) {
        let plain = String(a.characters)
        guard plain.contains("http"), let re = urlPattern else { return }
        let ns = plain as NSString
        for m in re.matches(in: plain, range: NSRange(location: 0, length: ns.length)).reversed() {
            guard let r = Range(m.range, in: plain), let url = URL(string: String(plain[r])) else { continue }
            let lower = plain.distance(from: plain.startIndex, to: r.lowerBound)
            let len = plain.distance(from: r.lowerBound, to: r.upperBound)
            let start = a.index(a.startIndex, offsetByCharacters: lower)
            let end = a.index(start, offsetByCharacters: len)
            let range = start..<end
            // Leave Markdown links and inline code as they are.
            if a[range].runs.contains(where: { $0.link != nil || $0.inlinePresentationIntent?.contains(.code) == true }) { continue }
            a[range].link = url
        }
    }

    /// Plain text of blocks, for tests and accessibility.
    static func plain(_ blocks: [MarkdownBlock]) -> String {
        blocks.map { b in
            switch b {
            case .paragraph(let a), .quote(let a), .heading(_, let a): String(a.characters)
            case .list(_, let items): items.map { ($0.marker ?? "-") + " " + String($0.text.characters) }.joined(separator: "\n")
            case .code(_, let t): t
            case .rule: "---"
            case .table(let h, let rows): ([h] + rows).map { $0.map { String($0.characters) }.joined(separator: " | ") }.joined(separator: "\n")
            }
        }.joined(separator: "\n\n")
    }
}
