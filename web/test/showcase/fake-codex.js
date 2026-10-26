#!/usr/bin/env node
// codex for the dev world (test/devworld.js). `codex app-server` speaks the JSON-RPC the daemon uses (core/codex.js):
// initialize, thread/list, thread/loaded/list and thread/read, answered from the pretend threads in
// $CODEX_HOME/showcase-threads.json (none, except in the showcase world; their transcripts are rollout files under
// $CODEX_HOME/sessions, which the daemon reads itself). `codex app-server daemon version` and `codex debug models`
// answer too; anything else, a turn or a queued message included, fails with a note: the threads only look alive.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const VERSION = '0.163.0';
const args = process.argv.slice(2);
const threads = () => { try { return JSON.parse(readFileSync(path.join(process.env.CODEX_HOME, 'showcase-threads.json'), 'utf8')); } catch { return []; } };

if (args[0] === 'app-server' && args[1] === 'daemon') { process.stdout.write(`${VERSION}\n`); process.exit(0); }
if (args[0] === '--version') { process.stdout.write(`codex-cli ${VERSION}\n`); process.exit(0); }
if (args[0] === 'debug' && args[1] === 'models') {
  const levels = (l) => l.map((effort) => ({ effort }));
  process.stdout.write(JSON.stringify({ models: [
    { slug: 'gpt-5.5', supported_reasoning_levels: levels(['low', 'medium', 'high', 'xhigh']) },
    { slug: 'gpt-5.5-codex', supported_reasoning_levels: levels(['low', 'medium', 'high', 'xhigh', 'max']) },
  ] }));
  process.exit(0);
}
if (args[0] !== 'app-server') { process.stderr.write(`codex ${args.join(' ')}: not part of the showcase world\n`); process.exit(1); }

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const fail = (id, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message } }) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;   // a notification (initialized)
  const all = threads();
  switch (m.method) {
    case 'initialize': return reply(m.id, { userAgent: `codex_cli_rs/${VERSION} (showcase)` });
    case 'thread/list': return reply(m.id, { data: all.map(({ items, loaded, ...t }) => t) });
    case 'thread/loaded/list': return reply(m.id, { data: all.filter((t) => t.loaded).map((t) => t.id) });
    case 'thread/read': {
      const t = all.find((x) => x.id === m.params?.threadId);
      return t ? reply(m.id, { thread: { id: t.id, turns: [{ id: 'turn-1', items: t.items ?? [] }] } }) : fail(m.id, 'thread not found');
    }
    default: return fail(m.id, `${m.method} is not part of the showcase world`);
  }
});
