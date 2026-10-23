import Foundation

/// What a sync changed. Flags only, never values, so printing one cannot leak a secret.
struct SyncChange: Equatable, Sendable {
    var baseURL = false
    var mainToken = false
    var widgetToken = false
    var rejectedBaseURL = false
    /// The stored server went from one server to another, or was cleared.
    var serverChanged = false
    var any: Bool { baseURL || mainToken || widgetToken }
}

/// Applies a `WatchSyncPayload` to the watch's stored configuration.
struct SyncApplier: Sendable {
    let vault: any TokenVault
    let config: WatchConfig
    let cache: SummaryCache
    let seen: SeenWaitingStore

    func apply(_ p: WatchSyncPayload) throws -> SyncChange {
        var change = SyncChange()

        if let raw = p.baseURL {
            let old = config.baseURL
            if raw.isEmpty {
                if old != nil {
                    config.baseURL = nil
                    change.baseURL = true
                }
            } else if let new = WatchConfig.normalize(raw) {
                if new != old {
                    config.baseURL = new
                    change.baseURL = true
                }
            } else {
                change.rejectedBaseURL = true
            }
            if change.baseURL, old != nil {
                change.serverChanged = true
                cache.clear()
                seen.seen = []
            }
        }

        change.mainToken = try applyToken(p.token, kind: .main)
        change.widgetToken = try applyToken(p.widgetToken, kind: .widget)
        return change
    }

    func unpair() throws {
        try vault.setToken(nil, for: .main)
        try vault.setToken(nil, for: .widget)
        config.baseURL = nil
        cache.clear()
        seen.seen = []
    }

    private func applyToken(_ value: String?, kind: TokenKind) throws -> Bool {
        guard let value else { return false }
        let stored = vault.token(kind)
        if value.isEmpty {
            guard !(stored ?? "").isEmpty else { return false }
            try vault.setToken(nil, for: kind)
            return true
        }
        guard stored != value else { return false }
        try vault.setToken(value, for: kind)
        return true
    }
}

enum PairingFormatting {
    /// Host and port only, e.g. "100.64.0.1:7337". IPv6 hosts are bracketed.
    static func serverLabel(_ url: URL?) -> String {
        guard let url, let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
              var host = c.host, !host.isEmpty else { return "Not set" }
        if host.contains(":"), !host.hasPrefix("[") { host = "[\(host)]" }
        if let port = c.port { return "\(host):\(port)" }
        return host
    }
}
