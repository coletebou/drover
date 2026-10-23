import Foundation

/// `native.summary`: compact, widget-sized board state. Also the App Group cache file format
/// (`<container>/summary.json` holds this object bare, no envelope).
public struct NativeSummary: Sendable, Hashable, Codable {
    public var generatedAt: DroverTimestamp
    public var hosts: [HostCount]
    public var waiting: [WaitingItem]
    public var working: [WorkingItem]
    public var totals: Totals
    public var manager: ManagerState

    public init(generatedAt: DroverTimestamp, hosts: [HostCount], waiting: [WaitingItem], working: [WorkingItem], totals: Totals, manager: ManagerState) {
        self.generatedAt = generatedAt; self.hosts = hosts; self.waiting = waiting; self.working = working; self.totals = totals; self.manager = manager
    }

    public struct HostCount: Sendable, Hashable, Codable, Identifiable {
        public var name: String
        public var up: Bool
        public var waiting: Int
        public var working: Int
        public var idle: Int
        public var id: String { name }
        public init(name: String, up: Bool, waiting: Int, working: Int, idle: Int) {
            self.name = name; self.up = up; self.waiting = waiting; self.working = working; self.idle = idle
        }
    }

    public struct WaitingItem: Sendable, Hashable, Codable, Identifiable {
        public var id: String
        public var name: String
        /// Pass back as the `host` arg of other ops; `local` is the daemon's own machine.
        public var host: String
        public var engine: Engine
        public var since: DroverTimestamp?
        public var kind: AskKind
        /// At most 140 chars, no secrets.
        public var headline: String
        public init(id: String, name: String, host: String, engine: Engine, since: DroverTimestamp?, kind: AskKind, headline: String) {
            self.id = id; self.name = name; self.host = host; self.engine = engine; self.since = since; self.kind = kind; self.headline = headline
        }
    }

    public struct WorkingItem: Sendable, Hashable, Codable, Identifiable {
        public var id: String
        public var name: String
        public var host: String
        public var engine: Engine
        public var headline: String
        public init(id: String, name: String, host: String, engine: Engine, headline: String) {
            self.id = id; self.name = name; self.host = host; self.engine = engine; self.headline = headline
        }
    }

    public struct Totals: Sendable, Hashable, Codable {
        public var waiting: Int
        public var working: Int
        public var idle: Int
        public var hosts: Int
        public init(waiting: Int, working: Int, idle: Int, hosts: Int) {
            self.waiting = waiting; self.working = working; self.idle = idle; self.hosts = hosts
        }
    }

    public struct ManagerState: Sendable, Hashable, Codable {
        public var up: Bool
        public var lastNoteAt: DroverTimestamp?
        public init(up: Bool, lastNoteAt: DroverTimestamp?) { self.up = up; self.lastNoteAt = lastNoteAt }
    }
}
