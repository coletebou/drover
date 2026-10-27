import Foundation

/// Pure formatting for the waiting list. Foundation only so it compiles in the macOS logic tests.
enum ListFormatting {
    /// Compact age: "now", "5m", "3h", "2d". Integer floor; future dates read "now".
    static func relative(_ since: Date?, now: Date) -> String {
        guard let since else { return "" }
        let s = Int(now.timeIntervalSince(since).rounded(.down))
        if s < 60 { return "now" }
        if s < 3600 { return "\(s / 60)m" }
        if s < 86400 { return "\(s / 3600)h" }
        return "\(s / 86400)d"
    }

    /// Last `max` characters of the text, with a leading ellipsis when cut.
    static func tail(_ text: String, max: Int = 800) -> String {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.count <= max { return t }
        let rest = String(t.suffix(max)).drop(while: { $0.isWhitespace || $0.isNewline })
        return "…" + rest
    }

    static func totalsLine(_ s: NativeSummary) -> String {
        let hosts = s.totals.hosts > 0 ? s.totals.hosts : s.hosts.count
        var line = "\(s.totals.working) working, \(s.totals.idle) idle, \(hosts) \(hosts == 1 ? "host" : "hosts")"
        let down = s.hosts.filter { !$0.up }.count
        if down > 0 { line += ", \(down) down" }
        return line
    }

    static func kindWord(_ kind: WaitingKind) -> String {
        switch kind {
        case .decision: return "decision"
        case .question: return "question"
        case .finished: return "finished"
        case .other: return "waiting"
        }
    }

    /// The badge of a waiting item: "Approval" for a Grok bot's approval request, else its kind ("Decision").
    static func kindLabel(_ item: WaitingItem) -> String {
        if item.approval != nil { return "Approval" }
        let w = kindWord(item.kind)
        return w.prefix(1).uppercased() + w.dropFirst()
    }

    static func spokenAge(_ since: Date, now: Date) -> String {
        let s = Int(now.timeIntervalSince(since).rounded(.down))
        if s < 60 { return "just now" }
        if s < 3600 { let m = s / 60; return "\(m) \(m == 1 ? "minute" : "minutes")" }
        if s < 86400 { let h = s / 3600; return "\(h) \(h == 1 ? "hour" : "hours")" }
        let d = s / 86400
        return "\(d) \(d == 1 ? "day" : "days")"
    }

    static func accessibilityLabel(_ item: WaitingItem, now: Date) -> String {
        var parts = [item.name, item.approval != nil ? "approval" : kindWord(item.kind)]
        if let since = item.since { parts.append("waiting \(spokenAge(since.date, now: now))") }
        parts.append(item.headline)
        return parts.joined(separator: ", ")
    }
}
