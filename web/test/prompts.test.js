// The prompt spool (core/prompts.js): what a Claude Code and a Codex transcript line says (typed, queued, peer, drover,
// headless, sdk; tool results, bookkeeping and generated sessions left out), the collector's incremental pass (byte
// offsets, ids that never repeat across rescans, a rewritten file, a restart), day files by UTC day with mode 0600,
// secrets redacted, label rules (cwd glob, a git remote read from the repository's config, a worktree's .git file, the
// identity, default), prompts.local's filters and paging, and prompts.list's fan-out (a fake ssh peer per host) with a
// down host shown from a git sink's clone. Synthetic transcripts in a temp dir; nothing reads the user's.
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakePeer } from './fake-peer.js';

const tmp = await mkdtemp(path.join(tmpdir(), 'drover-prompts-'));
// Working directories in the transcripts: a made-up home, never under the temp dir (a temp working directory is skipped).
const HOME = '/home/example';
Object.assign(process.env, {
  DROVER_CACHE: path.join(tmp, 'cache'), DROVER_STATE: path.join(tmp, 'state'), DROVER_DOTFILES: path.join(tmp, 'dotfiles'),
  DROVER_EVENTS: path.join(tmp, 'dotfiles', 'claude', 'drover-events.jsonl'), DROVER_HOST: 'box-a',
  DROVER_PROMPTS_CONFIG: path.join(tmp, 'prompts.json'), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), CODEX_HOME: path.join(tmp, 'codex'),
});
await mkdir(path.join(tmp, 'dotfiles', 'claude'), { recursive: true });
await writeFile(path.join(tmp, 'dotfiles', 'claude', 'fleet-hosts.txt'), 'box-b\nbox-c\n');
await writeFile(process.env.DROVER_EVENTS, '');
const P = await import('../core/prompts.js');
const api = await import('../core/api.js');
const remote = await import('../core/remote.js');
const { META, isMutating } = await import('../core/ops-meta.js');
const { generatedTools } = await import('../mcp/server.js');
after(async () => { remote.stopAll(); await rm(tmp, { recursive: true, force: true }); });

// A key-shaped value redactSecrets catches, assembled at runtime so no literal here looks like one.
const FAKE_KEY = ['sk', 'EXAMPLE0EXAMPLE0EXAMPLE0'].join('-');

const J = (o) => JSON.stringify(o);
const cl = (o) => J({ parentUuid: null, isSidechain: false, userType: 'external', entrypoint: 'cli', cwd: `${HOME}/code/app`, sessionId: 'c1', ...o });
const typed = (uuid, timestamp, text, extra = {}) => cl({ type: 'user', message: { role: 'user', content: text }, uuid, timestamp, promptSource: 'typed', turnOrigin: 'human', ...extra });
const queued = (uuid, timestamp, text, origin = { kind: 'human' }) => cl({ type: 'attachment', attachment: { type: 'queued_command', prompt: text, origin, commandMode: 'prompt' }, uuid, timestamp });
const assistant = (uuid, timestamp, text) => cl({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, uuid, timestamp });
const cx = (type, payload, timestamp = '2026-11-21T09:00:00.000Z') => J({ timestamp, type, payload });

describe('one transcript line', () => {
  test('Claude: typed, queued, peer, a peer Drover relayed, sdk; tool results, notices, compaction, bookkeeping and meta turns are no prompt', () => {
    const p = (l) => P.claudePrompt(l)?.prompt ?? null;
    assert.deepEqual(p(typed('u1', '2026-11-21T10:00:00Z', 'fix the build')), { via: 'typed', from: null, text: 'fix the build' });
    assert.equal(p(typed('u1', 'x', 'old Claude Code', { promptSource: undefined, turnOrigin: undefined })).via, 'typed');
    assert.equal(p(typed('u2', 'x', 'while you work', { promptSource: 'queued' })).via, 'queued');
    assert.deepEqual(p(queued('u3', 'x', 'and also this')), { via: 'queued', from: null, text: 'and also this' });
    assert.deepEqual(p(queued('u4', 'x', '', { kind: 'peer', name: 'drover (owner)', body: 'relayed words' })), { via: 'drover', from: null, text: 'relayed words' });
    assert.deepEqual(p(queued('u5', 'x', '', { kind: 'peer', name: 'reviewer-2', body: 'peer words' })), { via: 'peer', from: 'reviewer-2', text: 'peer words' });
    assert.equal(p(queued('u6', 'x', 'task', { kind: 'coordinator' })), null, 'a parent writing to its subagent');
    assert.equal(p(queued('u7', 'x', 'done', { kind: 'task-notification' })), null);
    const env = (attrs, body) => typed('u8', 'x', `<cross-session-message ${attrs}>${body}</cross-session-message>`, { isMeta: true, promptSource: 'system', turnOrigin: 'peer' });
    assert.deepEqual(p(env('from="worker-1"', 'hello from a peer')), { via: 'peer', from: 'worker-1', text: 'hello from a peer' });
    assert.deepEqual(p(env('from-name="drover (owner)"', 'status?')), { via: 'drover', from: null, text: 'status?' });
    assert.equal(p(typed('u9', 'x', 'scripted', { entrypoint: 'sdk-cli', promptSource: 'sdk', turnOrigin: 'sdk' })).via, 'sdk');
    for (const o of [{ turnOrigin: 'task_notification', promptSource: 'system' }, { turnOrigin: 'scheduled' }, { isCompactSummary: true, isVisibleInTranscriptOnly: true }, { isMeta: true, promptSource: undefined, turnOrigin: undefined }, { isSidechain: true }]) {
      assert.equal(p(typed('u10', 'x', 'not a prompt', o)), null, J(o));
    }
    assert.equal(p(typed('u11', 'x', '<command-name>/clear</command-name>')), null, 'Claude Code bookkeeping');
    assert.equal(p(typed('u12', 'x', '[Request interrupted by user]')), null);
    assert.equal(P.claudePrompt(cl({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'out' }] }, toolUseResult: { stdout: 'out' }, uuid: 'u13' })), null, 'a tool result is not even parsed');
    assert.equal(P.claudePrompt(assistant('a1', 'x', 'I typed "type":"user" here')), null);
    const r = P.claudePrompt(typed('u14', '2026-11-21T10:00:00Z', `<system-reminder>injected</system-reminder>deploy with ${FAKE_KEY} now`));
    assert.equal(r.prompt.text, 'deploy with [redacted] now', 'reminders stripped, the secret redacted');
    assert.deepEqual([r.ts, r.ref, r.cwd, r.sessionId], ['2026-11-21T10:00:00Z', 'u14', `${HOME}/code/app`, 'c1']);
  });

  test('Codex: session_meta, turn_context and environment_context move the cwd; injected blocks are no prompt; exec is sdk; a subagent thread is skipped', () => {
    const st = {};
    assert.equal(P.codexPrompt(cx('session_meta', { id: 'x1', cwd: '/w/one', source: 'cli' }), st), null);
    assert.deepEqual([st.session, st.cwd, st.source], ['x1', '/w/one', 'cli']);
    const user = (text) => cx('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
    assert.equal(P.codexPrompt(user('<environment_context><cwd>/w/two</cwd></environment_context>'), st), null);
    assert.equal(st.cwd, '/w/two');
    assert.equal(P.codexPrompt(user('# AGENTS.md instructions for /w/two'), st), null);
    P.codexPrompt(cx('turn_context', { cwd: '/w/three' }), st);
    const r = P.codexPrompt(user('refactor the parser'), st);
    assert.deepEqual(r, { ts: '2026-11-21T09:00:00.000Z', ref: null, cwd: '/w/three', sessionId: 'x1', prompt: { via: 'typed', from: null, text: 'refactor the parser' } });
    assert.equal(P.codexPrompt(cx('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }), st), null);
    const ex = {}; P.codexPrompt(cx('session_meta', { id: 'x2', cwd: '/w', source: 'exec' }), ex);
    assert.equal(P.codexPrompt(user('one shot'), ex).prompt.via, 'sdk');
    const sub = {}; P.codexPrompt(cx('session_meta', { id: 'x3', cwd: '/w', source: { subagent: { thread_spawn: { parent_thread_id: 'x1' } } } }), sub);
    assert.equal(sub.skipped, 'subagent thread');
  });
});

describe('labels', () => {
  test('a cwd glob first, then a git remote from the repository config (a worktree .git file too), then the identity, then default', async () => {
    const repo = path.join(tmp, 'repos', 'personal-app'), wt = path.join(tmp, 'repos', 'wt-x');
    await mkdir(path.join(repo, '.git', 'worktrees', 'x'), { recursive: true }); await mkdir(path.join(repo, 'src', 'deep'), { recursive: true }); await mkdir(wt, { recursive: true });
    await writeFile(path.join(repo, '.git', 'config'), '[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://forge.example/other/x.git\n[remote "origin"]\n\turl = git@github.com:me/app.git\n');
    await writeFile(path.join(repo, '.git', 'worktrees', 'x', 'commondir'), '../..\n');
    await writeFile(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'x')}\n`);
    assert.deepEqual(P.repoRemotes(repo), ['git@github.com:me/app.git', 'https://forge.example/other/x.git'], 'origin first');
    assert.deepEqual(P.repoRemotes(wt), P.repoRemotes(repo), 'a worktree reads its main repository config');
    const l = new P.Labeler({ home: HOME, identity: 'work', rules: [{ cwd: '~/code/work-*', label: 'work' }, { remote: 'github\\.com[:/]me/', label: 'personal' }, { cwd: '/srv/**/secret', label: 'vault' }, { remote: '(', label: 'bad' }, { label: 'x' }] });
    assert.equal(l.errors.length, 2, 'a bad regular expression and a rule with no cwd or remote are named, not fatal');
    assert.equal(l.label(`${HOME}/code/work-api`), 'work');
    assert.equal(l.label(`${HOME}/code/work-api/packages/a`), 'work', 'a directory under a match');
    assert.equal(l.label(`${HOME}/code/workshop`), 'work', '* is any run within the segment');
    assert.equal(l.label(path.join(repo, 'src', 'deep')), 'personal');
    assert.equal(l.label(wt), 'personal');
    assert.equal(l.label('/srv/a/b/secret/c'), 'vault', '** crosses segments');
    assert.equal(l.label('/nowhere'), 'work', 'the identity');
    assert.equal(new P.Labeler({}).label('/nowhere'), 'default');
    assert.equal(new P.Labeler({ identity: 'personal' }).label(null), 'personal');
  });
});

/** A Claude project and a Codex sessions tree with every case the collector must tell apart. */
async function fixtures(root) {
  const claude = path.join(root, 'claude', 'projects'), codex = path.join(root, 'codex', 'sessions');
  const proj = path.join(claude, '-home-code-app');
  await mkdir(path.join(proj, 'c1', 'subagents'), { recursive: true });
  const main = path.join(proj, 'c1.jsonl');
  await writeFile(main, [
    typed('u1', '2026-11-20T23:59:59.000Z', 'first prompt, late on the 20th'),
    assistant('a1', '2026-11-21T00:00:00.500Z', 'ok'),
    typed('u2', '2026-11-21T00:00:01.000Z', `use the key ${FAKE_KEY} for the test`),
    queued('u3', '2026-11-21T00:05:00.000Z', 'queued while busy'),
    typed('u4', '2026-11-21T01:00:00.000Z', 'hello peer', { isMeta: true, promptSource: 'system', turnOrigin: 'peer', message: { role: 'user', content: '<cross-session-message from="worker-1">hello peer</cross-session-message>' } }),
    typed('u5', '2026-11-21T02:00:00.000Z', 'status?'),
    typed('u6', '2026-11-21T03:00:00.000Z', 'a scripted run', { entrypoint: 'sdk-cli', promptSource: 'sdk', turnOrigin: 'sdk' }),
  ].join('\n') + '\n');
  await writeFile(path.join(proj, 'c1', 'subagents', 'agent-1.jsonl'), typed('s1', '2026-11-21T04:00:00.000Z', 'subagent task') + '\n');
  // Sessions the index skips: one in a temp directory, one whose first prompt is a generator's.
  await writeFile(path.join(proj, 'tmpcwd.jsonl'), typed('t1', '2026-11-21T05:00:00.000Z', 'probe', { cwd: '/tmp/drover-probe', sessionId: 'tmpcwd' }) + '\n');
  await writeFile(path.join(proj, 'gen.jsonl'), typed('g1', '2026-11-21T05:00:00.000Z', 'You are writing the durable reflection of one AI coding session', { sessionId: 'gen' }) + '\n');
  await mkdir(path.join(claude, '-tmp-x'), { recursive: true });
  await writeFile(path.join(claude, '-tmp-x', 's.jsonl'), typed('t2', '2026-11-21T05:00:00.000Z', 'temp slug') + '\n');
  // Codex: a session, its subagent thread, and an exec run.
  const day = path.join(codex, '2026', '11', '21');
  await mkdir(day, { recursive: true });
  const user = (text, ts) => cx('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }, ts);
  await writeFile(path.join(day, 'rollout-2026-11-21T06-00-00-0199aaaa-1111-7222-8333-444455556666.jsonl'), [
    cx('session_meta', { id: '0199aaaa-1111-7222-8333-444455556666', cwd: `${HOME}/code/tool`, source: 'cli' }, '2026-11-21T06:00:00.000Z'),
    user('<environment_context><cwd>/x</cwd></environment_context>', '2026-11-21T06:00:00.100Z'),
    cx('turn_context', { cwd: `${HOME}/code/tool` }, '2026-11-21T06:00:01.000Z'),
    user('codex prompt one', '2026-11-21T06:00:02.000Z'),
  ].join('\n') + '\n');
  await writeFile(path.join(day, 'rollout-2026-11-21T06-10-00-0199bbbb-1111-7222-8333-444455556666.jsonl'), [
    cx('session_meta', { id: '0199bbbb-1111-7222-8333-444455556666', cwd: `${HOME}/code/tool`, source: { subagent: { thread_spawn: {} } } }),
    user('subagent thread prompt', '2026-11-21T06:10:00.000Z'),
  ].join('\n') + '\n');
  await writeFile(path.join(day, 'rollout-2026-11-21T06-20-00-0199cccc-1111-7222-8333-444455556666.jsonl'), [
    cx('session_meta', { id: '0199cccc-1111-7222-8333-444455556666', cwd: `${HOME}/code/tool`, source: 'exec' }),
    user('exec prompt', '2026-11-21T06:20:00.000Z'),
  ].join('\n') + '\n');
  return { claude, codex, main };
}

const spool = async (dir) => {
  const out = [];
  for (const f of (await readdir(dir).catch(() => [])).sort()) out.push(...(await readFile(path.join(dir, f), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  return out;
};

describe('the collector', () => {
  const root = path.join(tmp, 'collect');
  const dir = path.join(root, 'spool'), offsets = path.join(root, 'offsets.json'), eventsFile = path.join(root, 'events.jsonl');
  let fx;
  const make = () => new P.Collector({ env: { ...process.env, HOME }, roots: { claude: fx.claude, codex: fx.codex }, dir, offsets, host: 'box-a', eventsFile, identity: null, log: () => {} });
  before(async () => {
    fx = await fixtures(root);
    // What Drover sent: "status?" through tmux.send to this host a minute after the prompt time, and a headless launch.
    await writeFile(eventsFile, [
      J({ id: 'e1', ts: '2026-11-21T02:01:00.000Z', host: 'box-a', actor: 'owner', type: 'message', to: { kind: 'tmux', host: 'box-a', id: 'agents:1' }, text: 'status?', delivery: { ok: true, via: 'tmux paste' } }),
      J({ id: 'e2', ts: '2026-11-21T02:58:00.000Z', host: 'box-a', actor: 'owner', type: 'launch', engine: 'claude', mode: 'headless', prompt: 'a scripted run' }),
      J({ id: 'e3', ts: '2026-11-21T00:00:30.000Z', host: 'box-b', actor: 'owner', type: 'message', to: { kind: 'tmux', host: 'box-b', id: 'agents:1' }, text: 'queued while busy', delivery: { ok: true } }),
    ].join('\n') + '\n');
    await writeFile(process.env.DROVER_PROMPTS_CONFIG, J({ rules: [{ cwd: '~/code/tool', label: 'work' }] }));
  });

  test('a first pass keeps every prompt with its via, label and project, by UTC day, mode 0600; skipped sessions and subagents give nothing', async () => {
    const c = make();
    const r = await c.scan();
    assert.equal(r.added, 8);
    const recs = await spool(dir);
    const by = Object.fromEntries(recs.map((x) => [x.text, x]));
    assert.deepEqual(Object.keys(by).sort(), ['a scripted run', 'codex prompt one', 'exec prompt', 'first prompt, late on the 20th', 'hello peer', 'queued while busy', 'status?', 'use the key [redacted] for the test']);
    assert.equal(recs.length, 8);
    assert.ok(!recs.some((x) => /subagent|probe|temp slug|durable reflection/.test(x.text)), 'subagents, temp working directories and generated prompts are skipped');
    assert.ok(!JSON.stringify(recs).includes(FAKE_KEY), 'the key never reaches the spool');
    assert.equal(by['status?'].via, 'drover', 'a message event to this host with the same text a minute away');
    assert.equal(by['a scripted run'].via, 'headless', 'a headless launch prompt');
    assert.equal(by['queued while busy'].via, 'queued', 'a message to another host does not count here');
    assert.deepEqual([by['hello peer'].via, by['hello peer'].from], ['peer', 'worker-1']);
    assert.equal(by['codex prompt one'].via, 'typed'); assert.equal(by['exec prompt'].via, 'sdk');
    const f = by['first prompt, late on the 20th'];
    assert.deepEqual({ ...f, id: undefined }, { v: 1, id: undefined, ts: '2026-11-20T23:59:59.000Z', host: 'box-a', engine: 'claude', session: 'c1', cwd: '~/code/app', project: 'app', label: 'default', via: 'typed', text: 'first prompt, late on the 20th' });
    assert.equal(f.id, P.promptId({ host: 'box-a', engine: 'claude', session: 'c1', ref: 'u1', text: f.text }));
    assert.match(f.id, /^p_[0-9a-f]{16}$/);
    assert.equal(by['codex prompt one'].label, 'work', 'the cwd rule'); assert.equal(by['codex prompt one'].cwd, '~/code/tool');
    assert.equal(by['codex prompt one'].session, '0199aaaa-1111-7222-8333-444455556666');
    assert.deepEqual((await readdir(dir)).sort(), ['2026-11-20.jsonl', '2026-11-21.jsonl']);
    assert.equal((await readFile(path.join(dir, '2026-11-20.jsonl'), 'utf8')).trim().split('\n').length, 1);
    for (const n of await readdir(dir)) assert.equal((await stat(path.join(dir, n))).mode & 0o777, 0o600, n);
    assert.equal((await stat(offsets)).mode & 0o777, 0o600);
    const st = c.status();
    assert.deepEqual([st.records, st.files, st.oldest, st.newest, st.scanning], [8, 2, '2026-11-20T23:59:59.000Z', '2026-11-21T06:20:00.000Z', false]);
  });

  test('a second pass reads only what was appended; a rewritten file and a restarted collector add nothing twice', async () => {
    const c = make();
    assert.equal((await c.scan()).added, 0, 'a new collector loads the ids and offsets');
    await appendFile(fx.main, typed('u7', '2026-11-21T07:00:00.000Z', 'one more') + '\n');
    const r = await c.scan();
    assert.deepEqual([r.changed, r.added], [1, 1]);
    const saved = JSON.parse(await readFile(offsets, 'utf8')).files[fx.main];
    assert.equal(saved.offset, (await stat(fx.main)).size, 'the offset is the end of the file');
    // The same lines rewritten (a new inode, as a copy or a sync would leave it): read again, nothing new.
    const body = await readFile(fx.main, 'utf8');
    await rm(fx.main); await writeFile(fx.main, body);
    assert.equal((await c.scan()).added, 0);
    assert.equal((await spool(dir)).length, 9);
    assert.equal(new Set((await spool(dir)).map((x) => x.id)).size, 9);
  });

  test('a pass already running is shared, never run twice at once', async () => {
    const c = make();
    const [a, b] = [c.scan(), c.scan()];
    assert.equal(a, b);
    await a;
  });
});

describe('prompts.local: filters and paging', () => {
  const dir = P.spoolDir();
  const rec = (i, o = {}) => ({ v: 1, id: `p_${String(i).padStart(16, '0')}`, ts: new Date(Date.UTC(2026, 10, 19 + Math.floor(i / 10), i % 10)).toISOString(), host: 'box-a', engine: i % 3 ? 'claude' : 'codex', session: `s${i % 4}`, cwd: i % 2 ? '~/code/app' : '~/code/tool/sub', project: i % 2 ? 'app' : 'tool', label: i % 2 ? 'personal' : 'work', via: ['typed', 'queued', 'peer', 'drover', 'headless', 'sdk'][i % 6], text: `prompt number ${i}${i % 5 ? '' : ' Deploy the Thing'}`, ...o });
  before(async () => {
    await mkdir(dir, { recursive: true });
    const all = Array.from({ length: 30 }, (_, i) => rec(i));
    const byDay = new Map();
    for (const r of all) { const d = r.ts.slice(0, 10); byDay.set(d, [...(byDay.get(d) ?? []), J(r)]); }
    for (const [d, lines] of byDay) await writeFile(path.join(dir, `${d}.jsonl`), lines.join('\n') + '\n' + lines[0] + '\n');   // a repeated line counts once
  });
  const ids = (r) => r.prompts.map((p) => Number(p.id.slice(2)));
  const local = (a) => api.dispatch('prompts.local', a);

  test('default: the mine set, newest first, a total when every day was read', async () => {
    const r = await local({});
    assert.equal(r.host, 'box-a');
    assert.ok(r.prompts.every((p) => P.MINE.includes(p.via)));
    assert.deepEqual(ids(r), Array.from({ length: 30 }, (_, i) => 29 - i).filter((i) => P.MINE.includes(rec(i).via)));
    assert.equal(r.total, r.prompts.length); assert.equal(r.more, false);
  });
  test('q (all words, any case), via, engine, label, since/until, session prefix, cwd (or under it), id', async () => {
    assert.deepEqual(ids(await local({ q: 'deploy THING', via: 'all' })), [25, 20, 15, 10, 5, 0]);
    assert.deepEqual(ids(await local({ q: 'deploy nothing', via: 'all' })), []);
    assert.deepEqual(ids(await local({ via: ['peer'] })), [26, 20, 14, 8, 2]);
    assert.deepEqual(ids(await local({ via: 'peer,sdk' })), [29, 26, 23, 20, 17, 14, 11, 8, 5, 2]);
    assert.ok((await local({ via: 'all', engine: 'codex' })).prompts.every((p) => p.engine === 'codex'));
    assert.ok((await local({ via: 'all', label: ['work'] })).prompts.every((p) => p.label === 'work'));
    assert.deepEqual(ids(await local({ via: 'all', since: '2026-11-21T05:00:00Z', until: '2026-11-21T07:30:00Z' })), [27, 26, 25]);
    assert.ok((await local({ via: 'all', session: 's' })).prompts.length === 30);
    assert.deepEqual(ids(await local({ via: 'all', session: 's3' })), [27, 23, 19, 15, 11, 7, 3]);
    assert.equal((await local({ via: 'all', cwd: '~/code/tool' })).prompts.length, 15);
    assert.equal((await local({ via: 'all', cwd: `${process.env.HOME}/code/tool/sub/` })).prompts.length, 15, 'an absolute home path and a trailing slash');
    assert.equal((await local({ via: 'all', cwd: '~/code/to' })).prompts.length, 0, 'a directory, not a string prefix');
    assert.deepEqual(ids(await local({ id: 'p_0000000000000002' })), [2], 'an id filter takes any via');
    assert.deepEqual(P.whenMs('2d', 1_000_000_000_000), 1_000_000_000_000 - 2 * 86_400_000);
  });
  test('limit and before page through every day exactly once; before with beforeTs or alone', async () => {
    const seen = [];
    let page = await local({ via: 'all', limit: 7 });
    for (let i = 0; page.prompts.length; i++) {
      assert.ok(i < 10);
      seen.push(...ids(page));
      if (!page.more) break;
      const last = page.prompts.at(-1);
      page = await local({ via: 'all', limit: 7, before: last.id, ...(i % 2 ? { beforeTs: last.ts } : {}) });
    }
    assert.deepEqual(seen, Array.from({ length: 30 }, (_, i) => 29 - i));
    assert.equal((await local({ limit: 99999 })).prompts.length <= P.MAX_LIMIT, true);
    await assert.rejects(local({ before: 'p_ffffffffffffffff' }), /no prompt p_ffffffffffffffff here/);
  });
});

describe('prompts.list: the fan-out', () => {
  const real = { ...api.local };
  afterEach(() => { Object.assign(api.local, real); remote.stopAll(); });
  const mine = (host, i, o = {}) => ({ v: 1, id: `p_${host === 'box-b' ? 'b' : 'c'}${String(i).padStart(15, '0')}`, ts: `2026-11-22T0${i}:00:00.000Z`, host, engine: 'claude', session: 's', cwd: '~/x', project: 'x', label: 'default', via: 'typed', text: `${host} prompt ${i}`, ...o });

  test('every host in parallel, merged by id newest first; a host that is down shows from the sink clone; coverage says so', async () => {
    // box-c is down; its prompts were pushed to the "personal" git sink, whose clone on this machine holds them.
    await writeFile(process.env.DROVER_PROMPTS_CONFIG, J({ sinks: [{ name: 'personal', type: 'git', remote: path.join(tmp, 'no-remote.git'), labels: ['*'] }] }));
    const clone = path.join(process.env.DROVER_STATE, 'prompt-sinks', 'personal', 'prompts');
    await mkdir(path.join(clone, 'box-c'), { recursive: true }); await mkdir(path.join(clone, 'box-a'), { recursive: true });
    await writeFile(path.join(clone, 'box-c', '2026-11-22.jsonl'), [mine('box-c', 2), mine('box-c', 4), mine('box-c', 5, { via: 'peer' })].map(J).join('\n') + '\n');
    await writeFile(path.join(clone, 'box-a', '2026-11-22.jsonl'), J(mine('box-c', 9, { host: 'box-a', id: 'p_a000000000000009' })) + '\n');
    const calls = fakePeer(remote, ({ host, op, args }) => {
      if (host === 'box-c') return { $exit: 255, stderr: 'ssh: connect to host box-c port 22: Connection refused' };
      assert.equal(op, 'prompts.local');
      return { host: 'box-b', prompts: [mine('box-b', 3), mine('box-b', 1)].filter((p) => !args.q || p.text.includes(args.q)), more: false, total: 2, ms: 3 };
    }).calls;
    api.local['prompts.local'] = async () => ({ host: 'box-a', prompts: [mine('box-b', 6, { host: 'box-a', id: 'p_a000000000000006' }), mine('box-b', 3)], more: false, total: 2, ms: 1 });
    const r = await api.dispatch('prompts.list', { hosts: ['local', 'box-b', 'box-c'] });
    assert.deepEqual(r.prompts.map((p) => [p.id, p.route, p.source ?? null]), [
      ['p_a000000000000006', 'local', null], ['p_c000000000000004', 'box-c', 'sink:personal'], ['p_b000000000000003', 'local', null],
      ['p_c000000000000002', 'box-c', 'sink:personal'], ['p_b000000000000001', 'box-b', null]], 'merged by id (box-b 3 came from two hosts), the mine set from the clone, its own clone dir skipped');
    assert.deepEqual(calls.map((c) => c.op), ['prompts.local', 'prompts.local']);
    assert.deepEqual(r.perHost.map((p) => [p.host, p.ok, p.count, p.source ?? null]), [['box-a', true, 2, null], ['box-b', true, 2, null], ['box-c', false, 0, null], ['box-c', false, 2, 'sink:personal']]);
    assert.match(r.perHost[2].error, /Connection refused/);
    assert.deepEqual(r.coverage.notCovered.map((n) => n.host), ['box-c']);
    assert.deepEqual(r.coverage.partial, [{ host: 'box-c', reason: 'from the personal sink clone (as of its last pull)' }]);
    assert.equal(r.total, undefined, 'no total when a host did not answer');
  });

  test('host names one machine (the op stays on the front); limit cuts the merge; before pages from the same time on every host', async () => {
    await writeFile(process.env.DROVER_PROMPTS_CONFIG, '{}');
    const seen = [];
    fakePeer(remote, ({ host, args }) => { seen.push([host, args]); return { host, prompts: [mine('box-b', 3), mine('box-b', 2), mine('box-b', 1)].filter((p) => (!args.id || p.id === args.id) && (!args.beforeTs || p.ts < args.beforeTs)).slice(0, args.limit), more: false, ms: 1 }; });
    const r = await api.dispatch('prompts.list', { host: 'box-b', limit: 2 });
    assert.deepEqual(r.prompts.map((p) => p.id), ['p_b000000000000003', 'p_b000000000000002']);
    assert.equal(seen[0][1].limit, 2);
    assert.equal(r.total, undefined);
    const next = await api.dispatch('prompts.list', { host: 'box-b', limit: 2, before: 'p_b000000000000002' });
    assert.deepEqual(next.prompts.map((p) => p.id), ['p_b000000000000001'], 'the cursor time came from the host itself');
    assert.equal(seen.at(-1)[1].beforeTs, '2026-11-22T02:00:00.000Z');
    await assert.rejects(api.dispatch('prompts.list', { host: 'box-b', before: 'p_0000000000000bad' }), /no prompt p_0000000000000bad on any host/);
  });
});

describe('the op table, MCP and routing', () => {
  test('prompts.* and tmux.captureMany are ops with metadata; only sync mutates; list is front-only; MCP tools are generated', () => {
    for (const op of ['prompts.list', 'prompts.local', 'prompts.status', 'prompts.sync', 'tmux.captureMany']) { assert.ok(api.OPS.includes(op), op); assert.ok(META[op]?.d.length > 40, op); }
    assert.deepEqual(['prompts.list', 'prompts.local', 'prompts.status', 'prompts.sync', 'tmux.captureMany'].map(isMutating), [false, false, false, true, false]);
    assert.ok(META['prompts.sync'].s.properties.actor, 'a write takes actor');
    assert.deepEqual(META['tmux.captureMany'].s.required, ['targets']);
    const names = generatedTools().map((t) => t.name);
    for (const n of ['drover_prompts_list', 'drover_prompts_status', 'drover_prompts_sync', 'drover_tmux_captureMany']) assert.ok(names.includes(n), n);
    assert.equal(api.hostTimeoutMs('prompts.sync'), 140_000);
  });
  test('prompts.status and prompts.sync with no daemon run here: an empty config means the local spool only', async () => {
    await writeFile(process.env.DROVER_PROMPTS_CONFIG, '{}');
    const s = await api.dispatch('prompts.status', {});
    assert.equal(s.host, 'box-a'); assert.equal(s.enabled, false, 'off under node --test'); assert.deepEqual(s.sinks, []);
    assert.equal(typeof s.records, 'number');
    const y = await api.dispatchRecorded('prompts.sync', { actor: 'test' });
    assert.deepEqual(y.sinks, []); assert.equal(typeof y.scanned, 'number');
    assert.equal(P.enabled({ NODE_TEST_CONTEXT: 'child' }), false); assert.equal(P.enabled({ NODE_TEST_CONTEXT: 'child', DROVER_PROMPTS: 'on' }), true);
    assert.equal(P.enabled({ DROVER_PROMPTS: 'off' }), false); assert.equal(P.enabled({}), true);
  });
});
