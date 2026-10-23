import Foundation
import Testing
@testable import DroverWidgetCore

struct DeepLinkTests {
    @Test(arguments: ["s-demo-build", "demo build", "a/b", "q?x#y", "100%", "démo-ü"],
          ["demo-mac", "", nil] as [String?])
    func roundTrip(id: String, host: String?) {
        let link = DroverDeepLink.session(id: id, host: host)
        let expectedHost = (host?.isEmpty ?? true) ? nil : host
        #expect(DroverDeepLink(url: link.url) == .session(id: id, host: expectedHost))
    }

    @Test func exactStrings() {
        #expect(DroverDeepLink.session(id: "s-demo-build", host: nil).url.absoluteString == "drover://session/s-demo-build")
        #expect(DroverDeepLink.session(id: "s-demo-build", host: "").url.absoluteString == "drover://session/s-demo-build")
        #expect(DroverDeepLink.session(id: "s-demo-build", host: "demo-mac").url.absoluteString
                == "drover://session/s-demo-build?host=demo-mac")
        #expect(DroverDeepLink.board.url.absoluteString == "drover://board")
    }

    @Test func encodesReservedCharactersInId() {
        #expect(DroverDeepLink.session(id: "a/b", host: nil).url.absoluteString == "drover://session/a%2Fb")
        #expect(DroverDeepLink.session(id: "q?x#y", host: nil).url.absoluteString == "drover://session/q%3Fx%23y")
    }

    @Test func parsesBoard() {
        #expect(DroverDeepLink(url: URL(string: "DROVER://board")!) == .board)
    }

    @Test(arguments: [
        "https://session/abc", "drover://manager", "drover://session", "drover://session/", "drover://session//",
        "drover://session/a/b", "drover://session/a/", "drover://other/abc",
    ])
    func rejects(_ string: String) {
        #expect(DroverDeepLink(url: URL(string: string)!) == nil)
    }

    @Test func emptyHostQueryIsNil() {
        #expect(DroverDeepLink(url: URL(string: "drover://session/x?host=")!) == .session(id: "x", host: nil))
    }
}
