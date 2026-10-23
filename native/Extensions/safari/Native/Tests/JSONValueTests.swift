import XCTest

final class JSONValueTests: XCTestCase {
    func testNSNumberBoolVersusNumber() throws {
        XCTAssertEqual(try JSONValue(any: NSNumber(value: true)), .bool(true))
        XCTAssertEqual(try JSONValue(any: NSNumber(value: false)), .bool(false))
        XCTAssertEqual(try JSONValue(any: NSNumber(value: 1)), .number(1))
        XCTAssertEqual(try JSONValue(any: NSNumber(value: 0)), .number(0))
        XCTAssertEqual(try JSONValue(any: NSNumber(value: 2.5)), .number(2.5))
    }

    func testNSNumberFromJSONSerializationKeepsBools() throws {
        let raw = try JSONSerialization.jsonObject(with: Data(#"{"a":true,"b":1,"c":false,"d":0}"#.utf8))
        let value = try JSONValue(any: raw)
        XCTAssertEqual(value, .object(["a": .bool(true), "b": .number(1), "c": .bool(false), "d": .number(0)]))
    }

    func testBridgeRoundTrip() throws {
        let original: [String: Any] = [
            "s": "demo-build",
            "n": 3,
            "d": 1.5,
            "t": true,
            "nil": NSNull(),
            "list": [1, "two", false],
            "obj": ["k": "v"],
        ]
        let value = try JSONValue(any: original)
        let back = try JSONValue(any: value.anyValue)
        XCTAssertEqual(value, back)
        let bridged = value.anyValue as? [String: Any]
        XCTAssertEqual(bridged?["n"] as? Int, 3)
        XCTAssertEqual(bridged?["d"] as? Double, 1.5)
        XCTAssertEqual(bridged?["t"] as? Bool, true)
        XCTAssertTrue(bridged?["nil"] is NSNull)
    }

    func testUnsupportedValueThrows() {
        XCTAssertThrowsError(try JSONValue(any: Date()))
        XCTAssertThrowsError(try JSONValue(any: NSNumber(value: Double.nan)))
    }

    func testCodableRoundTrip() throws {
        let value: JSONValue = .object([
            "a": .array([.number(1), .number(2.5), .null, .bool(true), .string("x")]),
            "b": .object(["c": .bool(false)]),
        ])
        let data = try JSONEncoder().encode(value)
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: data), value)
    }

    func testDecodeKeepsBoolAndNumberApart() throws {
        let decoded = try JSONDecoder().decode(JSONValue.self, from: Data(#"[true,1,0,false]"#.utf8))
        XCTAssertEqual(decoded, .array([.bool(true), .number(1), .number(0), .bool(false)]))
    }

    func testJSONTextIsCompactAndSorted() {
        let value: JSONValue = .object(["b": .number(2), "a": .string("x/y"), "c": .number(0.5)])
        XCTAssertEqual(value.jsonText, #"{"a":"x/y","b":2,"c":0.5}"#)
    }
}
