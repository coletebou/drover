import Foundation

#if DROVER_DEV
/// The unentitled dev build only (tools/build-app.sh passes `-D DROVER_DEV`; the XcodeGen target never does).
/// It cannot read the shared Keychain item, so it reads the daemon's token file, takes the server from
/// `DROVER_URL`, keeps away from the App Group, the widgets and real notifications, and refuses writes to any
/// daemon but a test one unless `DROVER_DEV_ALLOW_WRITES=1`. Nothing here prints or logs the token.
enum DevConfig {
    static let env = ProcessInfo.processInfo.environment

    /// `DROVER_URL`, default http://127.0.0.1:7337.
    static var serverURL: String { env["DROVER_URL"].flatMap { $0.isEmpty ? nil : $0 } ?? "http://127.0.0.1:7337" }

    /// `$DROVER_STATE/token`, default ~/.local/state/drover/token.
    static var tokenFile: URL {
        let state = env["DROVER_STATE"].flatMap { $0.isEmpty ? nil : $0 }
            ?? FileManager.default.homeDirectoryForCurrentUser.appending(path: ".local/state/drover").path
        return URL(fileURLWithPath: state).appending(path: "token")
    }

    /// Real notifications (authorization prompt, banners) only when asked: the signed app already posts them.
    static var notificationsEnabled: Bool { env["DROVER_DEV_NOTIFY"] == "1" }

    /// Skip NSApp.activate() (window tests that should not take focus from whoever is typing).
    static var activates: Bool { env["DROVER_DEV_NO_ACTIVATE"] != "1" }

    /// Mutating ops reach the daemon only when it is a test daemon (port 7338) or writes are allowed explicitly,
    /// so a dev build pointed at the live daemon can never message a session or press a key in a pane.
    static func allowsWrites(to url: URL?) -> Bool {
        if env["DROVER_DEV_ALLOW_WRITES"] == "1" { return true }
        return url?.port == 7338
    }

    /// Ops that change something somewhere. Reads (board, transcript, capture, threads, follow) are fine.
    static let mutatingOps: Set<String> = [
        "sessions.message", "sessions.answer", "tmux.send", "tmux.keys", "tmux.answer", "tmux.new", "tmux.kill",
        "tmux.rename", "uploads.put", "openclaw.sweep", "launch.start", "headless.send", "headless.stop",
        "events.append", "features.upsert",
    ]
}

/// The daemon's token file, read-only (dev build). Never logged.
struct FileTokenStore: TokenStore {
    var url: URL
    func read() -> String? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        let s = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return s.isEmpty ? nil : s
    }
    func write(_ token: String) throws { throw DroverError.unsupported("Saving a token in the dev build") }
    func delete() throws { throw DroverError.unsupported("Removing the token in the dev build") }
}
#endif

/// Timings for a dev build (stderr, `open --stderr`); compiled out of the real app.
enum PerfLog {
    #if DROVER_DEV
    static let enabled = true
    #else
    static let enabled = false
    #endif

    /// Monotonic now, for `log(_:since:)`.
    static func now() -> UInt64 { DispatchTime.now().uptimeNanoseconds }

    static func log(_ label: String, since start: UInt64, _ detail: @autoclosure () -> String = "") {
        guard enabled else { return }
        let ms = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
        let extra = detail()
        FileHandle.standardError.write(Data("perf \(label) \(String(format: "%.1f", ms)) ms\(extra.isEmpty ? "" : " \(extra)")\n".utf8))
    }

    static func note(_ text: @autoclosure () -> String) {
        guard enabled else { return }
        FileHandle.standardError.write(Data("dev \(text())\n".utf8))
    }
}
