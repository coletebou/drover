# Fixtures

Synthetic only: invented names (`demo-build`, `demo-review`, `demo-box`), invented ids, no tokens.
Each `*.json` is the full HTTP response body of `POST /api/op/<op>` (the `{ ok, result, ms, cache }`
envelope), except `error.unauthorized.json` (the 401 body) and `events.sse.txt` (a raw
`GET /api/stream` capture, including a comment ping, an unknown event and a multi-line `data:`).
Timestamps in `native.*` are ISO 8601 strings; the older ops (`sessions.list`) use epoch numbers
(Claude in milliseconds, Codex in seconds), which DroverKit's `DroverTimestamp` accepts.

DroverKit embeds these files as Swift string constants (`Sources/DroverKit/Mock/Fixtures+Generated.swift`,
written by `script/gen-fixtures.sh`) so `MockServer` works in previews without a resource bundle.
Run the script after editing a fixture; the `FixturesInSync` test fails if you forget.
