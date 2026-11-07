import Foundation

/// The client before Settings has an address and a token: every call fails with `.notConfigured`,
/// so no screen ever shows invented data in a real build (mocks are only for injected previews and tests).
struct UnconfiguredDroverAPI: DroverAPI {
    func summary() async throws -> NativeSummary { throw DroverError.notConfigured }
    func notifications(since cursor: String?, wait: Int?) async throws -> NotificationFeed { throw DroverError.notConfigured }
    func sessions(host: String?) async throws -> [SessionInfo] { throw DroverError.notConfigured }
    func transcript(_ ref: SessionRef, since: Int?, limit: Int) async throws -> TranscriptPage { throw DroverError.notConfigured }
    func lastReply(_ ref: SessionRef) async throws -> LastReply { throw DroverError.notConfigured }
    func message(_ ref: SessionRef, text: String) async throws -> MessageResult { throw DroverError.notConfigured }
    func capture(host: String?, target: String, lines: Int) async throws -> ScreenCapture { throw DroverError.notConfigured }
    func sendKeys(host: String?, target: String, keys: [PaneKey]) async throws -> PaneSendResult { throw DroverError.notConfigured }
    func sendToPane(host: String?, target: String, text: String, enter: Bool) async throws -> PaneSendResult {
        throw DroverError.notConfigured
    }
    func upload(_ ref: SessionRef, name: String, mime: String, data: Data) async throws -> UploadResult {
        throw DroverError.notConfigured
    }
    func managerStatus(host: String?) async throws -> JSONValue { throw DroverError.notConfigured }
    func managerFeed(host: String?, limit: Int) async throws -> JSONValue { throw DroverError.notConfigured }
    func managerSweep(host: String?) async throws -> JSONValue { throw DroverError.notConfigured }
    func answerApproval(id: String, choice: Int, via: String) async throws -> ApprovalAnswerResult {
        throw DroverError.notConfigured
    }
    func approval(id: String) async throws -> ApprovalRequest? { throw DroverError.notConfigured }
    func events() -> AsyncThrowingStream<ServerEvent, Error> {
        AsyncThrowingStream { $0.finish(throwing: DroverError.notConfigured) }
    }
}
