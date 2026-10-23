#if canImport(Security)
import Foundation
import Testing
@testable import DroverKit

@Suite struct KeychainTests {
    /// Unsigned CLI test binaries usually cannot use the data protection keychain; opt in with DROVERKIT_KEYCHAIN_TESTS=1.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["DROVERKIT_KEYCHAIN_TESTS"] == "1"))
    func roundTrip() async throws {
        let store = KeychainTokenStore(service: "dev.drover.test.\(UUID().uuidString)")
        #expect(try await store.token(for: .main) == nil)
        try await store.setToken("one", for: .main)
        try await store.setToken("two", for: .main)
        try await store.setToken("w", for: .widget)
        #expect(try await store.token(for: .main) == "two")
        #expect(try await store.token(for: .widget) == "w")
        try await store.setToken(nil, for: .main)
        try await store.setToken(nil, for: .widget)
        #expect(try await store.token(for: .main) == nil)
        try await store.setToken(nil, for: .main)
    }

    @Test func inMemoryStore() async throws {
        let store = InMemoryTokenStore()
        try await store.setToken("a", for: .widget)
        #expect(try await store.token(for: .widget) == "a")
        try await store.setToken(nil, for: .widget)
        #expect(try await store.token(for: .widget) == nil)
    }
}
#endif
