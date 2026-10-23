import Testing
@testable import DroverKit

@Suite struct MockServerTests {
    @Test func previewValuesAreNonEmpty() {
        #expect(!MockServer.summary.hosts.isEmpty)
        #expect(!MockServer.notifications.items.isEmpty)
        #expect(!MockServer.sessions.sessions.isEmpty)
        #expect(!MockServer.transcript.turns.isEmpty)
    }
}
