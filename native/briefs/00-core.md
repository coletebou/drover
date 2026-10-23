# Window 0: core (DroverKit + server side)  [runs first; others code against CONTRACT.md meanwhile]
Owns: `Packages/DroverKit/**`, `Fixtures/**`, `script/**`, root `project.yml`, and (in ~/code/drover/web, branch master) the
server additions in CONTRACT.md: `native.summary`, `native.notifications`, widget token scope, `DROVER_BIND`,
`DROVER_ALLOW_ORIGINS`. Server work: ops in a new `core/native.js` registered in `core/api.js` + `core/ops-meta.js`
(MCP tools generate automatically), tests in `test/native.test.js`, README section, commit+push, restart the daemon
(`launchctl kickstart -k gui/$(id -u)/dev.drover.daemon`) and dotsync/restart the box daemons at the end. Derive
`kind`/`headline` from the existing waiting/notify classification (see `core/tmux.js` classifyScreen and the
notify hook); another agent (notifications) is improving that: coordinate by reading its latest commits, do not edit its files.
DroverKit (SwiftPM, Swift 6, iOS17/macOS14/watchOS10): `DroverClient` (async/await URLSession, bearer from a
`TokenStore` protocol), Codable models matching the fixtures, `EventStream` (SSE over URLSession bytes with
reconnect/backoff), `SummaryStore` (observable, caches last summary to an App Group container for
widgets), `KeychainTokenStore` (access group configurable), `MockServer` helper for previews/tests, unit tests.
Also write root `project.yml` (XcodeGen) that `include:`s each `Apps/*/project.part.yml`, `Widgets/project.part.yml`,
and a `.github/workflows/build.yml` for a macOS runner (xcodegen + xcodebuild for each scheme, no secrets,
no signing) that stays inactive until the repo gets a remote.
Slices for workers: (a) server ops+tests, (b) DroverClient+models+fixtures, (c) EventStream+stores, (d) project.yml+CI.
