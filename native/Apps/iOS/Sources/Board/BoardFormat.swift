import Foundation

/// Pure display helpers for the Board tab.
enum BoardFormat {
    /// decision -> "Decision", question -> "Question", anything else capitalized; nil or empty -> "Waiting".
    static func kindLabel(_ kind: String?) -> String {
        guard let kind = kind?.trimmingCharacters(in: .whitespaces), !kind.isEmpty else { return "Waiting" }
        return kind.prefix(1).uppercased() + kind.dropFirst().lowercased()
    }

    /// The badge of a waiting row: "Approval" for a Grok bot's approval request, else the kind's label.
    static func waitingLabel(_ item: NativeSummary.WaitingItem) -> String {
        item.approval != nil ? "Approval" : kindLabel(item.kind)
    }

    /// "1 waiting, 2 working, 3 idle"
    static func countsSentence(waiting: Int, working: Int, idle: Int) -> String {
        "\(waiting) waiting, \(working) working, \(idle) idle"
    }

    static func countsSentence(_ h: NativeSummary.HostSummary) -> String {
        countsSentence(waiting: h.waiting, working: h.working, idle: h.idle)
    }

    static func hostStatus(_ h: NativeSummary.HostSummary) -> String { h.up ? "up" : "down" }

    static func managerLabel(up: Bool?) -> String { up == true ? "Manager up" : "Manager down" }

    /// Spoken summary of the totals.
    static func totalsSentence(_ t: NativeSummary.Totals) -> String {
        "\(t.waiting) waiting, \(t.working) working, \(t.idle) idle, \(t.hosts) \(t.hosts == 1 ? "host" : "hosts")"
    }

    /// True when waiting count rose compared to a previous known value.
    static func waitingIncreased(from old: Int?, to new: Int?) -> Bool {
        guard let old, let new else { return false }
        return new > old
    }
}
