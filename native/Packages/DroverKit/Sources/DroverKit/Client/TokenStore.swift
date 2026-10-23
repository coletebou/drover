import Foundation

/// Which token a client uses. The raw value is the Keychain account.
public enum TokenScope: String, Sendable, CaseIterable {
    case main
    case widget
}

public protocol TokenStore: Sendable {
    func token(for scope: TokenScope) async throws -> String?
    /// `nil` deletes.
    func setToken(_ token: String?, for scope: TokenScope) async throws
}

public actor InMemoryTokenStore: TokenStore {
    private var tokens: [TokenScope: String]

    public init(_ tokens: [TokenScope: String] = [:]) { self.tokens = tokens }

    public func token(for scope: TokenScope) async throws -> String? { tokens[scope] }

    public func setToken(_ token: String?, for scope: TokenScope) async throws {
        tokens[scope] = token
    }
}
