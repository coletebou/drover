import Foundation

struct SSEEvent: Sendable, Equatable {
    var event: String
    var data: String
    var id: String?
}

/// Line-by-line Server-Sent Events parser (WHATWG rules). Feed it lines without the newline.
struct SSEParser {
    private var eventName: String?
    private var dataLines: [String] = []
    private var lastID: String?

    init() {}

    /// Returns an event when `line` is the blank line that ends one.
    mutating func feed(_ line: String) -> SSEEvent? {
        if line.isEmpty {
            defer { eventName = nil; dataLines = [] }
            guard !dataLines.isEmpty else { return nil }
            return SSEEvent(event: eventName ?? "message", data: dataLines.joined(separator: "\n"), id: lastID)
        }
        if line.hasPrefix(":") { return nil }
        let field: Substring
        var value: Substring
        if let colon = line.firstIndex(of: ":") {
            field = line[line.startIndex..<colon]
            value = line[line.index(after: colon)...]
            if value.hasPrefix(" ") { value = value.dropFirst() }
        } else {
            field = line[...]
            value = ""
        }
        switch field {
        case "event": eventName = String(value)
        case "data": dataLines.append(String(value))
        case "id": if !value.contains("\0") { lastID = String(value) }
        default: break // retry and unknown fields are ignored
        }
        return nil
    }
}
