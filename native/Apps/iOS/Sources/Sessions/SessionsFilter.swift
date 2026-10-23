import Foundation

/// Pure filtering, search and host grouping for the Sessions tab.
enum SessionsFilter: String, CaseIterable, Identifiable, Sendable {
    case all, live, waiting, working

    var id: String { rawValue }

    var label: String {
        switch self {
        case .all: "All"
        case .live: "Live"
        case .waiting: "Waiting"
        case .working: "Working"
        }
    }

    func matches(_ s: SessionInfo, state: BoardState) -> Bool {
        switch self {
        case .all: true
        case .live: s.isLive
        case .waiting: state == .waiting
        case .working: state == .working
        }
    }

    /// True when the lowercase query is found in name, id, cwd, host or tmux target. Empty query matches all.
    static func matches(_ s: SessionInfo, query: String) -> Bool {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if q.isEmpty { return true }
        let fields = [s.name, s.id, s.cwd, s.ref.displayHost, s.tmux]
        return fields.contains { $0?.lowercased().contains(q) == true }
    }

    /// Host order: local first, then alphabetical (case insensitive).
    static func hostOrder(_ a: String, _ b: String) -> Bool {
        if a == localHostName || b == localHostName { return a == localHostName && b != localHostName }
        return a.localizedCaseInsensitiveCompare(b) == .orderedAscending
    }

    /// Filters, searches and groups by host. Order within a host follows the input order.
    static func apply(_ sessions: [SessionInfo], filter: SessionsFilter, query: String,
                      state: (SessionRef) -> BoardState) -> [(host: String, sessions: [SessionInfo])] {
        var groups: [String: [SessionInfo]] = [:]
        for s in sessions where filter.matches(s, state: state(s.ref)) && matches(s, query: query) {
            groups[s.ref.displayHost, default: []].append(s)
        }
        return groups.keys.sorted(by: hostOrder).map { (host: $0, sessions: groups[$0] ?? []) }
    }

    /// Last path component of a working directory, or nil when there is none.
    static func lastPathComponent(_ cwd: String?) -> String? {
        guard let cwd else { return nil }
        let parts = cwd.split(separator: "/")
        return parts.last.map(String.init)
    }
}
