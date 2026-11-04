// `drover transcript` and `drover transcripts`: the CLI front of core/transcript-export.js. A transcript file named
// on this machine is read here with no daemon; anything else pages through the sessions.transcript op (on --host
// when given), so a remote host's transcript reads the same way. Pages are written as they arrive.
import { existsSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import * as tx from './transcript-export.js';

const PAGE = 4 * 1024 * 1024;

/** A sink that writes to --out (owner-only: transcripts hold whatever the tools printed) or stdout. */
function sink(out) {
  if (!out) return { write: (s) => new Promise((r) => (process.stdout.write(s) ? r() : process.stdout.once('drain', r))), end: async () => {} };
  const ws = createWriteStream(out, { mode: 0o600 });
  return { write: (s) => new Promise((r, j) => ws.write(s, (e) => (e ? j(e) : r()))), end: () => new Promise((r) => ws.end(r)) };
}

/** A local transcript file: an existing path ending in .jsonl, unless --host says the id belongs to another machine. */
function localFile(id, host) {
  if (host) return null;
  const f = path.resolve(id.replace(/^~(?=\/|$)/, process.env.HOME ?? ''));
  return f.endsWith('.jsonl') && existsSync(f) ? f : null;
}

async function* filePages(file, { format, callStyle }) {
  const engine = await tx.sniffEngine(file);
  const head = { engine, kind: /\/subagents\/agent-[^/]+\.jsonl$/.test(file) ? 'subagent' : engine === 'codex' ? 'thread' : 'session', id: path.basename(file, '.jsonl'), path: file, format };
  let since = 0;
  for (;;) {
    const r = format === 'raw' ? await tx.readRaw(file, { since, maxBytes: PAGE })
      : await tx.readEntries(file, engine, { format, since, maxBytes: PAGE, callStyle, sidechain: head.kind === 'subagent' });
    yield { ...head, ...r };
    if (!r.more) return;
    since = r.offset;
  }
}

async function* opPages(id, { format, callStyle, host, thread }) {
  const { dispatch } = await import('./api.js');
  let since = 0;
  for (;;) {
    const r = await dispatch('sessions.transcript', { id, format, since, maxBytes: PAGE, ...(format === 'turns' ? {} : { callStyle, as: 'entries' }), ...(host ? { host } : {}), ...(thread ? { thread } : {}) });
    if (format !== 'turns' && r?.format !== format) throw new Error(`${host ?? 'this host'} runs a Drover without transcript formats: update it (git pull in its drover checkout, then restart its daemon)`);
    yield r;
    if (format === 'turns' || !r.more) return;
    since = r.offset;
  }
}

/** Print (or write to out) one session's transcript in a format, every page of it. */
export async function transcriptCli(id, { format = 'messages', brief = false, host, thread, json = false, out } = {}) {
  tx.checkFormat(format);
  const callStyle = brief ? 'brief' : 'input';
  const file = localFile(id, host);
  const pages = file ? filePages(file, { format, callStyle }) : opPages(id, { format, callStyle, host, thread });
  const w = sink(out);
  let about = null, entries = [];
  for await (const p of pages) {
    if (format === 'turns') { await w.write(JSON.stringify(p, null, 2) + '\n'); continue; }
    if (!about) {
      const { entries: _e, jsonl: _j, offset: _o, more: _m, ...rest } = p;
      about = rest;
      if (!json && format !== 'raw') await w.write(`# ${[rest.engine, rest.kind, rest.id, rest.thread ? `thread ${rest.thread}` : null].filter(Boolean).join(' · ')} · ${format}\n\n`);
    }
    if (format === 'raw') await w.write(p.jsonl);
    else if (json) entries.push(...p.entries);
    else if (p.entries.length) await w.write(tx.renderText(p.entries) + '\n');
  }
  if (json && format !== 'raw' && format !== 'turns') await w.write(JSON.stringify({ ...about, entries }, null, 2) + '\n');
  await w.end();
}

const SIZE = (n) => (n == null ? '' : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)}M` : n >= 1024 ? `${Math.round(n / 1024)}K` : `${n}B`);

/** transcripts.list as one line per transcript: when, engine, kind, id, size, and what it is. */
export function formatTranscriptList(r) {
  const rows = (r?.transcripts ?? []).map((t) => {
    const what = t.agentType ? `${t.agentType}: ${t.description ?? ''}` : t.key ?? t.name ?? t.firstPrompt ?? '';
    const size = t.bytes != null ? SIZE(t.bytes) : t.events != null ? `${t.events}ev` : '';
    return [String(t.mtime ?? '').slice(0, 16).replace('T', ' '), t.engine, t.kind, String(t.id), size, String(what).replace(/\s+/g, ' ').slice(0, 90)];
  });
  const w = [0, 1, 2, 3, 4].map((i) => Math.max(0, ...rows.map((x) => x[i].length)));
  const lines = rows.map((x) => x.map((c, i) => (i < 5 ? c.padEnd(w[i]) : c)).join('  ').trimEnd());
  const more = r?.matched != null && r.matched > rows.length ? `\n${r.matched - rows.length} more (--limit, --days, --engine, --kind)` : '';
  return `${lines.join('\n')}${more}\n`;
}
