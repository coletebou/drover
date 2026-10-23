import Foundation

// Pure logic of the manager tab (Foundation only, covered by Tests/Logic/ManagerTests.swift).
// Key names follow core/openclaw.js status() and feed() in Drover; every key is optional.

/// Drops fields that could carry secrets from the "Details" list.
enum ManagerRedaction {
    private static let fragments = ["token", "secret", "password", "key", "auth", "cookie"]

    /// True when any part of `key` (a dotted path) looks like a credential name.
    static func isSensitive(key: String) -> Bool {
        let k = key.lowercased()
        return fragments.contains { k.contains($0) }
    }
}

/// Where the manager runs: the explicit setting, else the first known OpenClaw session's host.
enum ManagerHostResolver {
    /// nil means the daemon's own machine.
    static func resolve(setting: String?, sessions: [SessionInfo]) -> String? {
        if let s = setting?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty { return s }
        if let h = sessions.first(where: { $0.engine == .openclaw })?.host, !h.isEmpty { return h }
        return nil
    }

    /// True when the server says there is no manager on that host.
    static func isNotFound(_ error: Error) -> Bool {
        if let e = error as? DroverError {
            switch e {
            case .http(let code): return code == 404
            case .server(let m): return looksLikeNotFound(m)
            default: return false
            }
        }
        return looksLikeNotFound(error.localizedDescription)
    }

    private static func looksLikeNotFound(_ message: String) -> Bool {
        let m = message.lowercased()
        return m.contains("not found") || m.contains("not configured") || m.contains("no such session")
    }
}

/// `openclaw.status` parsed defensively. Missing or oddly typed keys stay nil and hide their line.
struct ManagerStatus: Equatable, Sendable {
    var configured: Bool?
    var reason: String?
    var gatewayUp: Bool?
    var unitState: String?
    var model: String?
    var thinking: String?
    var heartbeatEvery: String?
    var lastActivity: Date?
    var todayUsd: Double?
    var budgetUsd: Double?
    var pausedByBudget: Bool?
    var details: [Detail] = []

    struct Detail: Equatable, Sendable, Identifiable {
        var key: String
        var value: String
        var id: String { key }
    }

    /// Up when the gateway answers (preferred) or the unit is active.
    var isUp: Bool? {
        if let g = gatewayUp { return g }
        if let u = unitState { return u == "active" }
        return nil
    }

    var costLine: String? {
        guard let t = todayUsd else { return nil }
        let spent = String(format: "$%.2f", t)
        if let b = budgetUsd { return "\(spent) of \(String(format: "$%.2f", b)) today" }
        return "\(spent) today"
    }

    static func parse(_ json: JSONValue) -> ManagerStatus {
        var s = ManagerStatus()
        s.configured = json["configured"]?.bool
        s.reason = json["reason"]?.string
        s.gatewayUp = json["gateway"]?["up"]?.bool
        s.unitState = (json["unit"]?["active"] ?? json["unit"]?["state"])?.string
        let m = json["model"]
        s.model = m?.string.flatMap { m?.object == nil ? $0 : nil } ?? m?["primary"]?.string
        s.thinking = m?["thinking"]?.string
        s.heartbeatEvery = m?["heartbeatEvery"]?.string
        s.lastActivity = json["wal24h"]?["last"]?.string.flatMap(LooseDate.parse)
        s.todayUsd = json["cost"]?["todayUsd"]?.double
        s.budgetUsd = json["cost"]?["budgetUsd"]?.double
        s.pausedByBudget = json["cost"]?["paused"]?.bool

        let shown: Set<String> = [
            "configured", "reason", "gateway.up", "unit.active", "unit.state", "model", "model.primary",
            "model.thinking", "model.heartbeatEvery", "wal24h.last", "cost.todayUsd", "cost.budgetUsd", "cost.paused",
        ]
        var lines: [Detail] = []
        flatten(json, path: "", into: &lines)
        s.details = lines
            .filter { !shown.contains($0.key) && !ManagerRedaction.isSensitive(key: $0.key) }
            .sorted { $0.key < $1.key }
        return s
    }

    /// Scalars only; arrays and nulls are skipped.
    private static func flatten(_ v: JSONValue, path: String, into out: inout [Detail]) {
        switch v {
        case .object(let o):
            for (k, child) in o {
                // Redact before descending so a sensitive subtree is never read.
                let p = path.isEmpty ? k : path + "." + k
                if ManagerRedaction.isSensitive(key: p) { continue }
                flatten(child, path: p, into: &out)
            }
        case .string, .number, .bool:
            if let s = v.string, !path.isEmpty { out.append(Detail(key: path, value: s)) }
        case .array, .null:
            break
        }
    }
}

/// One event of `openclaw.feed`.
struct ManagerFeedEvent: Equatable, Sendable, Identifiable {
    var id: String
    var date: Date?
    var type: String
    var actor: String?
    var text: String
    var to: String?

    /// Accepts a bare array or an object wrapping it (`items` or `events`). Output is newest first.
    static func parse(_ json: JSONValue) -> [ManagerFeedEvent] {
        let list = json.array ?? json["items"]?.array ?? json["events"]?.array ?? []
        let events: [ManagerFeedEvent] = list.enumerated().compactMap { i, e in
            guard e.object != nil else { return nil }
            let text = (e["text"] ?? e["title"] ?? e["notes"])?.string ?? ""
            let type = e["type"]?.string ?? "event"
            if text.isEmpty && type == "event" { return nil }
            let date = e["ts"]?.string.flatMap(LooseDate.parse)
            let id = e["id"]?.string ?? "\(i)-\(e["ts"]?.string ?? "")-\(type)"
            return ManagerFeedEvent(id: id, date: date, type: type, actor: e["actor"]?.string, text: text, to: e["to"]?.string)
        }
        // The server already sends newest first; sort only when every event has a time.
        if events.allSatisfy({ $0.date != nil }) {
            return events.sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }
        }
        return events
    }
}

/// A chat bubble.
struct ManagerMessage: Equatable, Sendable, Identifiable {
    var id: String
    var isUser: Bool
    var text: String
    var date: Date?

    /// User and assistant turns with text, oldest first.
    static func messages(from turns: [Turn]) -> [ManagerMessage] {
        turns.compactMap { t in
            guard t.role == "user" || t.role == "assistant", t.meta != true else { return nil }
            let text = (t.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            return ManagerMessage(id: t.id, isUser: t.role == "user", text: text, date: t.ts?.date)
        }
    }

    var accessibilityText: String { (isUser ? "You: " : "Manager: ") + text }

    /// Inline markdown, falling back to the plain string.
    var attributed: AttributedString {
        let opts = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: text, options: opts)) ?? AttributedString(text)
    }
}
