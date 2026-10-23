import Foundation
import Testing
@testable import DroverWidgetCore

@Suite struct SummaryFetcherTests {
    private func creds(_ base: String) throws -> WidgetCredentials {
        try #require(WidgetCredentials.resolve(baseURLString: base, token: "demo-token"))
    }

    private func body(_ s: String) -> Data { Data(s.utf8) }

    private func failure(_ s: String, _ code: Int) -> SummaryFetchError? {
        do { _ = try SummaryFetcher.parse(data: body(s), statusCode: code); return nil }
        catch { return error }
    }

    @Test func requestURLs() throws {
        #expect(SummaryFetcher.request(for: try creds("http://h:7337")).url?.absoluteString == "http://h:7337/api/op/native.summary")
        #expect(SummaryFetcher.request(for: try creds("http://h:7337/")).url?.absoluteString == "http://h:7337/api/op/native.summary")
        #expect(SummaryFetcher.request(for: try creds("http://h:7337/drover")).url?.absoluteString == "http://h:7337/drover/api/op/native.summary")
        #expect(SummaryFetcher.request(for: try creds("http://h:7337/drover/")).url?.absoluteString == "http://h:7337/drover/api/op/native.summary")
    }

    @Test func requestHeaders() throws {
        let req = SummaryFetcher.request(for: try creds("http://h"))
        #expect(req.httpMethod == "GET")
        #expect(req.value(forHTTPHeaderField: "Authorization") == "Bearer demo-token")
        #expect(req.value(forHTTPHeaderField: "Accept") == "application/json")
        #expect(req.cachePolicy == .reloadIgnoringLocalCacheData)
    }

    @Test func parsesOkEnvelope() throws {
        let json = "{\"ok\":true,\"ms\":3,\"cache\":false,\"result\":\(SummaryFixtures.sampleJSON)}"
        let r = try SummaryFetcher.parse(data: body(json), statusCode: 200)
        #expect(r.summary == SummaryFixtures.sample)
        let again = try JSONDecoder().decode(NativeSummary.self, from: r.resultJSON)
        #expect(again == r.summary)
    }

    @Test func okFalseIsServerError() {
        #expect(failure("{\"ok\":false,\"error\":\"boom\"}", 200) == .server("boom"))
        #expect(failure("{\"ok\":false}", 200) == .server("unknown error"))
    }

    @Test func authFailures() {
        #expect(failure("", 401) == .unauthorized)
        #expect(failure("", 403) == .unauthorized)
        #expect(failure("{\"ok\":false,\"error\":\"widget token: read-only scope\"}", 403) == .unauthorized)
    }

    @Test func otherHTTPFailures() {
        #expect(failure("{\"ok\":false,\"error\":\"bad\"}", 500) == .server("bad"))
        #expect(failure("oops", 500) == .http(500))
        #expect(failure("{}", 404) == .http(404))
    }

    @Test func malformedSuccess() {
        #expect(failure("<html>", 200) == .decoding)
        #expect(failure("{\"ok\":true}", 200) == .decoding)
        #expect(failure("{\"ok\":true,\"result\":[1]}", 200) == .decoding)
    }
}
