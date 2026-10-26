// The manager installer (core/openclaw-install.js): the pure renderers against the real repo data, and
// setup() end to end in a scratch HOME with every process faked (npm, the OpenClaw CLI, launchctl or
// systemctl), so it runs the same on a Mac and on the Linux CI runner and touches nothing real.
// Run: node --test test/openclaw-install.test.js
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, symlink, readlink, chmod, cp, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The repo's own data only: no overlay and no owner name from the shell running the suite.
for (const k of ['OPENCLAW_OVERLAY', 'OWNER', 'OWNER_NAME']) { delete process.env[`DROVER_${k}`]; delete process.env[`APXW_${k}`]; }
const install = await import('../core/openclaw-install.js');
const BEARER = 'EXAMPLE_bearer_value_1234567890', EXA = 'EXAMPLE_exa_value_1234567890', PROXY = 'EXAMPLE_proxy_key_1234567890';

/** A scratch overlay laid out like web/openclaw-manager: { 'profiles/x.json': {...} | 'text' }. */
async function makeOverlay(files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'drover-oc-overlay-'));
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
  return dir;
}
/** A second fleet's profile: the default one moved to another port, with its own trace endpoint and Exa source. */
const boxB = () => {
  const p = JSON.parse(readFileSync(path.join(install.SRC, 'profiles', 'default.json'), 'utf8'));
  return { ...p, summary: 'box-b: another fleet', port: 18831, vars: { ...p.vars, OTEL_ENDPOINT: 'http://127.0.0.1:3151/api/public/otel', CLIPROXY_API_KEY: 'EXAMPLE_loopback_literal' }, secrets: { ...p.secrets, EXA_API_KEY: { from: '~/.config/box-b/exa.env' } } };
};

describe('pure parts', () => {
  test('satisfies and pickNode follow OpenClaw\'s engines range', () => {
    const range = '>=24.16.0 <25 || >=26.1.0';
    for (const [v, ok] of [['v24.15.0', false], ['v24.16.0', true], ['24.21.0', true], ['v25.0.0', false], ['v26.0.9', false], ['v26.1.0', true], ['v22.23.2', false]]) assert.equal(install.satisfies(v, range), ok, v);
    assert.equal(install.satisfies('v1.0.0', null), true);
    const pick = install.pickNode(range, [{ path: 'a', version: 'v24.15.0' }, { path: 'b', version: 'v24.19.0' }, { path: 'c', version: 'v24.21.0' }, { path: 'd', version: 'v25.1.0' }]);
    assert.equal(pick.path, 'c', 'the newest inside the range');
    assert.equal(install.pickNode(range, [{ path: 'a', version: 'v24.15.0' }]), null);
  });

  test('the committed lockfile pins openclaw with its engines; the tree directory is version + lock hash', () => {
    const l = install.lockInfo();
    assert.equal(l.version, '2026.10.1');
    assert.equal(l.engines, '>=24.16.0 <25 || >=26.1.0');
    assert.match(l.dirName, /^2026\.10\.1-[0-9a-f]{12}-p[0-9a-f]{8}$/, 'version, lock hash and patch-set hash');
    assert.deepEqual(l.patches.map((p) => p.name), ['heartbeat-thinking']);
  });

  test('roles and profiles load from the repo; the code holds no identity, the data does', () => {
    const roles = install.listRoles();
    assert.deepEqual(roles.map((r) => r.name), ['manager'], 'one role; what a manager covers is its scope');
    for (const r of roles) { assert.equal(r.profile, 'default'); assert.equal(r.from, 'repo'); assert.ok(r.summary.length > 20); }
    assert.deepEqual(install.listProfiles().map((p) => [p.name, p.port, p.from]), [['default', 18789, 'repo']], 'the repo ships one generic profile; a fleet\'s own live in its overlay');
    const p = install.loadProfile('default');
    assert.deepEqual(Object.keys(p.secrets).sort(), ['AWS_BEARER_TOKEN_BEDROCK', 'CLIPROXY_API_KEY', 'EXA_API_KEY', 'OPENCLAW_GATEWAY_TOKEN', 'OPENCLAW_HOOKS_TOKEN', 'OTEL_EXPORTER_OTLP_HEADERS']);
    assert.ok(Object.values(p.secrets).every((s) => s.generate || s.from === '~/.env_secrets'), 'every secret from one file, or generated');
    assert.equal(p.secrets.OTEL_EXPORTER_OTLP_HEADERS.optional, true);
    assert.equal(p.env.AWS_REGION, 'us-east-1');
    assert.ok(p.egress.allow.includes('api.exa.ai'));
    assert.deepEqual([p.port, p.vars.PORT, p.vars.OTEL_ENDPOINT, p.vars.CLIPROXY_API_KEY], [18789, 18789, 'http://127.0.0.1:3000/api/public/otel', '${CLIPROXY_API_KEY}'], 'the proxy key is an env ref the gateway resolves from its .env');
    assert.equal(p.config, path.join(install.SRC, 'openclaw.json'));
    assert.throws(() => install.loadRole('nope'), /unknown role "nope"; this checkout defines: manager /);
    assert.throws(() => install.loadProfile('../x'), /bad profile name/);
    assert.throws(() => install.loadProfile('box-b'), /no profile box-b \(profiles\/box-b\.json in .*openclaw-manager\); profiles here: default$/);
  });

  test('an overlay adds profiles and roles and replaces this checkout\'s files at the same path, one file at a time', async () => {
    const dir = await makeOverlay({
      'profiles/box-b.json': boxB(),
      'roles/manager/AGENTS.md': 'You are **{{ACTOR}}** on {{HOST}}, for {{OWNER_NAME}}.\n',
      'roles/scout/role.json': { summary: 'a scout that only looks', profile: 'box-b', heartbeatPrompt: 'Look ({{SCOPE_SHORT}}).' },
      'workspace/box-b/USER.md': '# USER.md\n\nbox-b seed\n',
      'workspace/SOUL.md': '# SOUL.md\n\nthe overlay soul\n',
    });
    assert.deepEqual(install.listRoles(install.SRC, dir).map((r) => [r.name, r.profile, r.from]), [['manager', 'default', 'repo'], ['scout', 'box-b', 'overlay']], 'a role.json the overlay lacks stays the repo\'s');
    assert.deepEqual(install.listProfiles(install.SRC, dir).map((p) => [p.name, p.port, p.from]), [['box-b', 18831, 'overlay'], ['default', 18789, 'repo']]);
    const m = install.loadRole('manager', install.SRC, dir);
    assert.deepEqual([m.agentsFile, m.roleFile, m.memoryFile], [path.join(dir, 'roles', 'manager', 'AGENTS.md'), path.join(install.SRC, 'roles', 'manager', 'role.json'), path.join(install.SRC, 'roles', 'manager', 'MEMORY.md')], 'the orders from the overlay, role.json and the memory seed from the repo');
    const b = install.loadProfile('box-b', install.SRC, dir);
    assert.deepEqual([b.file, b.config, b.port, b.vars.PORT], [path.join(dir, 'profiles', 'box-b.json'), path.join(install.SRC, 'openclaw.json'), 18831, 18831], 'the config template is the repo\'s until the overlay has one');
    await writeFile(path.join(dir, 'openclaw.json'), '{}\n');
    assert.equal(install.loadProfile('box-b', install.SRC, dir).config, path.join(dir, 'openclaw.json'));
    assert.throws(() => install.loadRole('nope', install.SRC, dir), /this checkout and its overlay define: manager .*; scout \(a scout that only looks\)/);
    assert.equal(install.sourceFile('workspace/SOUL.md', { overlay: dir }), path.join(dir, 'workspace', 'SOUL.md'));
    assert.equal(install.sourceFile('workspace/IDENTITY.md', { overlay: dir }), path.join(install.SRC, 'workspace', 'IDENTITY.md'));
    assert.equal(install.sourceFile('workspace/NOPE.md', { overlay: dir }), null);
    await rm(dir, { recursive: true, force: true });
  });

  test('which overlay: --overlay, then DROVER_OPENCLAW_OVERLAY, then the manifest\'s; none (or empty) means none', () => {
    const env = (v) => ({ HOME: '/h', ...(v === undefined ? {} : { DROVER_OPENCLAW_OVERLAY: v }) });
    const manifest = { overlay: '/m/overlay' };
    assert.equal(install.resolveOverlay('/flag', { manifest, env: env('/env') }), '/flag');
    assert.equal(install.resolveOverlay(undefined, { manifest, env: env('/env') }), '/env');
    assert.equal(install.resolveOverlay(undefined, { manifest, env: env() }), '/m/overlay', 'a shell without the variable keeps what the install used');
    assert.equal(install.resolveOverlay(undefined, { manifest: null, env: env() }), null);
    for (const off of ['none', '', '  ']) assert.equal(install.resolveOverlay(undefined, { manifest, env: env(off) }), null, `DROVER_OPENCLAW_OVERLAY=${JSON.stringify(off)}`);
    assert.equal(install.resolveOverlay('none', { manifest, env: env('/env') }), null);
    assert.equal(install.resolveOverlay('~/private/oc', { env: env() }), '/h/private/oc');
    assert.equal(install.resolveOverlay(undefined, { env: { HOME: '/h', APXW_OPENCLAW_OVERLAY: '/legacy' } }), '/legacy', 'the old APXW_ spelling still works');
    assert.equal(install.overlayFromEnv({}), undefined, 'unset is not the same as none');
  });

  test('a profile\'s flags switch role-file sections; a bad or clashing flag is refused', async () => {
    const dir = await makeOverlay({ 'profiles/box-b.json': { ...boxB(), flags: { github: true } } });
    const b = install.loadProfile('box-b', install.SRC, dir);
    assert.deepEqual(b.flags, { github: true });
    assert.deepEqual(install.loadProfile('default').flags, {}, 'no flags: every flag section reads as off');
    const role = install.loadRole('manager');
    const sc = install.resolveScope({ scope: 'all', digest: true, actor: 'manager', host: 'box-a' });
    const text = '{{#digest}}MRs: {{#github}}gh{{/github}}{{^github}}drover_mrs_list{{/github}}{{/digest}}';
    assert.equal(install.renderTemplate(text, install.roleView(role, sc, 'box-a', { flags: b.flags }).vars), 'MRs: gh');
    assert.equal(install.renderTemplate(text, install.roleView(role, sc, 'box-a').vars), 'MRs: drover_mrs_list', 'a profile without the flag keeps the old orders');
    assert.throws(() => install.roleView(role, sc, 'box-a', { flags: { digest: true } }), /flag digest clashes/);
    assert.throws(() => install.roleView(role, sc, 'box-a', { flags: { local: true } }), /flag local clashes/);
    for (const [flags, re] of [[{ Git: true }, /bad flag Git/], [{ github: 'yes' }, /flag github must be true or false/], [['github'], /flags must be an object/]]) {
      await writeFile(path.join(dir, 'profiles', 'box-b.json'), JSON.stringify({ ...boxB(), flags }));
      assert.throws(() => install.loadProfile('box-b', install.SRC, dir), re);
    }
    await rm(dir, { recursive: true, force: true });
  });

  test('a profile must name a source or generate for every secret, and always the gateway token', async () => {
    const src = await mkdtemp(path.join(tmpdir(), 'drover-oc-src-'));
    await mkdir(path.join(src, 'profiles'));
    await writeFile(path.join(src, 'profiles', 'p.json'), JSON.stringify({ secrets: { X: {} , OPENCLAW_GATEWAY_TOKEN: { generate: true } } }));
    assert.throws(() => install.loadProfile('p', src), /secret X needs "from"/);
    await writeFile(path.join(src, 'profiles', 'p.json'), JSON.stringify({ secrets: {} }));
    assert.throws(() => install.loadProfile('p', src), /must include OPENCLAW_GATEWAY_TOKEN/);
  });

  test('renderConfig fills every token per role and profile, gives every manager full powers, keeps what OpenClaw owns', async () => {
    const template = JSON.parse(await readFile(install.loadProfile('default').config, 'utf8'));
    const vars = { ...install.loadProfile('default').vars, NODE: '/n/node', DROVER_BIN: '/h/.local/bin/drover', HOME: '/h' };
    const live = { meta: { lastTouchedVersion: '2026.10.1' }, wizard: { lastRunCommand: 'doctor' }, agents: { entries: { main: {} }, defaults: { heartbeat: { every: '1m' } } } };
    const role = install.loadRole('manager');
    const fleet = install.renderConfig({ template, role: install.roleView(role, install.resolveScope({ ...{ scope: 'all', exclude: ['laptop'], digest: true, actor: 'manager' }, host: 'box-a' }), 'box-a'), vars, live });
    const mac = install.renderConfig({ template, role: install.roleView(role, install.resolveScope({ scope: 'local', actor: 'manager-laptop', host: 'LAPTOP' }), 'LAPTOP'), vars, live });
    assert.ok(!JSON.stringify(fleet).includes('{{') && !JSON.stringify(mac).includes('{{'), 'no token left');
    const d = (c) => c.mcp.servers.drover;
    assert.deepEqual([d(fleet).command, d(fleet).args, d(fleet).cwd, d(fleet).env], ['/n/node', ['/h/.local/bin/drover', 'mcp'], '/h', { HOME: '/h', DROVER_MCP_ACTOR: 'manager' }]);
    assert.equal(d(mac).env.DROVER_MCP_ACTOR, 'manager-laptop');
    assert.match(fleet.agents.defaults.heartbeat.prompt, /'Sweep and drive' in AGENTS\.md for the hosts in your scope \(every host it reaches, except laptop\).*\(actor manager\)/);
    assert.match(fleet.agents.defaults.heartbeat.prompt, /answered the way the owner would, except what 'What needs the owner' lists\); fix what you can yourself; pin what only the owner can answer;/, 'the owner\'s name is install data (DROVER_OWNER_NAME)');
    for (const c of [fleet, mac]) {
      assert.equal(d(c).toolFilter, undefined, 'every drover tool: launches, tmux input, MR and file writes included');
      assert.deepEqual([c.tools.profile, c.tools.exec.security, c.tools.exec.ask, c.tools.deny, c.tools.fs, c.plugins.allow], ['full', 'full', 'off', undefined, undefined, undefined], 'the full tool profile: no deny list, no workspace-only files, no plugin allowlist');
      assert.equal(c.tools.web.fetch.enabled, true);
      assert.deepEqual([c.gateway.port, c.diagnostics.otel.endpoint], [18789, 'http://127.0.0.1:3000/api/public/otel'], 'the default profile\'s port and trace endpoint');
      assert.equal(c.models.providers.cliproxy.apiKey, '${CLIPROXY_API_KEY}', 'the loopback proxy key is an env ref, never a literal in the config');
    }
    for (const c of [fleet, mac]) assert.match(c.agents.defaults.heartbeat.prompt, /^Execute the program 'Sweep and drive'/, 'no directive: a heartbeat turn never sees its prompt as a message');
    assert.match(mac.agents.defaults.heartbeat.prompt, /\(this host only\).*\(actor manager-laptop\)/);
    // The template holds no key: every provider key is a template token (the profile fills it) or an env ref (the .env does).
    const keys = []; const walk = (v, k) => { if (v && typeof v === 'object') for (const [kk, vv] of Object.entries(v)) walk(vv, kk); else if (/apikey|token/i.test(k ?? '') && typeof v === 'string') keys.push(v); };
    walk(template);
    assert.ok(keys.length >= 3 && keys.every((v) => /^(\{\{[A-Z_]+\}\}|\$\{[A-Z_]+\})$/.test(v)), JSON.stringify(keys));
    // A profile may fill the proxy key with the literal its loopback proxy accepts (one fleet's overlay does).
    assert.equal(install.renderConfig({ template, role: install.roleView(role, install.resolveScope({ scope: 'local', actor: 'manager', host: 'h' }), 'h'), vars: { ...vars, CLIPROXY_API_KEY: 'EXAMPLE_loopback_literal' } }).models.providers.cliproxy.apiKey, 'EXAMPLE_loopback_literal');
    const { CLIPROXY_API_KEY: _key, ...noKey } = vars;
    assert.throws(() => install.renderConfig({ template, role: install.roleView(role, install.resolveScope({ scope: 'local', actor: 'manager', host: 'h' }), 'h'), vars: noKey }), /token \{\{CLIPROXY_API_KEY\}\} has no value/, 'a profile without it fails setup, not the gateway');
    for (const c of [fleet, mac]) { assert.deepEqual(c.meta, live.meta); assert.deepEqual(c.wizard, live.wizard); assert.deepEqual(c.agents.entries, { main: {} }); }
    assert.equal(fleet.agents.defaults.heartbeat.every, '5m', 'everything else comes from the template');
    assert.throws(() => install.fillTokens({ a: '{{NOPE}}' }, {}), /token \{\{NOPE\}\} has no value/);
    assert.equal(install.fillTokens('keep ${AWS_BEARER_TOKEN_BEDROCK} and {{X}} inside text', { X: 'y' }), 'keep ${AWS_BEARER_TOKEN_BEDROCK} and {{X}} inside text', 'whole strings only');
  });

  test('scope: flags, then the manifest, then a pre-scope role; every manager runs the same orders, filled per scope', async () => {
    assert.equal(install.renderTemplate('a{{#x}} X{{/x}}{{^x}} notX{{/x}} {{V}}', { x: true, V: 1 }), 'a X 1');
    assert.equal(install.renderTemplate('{{#x}}A{{#y}}B{{/y}}{{/x}}{{^x}}C{{/x}}', { x: true, y: false }), 'A');
    assert.throws(() => install.renderTemplate('{{NOPE}}', {}), /\{\{NOPE\}\} has no value/);
    assert.deepEqual(install.resolveScope({ prev: { role: 'fleet', actor: 'manager' }, host: 'h' }), { hosts: 'all', exclude: ['macbook'], digest: true, actor: 'manager' });
    assert.deepEqual(install.resolveScope({ prev: { role: 'mac', actor: 'manager-mac' }, host: 'h' }), { hosts: 'local', exclude: [], digest: false, actor: 'manager-mac' });
    assert.deepEqual(install.resolveScope({ prev: { scope: { hosts: 'all', exclude: ['a'], digest: true }, actor: 'manager' }, digest: false, host: 'h' }), { hosts: 'all', exclude: ['a'], digest: false, actor: 'manager' }, 'a flag overrides the manifest');
    assert.equal(install.resolveScope({ scope: 'local', host: 'Owners-Laptop.local' }).actor, 'manager-owners-laptop-local');
    assert.throws(() => install.resolveScope({ host: 'h' }), /first install on this host: pass --scope local/);
    assert.throws(() => install.resolveScope({ scope: 'some', host: 'h' }), /scope must be local or all/);
    assert.throws(() => install.resolveScope({ scope: 'all', exclude: ['a;b'], host: 'h' }), /bad host in --exclude/);
    assert.throws(() => install.resolveScope({ scope: 'all', actor: 'boss', host: 'h' }), /actor must be manager or manager-<name>/);
    const role = install.loadRole('manager'); const text = await readFile(role.agentsFile, 'utf8');
    const fleet = install.renderTemplate(text, install.roleView(role, install.resolveScope({ ...{ scope: 'all', exclude: ['laptop'], digest: true, actor: 'manager' }, host: 'box-a' }), 'box-a').vars);
    const mac = install.renderTemplate(text, install.roleView(role, install.resolveScope({ scope: 'local', actor: 'manager-laptop', host: 'LAPTOP' }), 'LAPTOP').vars);
    for (const t of [fleet, mac]) assert.ok(!t.includes('{{'), 'no template markup left');
    assert.match(fleet, /You are \*\*manager\*\*.*running on box-a/); assert.match(fleet, /Program 2: Daily digest/); assert.match(fleet, /6\. Merge requests, when a plugin gives this fleet a tool that lists them \(`drover_mrs_list state=open\n {3}author=owner`, say\)/, 'the owner\'s MRs (DROVER_OWNER), when a plugin lists them'); assert.match(fleet, /except `laptop` \(each covers itself\)/);
    assert.match(mac, /You are \*\*manager-laptop\*\*/); assert.ok(!/Program 2: Daily digest/.test(mac) && !/6\. Merge requests/.test(mac)); assert.match(mac, /this host only \(LAPTOP\)/); assert.match(mac, /Another manager owns the daily digest/);
    const earns = (t) => t.match(/\*\*What earns a note:\*\* ([^*]*?)\nLane counts/)[1].replace(/\s+/g, ' ');
    assert.equal(earns(fleet), 'a session waiting on the owner (step 3), a possible stall (step 4), how a session that left the lanes ended (step 5), a host that cannot be read (once a day, step 1), a merge-request flip (step 6), and the escalations above.');
    assert.equal(earns(mac), 'a session waiting on the owner (step 3), a possible stall (step 4), how a session that left the lanes ended (step 5), and the escalations above.');
    assert.match(fleet, /For In-flight, read\nthe working lane of every host in `drover_native_summary`/);
    for (const [t, actor] of [[fleet, 'manager'], [mac, 'manager-laptop']]) {
      assert.match(t, /## Program 1: Sweep and drive \(continuous\)/);
      assert.ok(t.includes(`"${actor} here, the owner's manager: the owner wants work kept moving without waiting on them.`), 'the drive message carries the actor');
      assert.match(t, /\*\*D2, a dialog\.\*\* A question dialog, a plan approval or a permission prompt: read it, and answer it\n  the way the owner would/, 'dialogs and permission prompts are the manager\'s to answer');
      assert.match(t, /This is not the owner's approval: whatever your own rules say needs their\n  explicit yes still does/, 'the drive message approves nothing');
      assert.match(t, /You have full powers: a full\nshell, files anywhere, the web, every `drover` tool\./);
      assert.match(t, /## What needs the owner \(the only things that wait for their yes\)\n- Merging to a default or shared branch, deploying, or changing production\./, 'merges, deploys and production stay with the owner');
      assert.ok(!/Shell: only `ro <verb>`|Never start, stop or kill agents|Never type into a tmux pane/.test(t), 'none of the read-only rules are left');
      assert.match(t, /1\. `drover_native_summary` with `stopped: true`/);
      assert.match(t, /\*\*D3, never on the owner's behalf:\*\* the list under "What needs the owner"/);
      assert.ok(t.includes(`Drover, the control plane your \`drover_*\` tools talk to, is ${path.resolve(install.SRC, '..', '..')}:`), 'the checkout its tools run, not a guessed path');
    }
  });

  test('a role\'s thinking levels are OpenClaw\'s: heartbeatThinking and each automation\'s', async () => {
    const src = await mkdtemp(path.join(tmpdir(), 'drover-roles-'));
    const role = (extra) => ({ summary: 's', profile: 'default', heartbeatPrompt: 'p', ...extra });
    const write = async (name, body) => { await mkdir(path.join(src, 'roles', name), { recursive: true }); await writeFile(path.join(src, 'roles', name, 'role.json'), JSON.stringify(body)); };
    // OpenClaw 2026.10.1's own set (normalizeThinkLevel; automations --thinking lists the same nine).
    await write('ok', role({ heartbeatThinking: 'medium', duties: { d: { automations: [{ name: 'a', thinking: 'max' }, { name: 'b', thinking: 'adaptive' }, { name: 'c', thinking: 'ultra' }] } } }));
    await write('turbo', role({ heartbeatThinking: 'turbo' }));
    await write('auto', role({ duties: { d: { automations: [{ name: 'a', thinking: 'extreme' }] } } }));
    assert.equal(install.loadRole('ok', src).heartbeatThinking, 'medium');
    assert.throws(() => install.loadRole('turbo', src), /heartbeatThinking must be one of off, minimal, low, medium, high, xhigh, adaptive, max, ultra, not "turbo"/);
    assert.throws(() => install.loadRole('auto', src), /duties\.d automation a thinking must be one of/);
    await rm(src, { recursive: true, force: true });
  });

  test('canonical and diffPaths compare by content and skip OpenClaw-owned keys', () => {
    assert.equal(install.canonical({ b: 1, a: [1, { d: 2, c: 3 }] }), install.canonical({ a: [1, { c: 3, d: 2 }], b: 1 }));
    const a = { x: 1, y: { z: [1, 2] }, meta: { v: 1 }, agents: { entries: { main: {} }, defaults: { t: 1 } } };
    const b = { x: 2, y: { z: [1, 3] }, meta: { v: 2 }, agents: { defaults: { t: 1 } }, n: true };
    assert.deepEqual(install.diffPaths(a, b), ['n', 'x', 'y.z']);
  });

  test('the wrappers carry the secrets file, the profile env, every egress switch and the pinned runtime; never a value', () => {
    const profile = install.loadProfile('default');
    for (const platform of ['darwin', 'linux']) {
      const lay = install.layout({ home: '/h', platform, env: {} });
      for (const text of [install.renderLauncher(lay, { node: '/n/bin/node', mjs: "/o/it's/openclaw.mjs" }, profile), install.renderOc(lay, { node: '/n/bin/node', mjs: "/o/it's/openclaw.mjs" }, profile)]) {
        assert.match(text, /^#!\/bin\/bash\n/);
        assert.match(text, /set -a; \. '\/h\/\.openclaw-manager\/\.env'; set \+a/);
        assert.match(text, /AWS_REGION='us-east-1'/);
        for (const [k, v] of Object.entries(install.EGRESS_ENV)) assert.match(text, new RegExp(`\\b${k}=${v}\\b`), k);
        const brew = platform === 'darwin' ? '/opt/homebrew/bin:/h/homebrew/bin' : '/home/linuxbrew/.linuxbrew/bin';
        assert.ok(text.includes(`export PATH='${lay.bin}:/n/bin:/h/.local/bin:/h/.bun/bin:/h/.cargo/bin:${brew}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'`), 'the manager\'s bin, the pinned node, then the user\'s usual tool dirs: its exec runs anything');
        assert.match(text, /for v in [A-Z_ ]*\bXDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS; do/, 'the user\'s session bus survives the clean re-exec');
        assert.match(text, /'\/o\/it'\\''s\/openclaw\.mjs'/, 'quoted for the shell');
        assert.equal(/NODE_EXTRA_CA_CERTS/.test(text), platform === 'linux');
        assert.equal(/OPENCLAW_HEARTBEAT_THINKING/.test(text), false, 'no level unless the role sets one');
      }
      assert.match(install.renderLauncher(lay, { node: '/n/bin/node', mjs: '/o/m.mjs' }, profile), /exec '\/n\/bin\/node' '\/o\/m\.mjs' gateway --port 18789\n$/);
      const high = install.renderLauncher(lay, { node: '/n/bin/node', mjs: '/o/m.mjs' }, profile, { heartbeatThinking: 'high' });
      assert.match(high, /\nexport OPENCLAW_HEARTBEAT_THINKING='high'\n/);
      assert.deepEqual([install.launcherHeartbeatThinking(high), install.launcherHeartbeatThinking(install.renderLauncher(lay, { node: '/n/bin/node', mjs: '/o/m.mjs' }, profile)), install.launcherHeartbeatThinking(null)], ['high', null, null], 'status reads the level back from the launcher');
      assert.match(install.renderOc(lay, { node: '/n/bin/node', mjs: '/o/m.mjs' }, profile), /exec '\/n\/bin\/node' '\/o\/m\.mjs' "\$@"\n$/);
    }
    const plist = install.renderPlist(install.layout({ home: '/h/a&b', platform: 'darwin', env: {} }));
    assert.match(plist, /<key>Label<\/key><string>dev\.drover\.manager<\/string>/);
    assert.match(plist, /<string>\/h\/a&amp;b\/\.openclaw-manager\/bin\/run-gateway<\/string>/);
    assert.match(plist, /<key>ExitTimeOut<\/key><integer>330<\/integer>/);
    assert.match(readFileSync(path.join(install.SRC, 'systemd', 'openclaw-manager.service'), 'utf8'), new RegExp(`\\nTimeoutStopSec=${install.STOP_TIMEOUT_SEC}\\n`), 'one stop timeout for both supervisors');
    assert.match(plist, /openclaw-manager\.log/);
  });

  test('a generated wrapper hands OpenClaw an allowlisted environment, whatever its caller exports', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'drover-oc-wrap-'));
    const lay = install.layout({ home, platform: process.platform, env: {} });
    await mkdir(lay.bin, { recursive: true });
    await writeFile(lay.env, `AWS_BEARER_TOKEN_BEDROCK=${BEARER}\nOPENCLAW_GATEWAY_TOKEN=tok\n`);
    const fakeNode = path.join(home, 'node-bin', 'node');
    await mkdir(path.dirname(fakeNode), { recursive: true });
    await writeFile(fakeNode, '#!/bin/sh\nenv\n'); await chmod(fakeNode, 0o755);
    await writeFile(lay.oc, install.renderOc(lay, { node: fakeNode, mjs: '/unused/openclaw.mjs' }, install.loadProfile('default'))); await chmod(lay.oc, 0o700);
    const out = execFileSync(lay.oc, ['health'], { env: { PATH: '/usr/bin:/bin', HOME: home, USER: 'u', XDG_RUNTIME_DIR: '/run/user/501', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/501/bus', OPENAI_API_KEY: 'EXAMPLE_leak', ANTHROPIC_API_KEY: 'EXAMPLE_leak', AWS_BEARER_TOKEN_BEDROCK: 'EXAMPLE_callers_own' }, encoding: 'utf8' });
    const env = Object.fromEntries(out.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    assert.equal(env.OPENAI_API_KEY, undefined, 'a caller\'s provider key never reaches OpenClaw');
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.AWS_BEARER_TOKEN_BEDROCK, BEARER, 'the manager\'s own bearer, not the caller\'s');
    assert.deepEqual([env.OPENCLAW_GATEWAY_TOKEN, env.OPENCLAW_OFFLINE, env.AWS_REGION, env.HOME, env.USER, env.OPENCLAW_STATE_DIR], ['tok', '1', 'us-east-1', home, 'u', lay.state]);
    assert.equal(env.DROVER_MANAGER_CLEAN_ENV, undefined, 'the re-exec marker is not passed on');
    assert.deepEqual([env.XDG_RUNTIME_DIR, env.DBUS_SESSION_BUS_ADDRESS], ['/run/user/501', 'unix:path=/run/user/501/bus'], 'ro systemctl --user can reach the service manager');
    assert.ok(env.PATH.split(':')[1] === path.dirname(fakeNode) && env.PATH.split(':')[0].endsWith(path.join('.openclaw-manager', 'bin')), env.PATH);
  });

  test('envLine writes plain values bare and the rest single-quoted; it refuses what the shell cannot carry, without echoing it', () => {
    assert.equal(install.envLine('A', 'abc/def+ghi=='), 'A=abc/def+ghi==');
    assert.equal(install.envLine('A', 'abc def $(x)'), "A='abc def $(x)'");
    assert.equal(install.parseEnvFile(install.envLine('A', 'abc def $(x)')).A, 'abc def $(x)', 'the file parser reads it back the same');
    assert.throws(() => install.envLine('A', "it's EXAMPLE_secret"), (e) => /single quote/.test(e.message) && !e.message.includes('EXAMPLE_secret'));
  });

  test('approvals are full exec with no prompts; drift is named field by field', async () => {
    const base = JSON.parse(await readFile(path.join(install.SRC, 'exec-approvals.json'), 'utf8'));
    const out = JSON.parse(install.renderApprovals({ ...base, agents: { main: { ...base.agents.main, allowlist: [{ pattern: '~/x' }] } } }));
    assert.equal(out.agents.main.allowlist, undefined, 'no allowlist: full exec runs anything');
    assert.deepEqual([out.defaults.security, out.defaults.ask, out.agents.main.security, out.agents.main.askFallback], ['full', 'off', 'full', 'full']);
    assert.deepEqual(install.approvalsDrift(out, out), []);
    assert.deepEqual(install.approvalsDrift({ defaults: { ...out.defaults, security: 'allowlist' }, agents: { main: { ...out.agents.main, ask: 'on-miss' } } }, out), ['defaults.security', 'main.ask']);
    assert.ok(install.approvalsDrift(null, out).length > 0, 'nothing stored is drift');
  });

  test('secrets: the first .env comes from the profile\'s sources and fresh tokens; problems are named, values are not', async () => {
    const dir = await makeOverlay({ 'profiles/box-b.json': boxB() });
    const profile = install.loadProfile('box-b', install.SRC, dir);   // Exa from a file of its own, the rest from ~/.env_secrets
    const files = { '/h/.env_secrets': `export OTHER=1\nexport AWS_BEARER_TOKEN_BEDROCK="${BEARER}"\nexport CLIPROXY_API_KEY=${PROXY}\n`, '/h/.config/box-b/exa.env': `EXA_API_KEY=${EXA}\nOPENAI_API_KEY=EXAMPLE_no\n` };
    const text = install.newEnvFile(profile, { home: '/h', read: (p) => files[p] ?? null });
    const env = install.parseEnvFile(text);
    assert.deepEqual(Object.keys(env).sort(), ['AWS_BEARER_TOKEN_BEDROCK', 'CLIPROXY_API_KEY', 'EXA_API_KEY', 'OPENCLAW_GATEWAY_TOKEN', 'OPENCLAW_HOOKS_TOKEN'], 'the required names, nothing else from the source files; the optional header has no keys to come from');
    files['/h/.env_secrets'] += 'export LANGFUSE_PUBLIC_KEY=pk-lf-EXAMPLE\nexport LANGFUSE_SECRET_KEY=sk-lf-EXAMPLE\n';
    const withTraces = install.parseEnvFile(install.newEnvFile(profile, { home: '/h', read: (p) => files[p] ?? null }));
    assert.equal(withTraces.OTEL_EXPORTER_OTLP_HEADERS, `Authorization=Basic%20${Buffer.from('pk-lf-EXAMPLE:sk-lf-EXAMPLE').toString('base64')}`, 'the trace header is derived from the Langfuse pair');
    assert.deepEqual([env.AWS_BEARER_TOKEN_BEDROCK, env.CLIPROXY_API_KEY, env.EXA_API_KEY], [BEARER, PROXY, EXA]);
    assert.match(env.OPENCLAW_GATEWAY_TOKEN, /^[A-Za-z0-9_-]{40}$/);
    assert.notEqual(env.OPENCLAW_GATEWAY_TOKEN, env.OPENCLAW_HOOKS_TOKEN);
    assert.throws(() => install.newEnvFile(profile, { home: '/h', read: (p) => (p.endsWith('.env_secrets') ? files[p] : null) }), (e) => /EXA_API_KEY not found in ~\/\.config\/box-b\/exa\.env \(profile box-b\)/.test(e.message) && !e.message.includes(BEARER));
    assert.deepEqual(install.envProblems(`${text}OPENAI_API_KEY=x\nOTEL_EXPORTER_OTLP_HEADERS=y\n`, profile), { missing: [], unexpected: ['OPENAI_API_KEY'] });
    assert.deepEqual(install.envProblems('OPENCLAW_GATEWAY_TOKEN=x\n', profile).missing, ['AWS_BEARER_TOKEN_BEDROCK', 'CLIPROXY_API_KEY', 'EXA_API_KEY', 'OPENCLAW_HOOKS_TOKEN'], 'an optional secret is never missing');
    // The default profile reads every one from ~/.env_secrets, the loopback proxy's key included.
    const def = install.loadProfile('default');
    assert.throws(() => install.newEnvFile(def, { home: '/h', read: (p) => (p === '/h/.env_secrets' ? `AWS_BEARER_TOKEN_BEDROCK=${BEARER}\nEXA_API_KEY=${EXA}\n` : null) }), (e) => /CLIPROXY_API_KEY not found in ~\/\.env_secrets \(profile default\)/.test(e.message) && !e.message.includes(BEARER));
    await rm(dir, { recursive: true, force: true });
  });

  test('cliEnv inherits nothing from the caller and hands out only the secrets asked for; npmEnv keeps the network settings', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'drover-oc-env-'));
    const lay = install.layout({ home, platform: 'darwin', env: {} });
    await mkdir(lay.state, { recursive: true });
    await writeFile(lay.env, `AWS_BEARER_TOKEN_BEDROCK=${BEARER}\nCLIPROXY_API_KEY=${PROXY}\nEXA_API_KEY=${EXA}\nOPENCLAW_GATEWAY_TOKEN=tok\nOPENCLAW_HOOKS_TOKEN=hooks\n`);
    const base = { OPENAI_API_KEY: 'EXAMPLE_no', ANTHROPIC_API_KEY: 'EXAMPLE_no', AWS_BEARER_TOKEN_BEDROCK: 'EXAMPLE_daemon', USER: 'u', TMPDIR: '/t', HTTPS_PROXY: 'http://proxy:3128', npm_config_registry: 'https://r.example', LANG: 'C' };
    const profile = install.loadProfile('default');
    const tok = install.cliEnv(lay, '/n/bin/node', { base, profile });
    assert.equal(tok.OPENCLAW_GATEWAY_TOKEN, 'tok');
    for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AWS_BEARER_TOKEN_BEDROCK', 'CLIPROXY_API_KEY', 'EXA_API_KEY', 'OPENCLAW_HOOKS_TOKEN', 'HTTPS_PROXY']) assert.equal(tok[k], undefined, k);
    assert.deepEqual([tok.USER, tok.TMPDIR, tok.LANG, tok.AWS_REGION, tok.OPENCLAW_OFFLINE, tok.HOME], ['u', '/t', 'C', 'us-east-1', '1', home]);
    const all = install.cliEnv(lay, '/n/bin/node', { base, profile, secrets: 'all' });
    assert.deepEqual([all.AWS_BEARER_TOKEN_BEDROCK, all.CLIPROXY_API_KEY, all.EXA_API_KEY, all.OPENCLAW_HOOKS_TOKEN, all.OPENAI_API_KEY], [BEARER, PROXY, EXA, 'hooks', undefined], 'the manager\'s own bearer, never the daemon\'s');
    const none = install.cliEnv(lay, '/n/bin/node', { base, profile, secrets: 'none' });
    assert.equal(none.OPENCLAW_GATEWAY_TOKEN, undefined);
    const npm = install.npmEnv(lay, '/n/bin/node', base);
    assert.deepEqual([npm.HTTPS_PROXY, npm.npm_config_registry, npm.OPENCLAW_GATEWAY_TOKEN, npm.OPENAI_API_KEY], ['http://proxy:3128', 'https://r.example', undefined, undefined]);
  });

  test('cliError prefers OpenClaw\'s JSON error, then the stderr tail, never the argv', () => {
    assert.equal(install.cliError({ code: 1, stdout: 'warn\n{"ok":false,"error":{"message":"gateway timeout after 10000ms"}}', stderr: 'x' }, ['gateway', 'usage-cost', '--days', '1']), 'openclaw gateway usage-cost exited 1: gateway timeout after 10000ms');
    assert.equal(install.cliError({ code: 2, stdout: '', stderr: 'a\nb\nc\nd\n' }, ['config', 'validate']), 'openclaw config validate exited 2: b | c | d');
    assert.deepEqual(install.parseCliJson('banner line\n{"a":1}'), { a: 1 });
  });

  test('launchctl print and ps etime parse into the status card fields', () => {
    const p = install.parseLaunchctlPrint(`gui/504/dev.drover.manager = {\n\tactive count = 1\n\tstate = running\n\tprogram = /x\n\truns = 35\n\tpid = 18555\n\tlast exit code = 78: EX_CONFIG\n\tresource coalition = {\n\t\tstate = active\n\t}\n\tjob state = running\n}`);
    assert.deepEqual(p, { state: 'running', pid: 18555, runs: 35, lastExitCode: 78, lastExitReason: 'EX_CONFIG' });
    assert.equal(install.parseEtime('17:52:27'), 17 * 3600 + 52 * 60 + 27);
    assert.equal(install.parseEtime('1-02:03:04'), 86400 + 2 * 3600 + 3 * 60 + 4);
    assert.equal(install.parseEtime('05:09'), 309);
    assert.equal(install.parseEtime('junk'), null);
  });
});

// ---------------------------------------------------------------- setup() in a sandbox
/** A fake host: files are real (in a scratch HOME), every process is emulated and recorded. */
function fakeHost(home) {
  const host = { calls: [], loaded: false, active: false, enabled: false, restarts: 0, approvals: null, jobs: [], gitHead: null, busyPolls: 0, clock: Date.parse('2026-10-20T12:00:00Z'), startedAt: null };
  // The node running drover, below OpenClaw's range unless a test says otherwise, so the sandbox's fnm nodes decide
  // (the node running this suite would otherwise compete, and win wherever it is newer).
  host.runningNode = { path: path.join(home, 'running', 'bin', 'node'), version: 'v24.15.0' };
  const started = () => { host.active = true; host.restarts++; host.startedAt = host.clock; };
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const cli = (argv, opts = {}) => {
    const a = argv.slice(1); const has = (...w) => w.every((x) => a.includes(x));
    if (has('config', 'validate')) return ok('valid');
    if (has('approvals', 'get') && host.approvalsReadFails) return { code: 1, stdout: '{"ok":false,"error":{"message":"Gateway not reachable (ETIMEDOUT)"}}', stderr: '' };
    if (has('approvals', 'get')) return ok(JSON.stringify(host.approvals ? { exists: true, file: host.approvals } : { exists: false }));
    if (has('doctor', '--fix')) {
      const f = path.join(home, '.openclaw-manager', 'exec-approvals.json');
      if (existsSync(f)) host.approvals = JSON.parse(readFileSync(f, 'utf8'));
      return ok('doctor done');
    }
    if (has('approvals', 'set', '--stdin')) { host.approvals = JSON.parse(opts.input); return ok(); }
    if (has('automations', 'list') && host.clock < (host.listFailsUntil ?? 0)) return { code: 1, stdout: '{"ok":false,"error":{"message":"gateway timeout after 60000ms"}}', stderr: '' };
    if (has('automations', 'list')) {
      const busy = host.busyPolls > 0 ? [{ name: 'heartbeat-main', displayName: 'Heartbeat (main)', status: 'running' }] : [];
      if (host.busyPolls > 0) host.busyPolls--;
      return ok(JSON.stringify({ jobs: [...busy, ...host.jobs.map((j) => ({ ...j, status: 'idle' }))] }));
    }
    const flag = (f) => (a.includes(f) ? a[a.indexOf(f) + 1] : undefined);
    if (has('automations', 'add')) { host.jobs.push({ id: `job-${host.jobs.length}`, name: flag('--name'), enabled: true, schedule: { kind: 'cron', expr: flag('--cron'), tz: flag('--tz') }, sessionTarget: flag('--session'), payload: { kind: 'agentTurn', message: flag('--message'), model: flag('--model'), thinking: flag('--thinking') } }); return ok('{}'); }
    if (has('automations', 'edit')) {
      const j = host.jobs.find((x) => x.id === a[a.indexOf('edit') + 1]); if (!j) return { code: 1, stdout: '', stderr: 'no such job' };
      for (const [f, set] of Object.entries({ '--cron': (v) => { j.schedule.expr = v; }, '--tz': (v) => { j.schedule.tz = v; }, '--session': (v) => { j.sessionTarget = v; }, '--message': (v) => { j.payload.message = v; }, '--model': (v) => { j.payload.model = v; }, '--thinking': (v) => { j.payload.thinking = v; } })) if (a.includes(f)) set(flag(f));
      return ok('{}');
    }
    if (has('automations', 'disable') || has('automations', 'enable')) { const j = host.jobs.find((x) => x.id === a.at(-1)); if (!j) return { code: 1, stdout: '', stderr: 'no such job' }; j.enabled = has('automations', 'enable'); return ok('{}'); }
    if (has('health')) return ok(JSON.stringify({ ok: true, plugins: { loaded: ['amazon-bedrock', 'exa'], errors: [] } }));
    return { code: 9, stdout: '', stderr: `fake openclaw: unexpected ${a.join(' ')}` };
  };
  const service = async (file, argv) => {
    if (file === 'launchctl') {
      // As on macOS: bootout returns at once, the job stays listed until it has exited (host.exitMs later), and
      // launchd refuses to bootstrap a label it still lists.
      if (host.leavesAt != null && host.clock >= host.leavesAt) { host.loaded = false; host.leavesAt = null; }
      if (argv[0] === 'print' && host.leavesAt != null && host.printTimeouts > 0) { host.printTimeouts--; host.clock += 5000; return { code: -1, stdout: '', stderr: 'launchctl timed out after 5000ms' }; }   // tryRun's answer for a hung print, 5 s later
      if (argv[0] === 'print') return host.loaded ? ok(`state = ${host.active ? 'running' : 'waiting'}\npid = 4242\nruns = ${host.restarts + 1}\n`) : { code: 113, stdout: '', stderr: 'Could not find service' };
      if (argv[0] === 'bootout') { host.active = false; if (host.exitMs) host.leavesAt = host.clock + host.exitMs; else host.loaded = false; return ok(); }
      if (argv[0] === 'bootstrap') { if (host.loaded) return { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' }; host.loaded = true; started(); return ok(); }
      if (argv[0] === 'kickstart') { started(); return ok(); }
    }
    if (file === 'systemctl') {
      const verb = argv[1];
      if (verb === 'is-active') return ok(host.active ? 'active\n' : 'inactive\n');
      if (verb === 'show') return ok(`LoadState=${host.loaded ? 'loaded' : 'not-found'}\nSubState=${host.active ? 'running' : 'dead'}\nMainPID=${host.active ? 4242 : 0}\nNRestarts=0\nExecMainStatus=0\n${host.active ? `ActiveEnterTimestamp=${new Date(host.startedAt).toISOString()}\n` : ''}`);
      if (verb === 'daemon-reload') { host.loaded = true; return ok(); }
      if (verb === 'is-enabled') return ok(host.enabled ? 'enabled\n' : 'disabled\n');
      if (verb === 'enable') { host.enabled = true; return ok(); }
      if (verb === 'restart' || verb === 'start') { started(); return ok(); }
      if (verb === 'stop') { host.active = false; return ok(); }
      if (verb === 'disable') { host.enabled = false; host.active = false; return ok(); }
    }
    if (file === 'plutil') return ok('OK');
    if (file === 'ps') { const t = Math.max(0, Math.round((host.clock - host.startedAt) / 1000)); return ok(`${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}\n`); }
    if (file === 'git') return host.gitHead ? ok(argv.includes('rev-parse') ? `${host.gitHead}\n` : '') : { code: 128, stdout: '', stderr: 'not a git repository' };
    return null;
  };
  host.deps = {
    run: async (file, argv, opts) => {
      host.calls.push([file, ...argv].join(' '));
      if (argv.length === 1 && argv[0] === '-v') return ok('v24.21.0\n');
      if (path.basename(file) === 'npm' && argv[0] === 'ci') {
        const lock = install.lockInfo();
        await mkdir(path.join(opts.cwd, 'node_modules', 'openclaw'), { recursive: true });
        await writeFile(path.join(opts.cwd, 'node_modules', 'openclaw', 'package.json'), JSON.stringify({ name: 'openclaw', version: lock.version }));
        await writeFile(path.join(opts.cwd, 'node_modules', 'openclaw', 'openclaw.mjs'), '// fake\n');
        await mkdir(path.join(opts.cwd, 'node_modules', 'openclaw', 'dist'), { recursive: true });
        await writeFile(path.join(opts.cwd, 'node_modules', 'openclaw', 'dist', 'heartbeat-runner-run-A1.mjs'), host.anchorMoved ? 'heartbeatModelOverride: model,\n' : 'replyOptions({ isHeartbeat: true, heartbeatModelOverride: heartbeat?.model?.trim(), abortSignal })\n');
        await writeFile(path.join(opts.cwd, 'node_modules', 'openclaw', 'dist', 'heartbeat-runner-run-B2.mjs'), '// another runner chunk\n');
        host.npmEnv = opts.env;
        return ok();
      }
      const r = (await service(file, argv)) ?? (argv[0]?.endsWith('openclaw.mjs') ? cli(argv, opts) : null);
      if (!r || r.code !== 0) throw new Error(`fake run failed: ${file} ${argv.join(' ')}`);
      return r;
    },
    tryRun: async (file, argv, opts) => {
      host.calls.push([file, ...argv].join(' '));
      if (argv[0]?.endsWith('openclaw.mjs')) { host.cliEnvs = [...(host.cliEnvs ?? []), opts.env]; return cli(argv, opts); }
      return (await service(file, argv)) ?? { code: 127, stdout: '', stderr: 'not found' };
    },
    uid: () => 501, platform: () => process.platform, runningNode: () => host.runningNode, now: () => host.clock, sleep: async (ms) => { host.clock += ms; }, alive: async () => host.active,
  };
  return host;
}

describe('setup in a sandbox', () => {
  let home, host, saved;
  const lay = () => install.layout();
  const restartCalls = () => host.calls.filter((c) => /^(launchctl (bootstrap|kickstart)|systemctl --user (restart|start) )/.test(c));
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'drover-oc-setup-'));
    saved ??= { HOME: process.env.HOME, DROVER_SHARE: process.env.DROVER_SHARE, OPENCLAW_MANAGER_STATE_DIR: process.env.OPENCLAW_MANAGER_STATE_DIR, DROVER_OPENCLAW_OVERLAY: process.env.DROVER_OPENCLAW_OVERLAY };
    process.env.HOME = home; delete process.env.DROVER_SHARE; delete process.env.OPENCLAW_MANAGER_STATE_DIR; delete process.env.DROVER_OPENCLAW_OVERLAY;
    await mkdir(path.join(home, '.local', 'bin'), { recursive: true });
    await writeFile(path.join(home, '.local', 'bin', 'drover'), '#!/bin/sh\n');
    await mkdir(path.join(home, '.local', 'share', 'fnm', 'node-versions', 'v24.21.0', 'installation', 'bin'), { recursive: true });
    await writeFile(path.join(home, '.local', 'share', 'fnm', 'node-versions', 'v24.21.0', 'installation', 'bin', 'node'), '');
    await writeFile(path.join(home, '.env_secrets'), `export AWS_BEARER_TOKEN_BEDROCK=${BEARER}\nexport CLIPROXY_API_KEY=${PROXY}\nexport EXA_API_KEY=${EXA}\nexport OPENAI_API_KEY=EXAMPLE_not_for_the_manager\n`);
    host = fakeHost(home);
    Object.assign(install._deps, host.deps);
  });
  const done = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };

  test('a dry run reports the plan and writes nothing', async () => {
    const r = await install.setup({ ...{ scope: 'all', exclude: ['laptop'], digest: true, actor: 'manager' }, dryRun: true });
    assert.equal(r.dryRun, true);
    assert.ok(r.steps.some((s) => s.step === 'openclaw' && s.action === 'would install'));
    assert.ok(r.steps.some((s) => s.step === 'secrets' && s.action === 'would create'));
    assert.ok(r.steps.some((s) => s.step === 'service' && s.action === 'would restart'));
    assert.equal(existsSync(path.join(home, '.openclaw-manager')), false, 'no state dir');
    assert.equal(existsSync(lay().service.file), false, 'no service file');
    assert.deepEqual(restartCalls(), []);
    assert.equal(host.calls.some((c) => c.includes('npm')), false);
  });

  test('first install, then a no-op second run, then drift, owned keys, a hand edit and a launcher change', async () => {
    // 1. First install (a tree a killed run left half-written is cleared first).
    const stale = path.join(home, '.local', 'share', 'drover', 'openclaw', `${install.lockInfo().dirName}.tmp-99999`);
    await mkdir(path.join(stale, 'node_modules', 'x'), { recursive: true });
    const r1 = await install.setup({ scope: 'all', exclude: ['laptop'], digest: true, actor: 'manager' });
    assert.equal(existsSync(stale), false, 'the half-written tree is gone');
    const L = lay();
    const by = (r, s) => r.steps.find((x) => x.step === s);
    assert.equal(by(r1, 'openclaw').action, 'installed');
    assert.equal(by(r1, 'secrets').action, 'created');
    assert.equal(by(r1, 'config').action, 'created');
    assert.equal(by(r1, 'approvals').action, 'imported');
    assert.equal(by(r1, 'service').action, 'restarted');
    assert.equal(by(r1, 'gateway').action, 'answering');
    assert.equal(by(r1, 'automation fleet-digest').action, 'created');
    assert.equal(by(r1, 'health').action, 'ok');
    const env = install.parseEnvFile(await readFile(L.env, 'utf8'));
    assert.deepEqual(Object.keys(env).sort(), ['AWS_BEARER_TOKEN_BEDROCK', 'CLIPROXY_API_KEY', 'EXA_API_KEY', 'OPENCLAW_GATEWAY_TOKEN', 'OPENCLAW_HOOKS_TOKEN']);
    assert.equal((await stat(L.env)).mode & 0o777, 0o600);
    assert.equal((await stat(L.state)).mode & 0o777, 0o700);
    const cfg = JSON.parse(await readFile(L.config, 'utf8'));
    const nodePath = path.join(home, '.local', 'share', 'fnm', 'node-versions', 'v24.21.0', 'installation', 'bin', 'node');
    assert.deepEqual([cfg.mcp.servers.drover.command, cfg.mcp.servers.drover.env.DROVER_MCP_ACTOR, cfg.mcp.servers.drover.cwd], [nodePath, 'manager', home]);
    assert.equal(cfg.models.providers.cliproxy.apiKey, '${CLIPROXY_API_KEY}', 'the proxy key reaches the gateway through its .env');
    assert.ok(!(await readFile(L.config, 'utf8')).includes(PROXY), 'no key value in openclaw.json');
    assert.equal(r1.steps.some((s) => s.step === 'overlay'), false, 'no overlay, no overlay step');
    const orders = await readFile(path.join(L.workspace, 'AGENTS.md'), 'utf8');
    assert.match(orders, /You are \*\*manager\*\*/); assert.match(orders, /Program 2: Daily digest/); assert.ok(!orders.includes('{{'));
    assert.match(JSON.parse(await readFile(L.config, 'utf8')).agents.defaults.heartbeat.prompt, /never for lane counts, lane moves or headline changes/);
    assert.match(await readFile(path.join(L.workspace, 'MEMORY.md'), 'utf8'), /^# MEMORY\.md \(manager's curated/, 'seeds are filled too');
    for (const f of ['SOUL.md', 'USER.md', 'IDENTITY.md', 'MEMORY.md']) assert.ok(existsSync(path.join(L.workspace, f)), f);
    assert.equal((await stat(L.ro)).mode & 0o777, 0o755);
    assert.equal((await stat(L.launcher)).mode & 0o777, 0o700);
    assert.deepEqual([host.approvals.defaults.security, host.approvals.agents.main.security, host.approvals.agents.main.ask, host.approvals.agents.main.allowlist], ['full', 'full', 'off', undefined], 'full exec, no prompts');
    assert.equal(existsSync(L.approvalsFile), false, 'the import file is removed after doctor');
    assert.deepEqual(host.jobs.map((j) => j.name), ['fleet-digest']);
    assert.ok(host.calls.some((c) => c.includes('automations add --name fleet-digest --declaration-key drover:manager:fleet-digest --cron 0 7 * * * --tz UTC --session isolated') && c.endsWith('--no-deliver')));
    const m = install.readManifest(L);
    assert.deepEqual([m.role, m.profile, m.overlay, m.actor, m.openclaw.version, m.node.version, m.node.path], ['manager', 'default', null, 'manager', '2026.10.1', 'v24.21.0', nodePath]);
    assert.deepEqual(m.scope, { hosts: 'all', exclude: ['laptop'], digest: true });
    assert.equal(m.openclaw.mjs, path.join(home, '.local', 'share', 'drover', 'openclaw', install.lockInfo().dirName, 'node_modules', 'openclaw', 'openclaw.mjs'));
    assert.deepEqual(install.runtimeFor(L), { node: nodePath, mjs: m.openclaw.mjs, from: 'manifest' });
    const report = JSON.stringify(r1) + host.calls.join('\n');
    for (const s of [BEARER, PROXY, EXA, env.OPENCLAW_GATEWAY_TOKEN, env.OPENCLAW_HOOKS_TOKEN]) assert.ok(!report.includes(s), 'no secret value in the report or any argv');
    assert.equal(host.npmEnv.AWS_BEARER_TOKEN_BEDROCK, undefined, 'npm ci (install scripts) never sees a secret');
    assert.ok(host.cliEnvs.every((e) => e.OPENAI_API_KEY === undefined), 'OpenClaw never sees the daemon\'s provider keys');
    assert.equal(restartCalls().length, 1);

    // 2. Nothing changed: nothing written, nothing restarted.
    const r2 = await install.setup({});
    assert.deepEqual([r2.role, r2.actor, r2.scope.hosts], ['manager', 'manager', 'all'], 'later runs reuse the manifest scope');
    for (const s of ['openclaw', 'secrets', 'config', 'AGENTS.md', 'bin/ro', 'bin/run-gateway', 'bin/oc', 'service file', 'service', 'approvals', 'automation fleet-digest']) assert.equal(by(r2, s).action, 'unchanged', s);
    assert.equal(restartCalls().length, 1, 'no restart');
    assert.equal(install.readManifest(L).installedAt, m.installedAt);

    // 3. Drift in an owned key is fixed, OpenClaw's own keys stay, hand edits are backed up; a config change alone restarts nothing.
    const live = JSON.parse(await readFile(L.config, 'utf8'));
    live.agents.defaults.heartbeat.every = '1m';
    Object.assign(live, { meta: { lastTouchedVersion: '2026.10.1', migrations: { x: true } }, wizard: { lastRunCommand: 'doctor' } });
    live.agents.entries = { main: {} };
    await writeFile(L.config, JSON.stringify(live));
    await writeFile(path.join(L.workspace, 'AGENTS.md'), 'hand edit\n');
    const r3 = await install.setup({});
    assert.equal(by(r3, 'config').action, 'updated');
    assert.equal(by(r3, 'config').detail, '1 path: agents.defaults.heartbeat.every');
    const after = JSON.parse(await readFile(L.config, 'utf8'));
    assert.equal(after.agents.defaults.heartbeat.every, '5m');
    assert.deepEqual([after.meta.migrations, after.wizard, after.agents.entries], [{ x: true }, { lastRunCommand: 'doctor' }, { main: {} }]);
    assert.equal(by(r3, 'AGENTS.md').action, 'updated');
    assert.ok(readdirSync(L.workspace).some((f) => f.startsWith('AGENTS.md.bak-')), 'the hand edit is kept as a backup');
    assert.ok(readdirSync(L.state).some((f) => f.startsWith('openclaw.json.bak-')));
    assert.equal(restartCalls().length, 1, 'OpenClaw hot-reloads config; no restart');

    // 4. A hand-edited launcher under a service setup started is put back without a restart; an install from the
    // read-only era (allowlist security, the ro shim) is moved to full exec.
    await writeFile(L.launcher, '#!/bin/bash\nexec true\n');
    host.approvals = { version: 1, defaults: { security: 'allowlist', ask: 'off', askFallback: 'deny', autoAllowSkills: false }, agents: { main: { security: 'allowlist', ask: 'off', askFallback: 'deny', autoAllowSkills: false, allowlist: [{ pattern: '~/.openclaw-manager/bin/ro' }] } } };
    const r4 = await install.setup({});
    assert.equal(by(r4, 'bin/run-gateway').action, 'updated');
    assert.equal(by(r4, 'service').action, 'unchanged', 'the running gateway was started from the rendered launcher');
    assert.equal(restartCalls().length, 1);
    assert.equal(by(r4, 'approvals').action, 'updated');
    assert.match(by(r4, 'approvals').detail, /defaults\.security.*main\.security/);
    assert.deepEqual([host.approvals.defaults.security, host.approvals.agents.main.security, host.approvals.agents.main.allowlist], ['full', 'full', undefined]);

    // 5. If the supervisor restarted it since (a crash restart re-reads the file), the hand edit may be running: restart.
    await writeFile(L.launcher, '#!/bin/bash\nexec false\n');
    host.clock += 60_000; host.startedAt = host.clock;
    const r5 = await install.setup({});
    assert.equal(by(r5, 'bin/run-gateway').action, 'updated');
    assert.equal(by(r5, 'service').action, 'restarted');
    assert.equal(by(r5, 'service').detail, 'restarted outside setup while its launcher differed');
    assert.equal(restartCalls().length, 2);

    // 6. --restart never leaves a real change pending; the next run restarts, after the running heartbeat finishes.
    const newer = path.join(home, '.local', 'share', 'fnm', 'node-versions', 'v24.22.0', 'installation', 'bin');
    await mkdir(newer, { recursive: true }); await writeFile(path.join(newer, 'node'), '');
    const r6a = await install.setup({ restart: 'never' });
    assert.equal(by(r6a, 'bin/run-gateway').action, 'updated', 'the newer node is in the launcher');
    assert.equal(by(r6a, 'service').action, 'not restarted');
    assert.match(by(r6a, 'service').detail, /due at the next run \(launcher changed\)/);
    assert.equal(restartCalls().length, 2);
    host.busyPolls = 3;
    const r6b = await install.setup({});
    assert.equal(by(r6b, 'bin/run-gateway').action, 'unchanged', 'the never-run already wrote it');
    assert.equal(r6b.steps.filter((x) => x.step === 'service').map((x) => x.action).join(','), 'waited,restarted');
    assert.equal(r6b.steps.find((x) => x.step === 'service' && x.action === 'restarted').detail, 'launcher changed');
    assert.match(r6b.steps.find((x) => x.action === 'waited').detail, /^\d+ s for Heartbeat \(main\) to finish$/);
    assert.equal(restartCalls().length, 3);
    assert.equal(install.readManifest(L).node.version, 'v24.22.0');
    const r6c = await install.setup({});
    assert.equal(by(r6c, 'service').action, 'unchanged', 'started with the current launcher and unit: nothing pending');
    assert.equal(restartCalls().length, 3);

    // 7. A plugin OpenClaw externalized under an older tree is relinked with the gateway stopped (else it loads unavailable).
    const ext = path.join(L.state, 'extensions', 'amazon-bedrock', 'node_modules');
    await mkdir(ext, { recursive: true });
    await symlink('/old/tree/node_modules/openclaw', path.join(ext, 'openclaw'));
    const npmPkg = path.join(L.state, 'npm', 'projects', 'openclaw-exa-plugin-43ba85cedc', 'node_modules', '@openclaw', 'exa-plugin', 'node_modules');
    await mkdir(npmPkg, { recursive: true });
    await symlink('/old/tree/node_modules/openclaw', path.join(npmPkg, 'openclaw'));
    assert.deepEqual(install.peerLinks(L, m.openclaw.mjs).map((l) => [l.plugin, l.ok]), [['amazon-bedrock', false], ['@openclaw/exa-plugin', false]], 'both layouts OpenClaw installs plugins in');
    const r7 = await install.setup({});
    assert.match(r7.steps.find((x) => x.step === 'service' && x.action === 'restarted').detail, /plugin peer links point at another OpenClaw tree \(amazon-bedrock, @openclaw\/exa-plugin\)/);
    assert.equal(by(r7, 'plugin links').action, 'relinked');
    for (const l of [path.join(ext, 'openclaw'), path.join(npmPkg, 'openclaw')]) assert.equal(await readlink(l), path.dirname(m.openclaw.mjs));
    if (process.platform !== 'darwin') { const stop = host.calls.findLastIndex((c) => c.startsWith('systemctl --user stop ')); assert.ok(stop >= 0 && host.calls.slice(stop).some((c) => c.startsWith('systemctl --user start ')), 'stop, relink, start'); }
    assert.equal(restartCalls().length, 4);
    const r7b = await install.setup({});
    assert.equal(by(r7b, 'service').action, 'unchanged', 'links fixed: nothing pending');

    // 8. Roles are fixed per host; pre-installer dirs are reported, never removed.
    await assert.rejects(install.setup({ role: 'other' }), /installed as role manager/);
    // An install from before scopes (role fleet, no scope) migrates on a plain run, keeping its actor.
    const legacy = install.readManifest(L); legacy.role = 'fleet'; delete legacy.scope; await writeFile(L.manifest, JSON.stringify(legacy));
    const rm2 = await install.setup({});
    assert.deepEqual([rm2.role, rm2.actor, rm2.scope], ['manager', 'manager', { hosts: 'all', exclude: ['macbook'], digest: true }]);
    // Moving the digest to another manager disables its automation here (kept, not deleted); taking it back re-enables it.
    const rd = await install.setup({ digest: false });
    assert.equal(rd.steps.find((x) => x.step === 'automation fleet-digest').action, 'disabled');
    assert.equal(host.jobs.find((j) => j.name === 'fleet-digest').enabled, false);
    const ordersNoDigest = await readFile(path.join(L.workspace, 'AGENTS.md'), 'utf8');
    assert.ok(!ordersNoDigest.includes('Program 2: Daily digest'));
    assert.match(ordersNoDigest, /\(once a day, step 1\), and the escalations above\./, 'no merge-request notes without the digest');
    assert.equal(JSON.parse(await readFile(L.config, 'utf8')).mcp.servers.drover.toolFilter, undefined, 'the tools stay: only the duty moves');
    const re = await install.setup({ digest: true });
    assert.equal(re.steps.find((x) => x.step === 'automation fleet-digest').action, 'enabled');
    await mkdir(path.join(home, 'code', 'openclaw-manager-poc', 'npm'), { recursive: true });
    const r6 = await install.setup({});
    assert.ok(r6.steps.some((s) => s.step === 'legacy' && s.detail.includes('openclaw-manager-poc')));
    assert.ok(existsSync(path.join(home, 'code', 'openclaw-manager-poc', 'npm')));

    // 9. Uninstall keeps the state unless purged.
    const u1 = await install.uninstall({});
    assert.equal(existsSync(L.service.file), false);
    for (const f of [L.launcher, L.oc, L.ro, L.manifest]) assert.equal(existsSync(f), false, f);
    assert.ok(existsSync(L.config) && existsSync(L.env), 'state kept');
    assert.ok(u1.steps.some((s) => s.step === 'kept'));
    await install.uninstall({ purge: true });
    assert.equal(existsSync(L.state), false);
    assert.equal(existsSync(L.installs), false);
    done();
  });

  test('a rotated secret restarts; a relative --node is made absolute; a deferred restart never prunes the running tree', async () => {
    const L = lay();
    const by = (r, s) => r.steps.findLast((x) => x.step === s);
    await install.setup({ ...{ scope: 'all', exclude: ['laptop'], digest: true, actor: 'manager' }, node: 'rel/v24/node' });
    const m1 = install.readManifest(L);
    assert.equal(m1.node.path, path.resolve('rel/v24/node'));
    assert.match(await readFile(L.launcher, 'utf8'), new RegExp(`exec '${path.resolve('rel/v24/node').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
    // Rotating a secret by hand: setup restarts so the gateway reads it.
    await appendFile(L.env, '');
    const env = install.parseEnvFile(await readFile(L.env, 'utf8'));
    await writeFile(L.env, Object.entries({ ...env, OPENCLAW_HOOKS_TOKEN: 'rotated_EXAMPLE' }).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
    const r2 = await install.setup({ node: 'rel/v24/node' });
    assert.equal(by(r2, 'service').action, 'restarted');
    assert.match(by(r2, 'service').detail, /secrets changed/);
    assert.ok(!JSON.stringify(r2).includes('rotated_EXAMPLE'));
    // The Langfuse pair reaches ~/.env_secrets: setup adds the derived trace header once (backed up) and restarts for it.
    await appendFile(path.join(home, '.env_secrets'), 'export LANGFUSE_PUBLIC_KEY=pk-lf-EXAMPLE\nexport LANGFUSE_SECRET_KEY=sk-lf-EXAMPLE\n');
    const r3 = await install.setup({ node: 'rel/v24/node' });
    assert.equal(r3.steps.find((x) => x.step === 'secrets').action, 'added');
    assert.equal(r3.steps.find((x) => x.step === 'secrets').detail, 'OTEL_EXPORTER_OTLP_HEADERS');
    assert.match(install.parseEnvFile(await readFile(L.env, 'utf8')).OTEL_EXPORTER_OTLP_HEADERS, /^Authorization=Basic%20/);
    assert.match(by(r3, 'service').detail, /secrets changed/);
    assert.ok(!JSON.stringify(r3).includes('sk-lf-EXAMPLE'));
    assert.equal((await install.setup({ node: 'rel/v24/node' })).steps.find((x) => x.step === 'secrets').action, 'unchanged', 'added once');

    // A new lockfile (tree B) installed twice with --restart never: tree A, still running, survives both.
    const src = await mkdtemp(path.join(tmpdir(), 'drover-oc-src2-'));
    await cp(install.SRC, src, { recursive: true });
    await appendFile(path.join(src, 'npm', 'package-lock.json'), '\n');
    const A = m1.openclaw.dir; const B = path.join(L.installs, install.lockInfo(src).dirName);
    assert.notEqual(A, B);
    await install.setup({ node: 'rel/v24/node', src, restart: 'never' });
    await install.setup({ node: 'rel/v24/node', src, restart: 'never' });
    assert.ok(existsSync(A), 'the tree the gateway runs from is kept while its restart is pending');
    assert.ok(existsSync(B));
    const r5 = await install.setup({ node: 'rel/v24/node', src });
    assert.equal(by(r5, 'service').action, 'restarted');
    await install.setup({ node: 'rel/v24/node', src });
    assert.equal(existsSync(A), false, 'pruned once nothing runs it');
    done();
  });

  test('a failed approvals read never runs doctor over an existing install', async () => {
    const L = lay();
    await install.setup({ scope: 'local', actor: 'manager-mac' });
    const doctors = () => host.calls.filter((c) => c.includes(' doctor --fix')).length;
    assert.equal(doctors(), 1, 'the first install imports once');
    host.approvalsReadFails = true;
    const r = await install.setup({});
    assert.equal(doctors(), 1, 'a manifest means approvals were imported before');
    assert.equal(r.steps.find((x) => x.step === 'approvals').action, 'error');
    await rm(L.manifest);   // an install from before the installer: a state database but no manifest
    await mkdir(path.join(L.state, 'state'), { recursive: true });
    await assert.rejects(install.setup({ scope: 'local', actor: 'manager-mac' }), /could not read the stored exec approvals, so none were imported/);
    assert.equal(doctors(), 1, 'never doctor because a read failed');
    done();
  });

  test('refuses an .env with names the profile does not use, and a missing secret source, without printing values', async () => {
    const L = lay();
    await mkdir(L.state, { recursive: true });
    await writeFile(L.env, `AWS_BEARER_TOKEN_BEDROCK=${BEARER}\nCLIPROXY_API_KEY=${PROXY}\nEXA_API_KEY=${EXA}\nOPENCLAW_GATEWAY_TOKEN=t\nOPENCLAW_HOOKS_TOKEN=h\nOPENAI_API_KEY=EXAMPLE_x\n`);
    await assert.rejects(install.setup({ scope: 'all', exclude: ['laptop'], digest: true, actor: 'manager' }), (e) => /unexpected OPENAI_API_KEY/.test(e.message) && !e.message.includes(BEARER));
    await rm(L.env);
    await writeFile(path.join(home, '.env_secrets'), `export AWS_BEARER_TOKEN_BEDROCK=${BEARER}\nexport CLIPROXY_API_KEY=${PROXY}\n`);
    await assert.rejects(install.setup({ scope: 'all', exclude: ['laptop'], digest: true, actor: 'manager' }), (e) => /EXA_API_KEY not found in ~\/\.env_secrets \(profile default\)/.test(e.message) && !e.message.includes(BEARER));
    done();
  });

  test('a hand-edited service file the supervisor already loaded is put back and re-read, not just restarted', async () => {
    const first = { scope: 'all', exclude: ['laptop'], digest: true, actor: 'manager' };
    await install.setup(first);
    const L = lay();
    await writeFile(L.service.file, 'hand edit\n');
    host.clock += 60_000; host.startedAt = host.clock; // the operator reloaded and restarted it with the edit
    const from = host.calls.length;
    const r = await install.setup({});
    assert.equal(r.steps.find((x) => x.step === 'service file').action, 'updated');
    assert.equal(r.steps.find((x) => x.step === 'service').detail, 'restarted outside setup while its service file differed');
    const calls = host.calls.slice(from).join('\n');
    if (L.service.kind === 'launchd') assert.match(calls, /launchctl bootout[\s\S]*launchctl bootstrap/, 'launchd loads the restored plist');
    else assert.match(calls, /systemctl --user daemon-reload[\s\S]*systemctl --user restart/, 'systemd reloads the restored unit before the restart');
    // Edited and reloaded but not restarted: systemd still holds the edit, so the restore is re-read without a restart.
    await writeFile(L.service.file, 'hand edit\n');
    const from2 = host.calls.length;
    const r2 = await install.setup({});
    assert.deepEqual([r2.steps.find((x) => x.step === 'service file').action, r2.steps.find((x) => x.step === 'service').action], ['updated', 'unchanged']);
    if (L.service.kind !== 'launchd') assert.match(host.calls.slice(from2).join('\n'), /systemctl --user daemon-reload/, 'systemd re-reads the restored unit without a restart');
    done();
  });

  test('a gateway slow to stop is waited for: launchd refuses to bootstrap a job it still lists', async () => {
    install._deps.platform = () => 'darwin';   // a Mac install on any host, so the Linux CI runner checks this too
    await install.setup({ scope: 'all', exclude: ['laptop'], digest: true, actor: 'manager' });
    const L = lay();
    assert.equal(L.service.kind, 'launchd');
    await writeFile(L.service.file, 'hand edit\n');
    host.clock += 60_000; host.startedAt = host.clock;   // restarted with the edit, so setup stops and reloads the restored file
    host.exitMs = 40_000;   // a loaded Mac's gateway took 40 s to close on SIGTERM (2026-10-21)
    host.printTimeouts = 1;   // a loaded Mac: one print hangs, which says nothing about the job
    const from = host.calls.length; const t0 = host.clock;
    const r = await install.setup({});
    assert.equal(r.steps.find((x) => x.step === 'service').action, 'restarted');
    assert.equal(host.active, true, 'the gateway runs again');
    {
      assert.deepEqual(host.calls.slice(from).filter((c) => /^launchctl (bootout|bootstrap)/.test(c)).map((c) => c.split(' ')[1]), ['bootout', 'bootstrap']);
      assert.ok(host.startedAt - t0 >= 40_000, 'loaded only once the old job had left');
      await writeFile(L.service.file, 'hand edit\n');
      host.clock += 60_000; host.startedAt = host.clock;
      host.exitMs = 400_000;   // past ExitTimeOut, when launchd would have killed it: said plainly, not as a failed bootstrap
      await assert.rejects(install.setup({}), /dev\.drover\.manager was still loaded 360 s after launchctl bootout; nothing was started/);
      host.clock += 400_000;
      await writeFile(L.service.file, 'hand edit\n');
      host.clock += 60_000; host.startedAt = host.clock;
      host.exitMs = 5_000_000; host.printTimeouts = 1e9;   // every print hangs: the deadline is wall time, not a count of 500 ms sleeps
      const t1 = host.clock;
      await assert.rejects(install.setup({}), /was still loaded 360 s after launchctl bootout/);
      assert.ok(host.clock - t1 < 400_000, `gave up after ${(host.clock - t1) / 1000} s`);
      host.printTimeouts = 0;
    }
    host.exitMs = 0;
    done();
  });

  test('a restart waits on an automation list that does not answer, as if a heartbeat were running', async () => {
    await install.setup({ scope: 'all', exclude: ['laptop'], digest: true, actor: 'manager' });
    const service = (r) => r.steps.filter((x) => x.step === 'service').map((x) => [x.action, x.detail]);
    host.listFailsUntil = host.clock + 25_000;
    assert.deepEqual(service(await install.setup({ restart: 'always' })), [['waited', '30 s for the automation list to answer'], ['restarted', 'asked for']]);
    host.listFailsUntil = Infinity;
    assert.deepEqual(service(await install.setup({ restart: 'always', waitIdleSec: 30 })), [['still busy', 'the automation list did not answer after 30 s; restarting anyway'], ['restarted', 'asked for']]);
    host.listFailsUntil = 0;
    done();
  });

  test('moving the digest away while the automation list does not answer fails loudly, and the next run finishes it', async () => {
    await install.setup({ scope: 'all', exclude: ['laptop'], digest: true, actor: 'manager' });
    host.listFailsUntil = Infinity;
    const r = await install.setup({ digest: false });
    assert.deepEqual(r.steps.filter((x) => x.step.startsWith('automation')).map((x) => [x.step, x.action]), [['automations', 'not ok']]);
    assert.equal(host.jobs.find((j) => j.name === 'fleet-digest').enabled, true, 'still running, and not reported as handled');
    host.listFailsUntil = 0;
    assert.equal((await install.setup({})).steps.find((x) => x.step === 'automation fleet-digest').action, 'disabled');
    done();
  });

  test('an existing automation is brought to the role\'s definition in place, never added twice', async () => {
    await install.setup({ scope: 'all', exclude: ['laptop'], digest: true, actor: 'manager' });
    const want = install.loadRole('manager').duties.digest.automations[0];
    assert.deepEqual([want.model, want.thinking], ['amazon-bedrock-mantle/openai.gpt-6-astra', 'max'], 'the digest runs on Astra at max');
    Object.assign(host.jobs[0].payload, { model: 'amazon-bedrock-mantle/openai.gpt-6-luna', thinking: 'low' });   // an older definition
    const from = host.calls.length;
    const r = await install.setup({});
    assert.deepEqual([r.steps.find((x) => x.step === 'automation fleet-digest').action, r.steps.find((x) => x.step === 'automation fleet-digest').detail], ['updated', 'model, thinking']);
    assert.ok(host.calls.slice(from).some((c) => / automations edit job-0 --model amazon-bedrock-mantle\/openai\.gpt-6-astra --thinking max$/.test(c)), 'edited in place');
    assert.equal(host.jobs.length, 1, 'no second digest job');
    assert.equal((await install.setup({})).steps.find((x) => x.step === 'automation fleet-digest').action, 'unchanged');
    done();
  });

  test('the pinned OpenClaw is patched so a sweep runs at the role\'s heartbeatThinking; a moved anchor fails the install', async () => {
    await install.setup({ scope: 'all', exclude: ['laptop'], digest: true, actor: 'manager' });
    const L = lay(); const lock = install.lockInfo(); const dist = path.join(L.installs, lock.dirName, 'node_modules', 'openclaw', 'dist');
    assert.match(lock.dirName, /-p[0-9a-f]{8}$/, 'the patch set is part of the tree name');
    assert.match(readFileSync(path.join(dist, 'heartbeat-runner-run-A1.mjs'), 'utf8'), /heartbeatModelOverride: heartbeat\?\.model\?\.trim\(\), thinkingLevelOverride: process\.env\.OPENCLAW_HEARTBEAT_THINKING \|\| void 0,/);
    assert.equal(readFileSync(path.join(dist, 'heartbeat-runner-run-B2.mjs'), 'utf8'), '// another runner chunk\n');
    assert.deepEqual(JSON.parse(readFileSync(path.join(L.installs, lock.dirName, '.drover-openclaw'), 'utf8')).patches, ['heartbeat-thinking']);
    assert.match(readFileSync(L.launcher, 'utf8'), /\nexport OPENCLAW_HEARTBEAT_THINKING='high'\n/, 'the launcher hands the role\'s level to the patch');
    const pkg = path.join(L.installs, lock.dirName, 'node_modules', 'openclaw');
    await install.applyPatches(pkg, lock.patches, lock.version);
    assert.equal(readFileSync(path.join(dist, 'heartbeat-runner-run-A1.mjs'), 'utf8').split('thinkingLevelOverride').length - 1, 1, 'applying twice changes nothing');
    await writeFile(path.join(dist, 'heartbeat-runner-run-C3.mjs'), 'replyOptions({ heartbeatModelOverride: heartbeat?.model?.trim(), })\n');
    await assert.rejects(install.applyPatches(pkg, lock.patches, lock.version), /its anchor occurs 1 times \(and 1 patched\) in 2 files/, 'a second site beside a patched one is not "already applied"');
    await rm(path.join(L.installs, lock.dirName), { recursive: true });
    host.anchorMoved = true;
    await assert.rejects(install.setup({}), /patch heartbeat-thinking does not apply to openclaw 2026\.10\.1: its anchor occurs 0 times in 0 files matching dist\/heartbeat-runner-run-\*\.mjs/);
    host.anchorMoved = false;
    done();
  });

  test('a first install needs a role and names the ones this checkout has; no usable node is a clear error', async () => {
    await assert.rejects(install.setup({}), /first install on this host: pass --scope local/);
    await rm(path.join(home, '.local', 'share', 'fnm'), { recursive: true });
    const first = { scope: 'all', exclude: ['laptop'], digest: true, actor: 'manager' };
    await assert.rejects(install.setup(first), /^Error: no node in >=24\.16\.0 <25 \|\| >=26\.1\.0 \(have: v24\.15\.0\); fnm install 24$/);
    host.runningNode = { ...host.runningNode, version: 'v24.22.0' };
    await install.setup(first);
    assert.deepEqual(install.readManifest(lay()).node, { path: host.runningNode.path, version: 'v24.22.0' }, 'without fnm, the node running drover is used when it is inside the range');
    done();
  });

  test('--profile from an overlay: its port, secrets, orders and seeds end to end; later runs keep profile and overlay without the variable', async () => {
    await mkdir(path.join(home, '.config', 'box-b'), { recursive: true });
    await writeFile(path.join(home, '.config', 'box-b', 'exa.env'), `EXA_API_KEY=${EXA}\n`);
    await writeFile(path.join(home, '.env_secrets'), `export AWS_BEARER_TOKEN_BEDROCK=${BEARER}\nexport CLIPROXY_API_KEY=${PROXY}\n`);
    const dir = await makeOverlay({
      'profiles/box-b.json': boxB(),
      'roles/manager/AGENTS.md': '# AGENTS.md\n\nYou are **{{ACTOR}}** on {{HOST}}, the box-b orders.\n',
      'workspace/box-b/USER.md': '# USER.md\n\n- box-b: the second fleet\n',
    });
    process.env.DROVER_OPENCLAW_OVERLAY = dir;
    const r = await install.setup({ profile: 'box-b', scope: 'all', digest: true, actor: 'manager' });
    const L = lay();
    assert.deepEqual([r.profile, r.overlay], ['box-b', dir]);
    const ov = r.steps.find((x) => x.step === 'overlay');
    assert.deepEqual([ov.action, ov.detail], ['used', `${dir}: ${path.join('roles', 'manager', 'AGENTS.md')}, ${path.join('profiles', 'box-b.json')}, ${path.join('workspace', 'box-b', 'USER.md')}`], 'names only, and only the files the overlay supplied');
    const cfg = JSON.parse(await readFile(L.config, 'utf8'));
    assert.deepEqual([cfg.gateway.port, cfg.diagnostics.otel.endpoint, cfg.models.providers.cliproxy.apiKey], [18831, 'http://127.0.0.1:3151/api/public/otel', 'EXAMPLE_loopback_literal'], 'the profile\'s own template values');
    assert.match(await readFile(L.launcher, 'utf8'), / gateway --port 18831\n$/);
    const m = install.readManifest(L);
    assert.deepEqual([m.profile, m.overlay, m.gateway.port, install.gatewayPort(L)], ['box-b', dir, 18831, 18831], 'the daemon and manager-say read the port from the manifest');
    assert.equal(install.parseEnvFile(await readFile(L.env, 'utf8')).EXA_API_KEY, EXA, 'Exa from the file the overlay profile names');
    assert.equal(await readFile(path.join(L.workspace, 'AGENTS.md'), 'utf8'), '# AGENTS.md\n\nYou are **manager** on ' + L.host + ', the box-b orders.\n', 'the overlay\'s orders, filled');
    assert.match(await readFile(path.join(L.workspace, 'USER.md'), 'utf8'), /box-b: the second fleet/, 'the profile\'s own seed');
    assert.equal(await readFile(path.join(L.workspace, 'SOUL.md'), 'utf8'), await readFile(path.join(install.SRC, 'workspace', 'SOUL.md'), 'utf8'), 'a seed the overlay lacks is the repo\'s');
    assert.equal(r.steps.find((x) => x.step === 'gateway').detail, '127.0.0.1:18831');
    // A later run from a shell without the variable (or the daemon's checks) reads the overlay the manifest names.
    delete process.env.DROVER_OPENCLAW_OVERLAY;
    const again = await install.setup({});
    assert.deepEqual([again.profile, again.overlay], ['box-b', dir], 'a later run keeps the manifest\'s profile and overlay');
    for (const s of ['config', 'AGENTS.md', 'service']) assert.equal(again.steps.find((x) => x.step === s).action, 'unchanged', s);
    assert.deepEqual(install.diffPaths(JSON.parse(await readFile(L.config, 'utf8')), install.expectedConfig({ manifest: install.readManifest(L), live: JSON.parse(await readFile(L.config, 'utf8')), lay: L })), [], 'what the console expects is what was rendered');
    // Turning the overlay off fails closed: the install's profile is not in the repo, so nothing is rewritten.
    process.env.DROVER_OPENCLAW_OVERLAY = 'none';
    await assert.rejects(install.setup({}), /no profile box-b \(profiles\/box-b\.json in .*\); profiles here: default/);
    assert.equal(install.expectedConfig({ manifest: install.readManifest(L), live: cfg, lay: L }), null, 'and the console reports no expectation rather than a wrong one');
    delete process.env.DROVER_OPENCLAW_OVERLAY;
    await assert.rejects(install.setup({ overlay: path.join(dir, 'missing') }), /overlay .*missing \(from --overlay\) is not a directory; pass --overlay none/);
    await rm(dir, { recursive: true, force: true });
    await assert.rejects(install.setup({}), /overlay .* \(from the install manifest\) is not a directory/, 'an overlay that went away is said plainly');
    done();
  });
});


test('gatewayPort: the port the install manifest records, else the default', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'drover-oc-port-'));
  const lay = install.layout({ home, platform: 'linux', env: {} });
  assert.equal(install.gatewayPort(lay), install.PORT, 'no manifest: the default');
  await mkdir(path.dirname(lay.manifest), { recursive: true });
  // A host where another OpenClaw already holds 18789: its profile moves the manager to 18831, and the manifest records it.
  await writeFile(lay.manifest, JSON.stringify({ gateway: { port: 18831 } }));
  assert.equal(install.gatewayPort(lay), 18831);
  for (const [manifest, why] of [[{}, 'no gateway'], [{ gateway: {} }, 'no port'], [{ gateway: { port: '18831' } }, 'a string'], [{ gateway: { port: 18831.5 } }, 'not an integer']]) {
    await writeFile(lay.manifest, JSON.stringify(manifest));
    assert.equal(install.gatewayPort(lay), install.PORT, why);
  }
  await writeFile(lay.manifest, '{ not json');
  assert.equal(install.gatewayPort(lay), install.PORT, 'an unreadable manifest falls back to the default');
  await rm(home, { recursive: true, force: true });
});
