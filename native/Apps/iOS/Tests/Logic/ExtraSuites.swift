// Suites contributed by feature slices; each slice owns one <Slice>Tests.swift defining its list.
extension Suites {
    static var extra: [(String, () async throws -> Void)] {
        boardSuites + chatSuites + managerSuites + backgroundSuites + a11ySuites + approvalSuites + liveSuites
    }
}
