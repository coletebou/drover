import Foundation

// Every slice owns one suite file (CoreTests.swift, ListTests.swift, RepliesTests.swift,
// SyncTests.swift, BackgroundTests.swift) and exports `let <slice>Tests: [TestCase]`.
let suites: [(String, [TestCase])] = [
    ("core", coreTests + coreModelExtraTests),
    ("list", listTests),
    ("replies", repliesTests),
    ("sync", syncTests),
    ("background", backgroundTests),
    ("approvals", approvalTests),
    ("live", approvalLiveTests),
]

var passed = 0, failed = 0
for (suite, cases) in suites {
    for t in cases {
        StubURLProtocol.reset()
        do {
            try await t.body()
            passed += 1
            print("ok   \(suite): \(t.name)")
        } catch {
            failed += 1
            print("FAIL \(suite): \(t.name)\n     \(error)")
        }
    }
}
print("\(passed) passed, \(failed) failed")
exit(failed == 0 ? 0 : 1)
