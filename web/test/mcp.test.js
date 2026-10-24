// MCP server tests: drive createServer({dispatch}) with a fake dispatch so no
// tmux, ssh, codex or truth-file access happens. Run: node --test test/mcp.test.js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createServer, serve, TOOLS, RESOURCES, LATEST_PROTOCOL, RPC, validateArgs } from '../mcp/server.js';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const quiet = () => {};

/** Fake dispatch that records calls and returns canned results per op. */
function fakeDispatch(results = {}) {
  const calls = [];
  const fn = async (op, args) => {
    calls.push({ op, args });
    const r = results[op];
    if (r instanceof Error) throw r;
    if (typeof r === 'function') return r(args);
    return r ?? { op, echo: args };
  };
  fn.calls = calls;
  return fn;
}

const req = (id, method, params) => (params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params });

describe('initialize', () => {
  test('echoes a supported client protocol version', async () => {
    const s = createServer({ dispatch: fakeDispatch(), log: quiet });
    for (const v of ['2025-06-18', '2025-03-26', '2024-11-05']) {
      const r = await s.handleMessage(req(1, 'initialize', { protocolVersion: v, capabilities: {}, clientInfo: { name: 't', version: '0' } }));
      assert.equal(r.jsonrpc, '2.0');
      assert.equal(r.id, 1);
      assert.equal(r.result.protocolVersion, v);
    }
  });

  test('falls back to 2025-06-18 for an unknown version and reports capabilities + serverInfo + instructions', async () => {
    const s = createServer({ dispatch: fakeDispatch(), log: quiet });
    const r = await s.handleMessage(req('init', 'initialize', { protocolVersion: '1999-01-01', capabilities: {} }));
    assert.equal(r.result.protocolVersion, LATEST_PROTOCOL);
    assert.deepEqual(r.result.capabilities, { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } });
    assert.deepEqual(r.result.serverInfo, { name: 'drover', version: '0.1.0' });
    assert.equal(typeof r.result.instructions, 'string');
    assert.ok(r.result.instructions.includes('drover_fleet'));
  });

  test('ping replies with an empty object', async () => {
    const s = createServer({ dispatch: fakeDispatch(), log: quiet });
    assert.deepEqual(await s.handleMessage(req(7, 'ping')), { jsonrpc: '2.0', id: 7, result: {} });
  });
});

describe('tools/list', () => {
  test('every tool has name, description, object inputSchema, a host property and no run() leak', async () => {
    const s = createServer({ dispatch: fakeDispatch(), log: quiet });
    const r = await s.handleMessage(req(2, 'tools/list'));
    const tools = r.result.tools;
    assert.ok(tools.length >= TOOLS.length, 'curated tools are all listed');
    assert.ok(tools.some((t) => t.name === 'drover_op'), 'the generic drover_op tool is listed');
    const names = new Set();
    for (const t of tools) {
      assert.equal(typeof t.name, 'string');
      assert.ok(t.name.startsWith('drover_'), t.name);
      assert.ok(!names.has(t.name), `duplicate tool ${t.name}`); names.add(t.name);
      assert.equal(typeof t.description, 'string');
      assert.ok(t.description.length > 40, `${t.name} description too short`);
      assert.equal(t.inputSchema.type, 'object');
      assert.equal(t.inputSchema.properties.host.type, 'string');
      assert.ok(Array.isArray(t.inputSchema.required));
      for (const k of t.inputSchema.required) assert.ok(t.inputSchema.properties[k], `${t.name} requires unknown ${k}`);
      for (const [k, p] of Object.entries(t.inputSchema.properties)) assert.equal(typeof p.description, 'string', `${t.name}.${k} needs a description`);
      assert.equal(t.run, undefined);
    }
    for (const expected of ['drover_fleet', 'drover_sessions', 'drover_session_transcript', 'drover_send', 'drover_tmux_windows', 'drover_capture', 'drover_tmux_send', 'drover_launch', 'drover_headless', 'drover_state', 'drover_events_tail', 'drover_event_append', 'drover_feature_upsert', 'drover_memory', 'drover_handoff_write', 'drover_reflections', 'drover_terminals']) {
      assert.ok(names.has(expected), `missing ${expected}`);
    }
  });
});

describe('tools/call', () => {
  test('round trip: drover_capture maps onto tmux.capture and returns pretty JSON text', async () => {
    const dispatch = fakeDispatch({ 'tmux.capture': { target: 'main:1', text: 'hello', screen: { state: 'idle' } } });
    const s = createServer({ dispatch, log: quiet });
    const r = await s.handleMessage(req(3, 'tools/call', { name: 'drover_capture', arguments: { target: 'main:1', lines: 50 } }));
    assert.equal(r.id, 3);
    assert.equal(r.result.isError, false);
    assert.equal(r.result.content.length, 1);
    assert.equal(r.result.content[0].type, 'text');
    assert.deepEqual(JSON.parse(r.result.content[0].text), { target: 'main:1', text: 'hello', screen: { state: 'idle' } });
    assert.equal(r.result.content[0].text, JSON.stringify({ target: 'main:1', text: 'hello', screen: { state: 'idle' } }, null, 2));
    assert.deepEqual(dispatch.calls, [{ op: 'tmux.capture', args: { target: 'main:1', lines: 50 } }]);
  });

  test('host is forwarded to dispatch; actor "mcp" is set on writes', async () => {
    const dispatch = fakeDispatch();
    const s = createServer({ dispatch, log: quiet });
    await s.handleMessage(req(4, 'tools/call', { name: 'drover_send', arguments: { id: 'abc', text: 'hi', host: 'devbox' } }));
    await s.handleMessage(req(5, 'tools/call', { name: 'drover_launch', arguments: { engine: 'codex', mode: 'tmux', prompt: 'go' } }));
    await s.handleMessage(req(6, 'tools/call', { name: 'drover_feature_upsert', arguments: { fid: 'f1', state: 'shipped', links: ['!1'] } }));
    await s.handleMessage(req(7, 'tools/call', { name: 'drover_handoff_write', arguments: { text: '# h' } }));
    await s.handleMessage(req(8, 'tools/call', { name: 'drover_event_append', arguments: { event: { type: 'note', about: 'x', text: 'y' } } }));
    assert.deepEqual(dispatch.calls, [
      { op: 'sessions.message', args: { id: 'abc', text: 'hi', host: 'devbox', actor: 'mcp' } },
      { op: 'launch.start', args: { engine: 'codex', mode: 'tmux', prompt: 'go', actor: 'mcp' } },
      { op: 'features.upsert', args: { fid: 'f1', state: 'shipped', links: ['!1'], actor: 'mcp' } },
      { op: 'memory.handoff.write', args: { text: '# h', actor: 'mcp' } },
      { op: 'events.append', args: { event: { type: 'note', about: 'x', text: 'y' }, actor: 'mcp' } },
    ]);
  });

  test('drover_sessions defaults includeRecent to false', async () => {
    const dispatch = fakeDispatch();
    const s = createServer({ dispatch, log: quiet });
    await s.handleMessage(req(9, 'tools/call', { name: 'drover_sessions', arguments: {} }));
    assert.deepEqual(dispatch.calls, [{ op: 'sessions.list', args: { includeRecent: false } }]);
  });

  test('action tools route to the right op (headless, reflections, terminals)', async () => {
    const dispatch = fakeDispatch();
    const s = createServer({ dispatch, log: quiet });
    await s.handleMessage(req(1, 'tools/call', { name: 'drover_headless', arguments: { action: 'send', id: 'h1', text: 'more' } }));
    await s.handleMessage(req(2, 'tools/call', { name: 'drover_reflections', arguments: { action: 'done', ids: ['r1', 'r2'] } }));
    await s.handleMessage(req(3, 'tools/call', { name: 'drover_reflections', arguments: { action: 'add', title: 'T', kind: 'gotcha', tags: ['a'] } }));
    await s.handleMessage(req(4, 'tools/call', { name: 'drover_terminals', arguments: { action: 'open', target: 'main:1' } }));
    assert.deepEqual(dispatch.calls.map((c) => c.op), ['headless.send', 'reflections.mark', 'reflections.add', 'terminals.open']);
    // Reflection writes carry the actor, so the truth file records "mcp" rather than the default, the owner.
    assert.deepEqual(dispatch.calls[1].args, { op: 'done', ids: ['r1', 'r2'], actor: 'mcp' });
    assert.deepEqual(dispatch.calls[2].args, { title: 'T', kind: 'gotcha', tags: ['a'], actor: 'mcp' });
  });

  test('drover_reflections: every action maps onto its op; writes carry actor mcp, reads do not', async () => {
    const dispatch = fakeDispatch();
    const s = createServer({ dispatch, log: quiet });
    const call = (args) => s.handleMessage(req(1, 'tools/call', { name: 'drover_reflections', arguments: args }));
    const ops = [{ op: 'done', id: 'abcd2345', note: 'shipped' }, { op: 'edit', id: 'efgh2345', title: 'T2' }];
    for (const a of [
      { action: 'list', repo: 'drover', status: 'open,stale', kind: 'action', session: 's1', limit: 5, all: false },
      { action: 'repos', host: 'devbox' },
      { action: 'search', query: 'breaker', status: 'all', source: 'reflection', anyIdentity: true, host: 'devbox' },
      { action: 'semantic', query: 'breaker timeout', repo: 'webapp', status: 'open', kind: 'gotcha', limit: 3 },
      { action: 'show', id: 'abcd2345' },
      { action: 'candidates', query: 'session text', session: 's1', limit: 9 },
      { action: 'add', title: 'T', body: 'B', priority: 2, session: 's1', repo: 'webapp' },
      { action: 'edit', id: 'abcd2345', title: 'New', tags: [] },
      { action: 'drop', ids: ['abcd2345'], note: 'obsolete' },
      { action: 'apply', ops, repo: 'webapp', note: 'reconciled' },
      { action: 'apply', ops, anyRepo: true },
    ]) { const r = await call(a); assert.equal(r.result.isError, false, JSON.stringify(a)); }
    assert.deepEqual(dispatch.calls, [
      { op: 'reflections.list', args: { repo: 'drover', all: false, status: 'open,stale', kind: 'action', session: 's1', limit: 5 } },
      { op: 'reflections.repos', args: { host: 'devbox' } },
      { op: 'reflections.search', args: { query: 'breaker', status: 'all', source: 'reflection', anyIdentity: true, host: 'devbox' } },
      { op: 'reflections.semantic', args: { query: 'breaker timeout', repo: 'webapp', status: 'open', kind: 'gotcha', limit: 3 } },
      { op: 'reflections.show', args: { id: 'abcd2345' } },
      { op: 'reflections.candidates', args: { query: 'session text', session: 's1', limit: 9 } },
      { op: 'reflections.add', args: { repo: 'webapp', title: 'T', body: 'B', priority: 2, session: 's1', actor: 'mcp' } },
      { op: 'reflections.edit', args: { id: 'abcd2345', title: 'New', tags: [], actor: 'mcp' } },
      { op: 'reflections.mark', args: { op: 'drop', ids: ['abcd2345'], note: 'obsolete', actor: 'mcp' } },
      { op: 'reflections.apply', args: { ops, repo: 'webapp', note: 'reconciled', actor: 'mcp' } },
      { op: 'reflections.apply', args: { ops, anyRepo: true, actor: 'mcp' } },
    ]);
  });

  test('drover_reflections refuses malformed input before dispatch: apply needs a list of objects, show and edit an id', async () => {
    const dispatch = fakeDispatch();
    const s = createServer({ dispatch, log: quiet });
    const call = async (args) => (await s.handleMessage(req(1, 'tools/call', { name: 'drover_reflections', arguments: args }))).result;
    for (const [args, msg] of [
      [{ action: 'apply', ops: { op: 'done', id: 'x' }, repo: 'webapp' }, /"ops" must be a array/],
      [{ action: 'apply', ops: 'done abcd2345', repo: 'webapp' }, /"ops" must be a array/],
      [{ action: 'apply', ops: ['done abcd2345'], repo: 'webapp' }, /"ops" must contain only objects/],
      [{ action: 'apply', repo: 'webapp' }, /"ops" is required for action "apply"/],
      [{ action: 'show' }, /"id" is required for action "show"/],
      [{ action: 'edit', title: 'x' }, /"id" is required for action "edit"/],
      [{ action: 'semantic' }, /"query" is required for action "semantic"/],
      [{ action: 'add', title: 'x', kind: 'chore' }, /must be one of action, question/],
      [{ action: 'close', ids: ['x'] }, /must be one of list, repos, search, semantic/],
    ]) { const r = await call(args); assert.equal(r.isError, true, JSON.stringify(args)); assert.match(r.content[0].text, msg); }
    assert.equal(dispatch.calls.length, 0);
  });

  test('drover_fleet composes host.list + host.facts (+ host.probe when asked) and survives a failing part', async () => {
    const dispatch = fakeDispatch({ 'host.list': [{ name: 'local' }], 'host.facts': new Error('ssh down'), 'host.probe': [{ host: 'a', up: true }] });
    const s = createServer({ dispatch, log: quiet });
    const r = await s.handleMessage(req(1, 'tools/call', { name: 'drover_fleet', arguments: { probe: true, host: 'devbox' } }));
    assert.equal(r.result.isError, false);
    const out = JSON.parse(r.result.content[0].text);
    assert.deepEqual(out.hosts, [{ name: 'local' }]);
    assert.deepEqual(out.facts, { error: 'ssh down' });
    assert.deepEqual(out.probe, [{ host: 'a', up: true }]);
    assert.deepEqual(dispatch.calls.map((c) => c.op).sort(), ['host.facts', 'host.list', 'host.probe']);
    assert.deepEqual(dispatch.calls.find((c) => c.op === 'host.facts').args, { host: 'devbox' });
  });

  test('a thrown dispatch becomes isError:true with the message, not a transport error', async () => {
    const dispatch = fakeDispatch({ 'tmux.windows': new Error('tmux server not running') });
    const s = createServer({ dispatch, log: quiet });
    const r = await s.handleMessage(req(10, 'tools/call', { name: 'drover_tmux_windows', arguments: {} }));
    assert.equal(r.id, 10);
    assert.equal(r.error, undefined);
    assert.equal(r.result.isError, true);
    assert.deepEqual(r.result.content, [{ type: 'text', text: 'tmux server not running' }]);
  });

  test('argument validation failures are isError:true with an actionable message', async () => {
    const dispatch = fakeDispatch();
    const s = createServer({ dispatch, log: quiet });
    const missing = await s.handleMessage(req(1, 'tools/call', { name: 'drover_capture', arguments: {} }));
    assert.equal(missing.result.isError, true);
    assert.match(missing.result.content[0].text, /missing required argument "target"/);
    const badType = await s.handleMessage(req(2, 'tools/call', { name: 'drover_capture', arguments: { target: 'main:1', lines: 'many' } }));
    assert.match(badType.result.content[0].text, /"lines" must be a number/);
    const badEnum = await s.handleMessage(req(3, 'tools/call', { name: 'drover_headless', arguments: { action: 'kill' } }));
    assert.match(badEnum.result.content[0].text, /must be one of list, get, send, stop/);
    const unknownKey = await s.handleMessage(req(4, 'tools/call', { name: 'drover_tmux_windows', arguments: { sessionId: 'x' } }));
    assert.match(unknownKey.result.content[0].text, /unknown argument "sessionId"/);
    const actionNeed = await s.handleMessage(req(5, 'tools/call', { name: 'drover_headless', arguments: { action: 'send', id: 'h1' } }));
    assert.match(actionNeed.result.content[0].text, /"text" is required for action "send"/);
    assert.equal(dispatch.calls.length, 0);
  });

  test('null arguments are treated as not given', () => {
    const tool = TOOLS.find((t) => t.name === 'drover_capture');
    assert.deepEqual(validateArgs(tool.inputSchema, { target: 'a:1', lines: null, host: null }), { target: 'a:1' });
  });

  test('unknown tool name is a JSON-RPC invalid-params error', async () => {
    const s = createServer({ dispatch: fakeDispatch(), log: quiet });
    const r = await s.handleMessage(req(11, 'tools/call', { name: 'drover_nope', arguments: {} }));
    assert.equal(r.id, 11);
    assert.equal(r.error.code, RPC.INVALID_PARAMS);
    assert.match(r.error.message, /unknown tool "drover_nope"/);
  });
});

describe('resources', () => {
  test('resources/list has the drover:// resources with uri, name, mimeType', async () => {
    const s = createServer({ dispatch: fakeDispatch(), log: quiet });
    const r = await s.handleMessage(req(20, 'resources/list'));
    const uris = r.result.resources.map((x) => x.uri);
    for (const u of ['drover://ops', 'drover://state', 'drover://handoff', 'drover://events/tail', 'drover://sessions']) assert.ok(uris.includes(u), `${u} listed`);
    assert.equal(r.result.resources.length, RESOURCES.length);
    for (const x of r.result.resources) {
      assert.equal(typeof x.name, 'string');
      assert.equal(typeof x.mimeType, 'string');
      assert.equal(x.read, undefined);
    }
    const tpl = await s.handleMessage(req(21, 'resources/templates/list'));
    assert.deepEqual(tpl.result, { resourceTemplates: [] });
  });

  test('resources/read returns contents with uri, mimeType, text', async () => {
    const dispatch = fakeDispatch({
      'events.state': { features: { f1: { state: 'shipped' } } },
      'memory.overview': { home: '/mem/webapp', handoff: { text: '# Handoff\n\nhello\n' } },
      'events.tail': [{ id: 'e1', type: 'note' }],
      'sessions.list': { sessions: [{ id: 's1' }] },
    });
    const s = createServer({ dispatch, log: quiet });

    const state = await s.handleMessage(req(1, 'resources/read', { uri: 'drover://state' }));
    assert.deepEqual(state.result.contents[0], { uri: 'drover://state', mimeType: 'application/json', text: JSON.stringify({ features: { f1: { state: 'shipped' } } }, null, 2) });

    const handoff = await s.handleMessage(req(2, 'resources/read', { uri: 'drover://handoff' }));
    assert.deepEqual(handoff.result.contents, [{ uri: 'drover://handoff', mimeType: 'text/markdown', text: '# Handoff\n\nhello\n' }]);

    const tail = await s.handleMessage(req(3, 'resources/read', { uri: 'drover://events/tail' }));
    assert.equal(tail.result.contents[0].mimeType, 'application/json');
    assert.deepEqual(JSON.parse(tail.result.contents[0].text), [{ id: 'e1', type: 'note' }]);

    const sessions = await s.handleMessage(req(4, 'resources/read', { uri: 'drover://sessions' }));
    assert.deepEqual(JSON.parse(sessions.result.contents[0].text), { sessions: [{ id: 's1' }] });

    assert.deepEqual(dispatch.calls, [
      { op: 'events.state', args: {} },
      // No repo named: the op reads DROVER_DEFAULT_REPO where it runs.
      { op: 'memory.overview', args: {} },
      { op: 'events.tail', args: { limit: 200 } },
      { op: 'sessions.list', args: { includeRecent: false } },
    ]);
  });

  test('no default repo where the op runs (DROVER_DEFAULT_REPO unset) yields a markdown note too; another failure stays an error', async () => {
    const unset = createServer({ dispatch: fakeDispatch({ 'memory.overview': new Error('repo is required (or set DROVER_DEFAULT_REPO)') }), log: quiet });
    const r = await unset.handleMessage(req(1, 'resources/read', { uri: 'drover://handoff' }));
    assert.equal(r.result.contents[0].mimeType, 'text/markdown');
    assert.match(r.result.contents[0].text, /No default repo: set DROVER_DEFAULT_REPO/);
    const down = createServer({ dispatch: fakeDispatch({ 'memory.overview': new Error('disk gone') }), log: quiet });
    assert.equal((await down.handleMessage(req(2, 'resources/read', { uri: 'drover://handoff' }))).error.message, 'disk gone');
  });

  test('missing handoff file yields a markdown note, not an error', async () => {
    const s = createServer({ dispatch: fakeDispatch({ 'memory.overview': { home: '/mem/webapp', handoff: null } }), log: quiet });
    const r = await s.handleMessage(req(1, 'resources/read', { uri: 'drover://handoff' }));
    assert.match(r.result.contents[0].text, /No session_handoff\.md found under \/mem\/webapp/);
  });

  test('unknown uri is -32002; a throwing read is -32603', async () => {
    const s = createServer({ dispatch: fakeDispatch({ 'events.state': new Error('disk gone') }), log: quiet });
    const nf = await s.handleMessage(req(1, 'resources/read', { uri: 'drover://nope' }));
    assert.equal(nf.error.code, RPC.RESOURCE_NOT_FOUND);
    assert.deepEqual(nf.error.data, { uri: 'drover://nope' });
    const boom = await s.handleMessage(req(2, 'resources/read', { uri: 'drover://state' }));
    assert.equal(boom.error.code, RPC.INTERNAL);
    assert.equal(boom.error.message, 'disk gone');
  });
});

describe('protocol edges', () => {
  test('unknown method -> -32601 with the request id', async () => {
    const s = createServer({ dispatch: fakeDispatch(), log: quiet });
    const r = await s.handleMessage(req('x-1', 'prompts/list'));
    assert.deepEqual(r, { jsonrpc: '2.0', id: 'x-1', error: { code: RPC.METHOD_NOT_FOUND, message: 'method not found: prompts/list' } });
  });

  test('notifications (known and unknown) get no reply', async () => {
    const s = createServer({ dispatch: fakeDispatch(), log: quiet });
    assert.equal(await s.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    assert.equal(s.state.initialized, true);
    assert.equal(await s.handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }), null);
    assert.equal(await s.handleMessage({ jsonrpc: '2.0', method: 'notifications/whatever' }), null);
    assert.equal(await s.handleMessage({ jsonrpc: '2.0', method: 'tools/list' }), null, 'a request-shaped message without id is a notification');
    assert.equal(await s.handleMessage({ jsonrpc: '2.0', id: 5, result: {} }), null, 'responses are ignored');
  });

  test('malformed requests -> -32600, never a throw', async () => {
    const s = createServer({ dispatch: fakeDispatch(), log: quiet });
    assert.equal((await s.handleMessage('nope')).error.code, RPC.INVALID_REQUEST);
    assert.equal((await s.handleMessage({ id: 1 })).error.code, RPC.INVALID_REQUEST);
    assert.equal((await s.handleMessage({ jsonrpc: '1.0', id: 2, method: 'ping' })).error.code, RPC.INVALID_REQUEST);
    assert.equal((await s.handleMessage([])).error.code, RPC.INVALID_REQUEST);
  });

  test('batch arrays are answered per request, notifications dropped', async () => {
    const s = createServer({ dispatch: fakeDispatch(), log: quiet });
    const r = await s.handleMessage([req(1, 'ping'), { jsonrpc: '2.0', method: 'notifications/initialized' }, req(2, 'nope')]);
    assert.equal(r.length, 2);
    assert.deepEqual(r[0], { jsonrpc: '2.0', id: 1, result: {} });
    assert.equal(r[1].error.code, RPC.METHOD_NOT_FOUND);
    assert.equal(await s.handleMessage([{ jsonrpc: '2.0', method: 'notifications/initialized' }]), null);
  });
});

describe('stdio transport (serve)', () => {
  test('answers each line, writes only JSON-RPC, waits for in-flight calls, exits 0 on stdin end', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let out = '';
    output.on('data', (d) => { out += d; });
    let exitCode = null;
    let shutdownCalls = 0;
    const slow = fakeDispatch({ 'tmux.windows': () => new Promise((r) => setTimeout(() => r([{ target: 'main:1' }]), 60)) });
    const running = serve({ dispatch: slow, log: quiet, input, output, exit: (c) => { exitCode = c; }, shutdown: async () => { shutdownCalls++; } });

    input.write(JSON.stringify(req(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } })) + '\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    input.write(JSON.stringify(req(2, 'tools/list')) + '\n' + JSON.stringify(req(3, 'tools/call', { name: 'drover_tmux_windows', arguments: {} })) + '\n');
    input.write('this is not json\n');
    input.write(JSON.stringify(req(4, 'ping')));   // no trailing newline: flushed on end
    input.end();

    const code = await running;
    assert.equal(code, 0);
    assert.equal(exitCode, 0);
    assert.equal(shutdownCalls, 1);

    const lines = out.split('\n').filter(Boolean);
    const msgs = lines.map((l) => JSON.parse(l));   // throws if anything but JSON reached stdout
    const byId = new Map(msgs.map((m) => [m.id, m]));
    assert.equal(byId.get(1).result.protocolVersion, '2025-06-18');
    assert.ok(byId.get(2).result.tools.length >= 17);
    assert.deepEqual(JSON.parse(byId.get(3).result.content[0].text), [{ target: 'main:1' }]);
    assert.equal(byId.get(null).error.code, RPC.PARSE);
    assert.deepEqual(byId.get(4).result, {});
    assert.equal(msgs.length, 5, 'initialize, tools/list, tools/call, parse error, ping; nothing for the notification');
  });
  test('the real server marks the process long-lived for the core it runs when no daemon answers; one given a dispatch does not', async (t) => {
    const cache = await import('../core/cache.js');
    const was = cache.markLongLived(false); t.after(() => cache.markLongLived(was));
    const run = (deps) => { const input = new PassThrough(); input.end(); return serve({ log: quiet, input, output: new PassThrough(), exit: () => {}, shutdown: async () => {}, ...deps }); };
    await run({ dispatch: fakeDispatch() });
    assert.equal(cache.markLongLived(false), false, 'a server given its dispatch runs no core here');
    await run({});
    assert.equal(cache.markLongLived(false), true, 'the stdio server outlives its answers, as the daemon does, so it refreshes behind them');
  });
});

describe('a manager server pins its actor', () => {
  // ACTOR is read once at load, so each case runs in its own process with its own DROVER_MCP_ACTOR.
  // named: the actor the call itself names; viaOp: through drover_op (a sessions.message to the manager) instead of a
  // generated tool.
  const callAs = (envActor, named = 'owner', viaOp = false, owner = null) => {
    const code = `const { GENERATED_TOOLS, GENERIC_TOOL } = await import('./mcp/server.js'); const seen = [];
      const rec = async (op, args) => { seen.push({ op, args }); return { ok: true }; };
      if (${viaOp}) await GENERIC_TOOL.run(rec, { op: 'sessions.message', args: { id: 'manager', text: 'hi', actor: ${JSON.stringify(named)} } });
      else await GENERATED_TOOLS.find((t) => t.name === 'drover_tmux_answer').run(rec, { target: 's:@1', key: '1', expect: 'h', actor: ${JSON.stringify(named)} });
      process.stdout.write(JSON.stringify(seen));`;
    const env = { ...process.env };
    for (const k of ['MCP_ACTOR', 'OWNER', 'OWNER_NAME']) { delete env[`DROVER_${k}`]; delete env[`APXW_${k}`]; }
    if (envActor) env.DROVER_MCP_ACTOR = envActor;
    if (owner) env.DROVER_OWNER = owner;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: WEB, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout)[0].args.actor;
  };
  test('a call naming the owner\'s actor still runs as the manager, so the WAL shows who acted', () => {
    assert.equal(callAs('manager'), 'manager');
    assert.equal(callAs('manager-mac'), 'manager-mac');
    assert.equal(callAs('Manager'), 'Manager', 'a near miss of the exact form is restricted too, not left open');
  });
  test('any other server keeps the actor a call names, except one of the owner\'s own clients', () => {
    assert.equal(callAs(null, 'reflector'), 'reflector', 'an automation keeps its own name');
    assert.equal(callAs('mcp', 'reflector', true), 'reflector');
    // Those names speak to the manager in the owner's own conversation: an agent naming one writes as mcp instead.
    assert.equal(callAs(null, 'owner'), 'mcp', 'the generic owner actor');
    assert.equal(callAs(null, 'alice', false, 'alice'), 'mcp', 'the configured owner (DROVER_OWNER)');
    assert.equal(callAs(null, 'alice'), 'alice', 'a name that is not the configured owner is an automation\'s own');
    assert.equal(callAs('mcp', 'Chrome'), 'mcp', 'in any case');
    assert.equal(callAs(null, 'tui', true), 'mcp', 'drover_op too, for a message to the manager');
  });
});

describe('a manager server has full powers, like any other agent', () => {
  test('tmux input, launches and every other write reach dispatch, as for any server', async () => {
    const dispatch = fakeDispatch();
    const s = createServer({ dispatch, log: quiet });
    const call = (name, args) => s.handleMessage(req(name, 'tools/call', { name, arguments: args }));
    for (const [name, args] of [
      ['drover_tmux_send', { target: 's:@1', text: 'go', force: true }],
      ['drover_tmux_keys', { target: 's:@1', keys: ['1'] }],
      ['drover_launch', { engine: 'claude', prompt: 'x' }],
      ['drover_send', { id: 'abc', text: 'hi' }],
    ]) {
      const r = await call(name, args);
      assert.notEqual(r.result.isError, true, `${name}: ${JSON.stringify(r.result)}`);
    }
    assert.deepEqual(dispatch.calls.map((c) => c.op), ['tmux.send', 'tmux.keys', 'launch.start', 'sessions.message']);
  });
});

describe('drover_launch and folder trust', () => {
  test('drover_launch passes trust through; omitted, the op default (trust) applies', async () => {
    const dispatch = fakeDispatch();
    const s = createServer({ dispatch, log: quiet });
    await s.handleMessage(req(1, 'tools/call', { name: 'drover_launch', arguments: { engine: 'claude', cwd: '~/code/x', trust: false } }));
    await s.handleMessage(req(2, 'tools/call', { name: 'drover_launch', arguments: { engine: 'claude', cwd: '~/code/x' } }));
    assert.deepEqual(dispatch.calls.map((c) => c.args), [{ engine: 'claude', cwd: '~/code/x', trust: false, actor: 'mcp' }, { engine: 'claude', cwd: '~/code/x', actor: 'mcp' }]);
  });
});

describe('search tools carry the calling session\'s working directory', () => {
  test('drover_search_semantic, drover_search_fleet and drover_op pass callerCwd (this server\'s cwd) for the front\'s work guard, and remote: true (this server is a front)', async () => {
    const dispatch = fakeDispatch();
    const s = createServer({ dispatch, log: quiet });
    const call = (name, args) => s.handleMessage(req(1, 'tools/call', { name, arguments: args }));
    const results = [
      await call('drover_search_semantic', { query: 'drover search index', kinds: ['brain', 'claude'], host: 'box-a' }),
      await call('drover_search_fleet', { query: 'drover search index', kinds: ['brain'] }),
      // An agent cannot name another checkout: drover_op's free-form args get this server's own.
      await call('drover_op', { op: 'search.fleet', args: { query: 'q', callerCwd: '/somewhere/personal' } }),
    ];
    for (const r of results) assert.notEqual(r.result.isError, true, JSON.stringify(r.result));
    assert.deepEqual(dispatch.calls, [
      { op: 'search.semantic', args: { query: 'drover search index', kinds: ['brain', 'claude'], host: 'box-a', callerCwd: process.cwd(), remote: true } },
      { op: 'search.fleet', args: { query: 'drover search index', kinds: ['brain'], callerCwd: process.cwd(), remote: true } },
      { op: 'search.fleet', args: { query: 'q', callerCwd: process.cwd(), remote: true } },
    ]);
    const tool = (await s.handleMessage(req(2, 'tools/list'))).result.tools.find((t) => t.name === 'drover_search_fleet');
    assert.ok(tool.inputSchema.properties.kinds.items.enum.includes('brain'));
    assert.equal(tool.inputSchema.properties.callerCwd, undefined, 'set by this server, not by the agent');
    assert.match(tool.description, /remote\.brain/);
  });
});

describe('files.wait over MCP waits at most MCP_WAIT_MAX_SEC', () => {
  test('by name and through drover_op: a longer or absent timeoutSec becomes 110 s, a shorter one stays', async () => {
    const dispatch = fakeDispatch();
    const s = createServer({ dispatch, log: quiet });
    const call = (name, args) => s.handleMessage(req(1, 'tools/call', { name, arguments: args }));
    await call('drover_files_wait', { path: '~/x/status', timeoutSec: 3000, host: 'box-a' });
    await call('drover_files_wait', { path: '~/x/status' });
    await call('drover_files_wait', { path: '~/x/status', timeoutSec: 30, glob: 'WS-*.md' });
    await call('drover_op', { op: 'files.wait', args: { path: '~/x', timeoutSec: 999 }, host: 'box-a' });
    assert.deepEqual(dispatch.calls, [
      { op: 'files.wait', args: { path: '~/x/status', timeoutSec: 110, host: 'box-a' } },
      { op: 'files.wait', args: { path: '~/x/status', timeoutSec: 110 } },
      { op: 'files.wait', args: { path: '~/x/status', timeoutSec: 30, glob: 'WS-*.md' } },
      { op: 'files.wait', args: { path: '~/x', timeoutSec: 110, host: 'box-a' } },
    ]);
    const tool = (await s.handleMessage(req(2, 'tools/list'))).result.tools.find((t) => t.name === 'drover_files_wait');
    assert.match(tool.description, /over MCP a call waits at most 110 s/);
    assert.match(tool.description, /background Bash/);
    assert.deepEqual(tool.inputSchema.required, ['path']);
  });
});
