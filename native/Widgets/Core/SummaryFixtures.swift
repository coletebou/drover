import Foundation

/// SYNTHETIC fixtures for previews, placeholders and tests (CONTRACT.md: no real names, hosts or ids).
enum SummaryFixtures {
    static let sampleJSON = #"""
    {
      "generatedAt": "2026-10-11T18:00:00Z",
      "hosts": [
        {"name": "demo-mac", "up": true, "waiting": 2, "working": 1, "idle": 3},
        {"name": "demo-box-1", "up": true, "waiting": 1, "working": 2, "idle": 1},
        {"name": "demo-box-2", "up": false, "waiting": 0, "working": 0, "idle": 0}
      ],
      "waiting": [
        {"id": "s-demo-build", "name": "demo-build", "host": "demo-mac", "engine": "claude",
         "since": "2026-10-11T17:52:00Z", "kind": "decision",
         "headline": "Pick a cache strategy: in-memory or on disk?"},
        {"id": "s-demo-review", "name": "demo-review", "host": "demo-box-1", "engine": "codex",
         "since": "2026-10-11T17:40:00Z", "kind": "question",
         "headline": "Should the retry limit stay at three?"},
        {"id": "s-demo-docs", "name": "demo-docs", "host": "demo-mac", "engine": "claude",
         "since": "2026-10-11T17:31:00.000Z", "kind": "question",
         "headline": "README rewrite is drafted. Merge it into the docs branch?"}
      ],
      "working": [
        {"id": "s-demo-tests", "name": "demo-tests", "host": "demo-mac", "engine": "claude",
         "headline": "Running the unit tests"},
        {"id": "s-demo-lint", "name": "demo-lint", "host": "demo-box-1", "engine": "codex",
         "headline": "Fixing lint warnings"},
        {"id": "s-demo-api", "name": "demo-api", "host": "demo-box-1", "engine": "headless",
         "headline": "Drafting the API notes"}
      ],
      "totals": {"waiting": 3, "working": 3, "idle": 4, "hosts": 3},
      "manager": {"up": true, "lastNoteAt": "2026-10-11T17:58:00Z"}
    }
    """#

    static let emptyJSON = #"""
    {"generatedAt": 1791760000000, "hosts": [{"name": "demo-mac", "up": true, "waiting": 0, "working": 0, "idle": 2}],
     "waiting": [], "working": [], "totals": {"waiting": 0, "working": 0, "idle": 2, "hosts": 1},
     "manager": {"up": false, "lastNoteAt": null}}
    """#

    static var sample: NativeSummary { decode(sampleJSON) }
    static var empty: NativeSummary { decode(emptyJSON) }

    private static func decode(_ json: String) -> NativeSummary {
        // Force-try is acceptable: the fixtures are compile-time constants covered by tests.
        try! JSONDecoder().decode(NativeSummary.self, from: Data(json.utf8))
    }
}
