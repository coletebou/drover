import Foundation

protocol HTTPPerforming: Sendable {
    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

struct URLSessionHTTP: HTTPPerforming {
    private let session: URLSession

    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 20
        configuration.waitsForConnectivity = false
        self.session = URLSession(configuration: configuration)
    }

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (data, http)
    }
}

enum OpRequestBuilder {
    static func isValidOp(_ op: String) -> Bool {
        guard (1...64).contains(op.utf8.count) else { return false }
        var first = true
        for u in op.unicodeScalars {
            let isLetter = (u.value >= 65 && u.value <= 90) || (u.value >= 97 && u.value <= 122)
            let isDigit = u.value >= 48 && u.value <= 57
            if first {
                guard isLetter else { return false }
                first = false
            } else {
                guard isLetter || isDigit || u == "." || u == "_" || u == "-" else { return false }
            }
        }
        return true
    }

    static func make(base: URL, token: String, op: String, method: String,
                     args: [String: JSONValue]) throws(NativeError) -> URLRequest {
        guard isValidOp(op) else { throw .badRequest }
        guard method == "GET" || method == "POST" else { throw .badRequest }
        guard !token.isEmpty, !token.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F }) else {
            throw .badRequest
        }
        guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else { throw .badRequest }
        var path = components.percentEncodedPath
        while path.hasSuffix("/") { path.removeLast() }
        components.percentEncodedPath = path + "/api/op/" + op
        components.percentEncodedQuery = nil
        components.fragment = nil

        if method == "GET", !args.isEmpty {
            components.percentEncodedQuery = args.keys.sorted().map { key in
                let value = args[key] ?? .null
                let text = value.stringValue ?? value.jsonText
                return percentEncode(key) + "=" + percentEncode(text)
            }.joined(separator: "&")
        }
        guard let url = components.url else { throw .badRequest }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if method == "POST" {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data(JSONValue.object(args).jsonText.utf8)
        }
        return request
    }

    private static let unreserved = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~".utf8)

    static func percentEncode(_ s: String) -> String {
        var out = ""
        for byte in s.utf8 {
            if unreserved.contains(byte) {
                out.unicodeScalars.append(Unicode.Scalar(byte))
            } else {
                out += "%" + String(byte, radix: 16, uppercase: true).leftPad(2)
            }
        }
        return out
    }
}

private extension String {
    func leftPad(_ n: Int) -> String {
        count >= n ? self : String(repeating: "0", count: n - count) + self
    }
}
