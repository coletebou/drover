// Search index, pure parts: what is kept from each source line (core/search/extract.js),
// chunking (chunk.js), vector math (vec.js) and the hex-safe secret redaction (native.js).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { claudeLine, codexLine, codexAttribute, codexState, environmentCwd, PENDING, walEvent, memoryDoc, reflectionItem, projectOf, userText, tidy, REFLECTION_CHARS } from '../core/search/extract.js';
import { chunkText } from '../core/search/chunk.js';
import { truncateNormalize, quantize, dequantize, cosine, VectorMatrix, DIMS } from '../core/search/vec.js';
import { redactSecrets, redactArgv, clean } from '../core/native.js';

const j = (o) => JSON.stringify(o);

describe('claudeLine', () => {
  test('keeps typed user text and assistant text, with session facts', () => {
    const u = claudeLine(j({ type: 'user', timestamp: '2026-10-14T01:00:00Z', uuid: 'u1', cwd: '/Users/x/code/webapp', sessionId: 's1', message: { role: 'user', content: 'why does the breaker trip?' } }));
    assert.deepEqual(u.units, [{ role: 'user', text: 'why does the breaker trip?' }]);
    assert.equal(u.ts, '2026-10-14T01:00:00Z'); assert.equal(u.cwd, '/Users/x/code/webapp'); assert.equal(u.sessionId, 's1'); assert.equal(u.uuid, 'u1');
    const a = claudeLine(j({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Because the timeout' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }, { type: 'text', text: 'is 5 s.' }] } }));
    // Since extraction v2 a tool call that did something is its own keyword-only "command" unit (thinking stays out).
    assert.deepEqual(a.units, [{ role: 'assistant', text: 'Because the timeout\nis 5 s.' }, { role: 'command', text: '$ ls' }]);
  });
  test('drops tool results, meta turns, wrappers, reminders and interruptions', () => {
    assert.deepEqual(claudeLine(j({ type: 'user', message: { content: [{ type: 'tool_result', content: 'file dump' }] } })).units, []);
    assert.deepEqual(claudeLine(j({ type: 'user', isMeta: true, message: { content: 'Base directory for this skill: ...' } })).units, []);
    assert.deepEqual(claudeLine(j({ type: 'user', message: { content: '<command-name>/effort</command-name>' } })).units, []);
    assert.deepEqual(claudeLine(j({ type: 'user', message: { content: '<local-command-stdout>ok</local-command-stdout>' } })).units, []);
    assert.deepEqual(claudeLine(j({ type: 'user', message: { content: '[Request interrupted by user]' } })).units, []);
    const r = claudeLine(j({ type: 'user', message: { content: [{ type: 'text', text: 'fix it <system-reminder>secret context</system-reminder> please' }] } }));
    assert.deepEqual(r.units, [{ role: 'user', text: 'fix it  please' }]);
    assert.deepEqual(claudeLine(j({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } })).units, []);
  });
  test('unwraps peer messages, keeps compaction summaries, reads ai-title, rejects non-JSON', () => {
    const p = claudeLine(j({ type: 'user', message: { content: '<cross-session-message from-name="drover (alice)">status?</cross-session-message>' } }));
    assert.deepEqual(p.units, [{ role: 'user', text: 'status?' }]);
    assert.deepEqual(claudeLine(j({ type: 'summary', summary: 'Worked on the KB pipeline' })).units, [{ role: 'summary', text: 'Worked on the KB pipeline' }]);
    assert.equal(claudeLine(j({ type: 'ai-title', title: 'Gemma search spike' })).title, 'Gemma search spike');
    const t = claudeLine(j({ type: 'ai-title', title: 'rotate api_key=hunter2 and AKIAEXAMPLE123456789\nnow' })).title;
    assert.equal(t, 'rotate api_key=[redacted] and [redacted] now', 'titles are redacted and one line');
    assert.equal(claudeLine('not json'), null);
    assert.equal(claudeLine(''), null);
  });
  test('redacts secrets but keeps short SHAs and session UUIDs searchable', () => {
    const t = claudeLine(j({ type: 'user', message: { content: 'key AKIAEXAMPLE123456789 and Bearer abc.def123 at 2188ac1deca4 (full 2188ac1deca4b77dffefd603c2776a9d76d9d74e) session 01a12bd1-36bd-718a-9a85-f27349fdf2a7 tok XyZ12AbCdEf34GhIjKl56MnOpQr78StUvWx' } })).units[0].text;
    assert.ok(!t.includes('AKIAEXAMPLE123456789')); assert.ok(!t.includes('abc.def123')); assert.ok(!t.includes('XyZ12AbCdEf34'));
    assert.ok(t.includes('2188ac1deca4 ')); assert.ok(t.includes('01a12bd1-36bd-718a-9a85-f27349fdf2a7'));
    assert.ok(!t.includes('2188ac1deca4b77dffefd603c2776a9d76d9d74e'), 'a bare 40-hex run is redacted: it could be a Datadog application key');
  });
});

describe('codexLine', () => {
  test('keeps user and assistant messages from response_item lines only', () => {
    assert.deepEqual(codexLine(j({ type: 'response_item', timestamp: 't', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'rebase !5678' }] } })).units, [{ role: 'user', text: 'rebase !5678' }]);
    assert.deepEqual(codexLine(j({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } })).units, [{ role: 'assistant', text: 'Done.' }]);
    assert.deepEqual(codexLine(j({ type: 'event_msg', payload: { type: 'agent_message', message: 'Done.' } })).units, []);
    assert.deepEqual(codexLine(j({ type: 'response_item', payload: { type: 'function_call', name: 'shell' } })).units, []);
  });
  test('drops injected context and developer messages; session_meta gives cwd and id', () => {
    for (const t of ['<environment_context>cwd</environment_context>', '<user_instructions>x</user_instructions>', '# AGENTS.md instructions', '<permissions instructions>']) {
      assert.deepEqual(codexLine(j({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: t }] } })).units, [], t);
    }
    assert.deepEqual(codexLine(j({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ text: 'rules' }] } })).units, []);
    const m = codexLine(j({ type: 'session_meta', payload: { id: '019f-thread', cwd: '/home/u/code/apx' } }));
    assert.equal(m.cwd, '/home/u/code/apx'); assert.equal(m.sessionId, '019f-thread');
  });
  test('a turn_context gives the cwd its turn runs in (the reader carries it to the items after it)', () => {
    const t = codexLine(j({ type: 'turn_context', payload: { cwd: '/home/u/code/other', model: 'gpt' } }));
    assert.equal(t.cwd, '/home/u/code/other'); assert.deepEqual(t.units, []); assert.equal(t.sessionId, null);
    assert.equal(codexLine(j({ type: 'turn_context', payload: { model: 'gpt' } })).cwd, null);
    assert.equal(codexLine(j({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'hi' }] } })).cwd, null, 'an item names no cwd of its own');
  });
  test('marks what each line means for attribution: environment cwd, turn boundaries, prompts and model output', () => {
    const item = (payload) => codexLine(j({ type: 'response_item', payload }));
    const env = item({ type: 'message', role: 'user', content: [{ text: '<environment_context>\n  <cwd>/a/b&amp;c</cwd>\n</environment_context>' }] });
    assert.deepEqual([env.mark, env.envCwd, env.units], ['env', '/a/b&c', []]);
    assert.equal(item({ type: 'message', role: 'developer', content: [{ text: '<environment_context><cwd>/x</cwd></environment_context>' }] }).envCwd, '/x');
    assert.equal(item({ type: 'message', role: 'user', content: [{ text: '<environment_context><shell>zsh</shell></environment_context>' }] }).mark, null, 'no cwd named: nothing changes');
    for (const t of ['task_started', 'turn_started', 'task_complete', 'turn_complete', 'turn_aborted', 'error']) assert.equal(codexLine(j({ type: 'event_msg', payload: { type: t } })).mark, 'boundary', t);
    assert.equal(codexLine(j({ type: 'event_msg', payload: { type: 'agent_message', message: 'x' } })).mark, null);
    assert.equal(item({ type: 'message', role: 'user', content: [{ text: '<turn_aborted>x</turn_aborted>' }] }).mark, 'boundary');
    assert.equal(item({ type: 'message', role: 'user', content: [{ text: 'fix it' }] }).mark, 'prompt');
    assert.equal(item({ type: 'message', role: 'user', content: [{ text: '# AGENTS.md instructions' }] }).mark, null, 'injected context is no prompt');
    for (const type of ['reasoning', 'function_call', 'function_call_output', 'custom_tool_call', 'local_shell_call']) assert.equal(item({ type }).mark, 'output', type);
    assert.equal(item({ type: 'message', role: 'assistant', content: [{ text: 'ok' }] }).mark, 'output');
    assert.equal(item({ type: 'ghost_snapshot' }).mark, null, 'bookkeeping is not model output');
    assert.deepEqual([codexLine(j({ type: 'session_meta', payload: { cwd: '/a' } })).mark, codexLine(j({ type: 'turn_context', payload: { cwd: '/a' } })).mark], ['session', 'context']);
  });
  test('environmentCwd: one cwd, none, or several (unknown)', () => {
    assert.equal(environmentCwd('<environment_context><cwd> /a </cwd></environment_context>'), '/a');
    assert.equal(environmentCwd('<environment_context></environment_context>'), undefined);
    assert.equal(environmentCwd('<environments><environment><cwd>/a</cwd></environment><environment><cwd>/b</cwd></environment></environments>'), null);
    assert.equal(environmentCwd('<cwd>/a</cwd><cwd>/a</cwd>'), '/a', 'the same cwd twice is one');
  });
});

describe('codexAttribute', () => {
  const S = 'session', C = 'context', E = 'env', B = 'boundary', P = 'prompt', O = 'output';
  /** Run marks through one state: each step is [mark, cwd]; returns each step's cwd and resolve. */
  const run = (steps, state = codexState()) => steps.map(([mark, c]) => { const r = codexAttribute(state, { mark, cwd: c, envCwd: c }); return r.resolve === undefined ? r.cwd : [r.cwd, r.resolve]; });
  test('current order: a turn_context covers the prompt after it, until the model answers', () => {
    assert.deepEqual(run([[S, '/a'], [B], [C, '/a'], [E, '/a'], [P], [O], [O], [B]]), [null, null, '/a', null, '/a', '/a', '/a', null]);
  });
  test('0.46 order: a prompt waits for its turn_context and is settled in its cwd only if that was in effect', () => {
    assert.deepEqual(run([[S, '/a'], [E, '/a'], [P], [C, '/a'], [O]]), [null, null, PENDING, ['/a', '/a'], '/a']);
    assert.deepEqual(run([[S, '/a'], [P], [C, '/a'], [O], [E, '/b'], [P], [C, '/b'], [O]]).slice(-3), [PENDING, ['/b', '/b'], '/b'], 'switched by an environment_context');
    assert.deepEqual(run([[S, '/a'], [P], [C, '/a'], [O], [P], [C, '/b']]).slice(-2), [PENDING, ['/b', null]], 'resumed elsewhere: unknown');
    assert.deepEqual(run([[S, '/a'], [P], [O], [C, '/a']]).slice(-2), [PENDING, ['/a', '/a']], 'what follows a pending prompt waits with it');
    assert.deepEqual(run([[S, '/a'], [P], [E, '/b'], [C, '/b']]).slice(-1), [['/b', null]], 'the cwd changed while it waited: unknown');
  });
  test('a turn boundary or a new session_meta settles a pending run to unknown', () => {
    assert.deepEqual(run([[S, '/a'], [P], [B], [C, '/a'], [P]]), [null, PENDING, [null, null], '/a', '/a']);
    assert.deepEqual(run([[S, '/a'], [P], [S, '/a']]).slice(-1), [[null, null]]);
  });
  test('several environments, or a turn_context naming none, give unknown; the state survives a save and restore', () => {
    assert.deepEqual(run([[S, '/a'], [C, '/a'], [E, null], [P]]).slice(-1), [null]);
    assert.deepEqual(run([[S, '/a'], [C, null], [P], [C, null]]).slice(-2), [PENDING, [null, null]]);
    const st = codexState('/a');
    run([[P]], st);
    const back = codexState(st.cwd, JSON.parse(JSON.stringify({ ctx: st.ctx, pending: st.pending })));
    assert.deepEqual(run([[C, '/a']], back), [['/a', '/a']]);
    assert.deepEqual(codexState('/a', { pending: {} }).pending, { before: null, mixed: true }, 'a damaged saved state fails closed');
  });
});

describe('walEvent', () => {
  test('notes, messages, chats and survey items become text; ops and alerts do not', () => {
    assert.deepEqual(walEvent({ id: 'e1', ts: 't', type: 'note', about: 'deploy', text: 'devbox rolled' }), { id: 'e1', ts: 't', role: 'note', text: 'deploy\ndevbox rolled', title: 'note: deploy', sessionId: null });
    const m = walEvent({ id: 'e2', type: 'message', to: { id: 's9', name: 'webapp-26', host: 'devbox' }, text: 'rebase onto dev' });
    assert.equal(m.title, 'message to webapp-26 on devbox'); assert.equal(m.sessionId, 's9');
    const s = walEvent({ id: 'e3', type: 'survey-item', item: { title: 'KB fix', summary: 'halfway', next_step: 'run tests', mrs: ['!5678'], activities: ['#1234'], sessionId: 's2', host: 'laptop' } });
    assert.match(s.text, /next: run tests/); assert.match(s.text, /!5678/); assert.match(s.text, /#1234/); assert.equal(s.sessionId, 's2');
    assert.equal(walEvent({ id: 'e4', type: 'op', op: 'tmux.send' }), null);
    assert.equal(walEvent({ id: 'e5', type: 'notify', title: 'x' }), null);
    assert.equal(walEvent({ id: 'e6', type: 'note', about: '', text: '' }), null);
    assert.equal(walEvent({ type: 'note', text: 'no id' }), null);
  });
});

describe('reflectionItem', () => {
  const it = { id: 'abcd2345', kind: 'gotcha', status: 'open', repo: 'webapp', title: '  Breaker   trips\nearly ', body: 'Uses a 5 s timeout.', tags: ['breaker', '', 7, 'timeout'], session_id: 's1', origin: 'sessionend', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z' };
  test('embeds title, body and tags, then the id, never the status; role is the kind, project the repo, ts updated_at', () => {
    const d = reflectionItem(it);
    assert.deepEqual(d, { id: 'abcd2345', ts: '2026-10-02T00:00:00Z', role: 'gotcha', title: 'Breaker trips early', text: 'Breaker trips early\n\nUses a 5 s timeout.\n\ntags: breaker timeout\n\n#abcd2345', project: 'webapp', sessionId: 's1', status: 'open', origin: 'sessionend', checkout: null, host: null });
    assert.equal(reflectionItem({ ...it, status: 'done' }).text, d.text, 'a status change leaves the text (and so the vector) alone');
  });
  test('keeps where the item was written (checkout, host) as exported, never filled in; the exported cwd is never used', () => {
    const d = reflectionItem({ ...it, checkout: '/Users/x/code/webapp-wt', cwd: '/Users/x/code/webapp', host: 'box-b' });
    assert.equal(d.checkout, '/Users/x/code/webapp-wt'); assert.equal(d.host, 'box-b');
    assert.ok(!('cwd' in d), 'the CLI\'s cwd is its main worktree root, even for an item written in a private worktree');
    assert.equal(reflectionItem({ ...it, cwd: '/Users/x/code/webapp', host: 'box-b' }).checkout, null, 'no checkout: none, never the cwd');
    assert.deepEqual([reflectionItem({ ...it, checkout: '', host: 7 }).checkout, reflectionItem({ ...it, checkout: '', host: 7 }).host], [null, null]);
  });
  test('two items with the same words still have different texts, so search never folds them into one hit', () => {
    assert.notEqual(reflectionItem(it).text, reflectionItem({ ...it, id: 'efgh2345', repo: 'code' }).text);
  });
  test('secrets are redacted, long bodies cut to one embedding input, and an item without id or text is skipped', () => {
    assert.match(reflectionItem({ ...it, body: 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' }).text, /key \[redacted\]/);
    const long = reflectionItem({ ...it, body: 'x'.repeat(20_000) }).text;
    assert.equal(long.length, REFLECTION_CHARS + '\n\n#abcd2345'.length); assert.ok(long.endsWith('\n\n#abcd2345'), 'the id is never cut off');
    assert.equal(reflectionItem({ ...it, id: '' }), null);
    assert.equal(reflectionItem({ id: 'empty', title: ' ', body: '' }), null);
    assert.equal(reflectionItem({ id: 'noupd', title: 't', created_at: '2026-10-01T00:00:00Z' }).ts, '2026-10-01T00:00:00Z');
  });
});

describe('memoryDoc, projectOf, userText, tidy', () => {
  test('frontmatter name + description make the title; the body is the text', () => {
    const d = memoryDoc('---\nname: billing-repo\ndescription: "lives on GitHub"\nmetadata:\n  type: reference\n---\n\nClone with the PAT helper.\n', 'x.md');
    assert.equal(d.title, 'billing-repo: lives on GitHub'); assert.equal(d.text, 'Clone with the PAT helper.');
    assert.deepEqual(memoryDoc('Just text', 'plain-note.md'), { title: 'plain-note', text: 'Just text' });
  });
  test('worktree paths fold onto their repo', () => {
    assert.equal(projectOf('/Users/x/code/webapp'), 'webapp');
    assert.equal(projectOf('/Users/x/code/drover/.claude/worktrees/feat-semantic-search/web'), 'drover');
    assert.equal(projectOf('/home/u/code/Billing/'), 'Billing');
    assert.equal(projectOf(null), null);
  });
  test('tidy strips escapes and collapses blank runs', () => {
    assert.equal(tidy('\x1b[31mred\x1b[0m\n\n\n\nnext  '), 'red\n\nnext');
    assert.equal(userText('<bash-stdout>x</bash-stdout>'), '');
  });
});

describe('redactSecrets', () => {
  test('default mode redacts long mixed runs including hex; hexSafe keeps UUIDs but not bare hex keys', () => {
    const sha = '2188ac1deca4b77dffefd603c2776a9d76d9d74e';
    assert.equal(redactSecrets(sha), '[redacted]');
    assert.equal(redactSecrets(sha, { hexSafe: true }), '[redacted]', '40 hex: indistinguishable from a Datadog application key');
    assert.equal(redactSecrets('EXAMPLEa5580000000000000000000000'.toLowerCase().replace(/[^0-9a-f]/g, '0'), { hexSafe: true }), '[redacted]', '32 hex: a Datadog API key shape');
    assert.equal(redactSecrets('01a12bd1-36bd-718a-9a85-f27349fdf2a7', { hexSafe: true }), '01a12bd1-36bd-718a-9a85-f27349fdf2a7');
    assert.equal(redactSecrets('XyZ12AbCdEf34GhIjKl56MnOpQr78StUvWx', { hexSafe: true }), '[redacted]');
    assert.equal(redactSecrets('api_key=hunter2', { hexSafe: true }), 'api_key=[redacted]');
    assert.equal(redactSecrets('ABSKEXAMPLEEXAMPLEEXAMPLEEXAMPLE0000', { hexSafe: true }), '[redacted]');
  });
  test('search mode keeps word-like identifiers (memory names, branches) but still redacts token-shaped runs', () => {
    for (const keep of ['project_1234_importance_triage_mr5678_20261013', 'webapp-6988-6990-reliability-brief-20261014', 'reference_datadog_agent_fleet_and_laptop_20261014', 'Users/alice/code/webapp-3847-rebase-20261007/web']) assert.equal(redactSecrets(keep, { hexSafe: true }), keep, keep);
    assert.equal(redactSecrets('dGhpcyBpcyBub3QgYSByZWFsIGtleSBFWEFNUExF/ZXhhbXBsZSBleGFtcGxlIGV4YW1wbGU', { hexSafe: true }), '[redacted]', 'base64 with a slash: long random segments');
    for (const drop of ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9EXAMPLE0', 'github_pat_EXAMPLE0000000000000000_EXAMPLEEXAMPLEEXAMPLEEXAMPLE', 'Zm9vYmFyYmF6cXV4EXAMPLE0000EXAMPLE0000/+==',
      'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',                       // AWS's documented example secret key: three short segments
      'Xq3kfJ_8aLp-Zw9QmT_v2RbN-k7YsHd_EXAMPLE0x']) assert.equal(redactSecrets(drop, { hexSafe: true }), '[redacted]', drop);   // base64url with - and _
    // Field names that carry a secret, prefixed or not; numbers and booleans are not secrets.
    assert.equal(redactSecrets('aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', { hexSafe: true }), 'aws_secret_access_key = [redacted]');
    assert.equal(redactSecrets('DD_API_KEY=EXAMPLE123 client_secret: "EXAMPLEvalue" GITHUB_PERSONAL_ACCESS_TOKEN=x9', { hexSafe: true }), 'DD_API_KEY=[redacted] client_secret: [redacted] GITHUB_PERSONAL_ACCESS_TOKEN=[redacted]');
    assert.equal(redactSecrets('max_tokens: 2048, prompt_tokens=7, use_api_key: true', { hexSafe: true }), 'max_tokens: 2048, prompt_tokens=7, use_api_key: true');
    assert.equal(redactSecrets('project_1234_importance_triage_mr5678_20261013'), '[redacted]', 'native headlines keep the strict default');
  });
  test('Authorization headers lose scheme and credential together, whatever the scheme; numeric passwords are redacted', () => {
    for (const h of ['Authorization: GenieKey 01a12bd1-36bd-718a-9a85-f27349fdf2a7', 'authorization: Basic dXNlcjpFWEFNUExF', 'Authorization=Token EXAMPLEtoken9', 'Proxy-Authorization: Negotiate EXAMPLEticket']) {
      const out = redactSecrets(h, { hexSafe: true });
      assert.match(out, /^(proxy-)?authorization[=:]\s*\[redacted\]$/i, h);
      assert.ok(!/GenieKey|Basic|Token |Negotiate|01a12bd1|EXAMPLE/.test(out), out);
    }
    assert.equal(redactSecrets('curl -H "Authorization: GenieKey 01a12bd1-36bd-718a-9a85-f27349fdf2a7" https://x', { hexSafe: true }), 'curl -H "Authorization: [redacted]" https://x');
    for (const strict of [false, true]) {
      assert.equal(redactSecrets('password="12345678" database_password=12345678 pin: 4321', { hexSafe: strict }), 'password=[redacted] database_password=[redacted] pin: 4321');
      assert.equal(redactSecrets('max_tokens: 2048 token_count=5 batch_size: 16 api_key_limit=10', { hexSafe: strict }), 'max_tokens: 2048 token_count=5 batch_size: 16 api_key_limit=10');
    }
  });
  test('passwords in URL userinfo and curl -u are redacted; scheme, user and host stay searchable', () => {
    for (const strict of [false, true]) {
      const r = (t) => redactSecrets(t, { hexSafe: strict });
      assert.equal(r('DATABASE_URL=postgresql://app_user:Hunter2Hunter2@db.prod.internal:5432/orders'), 'DATABASE_URL=postgresql://app_user:[redacted]@db.prod.internal:5432/orders');
      assert.equal(r('redis://:p4ssw0rd@cache:6379/0'), 'redis://:[redacted]@cache:6379/0');
      assert.equal(r('git clone https://admin:S3cretPass@10.0.1.5/repo.git'), 'git clone https://admin:[redacted]@10.0.1.5/repo.git');
      assert.equal(r('curl -u svc_deploy:Tr0ub4dor3 https://internal/api'), 'curl -u svc_deploy:[redacted] https://internal/api');
      assert.equal(r('curl --user=ops:EXAMPLEpw https://x'), 'curl --user=ops:[redacted] https://x');
      assert.equal(r('env -u AWS_REGION aws sts get-caller-identity; see https://example.com/a@b'), 'env -u AWS_REGION aws sts get-caller-identity; see https://example.com/a@b');
    }
  });
  test('clean() is unchanged: one line, home paths folded, clipped', () => {
    assert.equal(clean('/Users/alice/code   x\n y', 140), '~/code x y');
  });
});

describe('redactArgv', () => {
  test('each item redacted in place; the value after a secret-named flag too; other items and order kept', () => {
    const key = ['sk', 'ant', 'api03', 'EXAMPLE0EXAMPLE0EXAMPLE0EXAMPLE0'].join('-');
    assert.deepEqual(redactArgv(['env', 'TOKEN=abc123', '-e', `KEY=${key}`, '--password', 'hunter2', '--api-key', 'x9', '--verbose', 'ls', key], { hexSafe: true }),
      ['env', 'TOKEN=[redacted]', '-e', 'KEY=[redacted]', '--password', '[redacted]', '--api-key', '[redacted]', '--verbose', 'ls', '[redacted]']);
    assert.deepEqual(redactArgv(['--token', '--dry-run', 'a']), ['--token', '--dry-run', 'a'], 'a flag after a secret-named flag is not its value');
    assert.deepEqual(redactArgv(['-p', 'hunter2']), ['-p', 'hunter2'], 'a one-letter flag names nothing: the known limit');
    assert.deepEqual(redactArgv([{ op: 'done' }, 3, 'a']), [{ op: 'done' }, 3, 'a']);
    assert.equal(redactArgv('not an array'), 'not an array');
  });
});

describe('chunkText', () => {
  test('short text is one chunk; blank is none', () => {
    assert.deepEqual(chunkText('hello'), ['hello']);
    assert.deepEqual(chunkText('   '), []);
  });
  test('long text splits at paragraph and sentence breaks, within max, with overlap, covering everything', () => {
    const paras = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} says something about the breaker timeout and the retry policy. It has two sentences.`);
    const text = paras.join('\n\n');
    const chunks = chunkText(text, { max: 400, overlap: 80 });
    assert.ok(chunks.length > 5);
    for (const c of chunks) assert.ok(c.length <= 400, `chunk of ${c.length}`);
    for (const p of paras) assert.ok(chunks.some((c) => c.includes(p)) || chunks.some((c) => p.startsWith(c.slice(0, 20))), p);
    assert.ok(chunks[0].endsWith('sentences.'));
    assert.ok(chunks.at(-1).includes('Paragraph 29'));
  });
  test('a text with no break at all is hard-cut and still terminates', () => {
    const chunks = chunkText('x'.repeat(5000), { max: 1000, overlap: 100 });
    assert.ok(chunks.length >= 5 && chunks.length <= 12);
    assert.ok(chunks.every((c) => c.length <= 1000));
  });
});

describe('vectors', () => {
  test('truncate + normalize: unit length, leading dims kept', () => {
    const v = Array.from({ length: 768 }, (_, i) => (i < 256 ? 2 : 100));
    const t = truncateNormalize(v);
    assert.equal(t.length, DIMS);
    assert.ok(Math.abs(cosine(t, t) - 1) < 1e-6);
    assert.ok(Math.abs(t[0] - 1 / 16) < 1e-6);
    assert.deepEqual([...truncateNormalize(new Array(768).fill(0))].slice(0, 3), [0, 0, 0]);
  });
  test('int8 quantization keeps cosine within 0.01 of float', () => {
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
    for (let n = 0; n < 20; n++) {
      const a = truncateNormalize(Array.from({ length: 768 }, rnd)), b = truncateNormalize(Array.from({ length: 768 }, rnd));
      const qa = quantize(a), qb = quantize(b);
      const exact = cosine(a, b), approx = cosine(dequantize(qa.q, qa.scale), dequantize(qb.q, qb.scale));
      assert.ok(Math.abs(exact - approx) < 0.01, `${exact} vs ${approx}`);
    }
  });
  test('VectorMatrix.topK returns the best k by cosine, in order, and grows', () => {
    const m = new VectorMatrix(4);
    const add = (k, v) => { const { q, scale } = quantize(truncateNormalize(v, 4)); m.add(k, q, scale); };
    add('north', [1, 0, 0, 0]); add('east', [0, 1, 0, 0]); add('ne', [1, 1, 0, 0]); add('south', [-1, 0, 0, 0]);
    for (let i = 0; i < 2000; i++) add(`noise${i}`, [0, 0, 1, (i % 7) - 3]);
    const top = m.topK(truncateNormalize([1, 0.2, 0, 0], 4), 3);
    assert.deepEqual(top.map((x) => x[0]), ['north', 'ne', 'east']);
    assert.ok(top[0][1] > top[1][1] && top[1][1] > top[2][1]);
    m.add('north', new Int8Array(4), 1);   // duplicate key ignored
    assert.equal(m.n, 2004);
    assert.throws(() => m.add('bad', new Int8Array(3), 1), /dims/);
  });
});
