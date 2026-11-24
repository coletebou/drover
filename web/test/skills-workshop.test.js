// The learned-skills ops (core/skills.js, the dotfiles skill-workshop CLI) behind the op table. Two halves:
// - against a fake CLI: what argv each op builds, what is refused before anything runs, how the CLI's own error comes
//   back, and that the CLI never inherits an agent session's markers;
// - against the real CLI on a throwaway store (temp dirs for every SKILL_WORKSHOP_* path, git off): list, changes, read,
//   versions, drafts, archive and restore, undo twice, mode, and a refusal surfaced with its message. The real CLI is
//   DROVER_SKILL_WORKSHOP_BIN when set, else <dotfiles>/scripts/skill-workshop; a box without it (CI) skips that half.
// A temp truth file and cache dir keep the real ones untouched.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'drover-skills-'));
process.env.DROVER_EVENTS = path.join(dir, 'events.jsonl');   // before core/events.js reads it
process.env.DROVER_CACHE = path.join(dir, 'cache');
await writeFile(process.env.DROVER_EVENTS, '');
const skills = await import('../core/skills.js');
const api = await import('../core/api.js');
const { readAll } = await import('../core/events.js');
const { OWNER } = await import('../core/owner.js');

const REAL_BIN = process.env.DROVER_SKILL_WORKSHOP_BIN || skills.skillWorkshopBin({ ...process.env, DROVER_SKILL_WORKSHOP_BIN: undefined, APXW_SKILL_WORKSHOP_BIN: undefined });
const realWorks = existsSync(REAL_BIN) && spawnSync(REAL_BIN, ['--help'], { encoding: 'utf8' }).status === 0;
const FAKE = path.join(dir, 'fake', 'skill-workshop');

after(async () => { await rm(dir, { recursive: true, force: true }); });
const opEvents = async (op) => (await readAll(process.env.DROVER_EVENTS)).filter((e) => e.type === 'op' && e.op === op);

const FAKE_CLI = `#!${process.execPath}
// Fake skill-workshop: logs {argv, env markers} to calls.jsonl and answers the way the real one does.
const fs = require('fs'), path = require('path');
const argv = process.argv.slice(2);
const env = Object.fromEntries(['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'SKILL_WORKSHOP_DOTFILES'].map((k) => [k, process.env[k] ?? null]));
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify({ argv, env }) + '\\n');
const rest = argv.includes('--') ? argv.slice(argv.indexOf('--') + 1) : [];
const die = (m) => { process.stderr.write('skill-workshop: ' + m + '\\n'); process.exit(2); };
const out = (o) => process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o) + '\\n');
const change = (action, skill) => ({ change: { id: 'c-new23456', action, skill, actor: 'user', version: '20261124T013451Z-ab2c' }, advisories: [] });
switch (argv[0]) {
  case 'list': out({ mode: 'propose', root: '/x', skills: [], archived: [], drafts: [] }); break;
  case 'changes': out([{ id: 'c-abcd2345', action: 'patch', skill: 'demo' }]); break;
  case 'view': if (rest[0] === 'gone') die("no live learned skill named 'gone'"); out('# text of ' + (rest[0] || argv.find((a) => a.startsWith('--draft='))) + '\\n'); break;
  case 'versions': out(['20261124T013451Z-ab2c']); break;
  case 'drafts': out([]); break;
  case 'usage': out([]); break;
  case 'mode': out((rest[0] || argv.filter((a) => !a.startsWith('-'))[1] || 'propose') + '\\n'); break;
  case 'archive': out(change('archive', rest[0])); break;
  case 'restore': out(change('restore', rest[0])); break;
  case 'undo': if (rest[0] === 'c-missing2') die("no change or review run 'c-missing2'; \`skill-workshop changes\` lists them."); out({ status: 'undone', changes: [{ id: 'c-rest2345', action: 'restore' }, { id: 'c-mark2345', action: 'undo', undoes: rest[0] }] }); break;
  case 'apply-draft': out(change('create', 'demo')); break;
  case 'discard': out({ id: rest[0], skill: 'demo' }); break;
  default: process.stderr.write('usage: skill-workshop [-h] ...\\nskill-workshop: error: argument cmd: invalid choice: ' + JSON.stringify(argv[0]) + '\\n'); process.exit(2);
}
`;

describe('against a fake CLI: argv, refusals, errors', () => {
  const calls = async () => { const f = path.join(path.dirname(FAKE), 'calls.jsonl'); return existsSync(f) ? (await readFile(f, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; };
  const last = async () => (await calls()).at(-1);
  let saved;
  before(async () => {
    await mkdir(path.dirname(FAKE), { recursive: true });
    await writeFile(FAKE, FAKE_CLI); await chmod(FAKE, 0o755);
    saved = { bin: process.env.DROVER_SKILL_WORKSHOP_BIN, cc: process.env.CLAUDECODE, sid: process.env.CLAUDE_CODE_SESSION_ID, cx: process.env.CODEX_THREAD_ID };
    process.env.DROVER_SKILL_WORKSHOP_BIN = FAKE;
  });
  beforeEach(async () => { await rm(path.join(path.dirname(FAKE), 'calls.jsonl'), { force: true }); });
  after(() => {
    for (const [k, v] of [['DROVER_SKILL_WORKSHOP_BIN', saved.bin], ['CLAUDECODE', saved.cc], ['CLAUDE_CODE_SESSION_ID', saved.sid], ['CODEX_THREAD_ID', saved.cx]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  test('reads: --json and --name=value flags, positionals after --', async () => {
    assert.equal((await api.dispatch('skills.workshop.list', {})).available, true);
    assert.deepEqual((await last()).argv, ['list', '--json']);
    await api.dispatch('skills.workshop.changes', { limit: 5, skill: 'demo', run: 'r-abcd2345' });
    assert.deepEqual((await last()).argv, ['changes', '--json', '--limit=5', '--run=r-abcd2345', '--skill=demo']);
    assert.deepEqual(await api.dispatch('skills.workshop.read', { name: 'demo', file: 'references/notes.md', version: '20261124T013451Z-ab2c' }), { name: 'demo', file: 'references/notes.md', version: '20261124T013451Z-ab2c', text: '# text of demo\n' });
    assert.deepEqual((await last()).argv, ['view', '--file=references/notes.md', '--version=20261124T013451Z-ab2c', '--', 'demo']);
    assert.deepEqual(await api.dispatch('skills.workshop.read', { draft: 'd-abcd2345' }), { draft: 'd-abcd2345', file: 'SKILL.md', text: '# text of --draft=d-abcd2345\n' });
    assert.deepEqual((await last()).argv, ['view', '--draft=d-abcd2345']);
    await api.dispatch('skills.workshop.versions', { name: 'demo' });
    assert.deepEqual((await last()).argv, ['versions', '--json', '--', 'demo']);
    await api.dispatch('skills.workshop.usage', { all: true, days: 7 });
    assert.deepEqual((await last()).argv, ['usage', '--json', '--all', '--days=7']);
    assert.deepEqual(await api.dispatch('skills.workshop.mode', {}), { mode: 'propose' });
  });

  test('writes go in as --actor user whoever calls, and the change id comes back on top', async () => {
    assert.equal((await api.dispatch('skills.workshop.archive', { name: 'demo', reason: '-superseded\nby other', absorbedInto: 'other', actor: 'mcp' })).id, 'c-new23456');
    assert.deepEqual((await last()).argv, ['archive', '--json', '--actor=user', '--reason=-superseded by other', '--absorbed-into=other', '--', 'demo']);
    await api.dispatch('skills.workshop.restore', { name: 'demo' });
    assert.deepEqual((await last()).argv, ['restore', '--json', '--actor=user', '--', 'demo']);
    const u = await api.dispatch('skills.workshop.undo', { id: 'r-abcd2345' });
    assert.deepEqual([u.ok, u.id, u.count, u.status], [true, 'c-mark2345', 2, 'undone']);
    assert.deepEqual((await last()).argv, ['undo', '--json', '--actor=user', '--', 'r-abcd2345']);
    await api.dispatch('skills.workshop.applyDraft', { id: 'd-abcd2345' });
    assert.deepEqual((await last()).argv, ['apply-draft', '--json', '--actor=user', '--', 'd-abcd2345']);
    assert.deepEqual(await api.dispatch('skills.workshop.discardDraft', { id: 'd-abcd2345' }), { ok: true, id: 'd-abcd2345', skill: 'demo' });
    assert.deepEqual(await api.dispatch('skills.workshop.setMode', { mode: 'off' }), { ok: true, mode: 'off' });
    assert.deepEqual((await last()).argv, ['mode', '--actor=user', 'off']);
  });

  test('the CLI never sees the agent session the daemon or MCP server was started from', async () => {
    Object.assign(process.env, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'sess-1', CODEX_THREAD_ID: 'th-1' });
    try { await api.dispatch('skills.workshop.undo', { id: 'c-abcd2345' }); } finally { delete process.env.CLAUDECODE; delete process.env.CLAUDE_CODE_SESSION_ID; delete process.env.CODEX_THREAD_ID; }
    const { env } = await last();
    assert.deepEqual([env.CLAUDECODE, env.CLAUDE_CODE_SESSION_ID, env.CODEX_THREAD_ID], [null, null, null]);
    assert.ok(env.SKILL_WORKSHOP_DOTFILES, 'the CLI is told which dotfiles checkout Drover uses');
  });

  test('bad names, ids, versions, files and modes are refused before the CLI runs', async () => {
    for (const [op, args, msg] of [
      ['skills.workshop.read', { name: '../etc' }, /name must be a learned-skill name/],
      ['skills.workshop.read', { name: 'demo', version: '../../x' }, /version must be a saved version id/],
      ['skills.workshop.read', { name: 'demo', file: '../config.json' }, /file must be a path inside the skill/],
      ['skills.workshop.read', { draft: 'd-abcd2345', file: '/etc/passwd' }, /file must be a path inside the skill/],
      ['skills.workshop.read', { draft: 'd-abcd2345', file: '.git/config' }, /file must be a path inside the skill/],
      ['skills.workshop.read', { draft: 'x', name: 'demo' }, /not both/],
      ['skills.workshop.read', { draft: '../d' }, /draft must be a draft id/],
      ['skills.workshop.undo', { id: '--all' }, /id must be a change id/],
      ['skills.workshop.undo', {}, /id must be a non-empty string/],
      ['skills.workshop.archive', { name: 'demo' }, /reason must be a non-empty string/],
      ['skills.workshop.archive', { name: 'demo', reason: 'r', absorbedInto: 'Bad Name' }, /absorbedInto must be a learned-skill name/],
      ['skills.workshop.applyDraft', { id: 'c-abcd2345' }, /id must be a draft id/],
      ['skills.workshop.setMode', { mode: 'on' }, /mode must be one of auto, propose, off/],
      ['skills.workshop.changes', { limit: 0 }, /limit must be an integer/],
      ['skills.workshop.changes', { run: 'c-abcd2345' }, /run must be a review run id/],
    ]) await assert.rejects(api.dispatch(op, args), msg, `${op} ${JSON.stringify(args)}`);
    assert.equal((await calls()).length, 0);
  });

  test('the CLI\'s own refusal (exit 2, "skill-workshop: <why>") comes back as the message, and is recorded as a failed write', async () => {
    await assert.rejects(api.dispatchCached('skills.workshop.undo', { id: 'c-missing2', actor: 'mcp' }), /^Error: skill-workshop undo: no change or review run 'c-missing2'; `skill-workshop changes` lists them\.$/);
    const ev = (await opEvents('skills.workshop.undo')).at(-1);
    assert.equal(ev.ok, false);
    assert.equal(ev.actor, 'mcp');
    assert.match(ev.error, /no change or review run 'c-missing2'/);
    await assert.rejects(api.dispatch('skills.workshop.read', { name: 'gone' }), /^Error: skill-workshop view: no live learned skill named 'gone'$/);
  });

  test('a missing CLI: list says so in its answer (the view shows it), the rest throw', async () => {
    process.env.DROVER_SKILL_WORKSHOP_BIN = path.join(dir, 'nope');
    try {
      const r = await api.dispatch('skills.workshop.list', {});
      assert.equal(r.available, false);
      assert.match(r.error, /skill-workshop CLI missing: .*nope$/);
      assert.deepEqual([r.skills, r.drafts, r.archived], [[], [], []]);
      await assert.rejects(api.dispatch('skills.workshop.changes', {}), /skill-workshop CLI missing/);
    } finally { process.env.DROVER_SKILL_WORKSHOP_BIN = FAKE; }
  });
});

describe('against the real CLI on a throwaway store', { skip: !realWorks && `no skill-workshop CLI at ${REAL_BIN} (set DROVER_SKILL_WORKSHOP_BIN)` }, () => {
  const store = path.join(dir, 'store');
  const SW_ENV = {
    SKILL_WORKSHOP_ROOT: path.join(store, 'root'), SKILL_WORKSHOP_USAGE_DIR: path.join(store, 'usage'), SKILL_WORKSHOP_CLAUDE_SKILLS: path.join(store, 'claude'),
    SKILL_WORKSHOP_CODEX_SKILLS: path.join(store, 'codex'), SKILL_WORKSHOP_STATE: path.join(store, 'state'), SKILL_WORKSHOP_LOG: path.join(store, 'sw.jsonl'),
    SKILL_WORKSHOP_HOST: 'test', SKILL_WORKSHOP_GIT: '0',
  };
  const saved = {};
  const skillMd = (name, body) => `---\nname: ${name}\ndescription: Use when testing ${name}; produces a test result.\n---\n\n# ${name}\n\n${body}\n`;
  /** Set up the store the way an agent would: the CLI directly, as an agent. */
  const asAgent = (argv, input) => {
    const r = spawnSync(REAL_BIN, [...argv, '--actor', 'agent', '--json'], { input, encoding: 'utf8', env: { ...process.env, ...SW_ENV } });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  let created, patched;
  before(async () => {
    for (const k of [...Object.keys(SW_ENV), 'SKILL_WORKSHOP_MODE', 'DROVER_SKILL_WORKSHOP_BIN']) saved[k] = process.env[k];
    for (const k of ['root', 'usage', 'claude', 'codex', 'state']) await mkdir(path.join(store, k), { recursive: true });
    Object.assign(process.env, SW_ENV, { DROVER_SKILL_WORKSHOP_BIN: REAL_BIN });
    delete process.env.SKILL_WORKSHOP_MODE;
    created = asAgent(['create', 'demo-skill', '--reason', 'first cut', '--content-file', '-'], skillMd('demo-skill', 'Step one.')).change;
    patched = asAgent(['patch', 'demo-skill', '--old', 'Step one.', '--new', 'Step one.\nStep two.', '--reason', 'add step two']).change;
    asAgent(['create', 'other-skill', '--reason', 'second', '--content-file', '-'], skillMd('other-skill', 'Other.'));
  });
  after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  test('list, changes, versions and read (live and a saved version) through the op table', async () => {
    const l = await api.dispatch('skills.workshop.list', {});
    assert.equal(l.available, true);
    assert.equal(l.mode, 'propose');
    assert.deepEqual(l.skills.map((s) => s.name).sort(), ['demo-skill', 'other-skill']);
    const demo = l.skills.find((s) => s.name === 'demo-skill');
    assert.equal(demo.description, 'Use when testing demo-skill; produces a test result.');
    assert.deepEqual([demo.uses, demo.lastUsed, demo.files], [0, null, ['SKILL.md']]);
    const rows = await api.dispatch('skills.workshop.changes', { skill: 'demo-skill' });
    assert.deepEqual(rows.map((r) => [r.id, r.action, r.actor]), [[patched.id, 'patch', 'agent'], [created.id, 'create', 'agent']]);
    assert.deepEqual(await api.dispatch('skills.workshop.versions', { name: 'demo-skill' }), [patched.version]);
    assert.match((await api.dispatch('skills.workshop.read', { name: 'demo-skill' })).text, /Step one\.\nStep two\./);
    const old = await api.dispatch('skills.workshop.read', { name: 'demo-skill', version: patched.version });
    assert.match(old.text, /Step one\.\n$/);
    assert.equal(old.version, patched.version);
  });

  test('undo a change: the skill goes back, the change feed names the owner (actor user), the truth file the caller; twice is already-undone', async () => {
    const r = await api.dispatchCached('skills.workshop.undo', { id: patched.id, actor: 'mcp' });
    assert.equal(r.result.status, 'undone');
    assert.equal(r.result.ok, true);
    const [restoreRow, marker] = r.result.changes;
    assert.deepEqual([restoreRow.action, restoreRow.actor, restoreRow.skill], ['restore', 'user', 'demo-skill']);
    assert.deepEqual([marker.action, marker.actor, marker.undoes], ['undo', 'user', patched.id]);
    assert.equal(r.result.id, marker.id);
    assert.equal(marker.session, null, 'no agent session is stamped on the owner\'s change');
    assert.doesNotMatch((await api.dispatch('skills.workshop.read', { name: 'demo-skill' })).text, /Step two/);
    const ev = (await opEvents('skills.workshop.undo')).at(-1);
    assert.deepEqual([ev.ok, ev.actor, ev.args.id, ev.result.id, ev.result.count], [true, 'mcp', patched.id, marker.id, 2]);
    assert.deepEqual((await api.dispatchCached('skills.workshop.undo', { id: patched.id })).result, { ok: true, id: null, count: 0, status: 'already-undone', changes: [] });
    assert.equal((await opEvents('skills.workshop.undo')).at(-1).actor, OWNER, 'without an actor (the UI) the truth file names the owner');
  });

  test('the CLI\'s refusal comes back with its message', async () => {
    await assert.rejects(api.dispatch('skills.workshop.undo', { id: 'c-zzzzzzzz' }), /^Error: skill-workshop undo: no change or review run 'c-zzzzzzzz'; `skill-workshop changes` lists them\.$/);
    await assert.rejects(api.dispatch('skills.workshop.read', { name: 'demo-skill', version: '20200101T000000Z-zzzz' }), /^Error: skill-workshop view: demo-skill has no saved version 20200101T000000Z-zzzz/);
    await assert.rejects(api.dispatch('skills.workshop.archive', { name: 'nothing-here', reason: 'r' }), /^Error: skill-workshop archive: no live learned skill named 'nothing-here'$/);
  });

  test('archive then restore an archived skill; list moves it between live and archived', async () => {
    const a = await api.dispatchCached('skills.workshop.archive', { name: 'other-skill', reason: 'folded into demo-skill', absorbedInto: 'demo-skill' });
    assert.deepEqual([a.result.change.action, a.result.change.actor, a.result.change.absorbed_into], ['archive', 'user', 'demo-skill']);
    let l = (await api.dispatchCached('skills.workshop.list', {})).result;
    assert.deepEqual(l.skills.map((s) => s.name), ['demo-skill'], 'the write dropped the cached list');
    assert.deepEqual(l.archived.map((x) => x.name), ['other-skill']);
    const r = await api.dispatchCached('skills.workshop.restore', { name: 'other-skill' });
    assert.deepEqual([r.result.change.action, r.result.change.restored], ['restore', l.archived[0].versions[0]]);
    l = (await api.dispatchCached('skills.workshop.list', {})).result;
    assert.deepEqual(l.skills.map((s) => s.name).sort(), ['demo-skill', 'other-skill']);
  });

  test('drafts: read one, apply one, discard one', async () => {
    const d1 = asAgent(['draft', 'demo-skill', '--reason', 'rewrite', '--content-file', '-'], skillMd('demo-skill', 'Rewritten.'));
    const d2 = asAgent(['draft', 'new-skill', '--reason', 'brand new', '--content-file', '-'], skillMd('new-skill', 'New.'));
    const ds = await api.dispatch('skills.workshop.drafts', {});
    assert.deepEqual(ds.map((d) => [d.id, d.skill, d.replaces]).sort((a, b) => a[1].localeCompare(b[1])), [[d1.id, 'demo-skill', true], [d2.id, 'new-skill', false]]);
    assert.match((await api.dispatch('skills.workshop.read', { draft: d1.id })).text, /Rewritten\./);
    const applied = await api.dispatch('skills.workshop.applyDraft', { id: d1.id });
    assert.deepEqual([applied.change.action, applied.change.actor], ['write_file', 'user']);
    assert.match((await api.dispatch('skills.workshop.read', { name: 'demo-skill' })).text, /Rewritten\./);
    assert.equal((await api.dispatch('skills.workshop.discardDraft', { id: d2.id })).skill, 'new-skill');
    assert.deepEqual(await api.dispatch('skills.workshop.drafts', {}), []);
    assert.equal((await api.dispatch('skills.workshop.list', {})).skills.some((s) => s.name === 'new-skill'), false);
  });

  test('mode: read and set (the synced setting)', async () => {
    assert.deepEqual(await api.dispatch('skills.workshop.mode', {}), { mode: 'propose' });
    assert.deepEqual((await api.dispatchCached('skills.workshop.setMode', { mode: 'off' })).result, { ok: true, mode: 'off' });
    assert.equal((await api.dispatch('skills.workshop.list', {})).mode, 'off');
    assert.deepEqual(JSON.parse(await readFile(path.join(SW_ENV.SKILL_WORKSHOP_ROOT, 'config.json'), 'utf8')), { mode: 'off' });
  });
});
