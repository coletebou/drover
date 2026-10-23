import Foundation

// Before / after timings of the board and event paths (tools/bench.sh). Inputs are files given on the command line
// (a saved fleet.summary and native.board, an SSE stream served over HTTP); nothing here prints their content.
//   bench <fleet.json> <board.json> <stream-url> [native-summary.json]

func ms(_ start: UInt64) -> Double { Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000 }
func median(_ xs: [Double]) -> Double { xs.sorted()[xs.count / 2] }
func time(_ label: String, runs: Int = 7, _ body: () throws -> Void) rethrows {
    var xs: [Double] = []
    for _ in 0..<runs { let t = DispatchTime.now().uptimeNanoseconds; try body(); xs.append(ms(t)) }
    print(String(format: "%-58@ median %8.1f ms  (min %.1f, max %.1f, %d runs)", label as NSString, median(xs), xs.min()!, xs.max()!, runs))
}

let args = CommandLine.arguments
guard args.count >= 4 else { print("usage: bench <fleet.json> <board.json> <stream-url> [native-summary.json]"); exit(2) }
let fleetData = try Data(contentsOf: URL(fileURLWithPath: args[1]))
let boardData = try Data(contentsOf: URL(fileURLWithPath: args[2]))
let nativeData = args.count > 4 ? try? Data(contentsOf: URL(fileURLWithPath: args[4])) : nil
print("fleet.summary \(fleetData.count / 1024) KB, native.board \(boardData.count / 1024) KB")

// MARK: board refresh

try time("before: JSONDecoder -> JSONValue, fleet.summary") { _ = try JSONDecoder().decode(JSONValue.self, from: fleetData) }
try time("after:  JSONValue.parse, fleet.summary") { _ = try JSONValue.parse(fleetData) }
let fleet = try JSONValue.parse(fleetData)["result"] ?? .null
let native = nativeData.flatMap { try? JSONValue.parse($0)["result"] }
time("before: BoardBuilder.build (fleet + native.summary)") { _ = BoardBuilder.build(fleet: fleet, native: native) }
try time("before: one refresh, decode + build (old decoder)") {
    let f = try JSONDecoder().decode(JSONValue.self, from: fleetData)
    let n = try nativeData.map { try JSONDecoder().decode(JSONValue.self, from: $0) }
    _ = BoardBuilder.build(fleet: f["result"] ?? .null, native: n?["result"])
}
try time("after:  one refresh, native.board parse + decode") {
    _ = BoardDecoder.snapshot(try JSONValue.parse(boardData)["result"] ?? .null)
}

// MARK: SSE: the old per-byte loop over URLSession.AsyncBytes vs the chunked delegate reader

let streamURL = URL(string: args[3])!

@Sendable func oldReader() async throws -> (events: Int, ms: Double) {
    let t = DispatchTime.now().uptimeNanoseconds
    let (bytes, _) = try await URLSession.shared.bytes(from: streamURL)
    var parser = SSEParser()
    var line: [UInt8] = []
    var n = 0
    for try await byte in bytes {
        guard byte == 0x0A else { line.append(byte); continue }
        if let m = parser.feed(line: String(decoding: line, as: UTF8.self)) {
            // The old mapper decoded every event's data, a fleet event's megabyte included.
            _ = try? JSONDecoder().decode(JSONValue.self, from: Data(m.data.utf8))
            n += 1
        }
        line.removeAll(keepingCapacity: true)
    }
    return (n, ms(t))
}

final class Counter: @unchecked Sendable {
    let lock = NSLock(); var n = 0
    func add() { lock.withLock { n += 1 } }
}

@Sendable func newReader() async throws -> (events: Int, ms: Double) {
    let t = DispatchTime.now().uptimeNanoseconds
    let count = Counter()
    let c = SSEConnection(skipData: ServerEventMapper.skipData, onOpen: {}, onMessage: { m in _ = ServerEventMapper.map(m); count.add() })
    try await c.run(URLRequest(url: streamURL), idleTimeout: 30)
    return (count.n, ms(t))
}

for (label, reader) in [("before: per-byte AsyncBytes + decode every event", oldReader), ("after:  chunked delegate, skipped data undecoded", newReader)] {
    var xs: [Double] = []
    var events = 0
    for _ in 0..<3 { let r = try await reader(); xs.append(r.ms); events = r.events }
    print(String(format: "%-58@ median %8.1f ms  (%d events)", "SSE \(label)" as NSString, median(xs), events))
}
