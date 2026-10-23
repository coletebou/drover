import Foundation
import Testing
@testable import DroverWidgetCore

@Suite struct WidgetCredentialsTests {
    @Test func trimsAndStripsTrailingSlash() throws {
        let c = try #require(WidgetCredentials.resolve(baseURLString: "  http://demo-host:7337/ \n", token: " demo-token\n"))
        #expect(c.baseURL.absoluteString == "http://demo-host:7337")
        #expect(c.token == "demo-token")
    }

    @Test func keepsPathPrefix() throws {
        let c = try #require(WidgetCredentials.resolve(baseURLString: "https://demo-host/drover/", token: "t"))
        #expect(c.baseURL.absoluteString == "https://demo-host/drover")
    }

    @Test func rejectsEmptyValues() {
        #expect(WidgetCredentials.resolve(baseURLString: nil, token: "t") == nil)
        #expect(WidgetCredentials.resolve(baseURLString: "http://h", token: nil) == nil)
        #expect(WidgetCredentials.resolve(baseURLString: "  ", token: "t") == nil)
        #expect(WidgetCredentials.resolve(baseURLString: "http://h", token: " \n") == nil)
    }

    @Test func rejectsNonHTTPAndGarbage() {
        #expect(WidgetCredentials.resolve(baseURLString: "ftp://demo-host", token: "t") == nil)
        #expect(WidgetCredentials.resolve(baseURLString: "demo-host:7337", token: "t") == nil)
        #expect(WidgetCredentials.resolve(baseURLString: "http://", token: "t") == nil)
        #expect(WidgetCredentials.resolve(baseURLString: "not a url", token: "t") == nil)
    }
}
