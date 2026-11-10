// drover_ask and the ask tools over MCP (mcp/server.js) with a fake dispatch: the answer goes to the calling session
// by default (its registry entry, found above this process: core/ask/caller.js), and the hub's own ops are no tools.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer, allTools } from '../mcp/server.js';
import { callerSession, _deps as callerDeps } from '../core/ask/caller.js';

const quiet = () => {};
const req = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
function fakeDispatch() {
  const calls = [];
  const fn = async (op, args) => { calls.push({ op, args }); return { askId: 'a1', code: 'K7', status: 'open' }; };
  fn.calls = calls;
  return fn;
}

describe('drover_ask', () => {
  test('the tools: drover_ask, and get, list, cancel, status from the op table; never ask.deliver or ask.mark', () => {
    const names = allTools().map((t) => t.name).filter((n) => n.startsWith('drover_ask'));
    assert.deepEqual(names.sort(), ['drover_ask', 'drover_ask_cancel', 'drover_ask_get', 'drover_ask_list', 'drover_ask_status']);
  });
  test('the answer goes to the session that runs the MCP server, unless sessionId says another', async () => {
    const real = { ...callerDeps };
    callerDeps.sessionsDir = () => '/sessions';
    callerDeps.platform = () => 'linux';
    // This process -> its parent (a shell) -> the Claude Code session with a registry entry.
    callerDeps.readFile = async (f) => {
      if (f === `/proc/${process.ppid}/stat`) return `${process.ppid} (zsh (login)) S 4242 1 1`;
      if (f === path.join('/sessions', '4242.json')) return JSON.stringify({ pid: 4242, sessionId: 'sess-4242', name: 'worker-7', cwd: '/home/x/code/app' });
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    try {
      assert.deepEqual(await callerSession(), { sessionId: 'sess-4242', name: 'worker-7', cwd: '/home/x/code/app', pid: 4242 });
      const dispatch = fakeDispatch();
      const s = createServer({ dispatch, log: quiet });
      const r = await s.handleMessage(req(1, 'tools/call', { name: 'drover_ask', arguments: { question: 'Ship?', options: ['yes', 'no'], urgency: 'urgent' } }));
      assert.equal(r.result.isError, false);
      assert.deepEqual(dispatch.calls[0], { op: 'ask.create', args: { question: 'Ship?', options: ['yes', 'no'], urgency: 'urgent', sessionId: 'sess-4242', sessionName: 'worker-7', cwd: '/home/x/code/app', actor: 'mcp' } });
      await s.handleMessage(req(2, 'tools/call', { name: 'drover_ask', arguments: { question: 'For another?', sessionId: 'thread-9' } }));
      assert.equal(dispatch.calls[1].args.sessionId, 'thread-9');
      assert.equal(dispatch.calls[1].args.sessionName, undefined);
    } finally { Object.assign(callerDeps, real); }
  });
  test('drover_op refuses the hub\'s own calls', async () => {
    const dispatch = fakeDispatch();
    const s = createServer({ dispatch, log: quiet });
    const r = await s.handleMessage(req(3, 'tools/call', { name: 'drover_op', arguments: { op: 'ask.deliver', args: { askId: 'a1' } } }));
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /ask hub's own call/);
    assert.equal(dispatch.calls.length, 0);
  });
});
