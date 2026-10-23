import DroverKit
import Foundation

// Pairing through AppModel: a scripted daemon (DroverKit MockPairingTransport), memory token stores, throwaway
// defaults. Applying the connection points at 127.0.0.1:9 (nothing listens) and the model is stopped right after.
@MainActor
enum PairingTests {
    static let paired = "http://127.0.0.1:9"

    final class FailingTokenStore: TokenStore {
        func read() -> String? { nil }
        func write(_ token: String) throws { throw KeychainError(status: -34018) }
        func delete() throws { throw KeychainError(status: -34018) }
    }

    static func defaults(url: String? = nil) -> UserDefaults {
        let d = UserDefaults(suiteName: "harness-\(UUID())")!
        if let url { d.set(url, forKey: "drover.serverURL") }
        return d
    }

    static func model(url: String? = paired, token: String? = nil, group: UserDefaults? = nil,
                      widget: TokenStore = MemoryTokenStore(), main: TokenStore? = nil,
                      daemon: [MockPairingTransport.Answer]) -> (AppModel, MockPairingTransport) {
        let transport = MockPairingTransport(daemon)
        let pairing = PairingController(makeClient: { PairingClient(baseURL: $0, transport: transport, clock: MockPairingClock()) })
        let m = AppModel(settings: AppSettings(defaults: defaults(url: url), group: group), tokens: main ?? MemoryTokenStore(token),
                         widgetTokens: widget, service: MockDroverService(), pairing: pairing)
        return (m, transport)
    }

    static let created = MockPairingTransport.created(expiresAt: "2027-01-15T08:02:00.000Z")
    static let approved = MockPairingTransport.approved(token: "main-secret", widgetToken: "widget-secret")

    static func until(_ condition: () -> Bool) async -> Bool {
        for _ in 0..<400 where !condition() { try? await Task.sleep(for: .milliseconds(5)) }
        return condition()
    }

    static func run() async {
        await T.suite("Pairing at launch: only without a main token, only on loopback, once") {
            let (fresh, daemon) = model(url: nil, daemon: [created, .hang])
            T.eq(fresh.settings.serverURLString, "http://127.0.0.1:7337", "default URL")
            fresh.pairIfUnconfigured()
            T.check(fresh.pairing.phase.isActive, "no token + default loopback URL pairs at once")
            let done = await until { fresh.pairing.phase.code == "123456" }
            T.check(done, "code shown")
            T.eq(daemon.requests.first?.value(forHTTPHeaderField: "Authorization"), nil, "no token sent")
            fresh.pairing.cancel()
            fresh.pairIfUnconfigured()
            T.eq(fresh.pairing.phase, .idle, "once per launch")

            let (configured, _) = model(token: "x", daemon: [created])
            configured.pairIfUnconfigured()
            T.eq(configured.pairing.phase, .idle, "a stored main token: no pairing")

            let (remote, remoteDaemon) = model(url: "http://100.64.0.1:7337", daemon: [created])
            remote.pairIfUnconfigured()
            T.eq(remote.pairing.phase, .idle, "a remote daemon: pair only on request")
            T.eq(remoteDaemon.requests.count, 0)
        }
        await T.suite("Pairing stores both tokens, mirrors the URL to the App Group, applies") {
            let group = defaults()
            let widget = MemoryTokenStore()
            let (m, _) = model(group: group, widget: widget, daemon: [created, approved])
            T.eq(group.string(forKey: "drover.baseURL"), nil, "an unedited URL never reached the App Group")
            m.startPairing()
            let done = await until { m.pairing.phase == .paired }
            T.check(done, "paired, got \(m.pairing.phase)")
            m.stop()
            T.eq(m.tokens.read(), "main-secret")
            T.eq(widget.read(), "widget-secret")
            T.eq(m.tokenRevision, 1, "Settings re-reads the Keychain")
            T.eq(group.string(forKey: "drover.baseURL"), paired, "menu bar, Safari extension and widgets see the URL")
            T.eq(m.activeServerURL, paired, "connection applied")
            T.check(m.generation > 0, "reconfigured")
        }
        await T.suite("Pairing without a widget token clears the old one") {
            let widget = MemoryTokenStore("old-widget")
            let (m, _) = model(widget: widget, daemon: [created, MockPairingTransport.approved(token: "main-secret", widgetToken: nil)])
            m.startPairing()
            let done = await until { m.pairing.phase == .paired }
            T.check(done)
            m.stop()
            T.eq(widget.read(), nil, "no other daemon's widget token stays behind")
        }
        await T.suite("The tokens stay with the daemon that approved") {
            let (m, _) = model(daemon: [created, approved])
            m.startPairing()
            m.settings.serverURLString = "http://127.0.0.1:10"   // edited while the code was showing
            let done = await until { m.pairing.phase == .paired }
            T.check(done)
            m.stop()
            T.eq(m.settings.serverURLString, paired)
            T.eq(m.activeServerURL, paired)
        }
        await T.suite("A Keychain failure is shown and nothing is applied") {
            let (m, _) = model(main: FailingTokenStore(), daemon: [created, approved])
            let before = m.generation
            m.startPairing()
            let done = await until { !m.pairing.phase.isActive }
            T.check(done)
            guard case .failed(let message) = m.pairing.phase else { return T.fail("expected failed, got \(m.pairing.phase)") }
            T.check(message.hasPrefix("Paired, but the tokens could not be saved: Keychain error -34018"), message)
            T.check(!message.contains("secret"), "no token in the message")
            T.eq(m.generation, before, "not applied")
            T.eq(m.tokenRevision, 0)
        }
        await T.suite("A widget Keychain failure puts the previous main token back") {
            let (m, _) = model(widget: FailingTokenStore(), main: MemoryTokenStore("old-main"), daemon: [created, approved])
            let before = m.generation
            m.startPairing()
            let done = await until { !m.pairing.phase.isActive }
            T.check(done)
            guard case .failed = m.pairing.phase else { return T.fail("expected failed, got \(m.pairing.phase)") }
            T.eq(m.tokens.read(), "old-main", "the previous main token is back")
            T.eq(m.generation, before, "not applied")
            T.eq(m.tokenRevision, 0)

            let (fresh, _) = model(widget: FailingTokenStore(), daemon: [created, approved])
            fresh.startPairing()
            let freshDone = await until { !fresh.pairing.phase.isActive }
            T.check(freshDone)
            T.eq(fresh.tokens.read(), nil, "no main token before, none after")
        }
        await T.suite("Apply by hand cancels a pairing in flight; its late approval stores nothing") {
            let (m, daemon) = model(daemon: [created, .late(approved, after: .milliseconds(300))])
            m.startPairing()
            let polling = await until { daemon.requests.count == 2 }
            T.check(polling, "the approval is on its way")
            m.applyConnectionSettings()
            T.eq(m.pairing.phase, .idle, "cancelled at once")
            try await Task.sleep(for: .milliseconds(600))
            m.stop()
            T.eq(m.tokens.read(), nil, "the late approval stored nothing")
            T.eq(m.tokenRevision, 0)
            T.eq(m.pairing.phase, .idle)
        }
        await T.suite("A pair link for another daemon waits for a click; nothing changes before its approval") {
            let (m, daemon) = model(token: "old-main", daemon: [created, .late(approved, after: .milliseconds(300))])
            let before = m.generation
            let link = URL(string: "http://127.0.0.1:10")!   // nothing listens there either
            T.eq(m.open(url: URL(string: "drover://pair?url=http%3A%2F%2F127.0.0.1%3A10")!), .pair(link))
            T.eq(m.pairLink, link, "the sheet names the address")
            T.eq(m.pairing.phase, .idle, "no request before the click")
            T.eq(daemon.requests.count, 0)
            T.eq(m.settings.serverURLString, paired, "the server is still the one in use")
            T.eq(m.activeServerURL, paired)
            T.eq(m.generation, before, "not reconfigured: the stored token never goes to the link's address")
            m.confirmPairLink()
            let waiting = await until { m.pairing.phase.code == "123456" }
            T.check(waiting, "the code shows, got \(m.pairing.phase)")
            T.eq(daemon.requests.first?.url?.port, 10, "the pairing request goes to the link's daemon")
            T.eq(daemon.requests.first?.value(forHTTPHeaderField: "Authorization"), nil, "and carries no token")
            T.eq(m.generation, before, "nothing applied while the code waits")
            T.eq(m.tokens.read(), "old-main")
            m.confirmPairLink()
            T.eq(m.pairing.phase.code, "123456", "the same link again keeps the code")
            let done = await until { m.pairing.phase == .paired }
            T.check(done, "approved, got \(m.pairing.phase)")
            m.stop()
            T.eq(m.tokens.read(), "main-secret", "the approving daemon's token")
            T.eq(m.settings.serverURLString, link.absoluteString, "the server changes with the approval")
            T.check(m.generation > before, "and only then is the connection applied")
            m.dismissPairLink()
            T.eq(m.pairLink, nil)

            let (same, sameDaemon) = model(token: "x", daemon: [created, .hang])
            same.open(url: URL(string: "drover://pair?url=http%3A%2F%2F127.0.0.1%3A9%2F")!)
            T.check(same.pairing.phase.isActive, "pairing again with the daemon in use starts at once")
            let asked = await until { sameDaemon.requests.count == 2 }
            T.check(asked, "its code is asked for")
            T.eq(same.generation, 0, "and nothing else changes")
            same.dismissPairLink()
            T.eq(same.pairing.phase, .idle, "Cancel stops the link's pairing")
            T.eq(same.pairLink, nil)
        }
        await T.suite("PairLinkPolicy: only the daemon in use pairs by itself") {
            let mine = URL(string: "http://127.0.0.1:7337")!
            T.check(PairLinkPolicy.startsAutomatically(link: URL(string: "http://127.0.0.1:7337/")!, configured: mine), "trailing slash aside")
            T.check(PairLinkPolicy.startsAutomatically(link: URL(string: "HTTP://127.0.0.1:7337")!, configured: mine), "the scheme without case")
            T.check(!PairLinkPolicy.startsAutomatically(link: URL(string: "http://127.0.0.1:7338")!, configured: mine), "another port")
            T.check(!PairLinkPolicy.startsAutomatically(link: URL(string: "http://evil.example:7337")!, configured: mine), "another host")
            T.check(!PairLinkPolicy.startsAutomatically(link: URL(string: "https://mac.example.ts.net/Team")!,
                                                        configured: URL(string: "https://mac.example.ts.net/team")!), "the path exactly")
            T.check(!PairLinkPolicy.startsAutomatically(link: mine, configured: nil), "nothing set up: always ask")
            let words = PairLinkPolicy.confirmation(for: URL(string: "http://evil.example:7337")!, current: mine)
            T.check(words.contains("http://evil.example:7337") && words.contains("instead of http://127.0.0.1:7337"), words)
            T.check(!PairLinkPolicy.confirmation(for: mine, current: URL(string: "http://127.0.0.1:7337/")!).contains("instead of"),
                    "the daemon in use (or once paired): no other one to name")
        }
        await T.suite("Pairing buttons") {
            T.eq(PairingButtons.startTitle(.idle), "Pair with this daemon")
            T.eq(PairingButtons.startTitle(.paired), "Pair with this daemon")
            T.eq(PairingButtons.startTitle(.expired), "Try again")
            T.eq(PairingButtons.startTitle(.failed("x")), "Try again")
            T.eq(String(PairingStatus.markdown("run `drover pair approve 123456` now").characters), "run drover pair approve 123456 now",
                 "backticks render as code, not as text")
        }
    }
}
