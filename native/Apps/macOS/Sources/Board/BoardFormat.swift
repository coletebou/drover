import Foundation

/// Pure helpers for the board slice, kept static so the harness can test them.
enum BoardFormat {
    /// Short relative time like "2 min. ago". Static (no ticking) so rows do not jitter. "now" under 10 s.
    static func relative(_ date: Date?, now: Date = Date()) -> String {
        guard let date else { return "" }
        if abs(now.timeIntervalSince(date)) < 10 { return "now" }
        let f = RelativeDateTimeFormatter()
        f.locale = Locale(identifier: "en_US")
        f.unitsStyle = .abbreviated
        return f.localizedString(for: date, relativeTo: now)
    }

    /// `drover://session/<id>?host=<host>`; host omitted when empty or "local".
    static func droverLink(for session: SessionItem) -> URL {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        var c = URLComponents()
        c.scheme = "drover"
        c.host = "session"
        c.percentEncodedPath = "/" + (session.id.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")
        if !session.host.isEmpty && session.host != "local" {
            var q = CharacterSet.urlQueryAllowed
            q.remove(charactersIn: "&+=#")
            c.percentEncodedQuery = "host=" + (session.host.addingPercentEncoding(withAllowedCharacters: q) ?? "")
        }
        return c.url ?? URL(fileURLWithPath: "/")
    }

    /// "2 waiting · 1 working", "idle" when all zero, "offline · <error>" when down, "· last known" when the daemon
    /// could not reach the host and shows what it saw last.
    static func hostCaption(_ h: HostItem) -> String {
        if !h.up {
            if let e = h.error, !e.isEmpty { return "offline · \(e)" }
            return "offline"
        }
        var parts: [String] = []
        if h.waiting > 0 { parts.append("\(h.waiting) waiting") }
        if h.working > 0 { parts.append("\(h.working) working") }
        if parts.isEmpty { parts.append("idle") }
        if h.stale { parts.append("last known") }
        return parts.joined(separator: " · ")
    }

    static func laneCounts(_ sessions: [SessionItem]) -> [Lane: Int] {
        var out: [Lane: Int] = [:]
        for s in sessions { out[s.lane, default: 0] += 1 }
        return out
    }

    /// "host · engine" plus " · target" when the session has a pane.
    static func subtitle(_ s: SessionItem) -> String {
        var t = "\(s.host) · \(s.engine)"
        if let target = s.tmuxTarget, !target.isEmpty { t += " · \(target)" }
        return t
    }

    /// Second line of a row: a bot's approval question (whole: the headline may be cut), else the headline, else a
    /// recent "finished" note, else the wait kind, else raw status.
    static func summaryLine(_ s: SessionItem) -> String {
        if s.lane == .waiting, let q = s.approval?.question, !q.isEmpty { return q }
        if let h = s.headline, !h.isEmpty { return h }
        if let f = s.finished?.text, !f.isEmpty { return f }
        return s.waitKind?.label ?? s.status
    }

    static func shortId(_ id: String) -> String { String(id.prefix(8)) }
}
