#!/usr/bin/env node
// docker for the dev world (test/devworld.js), pinned with DROVER_DOCKER: it answers the calls core/docker.js makes
// from the containers in $DEVWORLD_CONTAINERS (none, except in the showcase world), one `docker container inspect`
// line each (the shape INSPECT_FORMAT prints, as in test/fixtures/docker-inspect.jsonl). ps, inspect, image inspect,
// version and logs answer; restart and start only print the ids; anything else fails: nothing runs.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const containers = (() => { try { return readFileSync(process.env.DEVWORLD_CONTAINERS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } })();
const PROJECT = 'com.docker.compose.project';
const WITH_VALUE = new Set(['--format', '--filter', '--tail', '--since', '--timeout']);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
/** The arguments from index `from` on that are neither a flag nor a flag's value. */
const operands = (from) => { const o = []; for (let i = from; i < args.length; i++) { if (WITH_VALUE.has(args[i])) i++; else if (!args[i].startsWith('-')) o.push(args[i]); } return o; };
const byId = (id) => containers.find((c) => c.id === id || c.id.startsWith(id) || c.name === `/${id}`);
const out = (lines) => { if (lines.length) process.stdout.write(lines.join('\n') + '\n'); process.exit(0); };

switch (args[0]) {
  case 'version': out(['29.6.1']); break;
  case 'ps': {
    const filter = flag('--filter')?.match(/^label=([^=]+)=(.*)$/);
    const list = filter ? containers.filter((c) => c.labels?.[filter[1]] === filter[2]) : containers;
    out(list.map((c) => (/\.Label/.test(flag('--format') ?? '') ? c.labels?.[PROJECT] ?? '' : c.id)));
    break;
  }
  case 'container': case 'inspect': {
    const ids = operands(args[0] === 'container' ? 2 : 1);
    const found = ids.map(byId).filter(Boolean);
    if (found.length) process.stdout.write(found.map((c) => JSON.stringify(c)).join('\n') + '\n');
    if (found.length < ids.length) { process.stderr.write('Error: No such container\n'); process.exit(1); }
    process.exit(0);
    break;
  }
  case 'image': {
    const ids = operands(2);
    if ((flag('--format') ?? '').trim() === '{{.ID}}') out(ids.map((i) => containers.find((c) => c.image === i)?.imageId ?? i));
    out(ids.map((id) => { const c = containers.find((x) => x.imageId === id); return JSON.stringify({ id, created: c?.created ?? null, tags: c ? [`${c.image}:latest`] : [], labels: {} }); }));
    break;
  }
  case 'logs': {
    const c = byId(operands(1).at(-1) ?? '');
    const name = c?.labels?.['com.docker.compose.service'] ?? 'service';
    const t0 = Date.now() - 5 * 60_000;
    const at = (s) => new Date(t0 + s * 1000).toISOString();
    out(c?.health?.Status === 'unhealthy'
      ? [`${at(0)} ${name} listening on :8080`, `${at(30)} GET /health 503 (reports cache is warming up)`, `${at(60)} GET /health 503 (reports cache is warming up)`, `${at(90)} warn: report job queue is 214 deep`]
      : [`${at(0)} ${name} starting`, `${at(4)} ${name} ready on :8080`, `${at(60)} GET /health 200 2ms`]);
    break;
  }
  case 'restart': case 'start': out(operands(1)); break;
  default: process.stderr.write(`docker ${args.join(' ')}: not part of the showcase world\n`); process.exit(1);
}
