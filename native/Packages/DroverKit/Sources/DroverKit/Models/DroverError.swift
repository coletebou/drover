import Foundation

/// Every failure DroverKit surfaces. Messages never contain a token or request headers.
public enum DroverError: Error, Sendable, Equatable, LocalizedError {
    /// No base URL, or no token stored for the scope.
    case notConfigured
    /// 401: the token is wrong or missing.
    case unauthorized
    /// 403: e.g. the widget token on a main-scope op.
    case forbidden(String?)
    /// `{ ok:false, error }` or another non-2xx answer.
    case server(status: Int, message: String?)
    /// The body did not match the model (message names the op and the field).
    case decoding(String)
    /// The request never got an answer (URLError and friends).
    case transport(String)
    case cancelled

    public var errorDescription: String? {
        switch self {
        case .notConfigured: "Set the server address and token in Settings."
        case .unauthorized: "The server did not accept the token."
        case .forbidden(let m): m.map { "Not allowed: \($0)" } ?? "Not allowed with this token."
        case .server(let status, let m): m.map { "Server error \(status): \($0)" } ?? "Server error \(status)."
        case .decoding(let m): "Unexpected answer from the server (\(m))."
        case .transport(let m): "Could not reach the server: \(m)"
        case .cancelled: "Cancelled."
        }
    }
}
