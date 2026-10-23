import Foundation

private struct Rig {
    let vault = MemoryTokenVault()
    let config = WatchConfig(defaults: scratchDefaults())
    let cache = SummaryCache(fileURL: scratchFile())
    let seen = SeenWaitingStore(defaults: scratchDefaults())
    var applier: SyncApplier { SyncApplier(vault: vault, config: config, cache: cache, seen: seen) }
    func fillCache() { cache.save(raw: Data("{}".utf8)) }
    var cacheExists: Bool { FileManager.default.fileExists(atPath: cache.fileURL.path) }
}

private let full = WatchSyncPayload(baseURL: "http://100.64.0.1:7337", token: "tok-SECRET-main", widgetToken: "tok-SECRET-widget")

let syncTests: [TestCase] = [
    TestCase("sync: first pairing sets url and both tokens") {
        let r = Rig()
        let c = try r.applier.apply(full)
        try expect(c.baseURL && c.mainToken && c.widgetToken && c.any)
        try expect(!c.serverChanged && !c.rejectedBaseURL)
        try expectEqual(r.config.baseURL, URL(string: "http://100.64.0.1:7337"))
        try expect(r.vault.token(.main) == "tok-SECRET-main")
        try expect(r.vault.token(.widget) == "tok-SECRET-widget")
    },
    TestCase("sync: re-applying the same payload changes nothing") {
        let r = Rig()
        _ = try r.applier.apply(full)
        let c = try r.applier.apply(full)
        try expectEqual(c, SyncChange())
        try expect(!c.any)
    },
    TestCase("sync: absent keys leave values unchanged") {
        let r = Rig()
        _ = try r.applier.apply(full)
        let c = try r.applier.apply(WatchSyncPayload())
        try expectEqual(c, SyncChange())
        try expect(r.config.baseURL != nil && r.vault.has(.main) && r.vault.has(.widget))
    },
    TestCase("sync: empty strings clear each value") {
        let r = Rig()
        _ = try r.applier.apply(full)
        let c1 = try r.applier.apply(WatchSyncPayload(widgetToken: ""))
        try expect(c1.widgetToken && !c1.mainToken && !c1.baseURL)
        try expect(!r.vault.has(.widget) && r.vault.has(.main))
        let c2 = try r.applier.apply(WatchSyncPayload(token: ""))
        try expect(c2.mainToken && !r.vault.has(.main))
        r.fillCache()
        let c3 = try r.applier.apply(WatchSyncPayload(baseURL: ""))
        try expect(c3.baseURL && c3.serverChanged)
        try expect(r.config.baseURL == nil)
        try expect(!r.cacheExists)
        // clearing already-empty values is not a change
        let c4 = try r.applier.apply(WatchSyncPayload(baseURL: "", token: "", widgetToken: ""))
        try expectEqual(c4, SyncChange())
    },
    TestCase("sync: invalid url is rejected and old value kept") {
        let r = Rig()
        _ = try r.applier.apply(full)
        for bad in ["ftp://x", "not a url"] {
            let c = try r.applier.apply(WatchSyncPayload(baseURL: bad))
            try expect(c.rejectedBaseURL && !c.baseURL && !c.any && !c.serverChanged, "bad url \(bad)")
            try expectEqual(r.config.baseURL, URL(string: "http://100.64.0.1:7337"))
        }
        let r2 = Rig()
        let c = try r2.applier.apply(WatchSyncPayload(baseURL: "ftp://x"))
        try expect(c.rejectedBaseURL && r2.config.baseURL == nil)
    },
    TestCase("sync: url with credentials and query is normalized") {
        let r = Rig()
        let c = try r.applier.apply(WatchSyncPayload(baseURL: "https://user:pw@example.com:8443/?token=abc#frag"))
        try expect(c.baseURL)
        try expectEqual(r.config.baseURL, URL(string: "https://example.com:8443"))
        let stored = r.config.baseURL?.absoluteString ?? ""
        try expect(!stored.contains("pw") && !stored.contains("abc"))
    },
    TestCase("sync: switching servers clears cache and seen set") {
        let r = Rig()
        _ = try r.applier.apply(full)
        r.fillCache()
        r.seen.seen = ["a", "b"]
        let c = try r.applier.apply(WatchSyncPayload(baseURL: "http://100.64.0.2:7337"))
        try expect(c.baseURL && c.serverChanged)
        try expect(!r.cacheExists)
        try expect(r.seen.seen.isEmpty)
    },
    TestCase("sync: first url on a fresh watch keeps cache and is not a server change") {
        let r = Rig()
        r.fillCache()
        r.seen.seen = ["a"]
        let c = try r.applier.apply(WatchSyncPayload(baseURL: "http://100.64.0.1:7337"))
        try expect(c.baseURL && !c.serverChanged)
        try expect(r.cacheExists && r.seen.seen == ["a"])
    },
    TestCase("sync: same server with trailing slash is not a change") {
        let r = Rig()
        _ = try r.applier.apply(full)
        r.fillCache()
        r.seen.seen = ["a"]
        let c = try r.applier.apply(WatchSyncPayload(baseURL: "http://100.64.0.1:7337/"))
        try expectEqual(c, SyncChange())
        try expect(r.cacheExists && r.seen.seen == ["a"])
    },
    TestCase("sync: changing only a token flags only that token") {
        let r = Rig()
        _ = try r.applier.apply(full)
        let c = try r.applier.apply(WatchSyncPayload(token: "tok-SECRET-main-2"))
        try expect(c.mainToken && !c.widgetToken && !c.baseURL && !c.serverChanged)
    },
    TestCase("sync: unpair clears everything") {
        let r = Rig()
        _ = try r.applier.apply(full)
        r.fillCache()
        r.seen.seen = ["a"]
        try r.applier.unpair()
        try expect(!r.vault.has(.main) && !r.vault.has(.widget))
        try expect(r.config.baseURL == nil && !r.cacheExists && r.seen.seen.isEmpty)
    },
    TestCase("sync: change descriptions never contain a token") {
        let r = Rig()
        let c = try r.applier.apply(full)
        try expect(!String(describing: c).contains("SECRET"), "description leaked")
        try expect(!String(reflecting: c).contains("SECRET"), "debug description leaked")
        try expect(!String(describing: full).contains("SECRET"), "payload description leaked")
        try expect(!String(reflecting: full).contains("SECRET"), "payload debug description leaked")
    },
    TestCase("sync: pairing server label formatting") {
        try expectEqual(PairingFormatting.serverLabel(nil), "Not set")
        try expectEqual(PairingFormatting.serverLabel(URL(string: "https://example.com")), "example.com")
        try expectEqual(PairingFormatting.serverLabel(URL(string: "http://100.64.0.1:7337")), "100.64.0.1:7337")
        try expectEqual(PairingFormatting.serverLabel(URL(string: "http://[fd7a::1]:7337")), "[fd7a::1]:7337")
        try expectEqual(PairingFormatting.serverLabel(URL(string: "http://[fd7a::1]")), "[fd7a::1]")
    },
]
