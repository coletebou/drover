import Foundation
import Testing
@testable import MenuBarCore

@MainActor
struct PreferencesTests {
    private func makeDefaults() -> (UserDefaults, String) {
        let name = "test-\(UUID())"
        return (UserDefaults(suiteName: name)!, name)
    }

    private func cleanup(_ names: String...) {
        for n in names { UserDefaults.standard.removePersistentDomain(forName: n) }
    }

    @Test func defaultsWhenEmpty() {
        let (d, n) = makeDefaults(); defer { cleanup(n) }
        let store = PreferencesStore(defaults: d, shared: nil)
        #expect(store.value == .default)
    }

    @Test func roundTripsEveryField() {
        let (d, n) = makeDefaults(); defer { cleanup(n) }
        let combo = KeyCombo(keyCode: 0x2C, modifiers: [.command, .shift])
        let store = PreferencesStore(defaults: d, shared: nil)
        store.value = MenuBarPreferences(serverURL: "https://example.test:8443/x", pollSeconds: 120,
                                         openTarget: .webUI, notifyOnWaiting: false,
                                         notificationSound: false, hotkey: combo)
        let again = PreferencesStore(defaults: d, shared: nil)
        #expect(again.value == store.value)
        #expect(again.value.hotkey == combo)
    }

    @Test func roundTripsNilHotkey() {
        let (d, n) = makeDefaults(); defer { cleanup(n) }
        let store = PreferencesStore(defaults: d, shared: nil)
        store.value.hotkey = nil
        let again = PreferencesStore(defaults: d, shared: nil)
        #expect(again.value.hotkey == nil)
    }

    @Test func undecodableJSONYieldsDefaults() {
        let (d, n) = makeDefaults(); defer { cleanup(n) }
        d.set(Data("not json".utf8), forKey: "menubar.preferences")
        #expect(PreferencesStore(defaults: d, shared: nil).value == .default)
    }

    @Test func missingFieldsFallBackPerField() {
        let (d, n) = makeDefaults(); defer { cleanup(n) }
        d.set(Data(#"{"serverURL":"https://a.test","pollSeconds":30}"#.utf8), forKey: "menubar.preferences")
        let v = PreferencesStore(defaults: d, shared: nil).value
        #expect(v.serverURL == "https://a.test")
        #expect(v.pollSeconds == 30)
        #expect(v.openTarget == .mainAppThenWeb)
        #expect(v.notifyOnWaiting)
        #expect(v.notificationSound)
        #expect(v.hotkey == .defaultCombo)
    }

    @Test func sharedBaseURLFollowsValidity() {
        let (d, n) = makeDefaults()
        let (s, sn) = makeDefaults(); defer { cleanup(n, sn) }
        let store = PreferencesStore(defaults: d, shared: s)
        store.value.serverURL = "https://good.test/"
        #expect(s.string(forKey: AppIdentifiers.sharedBaseURLKey) == "https://good.test")
        store.value.serverURL = "ftp://bad"
        #expect(s.object(forKey: AppIdentifiers.sharedBaseURLKey) == nil)
    }

    @Test func onChangeFires() {
        let (d, n) = makeDefaults(); defer { cleanup(n) }
        let store = PreferencesStore(defaults: d, shared: nil)
        var seen: [Int] = []
        store.onChange = { seen.append($0.pollSeconds) }
        store.value.pollSeconds = 90
        #expect(seen == [90])
    }

    @Test func looksLikeToken() {
        #expect(KeychainTokenStore.looksLikeToken("abcdefghijklmnop"))
        #expect(KeychainTokenStore.looksLikeToken("  abcdefghijklmnop\n"))
        #expect(!KeychainTokenStore.looksLikeToken("short"))
        #expect(!KeychainTokenStore.looksLikeToken(""))
        #expect(!KeychainTokenStore.looksLikeToken("abcdefgh ijklmnopqr"))
        #expect(!KeychainTokenStore.looksLikeToken(String(repeating: "a", count: 513)))
        #expect(KeychainTokenStore.looksLikeToken(String(repeating: "a", count: 512)))
    }
}
