// Server ops added for alerts, uploads and the file editor: settings.* and
// notify.mute (truth-file patches), uploads.* (per-session inbox, size cap, WAL
// without bytes), files.* (allowlist, traversal, symlink escape, secret refusal,
// conflict-safe atomic writes), the CORS rule for direct peers, and that every
// new op reaches the MCP tool list.
import './isolate-cache.js';
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as settings from '../core/settings.js';
import * as uploads from '../core/uploads.js';
import * as files from '../core/files.js';
import { readAll } from '../core/events.js';
import { DEFAULT_SETTINGS } from '../ui/notify-policy.js';
import { corsHeaders } from '../server/http.js';
import { ALL_TOOLS } from '../mcp/server.js';
import { META } from '../core/ops-meta.js';
import { OPS } from '../core/api.js';

describe('settings ops', () => {
  let file;
  before(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'drover-set-'));
    file = path.join(dir, 'events.jsonl'); await writeFile(file, '');
    settings._deps.eventsFile = () => file;
    settings._deps.now = () => Date.parse('2026-10-11T12:00:00Z');
    settings.invalidate();
  });
  test('get returns defaults plus the catalog', async () => {
    const g = await settings.get();
    assert.deepEqual(g.settings.categories, DEFAULT_SETTINGS.categories);
    assert.equal(g.updated, null);
    assert.ok(g.catalog.categories.length >= 7);
    assert.ok(g.catalog.sounds.some((s) => s.id === 'chime'));
  });
  test('set records a validated patch in the WAL and merges it', async () => {
    const seen = [];
    const off = settings.onChange((s) => seen.push(s));
    const r = await settings.set({ categories: { finished: { sound: 'ping', volume: 2 } } }, { actor: 'test' });
    off();
    assert.equal(r.settings.categories.finished.sound, 'ping');
    assert.equal(r.settings.categories.finished.volume, 1, 'clamped');
    assert.equal(r.settings.categories.finished.desktop, true, 'siblings kept');
    const evs = await readAll(file);
    assert.deepEqual(evs.map((e) => [e.type, e.actor]), [['settings', 'test']]);
    assert.deepEqual(evs[0].patch, { categories: { finished: { sound: 'ping', volume: 1 } } });
    assert.equal(seen.length, 1);
    await assert.rejects(() => settings.set({ categories: { finished: { sound: 'kazoo' } } }), /unknown sound/);
    await assert.rejects(() => settings.set({}), /nothing to change/);
    assert.equal((await readAll(file)).length, 1, 'a rejected patch writes nothing');
  });
  test('mute and unmute keep a pruned list; reset restores a section', async () => {
    await settings.mute({ scope: 'host', target: 'devbox', minutes: 30, actor: 'test' });
    await settings.mute({ scope: 'tmux', target: 'agents', host: 'mac' });
    let g = await settings.get();
    assert.deepEqual(g.activeMutes.map((m) => m.id), ['host::devbox', 'tmux:mac:agents']);
    assert.equal(g.activeMutes[0].until, '2026-10-11T12:30:00.000Z');
    settings._deps.now = () => Date.parse('2026-10-11T13:00:00Z');   // the host mute expired
    await settings.mute({ scope: 'category', target: 'launch' });
    g = await settings.get();
    assert.deepEqual(g.settings.mutes.map((m) => m.id), ['tmux:mac:agents', 'category::launch']);
    await settings.unmute({ id: 'tmux:mac:agents' });
    assert.deepEqual((await settings.get()).settings.mutes.map((m) => m.id), ['category::launch']);
    await assert.rejects(() => settings.unmute({ id: 'nope' }), /no such mute/);
    await assert.rejects(() => settings.mute({ scope: 'category', target: 'lunch' }), /unknown category/);
    const r = await settings.reset({ section: 'categories' });
    assert.equal(r.settings.categories.finished.sound, DEFAULT_SETTINGS.categories.finished.sound);
    await assert.rejects(() => settings.reset({ section: 'bogus' }), /unknown section/);
  });
});

describe('uploads', () => {
  let root; const events = [];
  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'drover-up-'));
    process.env.DROVER_UPLOADS = root;
    uploads._deps.appendEvent = async (ev, opts) => { events.push({ ...ev, actor: opts?.actor }); return ev; };
  });
  test('put writes under the session dir, returns the absolute path, records path + bytes only', async () => {
    const data = Buffer.from('hello image').toString('base64');
    const r = await uploads.put({ session: 'webapp-f8', name: '../../etc/passwd', mime: 'image/png', data: `data:image/png;base64,${data}` });
    assert.equal(r.bytes, 11);
    assert.ok(path.isAbsolute(r.path));
    assert.ok(r.path.includes(path.join('webapp-f8', '')), r.path);
    assert.ok(!r.path.includes('..'));
    assert.match(path.basename(r.path), /^\d{8}T\d{6}-passwd\.png$/);
    assert.equal(await readFile(r.path, 'utf8'), 'hello image');
    assert.deepEqual(Object.keys(events[0]).sort(), ['actor', 'bytes', 'mime', 'path', 'session', 'sha256', 'type']);
    assert.equal(events[0].type, 'upload');
  });
  test('same name twice gets a suffix; list and remove stay inside the root', async () => {
    const data = Buffer.from('x').toString('base64');
    const a = await uploads.put({ session: 's/../../x', name: 'a.txt', data });
    const b = await uploads.put({ session: 's/../../x', name: 'a.txt', data });
    assert.notEqual(a.path, b.path);
    assert.equal(path.dirname(path.dirname(a.path)), await (await import('node:fs/promises')).realpath(root), 'session names cannot climb out');
    const l = await uploads.list({ session: 's/../../x' });
    assert.equal(l.items.length, 2);
    await uploads.remove({ path: a.path });
    await assert.rejects(() => uploads.remove({ path: '/etc/hosts' }), /not an upload/);
  });
  test('size cap, empty and non-base64 data are refused', async () => {
    const big = 'A'.repeat(Math.ceil((uploads.MAX_BYTES + 10) * 4 / 3));
    await assert.rejects(() => uploads.put({ session: 's', name: 'big.bin', data: big }), /too large/);
    await assert.rejects(() => uploads.put({ session: 's', name: 'x', data: '' }), /base64/);
    await assert.rejects(() => uploads.put({ session: 's', name: 'x', data: 'not base64 !!' }), /not base64/);
    await assert.rejects(() => uploads.put({ session: '', data: 'eA==' }), /session/);
  });
});

describe('files', () => {
  let home; const evs = [];
  before(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'drover-home-'));
    files._deps.home = () => home;
    files._deps.appendEvent = async (ev, opts) => { evs.push({ ...ev, actor: opts?.actor }); return { id: `f-${evs.length}`, ...ev }; };
    await mkdir(path.join(home, '.dotfiles', 'claude'), { recursive: true });
    await mkdir(path.join(home, '.claude', 'skills', 'demo'), { recursive: true });
    await mkdir(path.join(home, '.claude', 'sessions'), { recursive: true });
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await mkdir(path.join(home, 'code', 'webapp', 'packages'), { recursive: true });
    await mkdir(path.join(home, 'outside'), { recursive: true });
    await writeFile(path.join(home, '.dotfiles', 'claude', 'MEMORY.md'), '# memory\n');
    await writeFile(path.join(home, '.claude', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\n');
    await writeFile(path.join(home, '.claude', 'CLAUDE.md'), 'global\n');
    await writeFile(path.join(home, '.claude', 'sessions', '1.json'), '{}');
    await writeFile(path.join(home, '.codex', 'auth.json'), '{"token":"EXAMPLE_secret"}');
    await writeFile(path.join(home, '.dotfiles', '.env.devbox'), 'K=EXAMPLE_v');
    await writeFile(path.join(home, 'code', 'webapp', 'CLAUDE.md'), 'repo rules\n');
    await writeFile(path.join(home, 'code', 'webapp', 'packages', 'CLAUDE.md'), 'nested\n');
    await writeFile(path.join(home, 'outside', 'target.md'), 'not yours\n');
    await symlink(path.join(home, 'outside', 'target.md'), path.join(home, '.dotfiles', 'escape.md'));
    await symlink(path.join(home, '.dotfiles', 'claude', 'MEMORY.md'), path.join(home, '.claude', 'linked.md'));
  });
  test('reads inside the roots, including ~/code/*/CLAUDE.md and links that stay inside', async () => {
    assert.equal((await files.read({ path: '~/.dotfiles/claude/MEMORY.md' })).text, '# memory\n');
    assert.equal((await files.read({ path: '~/code/webapp/CLAUDE.md' })).text, 'repo rules\n');
    const l = await files.read({ path: '~/.claude/linked.md' });
    assert.equal(l.symlink, true);
    assert.ok(l.real.endsWith(path.join('.dotfiles', 'claude', 'MEMORY.md')));
  });
  test('refuses traversal, deeper ~/code files, links out of the roots and secret-looking files', async () => {
    await assert.rejects(() => files.read({ path: '~/.dotfiles/../outside/target.md' }), /outside the editable roots/);
    await assert.rejects(() => files.read({ path: '~/code/webapp/packages/CLAUDE.md' }), /outside the editable roots/);
    await assert.rejects(() => files.read({ path: '~/.dotfiles/escape.md' }), /resolves outside/);
    await assert.rejects(() => files.read({ path: '~/.codex/auth.json' }), /looks like a secret/);
    await assert.rejects(() => files.read({ path: '~/.dotfiles/.env.devbox' }), /looks like a secret/);
    await assert.rejects(() => files.read({ path: '~/.claude/sessions/1.json' }), /looks like a secret/);
    await assert.rejects(() => files.read({ path: 'relative/CLAUDE.md' }), /absolute/);
    await assert.rejects(() => files.write({ path: '~/.codex/auth.json', content: 'x' }), /looks like a secret/);
  });
  test('writes are atomic, conflict-checked, recorded without content, and go to the real file behind a link', async () => {
    const r0 = await files.read({ path: '~/.claude/linked.md' });
    await assert.rejects(() => files.write({ path: '~/.claude/linked.md', content: 'x', expectSha256: 'stale' }), /changed on disk/);
    const w = await files.write({ path: '~/.claude/linked.md', content: '# memory\nmore\n', expectSha256: r0.sha256, actor: 'test' });
    assert.equal(w.bytes, 14);
    assert.equal(await readFile(path.join(home, '.dotfiles', 'claude', 'MEMORY.md'), 'utf8'), '# memory\nmore\n');
    const ev = evs.at(-1);
    assert.equal(ev.type, 'file-write');
    assert.equal(ev.bytes, 14);
    assert.ok(!('content' in ev));
    assert.ok(!JSON.stringify(ev).includes('more'));
    await assert.rejects(() => files.write({ path: '~/.dotfiles/new.md', content: 'n' }), /create:true/);
    const c = await files.write({ path: '~/.dotfiles/new.md', content: 'n', create: true });
    assert.equal(c.prevSha256, null);
    assert.ok(!(await readdir(path.join(home, '.dotfiles'))).some((n) => n.endsWith('.tmp')), 'no temp files left');
  });
  test('list hides secrets; roots lists the quick picks; find walks the roots', async () => {
    const l = await files.list({ dir: '~/.dotfiles' });
    assert.ok(l.entries.some((e) => e.name === 'claude'));
    assert.ok(!l.entries.some((e) => e.name.startsWith('.env')));
    const r = await files.roots();
    const picks = r.picks.map((p) => p.label);
    assert.ok(picks.includes('webapp/CLAUDE.md'));
    assert.ok(picks.includes('demo'));
    assert.ok(picks.includes('~/.claude/CLAUDE.md'));
    const f = await files.find({ query: 'skill demo' });
    assert.deepEqual(f.items.map((i) => i.name), ['SKILL.md']);
    await assert.rejects(() => files.find({ query: 'a' }), /at least 2/);
  });
});

describe('http: CORS for direct peers', () => {
  const req = (origin, host = '127.0.0.1:7337', extra = {}) => ({ headers: { origin, host, ...extra } });
  test('a loopback or tailnet page on another port gets CORS (and PNA) headers; same-origin and foreign origins get none', () => {
    const h = corsHeaders(req('http://127.0.0.1:7444', '127.0.0.1:7337', { 'access-control-request-private-network': 'true' }), '127.0.0.1');
    assert.equal(h['access-control-allow-origin'], 'http://127.0.0.1:7444');
    assert.equal(h['access-control-allow-private-network'], 'true');
    assert.match(h['access-control-allow-headers'], /authorization/);
    assert.ok(corsHeaders(req('http://100.101.102.103:7337', '127.0.0.1:7337'), '127.0.0.1'));
    assert.equal(corsHeaders(req('http://127.0.0.1:7337'), '127.0.0.1'), null);
    assert.equal(corsHeaders(req('https://evil.example.com'), '127.0.0.1'), null);
    assert.equal(corsHeaders({ headers: { host: 'x' } }, '127.0.0.1'), null);
  });
});

describe('every new op is described and reaches MCP', () => {
  const NEW = ['openclaw.status', 'openclaw.check', 'openclaw.sweep', 'openclaw.feed', 'tmux.answer', 'sessions.lastReply', 'settings.get', 'settings.set', 'settings.reset', 'notify.mute', 'notify.unmute', 'notify.recent', 'notify.list', 'notify.test', 'notify.send', 'uploads.put', 'uploads.list', 'uploads.remove', 'files.roots', 'files.list', 'files.read', 'files.write', 'files.find'];
  test('in the op table, in ops-meta, and an drover_* tool each', () => {
    const tools = new Set(ALL_TOOLS.map((t) => t.name));
    for (const op of NEW) {
      assert.ok(OPS.includes(op), `${op} in core/api.js`);
      assert.ok(META[op]?.d?.length > 40, `${op} described in ops-meta`);
      assert.ok(tools.has('drover_' + op.replace(/\./g, '_')), `${op} as an MCP tool`);
    }
    for (const op of OPS) assert.ok(META[op], `${op} has ops-meta`);
  });
});
