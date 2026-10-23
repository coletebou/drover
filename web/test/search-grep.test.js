// Raw transcript grep (core/search/grep.js) over synthetic Claude Code and Codex transcripts, with the real
// ripgrep binary (skipped where none is installed): which part of a line matched, the redacted snippet, the
// filters, the caps, and the skips (base64 blobs, matches outside the readable text, temp-directory helper sessions).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { grepTranscripts, findRg, lineParts, grepSnippet } from '../core/search/grep.js';

const rg = findRg();
const j = (o) => JSON.stringify(o) + '\n';
// A made-up token in the shape of a forge's personal access token, assembled at runtime so no credential-looking
// literal is in the source.
const FAKE_BODY = 'a1b2c3d4e5'.repeat(4);
const FAKE_PAT = ['webapp', 'pat', FAKE_BODY].join('_');
const SID = '11111111-2222-3333-4444-555555555555';
// A session whose cwd holds the word, so every line matches somewhere: only the parts a reader sees may answer.
const SID2 = '22222222-3333-4444-5555-666666666666';
const NIMBUS_CWD = '/home/u/code/nimbus-app';
const SID3 = '33333333-4444-5555-6666-777777777777';
const B64_RUN = (word) => `${'A1b2C3d4'.repeat(30)}${word}${'E5f6G7h8'.repeat(30)}`;
const SID4 = '44444444-5555-6666-7777-888888888888';
const SID5 = '55555555-6666-7777-8888-999999999999';
const CODEX2 = '019f7777-1111-72e2-84d4-f6fb9fd90225';
let dir, roots;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'drover-grep-'));
  roots = { claude: path.join(dir, 'projects'), codex: path.join(dir, 'sessions') };
  const proj = path.join(roots.claude, '-home-u-code-webapp');
  await mkdir(path.join(proj, SID, 'subagents'), { recursive: true });
  await writeFile(path.join(proj, `${SID}.jsonl`), [
    j({ type: 'user', timestamp: '2026-04-30T21:31:00Z', cwd: '/home/u/code/webapp', sessionId: SID, message: { content: 'should we try turborepo?' } }),
    j({ type: 'ai-title', sessionId: SID, aiTitle: 'Turborepo trial for the team' }),
    j({ type: 'assistant', timestamp: '2026-04-30T21:49:00Z', cwd: '/home/u/code/webapp', sessionId: SID, message: { content: [{ type: 'thinking', thinking: 'turborepo needs packageManager in 2.x' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls turbo.json' } }] } }),
    j({ type: 'user', timestamp: '2026-04-30T21:50:00Z', cwd: '/home/u/code/webapp', sessionId: SID, message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: `origin https://alice:${FAKE_PAT}@forge.example/repos/webapp/git and turbo.json present` }] }] } }),
    j({ type: 'user', timestamp: '2026-04-30T21:51:00Z', cwd: '/home/u/code/webapp', sessionId: SID, message: { content: [{ type: 'tool_result', content: `data:image/png;base64,${'QUJD'.repeat(40)}turbo${'REVG'.repeat(40)}` }] } }),
  ].join(''));
  await writeFile(path.join(proj, SID, 'subagents', 'agent-a1.jsonl'), j({ type: 'assistant', timestamp: '2026-05-01T10:00:00Z', cwd: '/home/u/code/webapp', message: { content: [{ type: 'text', text: 'Report: turborepo cut the warm build to 153 ms.' }] } }));
  const nimbus = path.join(roots.claude, '-home-u-code-nimbus-app');
  await mkdir(nimbus, { recursive: true });
  const at = (m) => ({ timestamp: `2026-05-02T10:${String(m).padStart(2, '0')}:00Z`, cwd: NIMBUS_CWD, sessionId: SID2 });
  await writeFile(path.join(nimbus, `${SID2}.jsonl`), [
    j({ type: 'user', ...at(0), message: { content: 'deploy the nimbus build' } }),
    j({ type: 'assistant', ...at(1), message: { id: 'msg_01nimbusQ', content: [{ type: 'thinking', thinking: 'plan the next step', signature: `EqQBCkgIBRAB${'Xk3Jq9Zr'.repeat(30)}nimbus${'Pw7Ty2Ls'.repeat(30)}` }] } }),
    j({ type: 'assistant', ...at(2), message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: `${NIMBUS_CWD}/package.json` } }] } }),
    j({ type: 'assistant', ...at(3), message: { content: [{ type: 'tool_use', name: 'Glob', input: { pattern: '**/nimbus*.ts' } }] } }),
    j({ type: 'user', ...at(4), message: { content: [{ type: 'tool_result', content: 'File created successfully at: /home/u/code/x/notes.md' }] }, toolUseResult: { type: 'create', filePath: '/home/u/code/x/notes.md', content: '# Notes\nthe nimbus cache lives in /var/cache' } }),
    j({ type: 'user', ...at(5), message: { content: [{ type: 'tool_result', content: `${NIMBUS_CWD}/dist` }] } }),
    j({ type: 'user', ...at(6), message: { content: [{ type: 'tool_result', content: `iVBORw0KGgo${'A1b2C3d4'.repeat(30)}nimbus${'E5f6G7h8'.repeat(30)}` }] } }),
    j({ type: 'assistant', ...at(7), message: { content: [{ type: 'text', text: 'done' }] } }),
  ].join(''));
  // Lines where the first candidate is a chance match in base64 and a readable one comes after it.
  const misc = path.join(roots.claude, '-home-u-code-misc');
  await mkdir(misc, { recursive: true });
  const at3 = (m) => ({ timestamp: `2026-05-03T10:${String(m).padStart(2, '0')}:00Z`, cwd: '/home/u/code/misc', sessionId: SID3 });
  await writeFile(path.join(misc, `${SID3}.jsonl`), [
    j({ type: 'user', ...at3(0), message: { content: [{ type: 'tool_result', content: `blob ${B64_RUN('zephyr')} then quokka ok` }] } }),
    j({ type: 'user', ...at3(1), message: { content: [{ type: 'tool_result', content: B64_RUN('zephyr') }] }, toolUseResult: { stdout: 'zephyr finished cleanly', stderr: '' } }),
    j({ type: 'user', ...at3(2), message: { content: 'she said "kestrel time" twice' } }),
    j({ type: 'user', ...at3(3), message: { content: 'path C:\\Users\\kestrel\\notes' } }),
  ].join(''));
  // A cwd that holds a whole word "go": where ripgrep matched decides, not a substring found elsewhere.
  const repos = path.join(roots.claude, '-repos-go');
  await mkdir(repos, { recursive: true });
  const at4 = (m) => ({ timestamp: `2026-05-04T10:${String(m).padStart(2, '0')}:00Z`, cwd: '/repos/go', sessionId: SID4 });
  await writeFile(path.join(repos, `${SID4}.jsonl`), [
    j({ type: 'user', ...at4(0), message: { content: 'going home' } }),
    j({ type: 'user', ...at4(1), message: { content: `going ${'x '.repeat(200)}go now` } }),
    j({ type: 'assistant', ...at4(2), message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cat gopher.txt; go build ./...' } }] } }),
    j({ type: 'user', ...at4(3), message: { content: `${'é'.repeat(300)} then wren here` } }),
    j({ type: 'user', ...at4(4), message: { content: `${'"q"\n'.repeat(100)}finch end` } }),
    // Written by hand: 1.0 is a spelling JSON.stringify does not reproduce, so this input cannot be placed in the line.
    `{"type":"assistant","timestamp":"2026-05-04T10:05:00Z","cwd":"/repos/go","sessionId":"${SID4}","message":{"content":[{"type":"tool_use","name":"X","input":{"t":1.0,"q":"heron call"}}]}}\n`,
  ].join(''));
  // Four matches in a row, oldest first as a transcript is written; a quoted shell command in a Claude tool call.
  const shore = path.join(roots.claude, '-home-u-code-shore');
  await mkdir(shore, { recursive: true });
  const at5 = (m) => ({ timestamp: `2026-05-05T10:${String(m).padStart(2, '0')}:00Z`, cwd: '/home/u/code/shore', sessionId: SID5 });
  await writeFile(path.join(shore, `${SID5}.jsonl`), [
    ...[1, 2, 3, 4].map((n) => j({ type: 'user', ...at5(n), message: { content: `sandpiper ${n}` } })),
    j({ type: 'assistant', ...at5(5), message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo "hello plover"' } }] } }),
  ].join(''));
  // Codex tool arguments are JSON inside a JSON string: a quote there is \\\" in the line.
  const day2 = path.join(roots.codex, '2026', '07', '16');
  await mkdir(day2, { recursive: true });
  await writeFile(path.join(day2, `rollout-2026-07-16T09-00-00-${CODEX2}.jsonl`), [
    j({ type: 'session_meta', payload: { id: CODEX2, cwd: '/Users/c/code/shore' } }),
    j({ type: 'response_item', timestamp: '2026-07-16T09:01:00Z', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'echo "hello plover"' }) } }),
    j({ type: 'response_item', timestamp: '2026-07-16T09:02:00Z', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'type C:\\temp\\plover.txt' }) } }),
  ].join(''));
  const tmpProj = path.join(roots.claude, '-private-tmp-reflector-x');
  await mkdir(tmpProj, { recursive: true });
  await writeFile(path.join(tmpProj, 'cccccccc-2222-3333-4444-555555555555.jsonl'), j({ type: 'user', timestamp: '2026-05-01T00:00:00Z', message: { content: 'You are writing the durable reflection of one AI session: turborepo' } }));
  const day = path.join(roots.codex, '2026', '07', '15');
  await mkdir(day, { recursive: true });
  await writeFile(path.join(day, 'rollout-2026-07-15T11-47-57-019f6676-9ea7-71e1-83d3-e5ea8fc80114.jsonl'), [
    j({ type: 'session_meta', payload: { id: '019f6676-9ea7-71e1-83d3-e5ea8fc80114', cwd: '/Users/c/code/webapp' } }),
    j({ type: 'response_item', timestamp: '2026-07-15T15:48:00Z', payload: { type: 'message', role: 'user', content: [{ text: 'what will the typescript port to go actually speed up for webapp?' }] } }),
    j({ type: 'event_msg', timestamp: '2026-07-15T15:48:00Z', payload: { type: 'user_message', message: 'what will the typescript port to go actually speed up for webapp?' } }),
    j({ type: 'response_item', timestamp: '2026-07-15T15:49:00Z', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'rg -n typescript package.json' }) } }),
    j({ type: 'response_item', timestamp: '2026-07-15T15:49:01Z', payload: { type: 'function_call_output', output: '"typescript": "5.9.3"' } }),
  ].join(''));
});
after(async () => { await rm(dir, { recursive: true, force: true }); });

describe('lineParts and snippets', () => {
  test('a Claude line splits into its text, thinking, tool calls and results; a Codex event_msg gives nothing', () => {
    const parts = lineParts({ type: 'assistant', message: { content: [{ type: 'text', text: 'a' }, { type: 'thinking', thinking: 'b' }, { type: 'tool_use', name: 'Bash', input: { command: 'c' } }] } }, 'claude');
    assert.deepEqual(parts.map((p) => p.role), ['assistant', 'thinking', 'tool_use']); assert.equal(parts[2].tool, 'Bash');
    assert.deepEqual(lineParts({ type: 'event_msg', payload: {} }, 'codex'), []);
    assert.equal(lineParts({ type: 'response_item', payload: { type: 'function_call_output', output: 'x' } }, 'codex')[0].role, 'tool_result');
  });
  test('a Claude tool result line also carries the whole result Claude Code keeps beside it, after the message parts', () => {
    const parts = lineParts({ type: 'user', message: { content: [{ type: 'tool_result', content: 'File created' }] }, toolUseResult: { type: 'create', filePath: '/x/notes.md', content: 'the nimbus cache', numLines: 1 } }, 'claude');
    assert.deepEqual(parts.map((p) => p.role), ['tool_result', 'tool_result']);
    assert.equal(parts[1].text, 'create\n/x/notes.md\nthe nimbus cache');
  });
  test('a match only inside base64 gives no snippet; a readable one after it is the one shown', () => {
    const b64 = `${'A1b2C3d4'.repeat(30)}turbo${'E5f6G7h8'.repeat(30)}`;
    assert.equal(grepSnippet(`data:image/png;base64,${b64}`, 'turbo'), '');
    assert.match(grepSnippet(`<img src="data:image/png;base64,${b64}"> then turbo.json in the text`, 'turbo'), /then turbo\.json in the text/);
    assert.match(grepSnippet('{"file_path":"/home/u/code/webapp/turbo.json"}', 'turbo'), /turbo\.json/, 'JSON with no space is not a blob');
    assert.match(grepSnippet(`x ${'QUJD'.repeat(60)}turbo${'REVG'.repeat(60)} y turbo.json here`, 'turbo'), /y turbo\.json here/, 'centred on the readable one, though the redactor left the digit-free run');
    const long = 'abcdefghij'.repeat(21);
    assert.match(grepSnippet(`the value was ${long} as shown`, long), /the value was abcdefghij/, 'a long needle does not match by chance, even inside a run');
  });
  test('a redacted match keeps the snippet on itself, not on a later copy the redactor left in base64', () => {
    const s = grepSnippet(`read /a/b/1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c/turbo.txt then data:image/png;base64,${'QUJD'.repeat(60)}turbo${'REVG'.repeat(60)} end`, 'turbo');
    assert.match(s, /^read \[redacted\]\.txt then/);
  });
  test('positions hold where lowercasing changes the length (İ lowercases to two characters)', () => {
    assert.match(grepSnippet(`${'İ '.repeat(200)}then turbo here ${'z '.repeat(400)}`, 'turbo'), /then turbo here/);
  });
  test('a match the redactor hides still centres the snippet where it was', () => {
    const s = grepSnippet(`${'x '.repeat(1500)}read /a/b/1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c/notes.txt ${'y '.repeat(300)}`, '1b2c3d4e');
    assert.match(s, /read \[redacted\]\.txt/); assert.doesNotMatch(s, /1b2c3d4e/);
  });
  test('redaction sees the whole label: a window that starts between "Bearer" and its value still hides the value', () => {
    const tok = 'Zx9Qw8Er7Ty6';
    const s = grepSnippet(`${'x '.repeat(200)}Authorization: Bearer ${tok} ${'y'.repeat(140)} needle here`, 'needle');
    assert.match(s, /needle/); assert.doesNotMatch(s, new RegExp(tok));
  });
  test('the snippet sits around the match, on one line, with secrets redacted', () => {
    const s = grepSnippet(`${'x '.repeat(300)}token ${FAKE_PAT} here turbo.json ${'y '.repeat(300)}`, 'turbo.json');
    assert.match(s, /^….*turbo\.json.*…$/); assert.doesNotMatch(s, new RegExp(FAKE_BODY));
  });
});

describe('grepTranscripts', { skip: rg ? false : 'ripgrep is not installed' }, () => {
  test('finds a literal in every part of a transcript and says which part matched', async () => {
    const r = await grepTranscripts({ pattern: 'turbo', perSession: 10 }, { roots, rg });
    const roles = r.results.filter((x) => x.sessionId === SID).map((x) => `${x.kind}:${x.role}${x.tool ? `:${x.tool}` : ''}`).sort();
    assert.deepEqual(roles, ['claude:meta', 'claude:thinking', 'claude:tool_result', 'claude:user', 'subagent:assistant'], 'the ai-title line is a meta hit');
    const tr = r.results.find((x) => x.role === 'tool_result');
    assert.doesNotMatch(tr.snippet, new RegExp(FAKE_BODY), 'the PAT in the tool output is redacted');
    assert.equal(tr.project, 'webapp'); assert.equal(tr.line, 4);
    assert.ok(r.skipped.blob >= 1, 'a base64 blob that happens to contain the word is skipped');
    assert.ok(!r.results.some((x) => /durable reflection/.test(x.snippet)), 'helper sessions in temp directories are skipped');
    assert.deepEqual(r.results.map((x) => x.ts), [...r.results.map((x) => x.ts)].sort((a, b) => String(b ?? '').localeCompare(String(a ?? ''))), 'newest first, untimed last');
  });
  test('tool calls match on their input (a Bash command, a Codex exec_command), and Codex hits carry the rollout cwd', async () => {
    const r = await grepTranscripts({ pattern: 'ls turbo.json' }, { roots, rg });
    assert.equal(r.results[0].role, 'tool_use'); assert.equal(r.results[0].tool, 'Bash');
    const c = await grepTranscripts({ pattern: 'typescript', kinds: ['codex'], perSession: 10 }, { roots, rg });
    assert.deepEqual(c.results.map((x) => x.role).sort(), ['tool_result', 'tool_use', 'user'], 'the event_msg copy is not a second hit');
    assert.ok(c.results.every((x) => x.project === 'webapp' && x.sessionId === '019f6676-9ea7-71e1-83d3-e5ea8fc80114'));
  });
  test('filters: roles, kinds, days, project; caps: perSession and limit (truncated says more matched)', async () => {
    assert.deepEqual((await grepTranscripts({ pattern: 'turbo', roles: ['tool_result'] }, { roots, rg })).results.map((x) => x.role), ['tool_result']);
    const tu = await grepTranscripts({ pattern: 'turbo', roles: ['tool_use'] }, { roots, rg });
    assert.deepEqual(tu.results.map((x) => `${x.role}:${x.tool}`), ['tool_use:Bash'], 'the tool call is found though the thinking before it matches too');
    assert.ok((await grepTranscripts({ pattern: 'turbo', kinds: ['subagent'] }, { roots, rg })).results.every((x) => x.kind === 'subagent'));
    assert.equal((await grepTranscripts({ pattern: 'turbo', days: 1 }, { roots, rg })).results.length, 0, 'old lines, and untimed ones (ai-title), fail a days filter');
    assert.equal((await grepTranscripts({ pattern: 'typescript', project: 'billing' }, { roots, rg })).results.length, 0);
    const capped = await grepTranscripts({ pattern: 'turbo', perSession: 1 }, { roots, rg });
    assert.equal(capped.results.filter((x) => x.sessionId === SID).length, 1, 'a subagent shares its parent session\'s cap, as in search.semantic');
    const lim = await grepTranscripts({ pattern: 'turbo', limit: 1 }, { roots, rg });
    assert.equal(lim.results.length, 1); assert.equal(lim.truncated, true);
  });
  test('a hit always shows its match: tool calls and output with no spaces count; ids, signatures, the envelope and base64 do not', async () => {
    const r = await grepTranscripts({ pattern: 'nimbus', perSession: 20 }, { roots, rg });
    const mine = r.results.filter((x) => x.sessionId === SID2);
    assert.deepEqual(mine.map((x) => `${x.role}${x.tool ? `:${x.tool}` : ''}`).sort(), ['tool_result', 'tool_result', 'tool_use:Glob', 'tool_use:Read', 'user'], 'Read and Glob inputs and a one-path tool output are hits, not blobs');
    assert.ok(mine.every((x) => /nimbus/i.test(x.snippet)), 'no hit shows text without its match');
    assert.match(mine.find((x) => x.line === 5).snippet, /the nimbus cache lives/, 'a match only in the kept tool result answers from it');
    assert.equal(r.skipped.outside, 2, 'the thinking signature and message id line, and the line matching only by cwd');
    assert.equal(r.skipped.blob, 1, 'base64 with digits in it is still a blob');
  });
  test('regex mode answers from whichever match a part holds, not only the first one in the line', async () => {
    const r = await grepTranscripts({ pattern: 'nimbus-app|nimbus cache', regex: true, perSession: 20 }, { roots, rg });
    const hit = r.results.find((x) => x.sessionId === SID2 && x.line === 5);
    assert.ok(hit, 'the first match is the cwd, the second the written file'); assert.match(hit.snippet, /nimbus cache/);
  });
  test('a greedy regex runs past the end of its JSON string; the hit still comes from the text it started in', async () => {
    const r = await grepTranscripts({ pattern: 'nimbus build.*', regex: true }, { roots, rg });
    const hit = r.results.find((x) => x.sessionId === SID2);
    assert.ok(hit, 'the raw match takes the closing quote and the rest of the line'); assert.equal(hit.role, 'user'); assert.match(hit.snippet, /deploy the nimbus build/);
  });
  test('a chance match in base64 gives way to a readable one: another match in the part, or the kept tool result', async () => {
    const alt = await grepTranscripts({ pattern: 'zephyr|quokka', regex: true }, { roots, rg });
    assert.match(alt.results.find((x) => x.sessionId === SID3 && x.line === 1)?.snippet ?? '', /then quokka ok/);
    const kept = await grepTranscripts({ pattern: 'zephyr' }, { roots, rg });
    assert.deepEqual(kept.results.filter((x) => x.sessionId === SID3).map((x) => `${x.line}:${x.snippet}`), ['2:zephyr finished cleanly']);
    assert.equal(kept.skipped.blob, 1, 'line 1 only has it inside base64');
  });
  test('a fixed string with quotes or backslashes matches the text, where the JSON line escapes them', async () => {
    assert.deepEqual((await grepTranscripts({ pattern: 'said "kestrel time"' }, { roots, rg })).results.map((x) => x.snippet), ['she said "kestrel time" twice']);
    assert.deepEqual((await grepTranscripts({ pattern: 'C:\\Users\\kestrel' }, { roots, rg })).results.map((x) => x.snippet), ['path C:\\Users\\kestrel\\notes']);
  });
  test('a regex hit is where ripgrep matched: \\bgo\\b in the cwd is not "going" in the text', async () => {
    const r = await grepTranscripts({ pattern: '\\bgo\\b', regex: true, perSession: 10 }, { roots, rg });
    const mine = r.results.filter((x) => x.sessionId === SID4);
    assert.deepEqual(mine.map((x) => `${x.line}:${x.role}`).sort(), ['2:user', '3:tool_use'], 'line 1 only says "going"');
    const two = mine.find((x) => x.line === 2).snippet;
    assert.match(two, /go now/); assert.doesNotMatch(two, /going/, 'centred on the word that matched, not on "going" before it');
    assert.match(mine.find((x) => x.line === 3).snippet, /go build/);
  });
  test('placing a match counts characters, not bytes, and reads escapes; a value that cannot be placed is still found', async () => {
    const one = async (pattern) => (await grepTranscripts({ pattern }, { roots, rg })).results.filter((x) => x.sessionId === SID4).map((x) => x.snippet);
    assert.match((await one('wren')).join(), /then wren here/, '300 two-byte characters before it');
    assert.match((await one('finch')).join(), /"q" "q" finch end/, '100 escaped quotes and newlines before it');
    assert.match((await one('heron')).join(), /heron call/);
  });
  test('past the per-session cap a session shows its newest matches, not its first ones', async () => {
    const r = await grepTranscripts({ pattern: 'sandpiper' }, { roots, rg });
    assert.deepEqual(r.results.filter((x) => x.sessionId === SID5).map((x) => x.snippet), ['sandpiper 4', 'sandpiper 3', 'sandpiper 2']);
    assert.equal(r.skipped.capped, 1);
  });
  test('a quoted command is found in a Claude tool call and in a Codex one, whose arguments are JSON in a JSON string', async () => {
    const r = await grepTranscripts({ pattern: 'echo "hello plover"' }, { roots, rg });
    assert.deepEqual(r.results.map((x) => `${x.kind}:${x.tool}`).sort(), ['claude:Bash', 'codex:exec_command']);
    assert.ok(r.results.every((x) => /hello plover/.test(x.snippet)));
    const win = await grepTranscripts({ pattern: 'C:\\temp\\plover.txt' }, { roots, rg });
    assert.deepEqual(win.results.map((x) => `${x.kind}:${x.line}`), ['codex:3'], 'a Windows path at the second depth');
  });
  test('with only env given, the roots and ripgrep come from that env', async () => {
    const home = path.join(dir, 'home');
    await mkdir(path.join(home, '.claude'), { recursive: true });
    const { symlink } = await import('node:fs/promises');
    await symlink(roots.claude, path.join(home, '.claude', 'projects')).catch(() => {});
    const r = await grepTranscripts({ pattern: 'warm build to 153' }, { env: { HOME: home, PATH: path.dirname(rg) } });
    assert.equal(r.results.length, 1); assert.equal(r.results[0].kind, 'subagent');
  });
  test('a file that reaches the per-file match cap is reported, not passed off as complete', async () => {
    const big = path.join(roots.claude, '-home-u-code-big');
    await mkdir(big, { recursive: true });
    await writeFile(path.join(big, 'dddddddd-2222-3333-4444-555555555555.jsonl'), Array.from({ length: 205 }, (_, i) => j({ type: 'user', timestamp: `2026-06-01T00:${String(i % 60).padStart(2, '0')}:00Z`, cwd: '/home/u/code/big', message: { content: `capword line ${i}` } })).join(''));
    const r = await grepTranscripts({ pattern: 'capword', limit: 5 }, { roots, rg });
    assert.equal(r.truncated, true);
    const all = await grepTranscripts({ pattern: 'capword', limit: 200, perSession: 50, roles: ['assistant'] }, { roots, rg });
    assert.equal(all.results.length, 0); assert.equal(all.truncated, true); assert.match(all.notes.join(' '), /200-match cap per file/);
  });
  test('regex mode, case sensitivity, and bad input', async () => {
    assert.ok((await grepTranscripts({ pattern: 'turbo(repo)?\\.json', regex: true }, { roots, rg })).results.length >= 1);
    assert.equal((await grepTranscripts({ pattern: 'TURBOREPO', caseSensitive: true }, { roots, rg })).results.length, 0);
    await assert.rejects(grepTranscripts({ pattern: 'x' }, { roots, rg }), /2 to 300/);
    await assert.rejects(grepTranscripts({ pattern: 'turbo' }, { roots, rg: null }), /ripgrep/);
  });
});
