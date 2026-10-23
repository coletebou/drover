// A pretend Claude Code session for the dev world (test/devworld.js), run inside a pane of a private tmux server.
// It draws what Claude Code draws (a permission dialog, an AskUserQuestion selector, a busy spinner, the idle
// prompt), keeps its registry entry (~/.claude/sessions/<pid>.json in the dev world's CLAUDE_CONFIG_DIR) and its
// transcript current, answers keys the way the real one does, and reads its inbox socket: a message arrives as
// a peer turn and gets a reply with a tool call, so a chat updates live. Synthetic text only.
//   node test/fake-agent.js --mode dialog|question|busy|idle --name demo-build --sid <uuid> --dir <devworld dir>
import { appendFileSync, mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const MODE = arg('mode', 'idle'), NAME = arg('name', 'demo'), SID = arg('sid', randomUUID()), DIR = arg('dir', process.cwd());
const RESHOW_MS = Number(arg('reshow', 12_000));
const CLAUDE = path.join(DIR, 'claude');
const CWD = path.join(DIR, 'work', NAME);
mkdirSync(CWD, { recursive: true });
const TRANSCRIPT = path.join(CLAUDE, 'projects', CWD.replace(/[\\/:]/g, '-'), `${SID}.jsonl`);
mkdirSync(path.dirname(TRANSCRIPT), { recursive: true });
const SOCKET = path.join(DIR, 'socks', `${process.pid}.sock`);
mkdirSync(path.dirname(SOCKET), { recursive: true });
const REGISTRY = path.join(CLAUDE, 'sessions', `${process.pid}.json`);
mkdirSync(path.dirname(REGISTRY), { recursive: true });
const where = (() => { try { return execFileSync('tmux', ['display-message', '-p', '-t', process.env.TMUX_PANE ?? '', '#{session_name}:#{window_id}.#{pane_id}'], { encoding: 'utf8' }).trim(); } catch { return null; } })();

let status = MODE === 'busy' ? 'busy' : 'idle', screen = MODE, startedAt = Date.now(), pendingTool = null, selected = 0, spin = 0;
const write = (o) => appendFileSync(TRANSCRIPT, JSON.stringify({ sessionId: SID, cwd: CWD, version: '2.1.304', timestamp: new Date().toISOString(), uuid: randomUUID(), ...o }) + '\n');
const user = (content, extra = {}) => write({ type: 'user', message: { role: 'user', content }, ...extra });
const said = (text) => write({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }] } });
const call = (name, input) => { const id = `toolu_dev_${randomUUID().slice(0, 12)}`; write({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name, input }] } }); return id; };
const result = (id, content, isError = false) => user([{ type: 'tool_result', tool_use_id: id, content, is_error: isError }]);
function registry() {
  writeFileSync(REGISTRY, JSON.stringify({ pid: process.pid, sessionId: SID, cwd: CWD, name: NAME, nameSource: 'derived', status, kind: 'interactive', entrypoint: 'cli', version: '2.1.304', peerProtocol: 1, startedAt, updatedAt: Date.now(), statusUpdatedAt: Date.now(), tmux: where, messagingSocketPath: SOCKET }));
}
const setStatus = (s) => { status = s; registry(); };

// ------------------------------------------------------------ screens
const W = () => Math.max(60, Math.min(process.stdout.columns || 100, 140));
const rule = () => '─'.repeat(W() - 2);
let runs = 0;   // each appearance of a dialog differs (its run number), so each raises its own alert with its own hash
const PERMISSION = [' Bash command', '', '   npm test', '   Run the unit tests', '', ' Do you want to proceed?', ' ❯ 1. Yes', "   2. Yes, and don't ask again for npm test commands in this project", '   3. No, and tell Claude what to do differently (esc)', '', ' Esc to cancel'];
const QUESTION = [' ☐ Fixtures', '', ' Should the review cover the test fixtures too?', '', ' ❯ 1. Yes, all of them (Recommended)', '     Review every fixture file under test/fixtures', '   2. Only the new ones', '   3. No, skip fixtures', '   4. Type something.', '', ' Enter to select · ↑/↓ to navigate · Esc to cancel'];
function draw() {
  const out = ['\x1b[2J\x1b[H', `⏺ ${NAME}: working in ${CWD.replace(process.env.HOME ?? '\0', '~')}`, ''];
  if (screen === 'dialog' || screen === 'question') {
    const lines = (screen === 'dialog' ? PERMISSION : QUESTION).map((l) => l.replace(/^   npm test$/, `   npm test   # run ${runs}`).replace(/^ Should the review cover the test fixtures too\?$/, ` Should the review cover the test fixtures too (ask ${runs})?`)).map((l) => l.replace(/^ ( *)(❯ |  )(\d)\./, (m, sp, mark, n) => ` ${sp}${Number(n) - 1 === selected ? '❯ ' : '  '}${n}.`));
    // As Claude Code draws a dialog: a rule above, the lines flush left, no side borders.
    out.push(rule(), ...lines);
  } else if (screen === 'busy') {
    out.push('⏺ Bash(npm run build)', '  ⎿  compiling 14 modules', '', `${'✻✳✢·'[spin % 4]} Compiling the parser… (${Math.round((Date.now() - startedAt) / 1000)}s · esc to interrupt)`);
  } else {
    out.push('Done. The parser builds and the tests pass.', '', `╭${rule()}╮`, `│ > ${' '.repeat(W() - 6)}│`, `╰${rule()}╯`, '  ? for shortcuts                                             bypass permissions on');
  }
  process.stdout.write(out.join('\r\n'));
}

// ------------------------------------------------------------ behavior
function ask() {
  selected = 0; runs++;
  if (MODE === 'dialog') pendingTool = call('Bash', { command: 'npm test', description: 'Run the unit tests' });
  else pendingTool = call('AskUserQuestion', { questions: [{ question: 'Should the review cover the test fixtures too?', header: 'Fixtures', options: [{ label: 'Yes, all of them (Recommended)' }, { label: 'Only the new ones' }, { label: 'No, skip fixtures' }] }] });
  screen = MODE; setStatus('idle'); draw();
}
function answered(choice) {
  if (!pendingTool) return;
  const id = pendingTool; pendingTool = null;
  if (choice === 'esc') { result(id, 'The user doesn\'t want to proceed with this tool use. The tool use was rejected.', true); said('Understood, I did not run it. Tell me what to do instead.'); }
  else if (MODE === 'dialog') { result(id, `> demo@1.0.0 test\n> node --test\n\n✔ parser handles empty input\n✔ parser keeps line numbers\nℹ tests 2\nℹ pass 2\nℹ fail 0\n(answered with option ${choice})`); said(`The tests pass (option ${choice}). Next I will wire the parser into the CLI.`); }
  else { result(id, `User answered: ${['Yes, all of them', 'Only the new ones', 'No, skip fixtures'][choice - 1] ?? choice}`); said(`Thanks, covering ${choice === 1 ? 'every fixture' : choice === 2 ? 'only the new fixtures' : 'no fixtures'}.`); }
  screen = 'idle'; setStatus('idle'); draw();
  setTimeout(ask, RESHOW_MS);   // the dialog comes back, so a client can be tried again
}
process.stdin.setRawMode?.(true);
process.stdin.on('data', (b) => {
  const k = b.toString('utf8');
  if (screen !== 'dialog' && screen !== 'question') return;
  const count = MODE === 'dialog' ? 3 : 4;
  if (/^[1-9]$/.test(k) && Number(k) <= count) answered(Number(k));
  else if (k === '\r' || k === '\n') answered(selected + 1);
  else if (k === '\x1b') answered('esc');
  else if (k === '\x1b[A') { selected = (selected + count - 1) % count; draw(); }
  else if (k === '\x1b[B') { selected = (selected + 1) % count; draw(); }
});

// The inbox: newline JSON frames (auth, then user), as Claude Code takes them (core/claude.js sendToSession).
if (existsSync(SOCKET)) unlinkSync(SOCKET);
createServer((sock) => {
  let buf = '';
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let f; try { f = JSON.parse(line); } catch { continue; }
      if (f.type !== 'user') continue;
      const content = String(f.message?.content ?? '');
      const m = content.match(/^<cross-session-message([^>]*)>\n?([\s\S]*?)\n?<\/cross-session-message>$/);
      const body = m ? m[2] : content;
      const from = m?.[1].match(/from-name="([^"]*)"/)?.[1] ?? 'unknown';
      user(`Another Claude session sent a message:\n${content}`, { isMeta: true, origin: { kind: 'peer', from: 'unknown', name: from, body } });
      setStatus('busy'); screen = 'busy'; draw();
      setTimeout(() => {
        const id = call('Bash', { command: `echo ${JSON.stringify(body.slice(0, 40))}`, description: 'Echo the message' });
        result(id, body.slice(0, 200));
        said(`Got it: ${body}`);
        screen = MODE === 'busy' ? 'busy' : 'idle'; setStatus(MODE === 'busy' ? 'busy' : 'idle'); draw();
      }, 1500);
    }
  });
}).listen(SOCKET);

registry();
if (MODE === 'dialog' || MODE === 'question') ask();
else draw();
if (MODE === 'busy') {
  setInterval(() => { spin++; draw(); }, 1000);
  let step = 0;
  setInterval(() => {   // a working session: a tool call and its result every few seconds
    const files = ['src/parser.js', 'src/lexer.js', 'test/parser.test.js'];
    const id = step % 3 === 0 ? call('Read', { file_path: path.join(CWD, files[step % 3]) }) : step % 3 === 1 ? call('Grep', { pattern: 'tokenize', path: 'src' }) : call('Bash', { command: 'npm run build', description: 'Build the parser' });
    result(id, step % 3 === 2 && step % 2 ? 'src/parser.js:41: SyntaxError: Unexpected token' : `${files[step % 3]}: ${40 + step} lines`, step % 3 === 2 && step % 2 === 1);
    step++;
  }, 6000);
}
process.on('SIGTERM', () => { try { unlinkSync(REGISTRY); } catch { /* gone */ } process.exit(0); });
