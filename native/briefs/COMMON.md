# Common rules for every window (read first)

You are an **Opus 5.5 orchestrator** (this session). Plan, split your feature into independent
slices, and run **Sonnet 5.5 workers in parallel git worktrees** (use the `parallel-worktrees` skill; Agent
tool with `model: "sonnet"`, `isolation: "worktree"`; worker count to match the slices, max ~6). Workers do
not make judgment calls: pre-decide interfaces in your prompt, then YOU verify each worker's output (read the
diff, run the checks yourself; a worker's "done" is a claim). You may also use `codex -p ultra exec` or
`codex -p altra exec` (GPT-6.1 Sol / Astra UltraFast) for an independent cross-model review of your
branch before you finish, and as additional workers if useful. Disclose any model substitution in your report.

Repo: `~/code/drover/native` (git, branch `master`). Work on branch `feat/<your-window>` in worktrees under
`~/code/drover-wt/<window>-<slice>`. Only edit the directories you own (listed in your brief);
shared files (`CONTRACT.md`, `script/`) only via a small, separate commit. Commit often; rebase on `master`
and fast-forward merge your branch into local `master` when green. Do not push anywhere (no remote yet).

**No Xcode license is accepted on this Mac**, so `xcodebuild` and `swift build` refuse to run. Do your
best: write idiomatic modern Swift (Swift 6 language mode, iOS 17+, macOS 14+, watchOS 10+), and verify with
`script/typecheck.sh <macos|ios|watchos> <paths>` (swiftc -typecheck against the real SDKs; no link, no
run). Pure-logic packages may also be tested with `swift test` only if it works; if it errors with the
license message, say so and rely on typecheck. Provide an XcodeGen spec (`project.part.yml` in your dir,
included by the root `project.yml`) so `xcodegen generate && xcodebuild` works as soon as the license is
accepted or on a GitHub macOS runner. State plainly in your final report what was typechecked, what was
only written, and what was never executed.

Security: never print, log or commit secrets (tokens, env values, Keychain contents, PAT URLs); say
"[redacted]". Synthetic fixtures only (see CONTRACT.md). Contact no third party: only the user's Drover
daemon. No analytics, no crash reporters, no remote fonts or scripts.

Server side: the Drover daemon is JS (`~/code/drover/web`, branch master, commit+push after each
change, tests `node --test test/*.test.js`). Only the **core** window edits it.

Final report (when finished, as your last message): what exists (paths), what was verified and how,
what was not, open risks, and what the owner must do (signing team id, license acceptance, provisioning).
