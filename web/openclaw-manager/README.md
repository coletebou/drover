# openclaw-manager: Drover's OpenClaw fleet managers, installed from this directory

An OpenClaw manager is an OpenClaw 2026.10.1 gateway on loopback that runs the agent fleet through
the `drover` MCP tools and records what changed in the Drover truth file. It has full powers: OpenClaw's
`full` tool profile, exec with `security: full` and no approval prompts, files anywhere, web fetch, and
every `drover` tool (the MCP server does not limit a manager's writes). Its standing orders keep only
merges, deploys, production, force-pushes, large deletes, secrets, spending and messages to people for
the owner. Its model paths and phone-home off-switches are fixed by the files here.

Design: `docs/specs/2026-10-11-openclaw-manager-design.md`. This directory, plus an optional private
overlay (below), is the only source: no host-side copy is edited by hand, and `drover manager setup`
re-renders everything it owns.

## Install, update, remove

```bash
drover manager setup --scope all --exclude laptop --digest --actor manager --dry-run   # the plan; changes nothing
drover manager setup --scope all --exclude laptop --digest --actor manager   # an always-on box that covers the fleet
drover manager setup --scope local --actor manager-laptop                   # a laptop that covers itself
drover manager setup --profile mine --overlay ~/private/openclaw-manager --scope all --digest --actor manager
drover manager setup                       # later: refresh from this checkout (scope, profile and overlay from the manifest)
drover manager roles                       # the roles this checkout and the overlay define
drover manager profiles                    # the profiles this checkout and the overlay define
drover manager status                      # service, gateway, health, automations, cost, install, checks
drover manager check --live                # egress check against the profile, plus the gateway's TCP peers
drover manager uninstall [--purge]         # --purge also deletes state, memory and secrets
```

`setup` is idempotent: a second run with nothing changed writes nothing and restarts nothing. It
restarts the service only when the launcher, the service file, the OpenClaw tree or node changed (or the
gateway was not running); a config change alone is hot-reloaded by OpenClaw. `--restart never|always`
overrides that. It never prints a secret, and never deletes the pre-installer install dirs: it reports
them (`legacy` steps) for removal by hand once the new install is verified.

What it does, in order: picks the newest fnm node inside OpenClaw's own `engines` range; `npm ci`s the
committed lockfile and applies `npm/patches.json` into `~/.local/share/drover/openclaw/<version>-<lock sha>-p<patch sha>/`
(a new tree per lockfile and patch set, so a running gateway's tree is never rewritten; a patch whose anchor
does not occur exactly once fails the install); creates `~/.openclaw-manager/.env` once from the profile's
sources; renders `openclaw.json` (keeping the keys OpenClaw writes itself: `meta`, `wizard`,
`agents.entries`); refreshes the standing orders and seeds the other workspace files once; writes
`bin/ro`, `bin/run-gateway` and `bin/oc`; writes the service (systemd unit or launchd plist); runs
`openclaw config validate`; on a first install imports `exec-approvals.json` through `openclaw doctor
--fix`, later keeps the stored policy at that file's; (re)starts the service;
writes the manifest `~/.openclaw-manager/drover-install.json`; then, once the gateway answers, creates the
role's missing automations, edits the existing ones in place to the role's definition, and reads `openclaw health`.

## What lives where

| In this directory (or the overlay) | On the host |
|---|---|
| `npm/package.json`, `npm/package-lock.json`: the pinned OpenClaw tree (563 packages, every platform's optional binaries); `npm/patches.json`: the edits setup makes to that tree (`heartbeat-thinking`) | `~/.local/share/drover/openclaw/2026.10.1-<lock sha>-p<patch sha>/` (`npm ci`, then the patches; the last two trees are kept) |
| `openclaw.json`: the gateway config template; `{{NODE}}`, `{{DROVER_BIN}}`, `{{HOME}}`, `{{ACTOR}}`, `{{HEARTBEAT_PROMPT}}` and the profile's `{{PORT}}`, `{{OTEL_ENDPOINT}}`, `{{CLIPROXY_API_KEY}}` are whole-string tokens (OpenClaw itself owns `${NAME}` env refs). It holds no key: each is a token or an env ref | `~/.openclaw-manager/openclaw.json` (0600) |
| `profiles/<p>.json`: what the gateway talks to: its config template, where each secret comes from, extra environment, the template values, the egress allowlist | `~/.openclaw-manager/.env` (0600, created once; only the profile's names) |
| `roles/<r>/role.json`: default profile, heartbeat prompt and `heartbeatThinking` (the sweep's effort: OpenClaw's heartbeat config takes a model but no thinking level, and a `/think` directive in the prompt never reaches the turn, so the launcher exports `OPENCLAW_HEARTBEAT_THINKING` and the `heartbeat-thinking` patch passes it as the run's level), duties with their automations, model and thinking (setup creates, edits in place, enables and disables them) | the rendered config, `bin/run-gateway` and `openclaw automations` |
| `roles/<r>/AGENTS.md` (standing orders, every run), `roles/<r>/MEMORY.md` and `workspace/{SOUL,USER,IDENTITY}.md` (seeded once; the manager's own memory afterwards) | `~/.openclaw-manager/workspace/` |
| `workspace/<profile>/<file>`: a profile's own seed, used instead of `workspace/<file>` | `~/.openclaw-manager/workspace/` |
| `bin/ro`: a read-only helper shell (`ro help`), kept as a quick way to look without side effects | `~/.openclaw-manager/bin/ro` |
| `exec-approvals.json`: the exec policy (full, ask off, full fallback); setup keeps the stored policy at it (`openclaw approvals set --stdin`) | the state database (`openclaw approvals get`) |
| `systemd/openclaw-manager.service` (Linux; static, runs the launcher) or the plist `setup` renders (macOS, `dev.drover.manager`) | `~/.config/systemd/user/` or `~/Library/LaunchAgents/` |
| generated: `bin/run-gateway` (the service runs it: pinned node and tree, the secrets, the profile env, every egress switch) and `bin/oc` (the same environment for the CLI by hand, e.g. `~/.openclaw-manager/bin/oc gateway auth-token --show`) | `~/.openclaw-manager/bin/` |
| `bin/manager-say`: talk to a manager over `POST /v1/chat/completions` on loopback (the owner's conversation, `drover:<DROVER_OWNER>`, unless `MANAGER_SAY_USER` names another) | run from here |
| `env.example`: the secret names of the `default` profile, with where each comes from | |

Log: `~/.local/state/logs/openclaw-manager.log` on every host. Drover reads the manifest for the node and
tree it runs the console's CLI calls with (`openclaw.status`, `openclaw.check`, `openclaw.sweep`), and
starts that CLI with a clean environment plus the gateway token: never the daemon's own environment,
which holds other providers' keys (OpenClaw itself reads the manager's `.env` from its state dir). The
generated wrappers do the same for the gateway and for `oc` run by hand: they re-run themselves under
`env -i` with an allowlist before loading `.env`, so a shell that exports `OPENAI_API_KEY` cannot hand it on.

## One role, a scope per install, and profiles

Drover runs on many kinds of machines, so the code knows no identity, box or provider: a box without
`~/.openclaw-manager` has no manager and every console op says `configured: false`. Every manager runs
the same role (`roles/manager/`: one set of standing orders, one heartbeat prompt, tools); what one
install covers is its scope, given to setup and kept in its manifest:

- `--scope local` (this host only) or `--scope all` (every host in `drover_fleet` it reaches), with
  `--exclude` for hosts that run their own manager. Two managers never sweep the same host, so pins,
  nudges, drives and notes are never doubled.
- `--digest` on the one manager that owns the 07:00 UTC `fleet-digest` and the merge-request watch; the others get
  neither the duty's tools nor the automation (setup disables it where the
  duty moved away, and re-enables it where it comes back).
- `--actor`: the WAL actor (`manager`, or `manager-<name>`); kept from the manifest so history and alerts
  stay continuous.

Every 5 minutes each manager sweeps its hosts and drives stopped sessions forward (Program 1 in
`roles/manager/AGENTS.md`): a session that stopped mid-task or asked a question at its prompt gets one
drive message telling it to continue, take its recommended option, or say what it needs from the owner; a
question dialog gets its recommended option only when that is reversible and local. Permission prompts
and anything destructive or outward-facing stay pinned for the owner.

The orders, prompt and memory seed are templates (`{{ACTOR}}`, `{{SCOPE}}`, `{{OWNER_NAME}}`, `{{OWNER}}`,
`{{DROVER_REPO}}`, `{{#digest}}...{{/digest}}`) that setup fills per install. The owner is configuration:
`DROVER_OWNER` (the WAL actor and MR author, default `owner`) and `DROVER_OWNER_NAME` (how the orders name
them, default "the owner"). Installs from before scopes migrate on their next plain `drover manager setup`:
role `fleet` became `--scope all --exclude macbook --digest --actor manager`, role `mac` became
`--scope local --actor manager-mac`.

| Example host | Scope | Actor | Service |
|---|---|---|---|
| an always-on Linux box | every host it reaches except `laptop`, owns the digest | `manager` | systemd |
| the laptop (a host no other box can reach, e.g. no SSH server) | this host | `manager-laptop` | launchd |

The `default` profile: commercial Bedrock in us-east-1 (Mantle and runtime, one bearer), the loopback
CLIProxyAPI (its key from `~/.env_secrets`, handed to the gateway as `${CLIPROXY_API_KEY}`), Exa, traces
to a Langfuse on this host (`127.0.0.1:3000`); every secret from `~/.env_secrets`, gateway port 18789. A
profile sets `port` and the template's `vars` (`{{OTEL_ENDPOINT}}`, `{{CLIPROXY_API_KEY}}`); pick one at
the first install with `--profile` (later runs keep the manifest's). Another kind of manager is a new
`profiles/<p>.json` (and a config template if it needs one), not a code change.

## The private overlay

What one fleet needs and nobody else should see (its profiles with their endpoints and secret sources, its
own standing orders, the facts its manager is seeded with) lives outside this repo, in an overlay: a
directory laid out like this one. Name it with `DROVER_OPENCLAW_OVERLAY` (or `--overlay`, which wins);
`setup` records it in the manifest, so later runs, `drover manager status` and `check` read the same files
even from a shell or a daemon without the variable. `DROVER_OPENCLAW_OVERLAY=none` (or `--overlay none`)
turns it off.

- A file at `profiles/<p>.json`, `roles/<r>/role.json`, `roles/<r>/AGENTS.md`, `roles/<r>/MEMORY.md` or
  `workspace/[<profile>/]<file>` there is used instead of this directory's file at the same path; one this
  directory lacks is added (a profile or a role of your own). Each file stands on its own: an overlay may
  replace the orders and keep this checkout's `role.json`.
- A profile's config template (`openclaw.json` unless it names another) is looked up the same way.
- The lockfile, patches, `bin/`, `exec-approvals.json` and the systemd unit always come from this directory.
- Each run reports the files the overlay supplied (the `overlay` step, names only). A named overlay that is
  not a directory fails the run; an install whose profile is only in the overlay fails closed when the
  overlay is turned off (`no profile <p>`), and its console checks say the profile is not found.

To start one: copy `profiles/default.json` to `<overlay>/profiles/<name>.json`, change what differs (the
port, `OTEL_ENDPOINT`, where each secret comes from, the egress allowlist), and add `workspace/<name>/USER.md`
with what the manager should know about you and your projects.

Primary model (revised 2026-10-11): GPT-6.1 Sol UltraFast at max thinking through the proxy alias
`gpt-6.1-sol-ultrafast-br` (an alias the loopback CLIProxyAPI config must define); GPT-6 Astra stays as
the first fallback (Mantle standard tier) and as an on-demand UltraFast `/model` row.

Efforts (2026-10-21): chats run at `thinkingDefault: max`, the sweep on Luna at the role's
`heartbeatThinking` (`high`), the `fleet-digest` on GPT-6 Astra (Mantle standard tier) at `max`, and
compaction at `low`; `drover manager status` shows the sweep's level next to its model. A run lowers a
level its model row does not list (`compat.supportedReasoningEfforts`) to the highest listed one below
it, so the row caps every run on that model: the Astra row lists `max` for the digest, Luna's stops at
`high`. Mantle itself accepts `max` for both (`/openai/v1/responses`, probed 2026-10-21).

Known gaps recorded in the spec: `openai.gpt-6.1-luna` does not exist on Bedrock (uses
`openai.gpt-6-luna`). The `usage-cost --json` figure is today's total, final only when
`cacheStatus.status` is `fresh` (the status op reports both).

## Decisions applied on 2026-10-13 (verified live on the first install)

All four are hot-reload paths in OpenClaw 2026.10.1 (`docs/gateway/configuration/hot-reload.md`:
`tools`, `skills`, `models` need no restart); the gateway log showed `config hot reload applied`
for each and the unit was not restarted.

### Weekly skill review: off
`skills.workshop.autonomous.mode` is `"off"` (schema values: `off`, `propose`, `auto`; default
`auto`). `auto` runs the weekly `skill-collection-review` job and applies Workshop edits with the
normal file tools, which matters now that the manager can write in its workspace. After the change
the gateway converged the system-owned job: `openclaw cron list --all --json` shows
`skill-collection-review-main` with `enabled: false` and no `nextRunAtMs` (it was due
2026-10-14T20:35:57Z). `off` keeps only the suggestion nudge; nothing is captured or applied.

### File writes: workspace only (superseded on 2026-10-22 by the full tool profile above; kept for the record)
Before: `tools.deny` held `write`/`edit`/`apply_patch` and `ro` is read-only, so Program 1 could
not update `memory/state/last-sweep.md` (stuck at `ts: never`) and the first `fleet-digest` run
failed to write `digests/2026-10-13.md`. Now:
- `write` and `edit` are removed from `tools.deny` and added to `tools.alsoAllow` (the `minimal`
  profile only includes `session_status` and update-only `gateway`, so removing the deny alone
  does not expose them).
- `tools.fs.workspaceOnly: true` confines `read`/`write`/`edit`/`apply_patch` to
  `~/.openclaw-manager/workspace` (schema description; `docs/gateway/security/tool-permissions.md`).
  This also confines `read`, which matches AGENTS.md ("`read`: files in this workspace"); `ro`
  is still the only way to read the rest of `$HOME`.
- Unchanged: `apply_patch` stays denied (and `tools.exec.applyPatch.enabled: false`); `exec` stays
  `security=allowlist` with only `bin/ro`, `ask=off`, `askFallback=deny` (`openclaw approvals get
  --gateway`).

Verified on 2026-10-13:
- The 20:20:57Z heartbeat called `write` then `read` and rewrote `memory/state/last-sweep.md`
  (`ts: 2026-10-13T20:24:00Z`).
- `openclaw automations run fb32f853-2a63-4114-befe-b5e3ee5e559d --wait` finished `ok` and wrote
  `workspace/digests/2026-10-13.md` (2860 bytes, no secret patterns).
- Outside writes are refused. A throwaway session asked to `write` `/tmp/x` and
  `../x-outside-probe`; the trajectory shows two real `write` calls, both errors:
  `Path escapes sandbox root (~/.openclaw-manager/workspace)`. Neither file exists.

### Mantle (Luna, Astra standard): fixed
Symptom: every `amazon-bedrock-mantle` call since install returned `401 Invalid bearer token`
(372 in the gateway log, 0 successes), so Luna runs (heartbeat, digest, compaction, memory flush,
dreaming) fell back to `amazon-bedrock/us.anthropic.claude-sonnet-5-5`. Two separate faults, one
under the other:
1. **Auth (the 401).** `apiKey` was the string `"env:AWS_BEARER_TOKEN_BEDROCK"`, copied from the
   example in `docs/providers/bedrock-mantle.md`. OpenClaw 2026.10.1 only treats `${NAME}`, `$NAME`
   or a `{source:"env",provider,id}` SecretRef as an env reference (`dist/types.secrets-*.mjs`,
   `parseEnvTemplateSecretRef`); `env:NAME` is none of those and is not a known marker
   (`dist/model-auth-markers-*.mjs`). So `resolveUsableCustomProviderApiKey`
   (`dist/model-auth-provider-config-*.mjs`) returned it as a literal key, and the literal text went
   out as the bearer. Reproduced with curl: `Authorization: Bearer env:AWS_BEARER_TOKEN_BEDROCK`
   gets exactly `401 {"code":"invalid_api_key","message":"Invalid bearer token"}`. (The plugin's
   own implicit-discovery path emits the same `env:` marker, so the doc example looks valid; with
   discovery disabled it is just a string.) Fix: `"apiKey": "${AWS_BEARER_TOKEN_BEDROCK}"`, the form
   `EXA_API_KEY` already uses.
2. **Route (hidden behind the 401).** With the real bearer, `https://bedrock-mantle.us-east-1.api.aws/v1`
   only lists models (`GET /v1/models` 200, which is why the earlier bearer check passed);
   `POST /v1/chat/completions` and `/v1/responses` answer 400 "isn't supported on this route" for
   `openai.gpt-6-luna` and `openai.gpt-6-astra`. The OpenAI first-party models live under
   `/openai/v1`, the same base `~/.cli-proxy-api/config.yaml` (`codex-api-key` rows) and codex's
   built-in `amazon-bedrock` provider use. On `/openai/v1`, chat/completions still refuses function
   tools combined with `reasoning_effort` for Luna ("use /v1/responses"), so the provider now uses
   `api: "openai-responses"`, the codex wire. Probed `/openai/v1/responses` directly: tools,
   instructions, `store`, `prompt_cache_key`, `include: reasoning.encrypted_content`, streaming and
   efforts `none|low|medium|high|xhigh` all return 200 for Luna (`minimal` is rejected; the
   config lists only `low|medium|high`).

Region and model ids were already right (us-east-1, `openai.gpt-6-luna`, `openai.gpt-6-astra`).
Verified on 2026-10-13 after the hot reload: one gateway turn `openclaw agent --model
amazon-bedrock-mantle/openai.gpt-6-luna` answered `luna-ok` with `executionTrace.winnerModel =
openai.gpt-6-luna`, `fallbackUsed = false`; the 20:20:57Z heartbeat ran end to end on Luna
(`sessions tail`: `model.completed amazon-bedrock-mantle/openai.gpt-6-luna done`, 271 s, `ok`);
the `fleet-digest` run reports `provider amazon-bedrock-mantle, model openai.gpt-6-luna`; one Astra
standard turn answered `astra-ok` on `openai.gpt-6-astra`. Note: `openclaw sessions list` shows the
session's default model (`cliproxy/...`) in its `model` column, not the model that ran; read
`sessions tail` or the run's `executionTrace` instead.

### Prices: every configured model now has a real cost row
Before, Luna, Astra standard and both Claude rows cost 0, and the Astra UltraFast row had only its
output price, so `usage-cost` read $0 for the traffic that ran. Units are
USD per 1M tokens, which is what OpenClaw's calculator expects (`dist/usage-cost-*.mjs`:
`tokens * rate / 1e6`). No number below is an estimate.

| Model row | input | output | cacheRead | cacheWrite | long context (more than 272K input tokens) | Source |
|---|---|---|---|---|---|---|
| `amazon-bedrock/us.anthropic.claude-sonnet-5-5` | 2.20 | 11.00 | 0.11 | 2.75 (5m) | none listed | A, cross-check C |
| `amazon-bedrock/us.anthropic.claude-opus-5-5` | 4.40 | 22.00 | 0.22 | 5.50 (5m) | none listed | A, cross-check C |
| `amazon-bedrock-mantle/openai.gpt-6-luna` | 0.11 | 0.55 | 0.011 | 0.1375 | 0.22 / 0.825 / 0.022 / 0.275 | B1 |
| `amazon-bedrock-mantle/openai.gpt-6-astra` (Standard) | 11.00 | 55.00 | 1.10 | 13.75 (30m) | 22 / 82.50 / 2.20 / 27.50 | B2, D |
| `cliproxy/gpt-6-astra-ultrafast-br` (Astra, UltraFast) | 66.00 | 330.00 | 6.60 | 82.50 (30m) | 132 / 495 / 13.20 / 165 | B2 |
| `cliproxy/gpt-6.1-sol-ultrafast-br` (6.1 Sol, UltraFast) | 13.20 | 66.00 | 0.66 | 16.50 (30m) | 26.40 / 99 / 1.32 / 33 | B3 (unchanged; the old row already matched) |

Long-context rates go in `cost.tieredPricing` with `range: [0, 272001]` and `[272001]`: AWS
applies them to the whole request when input exceeds 272,000 tokens, and OpenClaw picks the tier
by prompt tokens (input + cacheRead + cacheWrite). Only the Astra rows (contextWindow 278528) can
reach it today.

Sources (fetched 2026-10-13):
- **A**: AWS Bedrock pricing, https://aws.amazon.com/bedrock/pricing/ , Anthropic, table "Geo and
  In-region Cross-region Inference", US East (N. Virginia). The page renders prices from
  https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/bedrockfoundationmodels/USD/current/bedrockfoundationmodels.json
  (publication 2026-10-12T08:40:08Z); the row keys resolve to Sonnet 5.5 2.2 / 11 / 5m 2.75 /
  1h 4.4 / read 0.11 and Opus 5.5 4.4 / 22 / 5.5 / 8.8 / 0.22. The `us.` ids are US geo CRIS, which
  carries the 10% premium over the Global CRIS row (Sonnet 2 / 10 / 2.5 / 4 / 0.1, Opus 4 / 20 / 5 / 8 /
  0.2). The page also notes that Sonnet 5.5 cache read dropped 50% from 2026-10-07.
- **B1/B2/B3**: AWS model cards, https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-luna.html ,
  `model-card-openai-gpt-6-astra.html`, `model-card-openai-gpt-6-1-sol.html`, column "Mantle
  in-Region" / "In-Region (us-east-1)" (bedrock-mantle us-east-1 supports In-Region only; the
  cards say these prices already include the 10% premium). UltraFast is 6x Standard per the cards.
- **C**: Claude Code 2.1.296 on a dev box. Its baked catalog maps `us.anthropic.claude-sonnet-5-5`
  to `tier_2_10_cache_read_0_10` and `us.anthropic.claude-opus-5-5` to `tier_4_20_cache_read_0_20`.
  Eight `claude -p --bare --output-format json` calls on those ids reproduce `total_cost_usd`
  exactly at the Global rates. For example, Sonnet with 10735 1h-cache-write tokens costs
  $0.042988 (4.00/M), and with 10709 cache-read tokens $0.0011669 (0.10/M). Claude Code reports
  `costBasis: "list"` and applies no geo premium on Bedrock, so it is 10% under the AWS bill for
  `us.` profiles. A is used.
- **D**: AWS Price List API, offer `AmazonBedrockFoundationModels`, us-east-1, version
  20261012084008: "OpenAI GPT-6 Astra" `input_tokens_standard` 11, `output_tokens_standard` 55,
  `cache_read_tokens_standard` 1.10, `cache_write_tokens_30m_standard` 13.75. This matches B2.
  Luna and 6.1 Sol are not in that offer file, so B1/B3 rest on the model cards alone. Codex 0.162.1
  ships no prices.

Why `cacheWrite` is the 5-minute rate for Claude: OpenClaw's Bedrock Converse provider writes
5m cache points unless `cacheRetention: "long"` is set (`extensions/amazon-bedrock/dist/stream.runtime.js`,
`resolveCacheRetention` default `short`). Any 1h writes are priced by OpenClaw at 2x input
(4.40 / 8.80), which matches AWS's 1h column. Mantle reports `cache_write_tokens` for the OpenAI
models, and OpenClaw books them as `cacheWrite`. A Luna probe recorded 6847 of them.

Not covered: memory-search embeddings (`amazon.nova-2-multimodal-embeddings-v1:0`) have no cost
field in `openclaw.json`, and `usage-cost` does not count them. No us-east-1 SKU for that id was
found in the price-list files.

Effect on recorded cost (2026-10-13): `usage-cost` re-estimates every entry that has no recorded cost
from the current rows, so history re-priced as well. 10-11 went from $0.13 to $2.17, 10-12 from
$6.49 to $27.97, and 10-13 from $0 to $18.48 (28.8M tokens, through 20:43Z, mostly Sonnet fallback
caused by the Mantle 401). (The budget guard of that day paused the heartbeat at 20:44Z; it was
removed on 2026-10-14 with no cap in its place.) On Luna the same work is far cheaper: the `fleet-digest` run (2648 output,
375103 cache-read, 43021 cache-write tokens) costs about $0.0115.

## Still open
- Spend: no cap by design (2026-10-14). Cost stays visible in `usage-cost` and the Drover
  Manager panel, which is why the price rows above must stay accurate.
- `drover manager check --live` lists the TCP peers of the gateway and its direct children at one
  instant; an idle gateway can show none. On 2026-10-13 a 45 s sample of every PID in the unit's cgroup
  during a Luna turn saw only the profile's trace endpoint, 127.0.0.1, one `bedrock-mantle.us-east-1.api.aws`
  address and one `bedrock-runtime.us-east-1.amazonaws.com` address.
- OpenClaw's `docs/providers/bedrock-mantle.md` manual example (`/v1` base, `env:` apiKey,
  `openai-completions`) does not work for the OpenAI GPT-6 models with discovery off. Not yet
  reported upstream.
Closed on 2026-10-11: Drover has `DROVER_MCP_ACTOR` and the `core/openclaw.js` chat adapter
(`drover op sessions.message '{"id":"manager","text":"..."}'`). Closed on 2026-10-20: the workspace files
live in this directory (`roles/`, `workspace/`), the install is `drover manager setup` (it replaced
`install-commands.md`, `macos/install.sh` and the `~/code/openclaw-manager-poc` copy),
and the egress check is `drover manager check` (it replaced `check-egress.sh` and runs on macOS too).
