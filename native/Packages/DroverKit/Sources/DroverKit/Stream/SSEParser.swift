import Foundation

/// Incremental Server-Sent Events parser (WHATWG rules). Pure value type.
public struct SSEParser: Sendable {
    private var eventName: String?
    private var dataLines: [String] = []
    private var lastEventID: String?
    /// Last `retry:` field the server sent.
    public private(set) var retry: Duration?

    public init() {}

    /// Feed one line without its newline. Returns an event when a blank line dispatches one.
    public mutating func feed(line rawLine: String) -> ServerEvent? {
        var line = Substring(rawLine)
        if line.last == "\r" { line = line.dropLast() }

        if line.isEmpty {
            defer { eventName = nil; dataLines = [] }
            guard !dataLines.isEmpty else { return nil }
            return ServerEvent(name: eventName.flatMap { $0.isEmpty ? nil : $0 } ?? "message",
                               data: dataLines.joined(separator: "\n"),
                               id: lastEventID)
        }
        if line.first == ":" { return nil }

        let field: Substring
        var value: Substring
        if let colon = line.firstIndex(of: ":") {
            field = line[line.startIndex..<colon]
            value = line[line.index(after: colon)...]
            if value.first == " " { value = value.dropFirst() }
        } else {
            field = line
            value = ""
        }

        switch field {
        case "event": eventName = String(value)
        case "data": dataLines.append(String(value))
        case "id":
            if !value.contains("\0") { lastEventID = String(value) }
        case "retry":
            if !value.isEmpty, value.allSatisfy({ $0.isASCII && $0.isNumber }), let ms = Int(value) {
                retry = .milliseconds(ms)
            }
        default: break
        }
        return nil
    }
}
