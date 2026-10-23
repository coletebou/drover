// The chat rendering rule (ui/chat-model.js): no duplicate turns (local echo, polled copy, streamed and pending
// replies), tool-call groups with their verb line and results, and who a user turn is from. Synthetic turns only.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mergeTurns, rebase, chatItems, verbLine, turnKey, speaker, unwrapPeer, toolSummary, commandOf, headOf, itemSig } from '../ui/chat-model.js';
import { setOwner } from '../ui/owner.js';

const echo = (text, n = 1, extra = {}) => ({ role: 'user', text, ts: '2026-10-20T10:00:00.000Z', local: true, localId: `local:${n}`, ...extra });
const call = (id, name, summary, extra = {}) => ({ role: 'assistant', uuid: `u-${id}`, ts: `2026-10-20T10:00:0${id.length % 10}Z`, text: '', tools: [{ id, name, input: {}, summary }], ...extra });
const result = (id, text, isError = false) => ({ role: 'tool_result', uuid: `r-${id}`, results: [{ toolUseId: id, isError, text }] });

describe('mergeTurns: one copy of every turn', () => {
  test('the server copy of a message replaces its local echo (manager: same text; Claude: in a peer envelope)', () => {
    let list = [echo('who is waiting on me?')];
    list = mergeTurns(list, [{ role: 'user', id: 'ev1', text: 'who is waiting on me?', actor: 'owner' }]);
    assert.deepEqual(list.map((t) => [t.role, t.id ?? null, Boolean(t.local)]), [['user', 'ev1', false]]);
    let cl = [echo('run the tests')];
    cl = mergeTurns(cl, [{ role: 'user', uuid: 'a', text: '<cross-session-message from-name="drover (owner)" from-mode="bypass">\nrun the tests\n</cross-session-message>' }]);
    assert.equal(cl.length, 1); assert.equal(cl[0].uuid, 'a');
  });
  test('the event id the send returned matches the echo even when the text differs; a failed echo is never matched', () => {
    const list = mergeTurns([echo('x', 1, { serverId: 'ev9' })], [{ role: 'user', id: 'ev9', text: 'x (trimmed by the daemon)' }]);
    assert.deepEqual(list.map((t) => t.id), ['ev9']);
    const failed = mergeTurns([echo('same', 1, { failed: 'gateway 502' })], [{ role: 'user', id: 'ev2', text: 'same' }]);
    assert.equal(failed.length, 2);
  });
  test('two sends of the same words match in order', () => {
    let list = [echo('status?', 1), echo('status?', 2)];
    list = mergeTurns(list, [{ role: 'user', id: 'e1', text: 'status?' }]);
    assert.deepEqual(list.map(turnKey), ['id:e1', 'local:2']);
    list = mergeTurns(list, [{ role: 'user', id: 'e2', text: 'status?' }]);
    assert.deepEqual(list.map(turnKey), ['id:e1', 'id:e2']);
  });
  test('the copy takes the echo\'s place while only its reply follows; after other work it goes where the server put it', () => {
    let list = mergeTurns([echo('q', 1)], [{ role: 'assistant', id: 's', inReplyTo: 'm', streamed: true, pending: true, text: 'A' }]);
    list = mergeTurns(list, [{ role: 'user', id: 'm', text: 'q' }]);
    assert.deepEqual(list.map(turnKey), ['id:m', 'id:s']);
    let busy = [echo('also do x', 1), { role: 'assistant', uuid: 'w1', text: '', tools: [{ id: 'k', name: 'Bash' }] }];
    busy = mergeTurns(busy, [{ role: 'user', uuid: 'cp', text: '<cross-session-message from-name="drover (owner)">\nalso do x\n</cross-session-message>' }]);
    assert.deepEqual(busy.map(turnKey), ['uuid:w1', 'uuid:cp'], 'a busy session read it after the call it was making');
  });
  test('polls and events repeat turns: the same uuid or id is replaced in place, never appended', () => {
    const a = { role: 'assistant', uuid: 'x1', text: 'hello' };
    let list = mergeTurns([], [a, { role: 'user', uuid: 'x2', text: 'hi' }]);
    list = mergeTurns(list, [a, { ...a }, { role: 'user', uuid: 'x2', text: 'hi' }]);
    assert.equal(list.length, 2);
  });
  test('a pending reply is replaced by the final turn with the same inReplyTo; a stale pending copy never comes back', () => {
    let list = mergeTurns([], [{ role: 'user', id: 'm1', text: 'q' }, { role: 'assistant', id: 'p1', inReplyTo: 'm1', pending: true, text: 'Thinking about' }]);
    list = mergeTurns(list, [{ role: 'assistant', id: 'c1', inReplyTo: 'm1', text: 'Thinking about it: two sessions wait.' }]);
    assert.deepEqual(list.map((t) => [t.id, Boolean(t.pending)]), [['m1', false], ['c1', false]]);
    list = mergeTurns(list, [{ role: 'assistant', id: 'p1', inReplyTo: 'm1', pending: true, text: 'Thinking' }]);
    assert.equal(list.length, 2, 'a slow poll that still saw the pending turn adds nothing');
    list = mergeTurns(list, [{ role: 'assistant', id: 'c1', inReplyTo: 'm1', pending: true, text: 'Thinking' }]);
    assert.equal(list[1].pending ? 1 : 0, 0, 'a pending copy never reopens a finished turn');
  });
  test('a streamed reply grows; a pending poll copy never shortens it; done then final leaves one reply', () => {
    let list = mergeTurns([], [{ role: 'assistant', id: 't1', inReplyTo: 'm1', streamed: true, pending: true, text: 'Two sessions' }]);
    list = mergeTurns(list, [{ role: 'assistant', id: 't1', inReplyTo: 'm1', pending: true, text: 'Two' }]);
    assert.equal(list[0].text, 'Two sessions');
    list = mergeTurns(list, [{ role: 'assistant', id: 't1', inReplyTo: 'm1', streamed: true, pending: false, text: 'Two sessions wait.' }]);
    list = mergeTurns(list, [{ role: 'assistant', id: 'chat-9', inReplyTo: 'm1', text: 'Two sessions wait.' }]);
    assert.deepEqual(list.map((t) => t.id), ['chat-9']);
    list = mergeTurns(list, [{ role: 'assistant', id: 't1', inReplyTo: 'm1', streamed: true, pending: false, text: 'Two sessions wait.' }]);
    assert.deepEqual(list.map((t) => t.id), ['chat-9'], 'a late done event after the final adds nothing');
  });
  test('a failed reply (the daemon\'s system line) replaces the streamed text; a late done adds nothing', () => {
    let list = mergeTurns([], [{ role: 'user', id: 'm', text: 'q' }, { role: 'assistant', id: 'pending:m', inReplyTo: 'm', streamed: true, pending: true, text: 'Hal' }]);
    list = mergeTurns(list, [{ role: 'system', id: 'chat-e', inReplyTo: 'm', text: 'The manager did not answer: gateway 502', error: 'gateway 502' }]);
    assert.deepEqual(list.map((t) => [t.role, t.id]), [['user', 'm'], ['system', 'chat-e']]);
    list = mergeTurns(list, [{ role: 'assistant', id: 'pending:m', inReplyTo: 'm', streamed: true, text: 'Hal', error: 'gateway 502' }]);
    assert.equal(list.length, 2);
  });
  test('an inline reply from an older daemon gives way to its transcript copy', () => {
    let list = [{ role: 'user', text: 'hi', ts: '2026-10-20T10:00:00Z' }, { role: 'assistant', text: 'Hi there', localReply: true, localId: 'local:3' }];
    list = mergeTurns(list, [{ role: 'user', text: 'hi', ts: '2026-10-20T10:00:00Z' }, { role: 'assistant', text: 'Hi there', ts: '2026-10-20T10:00:02Z', model: 'openclaw/default' }]);
    assert.deepEqual(list.map((t) => [t.role, Boolean(t.localReply)]), [['user', false], ['assistant', false]]);
  });
  test('identity: event id, then uuid, then role, time, text and calls (two calls in the same second stay two)', () => {
    assert.equal(turnKey({ id: 'e', uuid: 'u' }), 'id:e');
    assert.equal(turnKey({ uuid: 'u' }), 'uuid:u');
    assert.notEqual(turnKey({ role: 'assistant', ts: 't', text: '', tools: [{ id: 'a' }] }), turnKey({ role: 'assistant', ts: 't', text: '', tools: [{ id: 'b' }] }));
  });
});

describe('rebase: a full read lines up with what is shown', () => {
  test('server order wins; an unanswered echo and newer event turns stay at the end; older history drops', () => {
    const shown = [{ role: 'user', id: 'b', text: 'two' }, { role: 'assistant', id: 'c', text: 'three' }, echo('four', 7)];
    const read = [{ role: 'user', id: 'a', text: 'one' }, { role: 'user', id: 'b', text: 'two' }];
    assert.deepEqual(rebase(shown, read).map(turnKey), ['id:a', 'id:b', 'id:c', 'local:7']);
    const old = [{ role: 'user', id: 'z', text: 'ancient', ts: '2026-10-01T00:00:00Z' }];
    assert.deepEqual(rebase(old, [{ role: 'user', id: 'a', text: 'one', ts: '2026-10-20T00:00:00Z' }]).map(turnKey), ['id:a']);
  });
  test('a read taken while the reply streamed does not bring back its pending copy once the final is here', () => {
    const shown = [{ role: 'user', id: 'm', text: 'q' }, { role: 'assistant', id: 'final', inReplyTo: 'm', text: 'done' }];
    const read = [{ role: 'user', id: 'm', text: 'q' }, { role: 'assistant', id: 'p', inReplyTo: 'm', pending: true, text: 'do' }];
    assert.deepEqual(rebase(shown, read).map(turnKey), ['id:m', 'id:final']);
  });
});

describe('chatItems: what a chat shows', () => {
  test('consecutive tool-only turns are one group; results attach by id; text breaks the group', () => {
    const turns = [
      { role: 'user', uuid: 'u0', text: 'fix it' },
      { role: 'thinking', uuid: 'th' },
      call('t1', 'Bash', 'npm test'), result('t1', 'ok 12 tests'),
      call('t2', 'Read', '~/code/x/a.js'), call('t3', 'Read', '~/code/x/b.js'), result('t3', 'b body'), result('t2', 'a body'),
      { role: 'assistant', uuid: 'a1', text: 'Found it.' },
      call('t4', 'Edit', '~/code/x/a.js'), result('t4', 'File has been updated', false),
      call('t5', 'Bash', 'npm test'), result('t5', '1 failing', true),
    ];
    const items = chatItems(turns);
    assert.deepEqual(items.map((i) => i.kind), ['user', 'tools', 'assistant', 'tools']);
    const [, g1, , g2] = items;
    assert.equal(g1.line, 'Ran 1 command, read 2 files');
    assert.deepEqual(g1.calls.map((c) => c.result.text), ['ok 12 tests', 'a body', 'b body']);
    assert.equal(g1.errors, 0);
    assert.equal(g2.line, 'Edited 1 file, ran 1 command');
    assert.equal(g2.errors, 1);
  });
  test('a turn with text and calls shows the text, then its calls as a group that later tool turns join', () => {
    const items = chatItems([{ role: 'assistant', uuid: 'a', text: 'Checking:', tools: [{ id: 'x', name: 'Grep', summary: '"foo" in src' }] }, call('y', 'Glob', '**/*.js')]);
    assert.deepEqual(items.map((i) => [i.kind, i.line ?? i.text]), [['assistant', 'Checking:'], ['tools', 'Searched 2 times']]);
  });
  test('whitespace-only text, thinking, titles and meta turns are hidden; meta shows when asked', () => {
    const turns = [{ role: 'assistant', uuid: 'a', text: '\n  \n' }, { role: 'title', text: '' }, { role: 'user', uuid: 'm', meta: true, text: 'Caveat: local commands' }, { role: 'queue', text: 'enqueue: x' }];
    assert.deepEqual(chatItems(turns), []);
    assert.deepEqual(chatItems(turns, { showMeta: true }).map((i) => [i.kind, i.label ?? i.sub]), [['user', 'system'], ['system', 'queue']]);
  });
  test('a pending empty reply still shows (the manager is typing); a streamed error shows', () => {
    assert.deepEqual(chatItems([{ role: 'assistant', id: 'p', pending: true, text: '' }]).map((i) => [i.kind, i.pending]), [['assistant', true]]);
    assert.equal(chatItems([{ role: 'assistant', id: 'p', text: '', error: 'gateway 502' }])[0].error, 'gateway 502');
  });
  test('older daemons: tool turns without ids or summaries, results as one joined text, Codex "tool" turns', () => {
    const turns = [
      { role: 'assistant', uuid: 'a', text: '', tools: [{ name: 'Bash', input: '{"command":"git status","description":"Show the tree"}' }] },
      { role: 'assistant', uuid: 'b', text: '', tools: [{ name: 'Read', input: { file_path: '/Users/someone/code/x/readme.md' } }] },
      { role: 'tool_result', uuid: 'r1', count: 1, text: 'On branch main' },
      { role: 'tool_result', uuid: 'r2', count: 1, text: '[error] File does not exist.' },
      { role: 'tool', ts: '2026-10-20T10:00:00Z', text: 'shell({"command":["bash","-lc","ls -la"]})' },
    ];
    const [g] = chatItems(turns);
    assert.deepEqual(g.calls.map((c) => [c.name, c.summary, c.result?.text ?? null, c.result?.isError ?? null]), [
      ['Bash', 'git status', 'On branch main', false], ['Read', '~/code/x/readme.md', 'File does not exist.', true], ['shell', 'ls -la', null, null]]);
    assert.equal(g.line, 'Ran 2 commands, read 1 file');
  });
  test('a result whose call fell outside the window is not put under another call', () => {
    const [g] = chatItems([call('new', 'Bash', 'ls'), result('old', 'stale output')]);
    assert.equal(g.calls[0].result, null);
  });
  test('user turns name who sent them; slash commands and interrupts read as system lines', () => {
    const items = chatItems([
      { role: 'user', uuid: '1', text: 'plain from the keyboard' },
      { role: 'user', uuid: '2', text: '<cross-session-message from-name="drover (mcp)">\nfrom an agent\n</cross-session-message>' },
      { role: 'user', uuid: '3', text: '<cross-session-message from-name="webapp-f8" from-mode="bypass">\npeer says hi\n</cross-session-message>' },
      { role: 'user', id: '4', text: 'hello', actor: 'grok:scout' },
      { role: 'user', uuid: '5', text: '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>' },
      { role: 'user', uuid: '6', text: '[Request interrupted by user]' },
      { role: 'user', uuid: '7', text: 'relayed by drover', via: 'drover', actor: 'owner', meta: false },
      { role: 'user', uuid: '8', text: 'relayed for an agent', via: 'drover', actor: 'mcp', meta: false },
      { role: 'user', uuid: '9', text: 'a peer wrote', via: 'peer', from: 'webapp-c2', meta: false },
    ]);
    assert.deepEqual(items.map((i) => [i.kind, i.label ?? i.sub, i.text]), [
      ['user', 'you', 'plain from the keyboard'], ['user', 'mcp', 'from an agent'], ['user', 'webapp-f8', 'peer says hi'], ['user', 'grok:scout', 'hello'],
      ['system', 'command', '/compact'], ['system', 'interrupt', 'interrupted'],
      ['user', 'you', 'relayed by drover'], ['user', 'mcp', 'relayed for an agent'], ['user', 'webapp-c2', 'a peer wrote']]);
  });
});

describe('verb lines and helpers', () => {
  test('one phrase per kind, in the order they ran; files count once; anything else is "used <name>"', () => {
    const c = (name, summary = '') => ({ name, summary });
    assert.equal(verbLine([c('Bash'), c('Bash'), c('Bash'), c('Read', 'a'), c('Read', 'b'), c('Read', 'a')]), 'Ran 3 commands, read 2 files');
    assert.equal(verbLine([c('Edit', 'a'), c('MultiEdit', 'a'), c('Write', 'b'), c('NotebookEdit', 'n.ipynb')]), 'Edited 3 files');
    assert.equal(verbLine([c('Grep'), c('Glob'), c('WebFetch'), c('WebSearch'), c('Task'), c('Agent'), c('TodoWrite')]), 'Searched 2 times, fetched 2 pages, ran 2 agents, updated the todo list');
    assert.equal(verbLine([c('Grep')]), 'Searched once');
    assert.equal(verbLine([c('mcp__drover__drover_sessions'), c('mcp__drover__drover_sessions'), c('Skill')]), 'Used drover_sessions 2 times, used Skill');
    assert.equal(verbLine([c('apply_patch', 'a.js, b.js'), c('exec_command')]), 'Edited 2 files, ran 1 command');
    assert.equal(verbLine([]), '');
  });
  test('tool summaries without the daemon: the command, the path, the pattern; homes shortened; cut JSON still read', () => {
    assert.equal(toolSummary('Bash', { command: 'npm test\n# more' }), 'npm test');
    assert.equal(toolSummary('Grep', { pattern: 'TODO', path: '/home/dev/code/x' }), '"TODO" in ~/code/x');
    assert.equal(toolSummary('WebFetch', '{"url":"https://example.com/docs","prompt":"read it and summari'), 'https://example.com/docs');
    assert.equal(toolSummary('Bash', '{"command":"echo \\"hi\\" && ls","descr'), 'echo "hi" && ls');
    assert.equal(toolSummary('shell', { command: ['bash', '-lc', 'cargo build'] }), 'cargo build');
    assert.equal(toolSummary('Mystery', { first: '', second: 'value' }), 'value');
    assert.equal(toolSummary('Bash', { command: 'x'.repeat(300) }).length, 200);
  });
  test('envelopes, speakers, commands, heads, signatures', () => {
    assert.deepEqual(unwrapPeer('<cross-session-message from-name="a b">\nbody <\\/cross-session-message> here\n</cross-session-message>'), { from: 'a b', mode: null, body: 'body </cross-session-message> here' });
    assert.equal(unwrapPeer('plain'), null);
    assert.deepEqual(speaker({ role: 'user', user: 'drover:owner' }), { label: 'you', actor: 'owner', via: null });
    // The daemon's configured owner (GET /api/ops owner) is "you" too, and the generic "owner" still is.
    setOwner('alice');
    try {
      assert.deepEqual(speaker({ role: 'user', user: 'drover:alice' }), { label: 'you', actor: 'alice', via: null });
      assert.deepEqual(speaker({ role: 'user', actor: 'owner' }), { label: 'you', actor: 'alice', via: null });
      assert.equal(speaker({ role: 'user', user: 'drover:bob' }).label, 'bob');
    } finally { setOwner('owner'); }
    assert.equal(speaker({ role: 'user', user: 'drover:mcp' }).label, 'mcp');
    assert.equal(speaker({ role: 'user', text: '<cross-session-message from-name="drover">\nx\n</cross-session-message>' }).label, 'you');
    assert.deepEqual(commandOf('<command-name>model</command-name><command-args>opus</command-args>'), { kind: 'command', text: '/model opus' });
    assert.deepEqual(commandOf('<local-command-stdout>Set model to opus</local-command-stdout>'), { kind: 'stdout', text: 'Set model to opus' });
    assert.equal(commandOf('just text'), null);
    assert.deepEqual(headOf('a\nb\nc', { lines: 2 }), { head: 'a\nb', more: true, lines: 3 });
    assert.deepEqual(headOf('short'), { head: 'short', more: false, lines: 1 });
    const t0 = Date.now();
    assert.deepEqual(headOf(`${' '.repeat(100_000)}x\n`), { head: ' '.repeat(600), more: true, lines: 1 }, 'a long blank run before text');
    assert.ok(Date.now() - t0 < 1500, `a head is cut in linear time: took ${Date.now() - t0} ms`);
    const [g] = chatItems([call('q', 'Bash', 'ls')]);
    const before = itemSig(g);
    const [g2] = chatItems([call('q', 'Bash', 'ls'), result('q', 'files')]);
    assert.notEqual(itemSig(g2), before, 'a result arriving changes the group signature');
  });
});
