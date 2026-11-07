#!/usr/bin/env node
// A stand-in for the imsg CLI (test/ask-imessage.test.js): `imsg account` prints FAKE_IMSG_ACCOUNT; `imsg rpc --json`
// speaks imsg's JSON-RPC on stdio (watch.subscribe, send), logs every request to FAKE_IMSG_LOG, and turns each new
// line of FAKE_IMSG_INBOX into a {method: "message", params: {message}} notification. Synthetic data only.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const [cmd] = process.argv.slice(2);
if (cmd === 'account') { process.stdout.write(process.env.FAKE_IMSG_ACCOUNT ?? 'Account: drover@example.com\n'); process.exit(0); }
if (cmd !== 'rpc') { process.stderr.write(`fake imsg: unknown command ${cmd}\n`); process.exit(2); }

const log = (o) => { if (process.env.FAKE_IMSG_LOG) appendFileSync(process.env.FAKE_IMSG_LOG, JSON.stringify(o) + '\n'); };
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let rowid = 1000, seen = 0, subscribed = false;
// FAKE_IMSG_SUBSCRIBE_FAIL names a file: while it exists, watch.subscribe fails.
const require0 = () => existsSync(process.env.FAKE_IMSG_SUBSCRIBE_FAIL);
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    log({ method: req.method, params: req.params });
    if (req.method === 'watch.subscribe' && process.env.FAKE_IMSG_SUBSCRIBE_FAIL && require0()) out({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'database not readable (Full Disk Access)' } });
    else if (req.method === 'watch.subscribe') { subscribed = true; out({ id: req.id, result: { subscription: 1 }, jsonrpc: '2.0' }); }
    else if (req.method === 'send') { rowid++; out({ jsonrpc: '2.0', id: req.id, result: { ok: true, rowid, guid: `FAKE-GUID-${rowid}` } }); }
    else out({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found', data: req.method } });
  }
});
process.stdin.on('end', () => process.exit(0));
setInterval(() => {
  const f = process.env.FAKE_IMSG_INBOX;
  if (!subscribed || !f || !existsSync(f)) return;
  const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean);
  for (const l of lines.slice(seen)) out({ jsonrpc: '2.0', method: 'message', params: { message: JSON.parse(l) } });
  seen = lines.length;
}, 40);
