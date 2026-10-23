import Foundation
import Testing
@testable import DroverKit

struct SSEParserTests {
    static func parse(_ text: String) -> [ServerEvent] {
        var p = SSEParser()
        var out: [ServerEvent] = []
        for line in text.unicodeScalars.split(separator: "\n", omittingEmptySubsequences: false).map({ String(String.UnicodeScalarView($0)) }) {
            if let e = p.feed(line: line) { out.append(e) }
        }
        return out
    }

    @Test func fixtureStream() throws {
        let text = String(decoding: try TestFixtures.data("events.sse.txt"), as: UTF8.self)
        let events = Self.parse(text)
        #expect(events.map(\.name) == ["hello", "mutation", "notify", "alerts", "future-thing", "message"])
        #expect(events.map(\.kind) == [.hello, .mutation, .notify, .alerts, .unknown, .unknown])
        #expect(events[5].data == "{\"multi\":\n\"line\"}")
        struct Hello: Decodable { let host: String; let ts: Double }
        let hello = try events[0].decode(Hello.self)
        #expect(hello.host == "local")
        #expect(hello.ts == 1791757200000)
    }

    @Test func commentsIgnoredAndCRLF() {
        let events = Self.parse(": ping\r\nevent: notify\r\ndata:x\r\n\r\n")
        #expect(events == [ServerEvent(name: "notify", data: "x")])
    }

    @Test func spaceStrippedOnce() {
        let events = Self.parse("data:  two\n\n")
        #expect(events.first?.data == " two")
    }

    @Test func retryAndIdPersist() {
        var p = SSEParser()
        #expect(p.feed(line: "retry: 1500") == nil)
        #expect(p.retry == .milliseconds(1500))
        _ = p.feed(line: "retry: soon")
        #expect(p.retry == .milliseconds(1500))
        _ = p.feed(line: "id: 7")
        _ = p.feed(line: "data: a")
        #expect(p.feed(line: "")?.id == "7")
        _ = p.feed(line: "data: b")
        #expect(p.feed(line: "")?.id == "7")
    }

    @Test func blankLineWithoutDataDispatchesNothing() {
        var p = SSEParser()
        _ = p.feed(line: "event: x")
        #expect(p.feed(line: "") == nil)
        _ = p.feed(line: "data")
        #expect(p.feed(line: "")?.data == "")
    }
}
