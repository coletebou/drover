#!/usr/bin/env node
// ssh for the dev world (test/devworld.js): `ssh [-o opt]... <host> [--] <command>` runs the command for one of the
// showcase world's pretend hosts (test/showcase/world.js), on this machine, with that host's settings (its own state,
// tmux server, Claude and Codex homes, docker) laid over the environment it inherits. `drover rpc` starts the daemon's
// rpc server directly, so a login shell's PATH cannot put the real docker or ps ahead of the world's; a host marked
// down fails the way an unreachable machine does. The file DEVWORLD_HOSTS names maps host names to their settings; any
// other name is unknown, so no call reaches a real machine.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const WITH_VALUE = new Set(['-o', '-p', '-i', '-l', '-F', '-J', '-E', '-b', '-c', '-D', '-L', '-R', '-S', '-W', '-w', '-Q', '-O', '-e', '-m']);
let i = 0;
while (i < argv.length && argv[i].startsWith('-') && argv[i] !== '--') i += WITH_VALUE.has(argv[i]) ? 2 : 1;
const host = argv[i];
const rest = argv.slice(i + 1);
if (rest[0] === '--') rest.shift();
const command = rest.join(' ');

const world = JSON.parse(readFileSync(process.env.DEVWORLD_HOSTS, 'utf8'));
const h = world.hosts?.[host];
if (!h) { process.stderr.write(`ssh: Could not resolve hostname ${host}: nodename nor servname provided, or not known\n`); process.exit(255); }
if (h.down) { setTimeout(() => { process.stderr.write(`${h.down}\n`); process.exit(255); }, 300); }
else {
  // The host's own settings over the environment this ssh got from the daemon (the dev world's, already isolated).
  const env = { ...process.env, ...h.settings };
  const child = /\brpc\b/.test(command)
    ? spawn(process.execPath, [world.drover, 'rpc'], { env, stdio: 'inherit' })
    : spawn('/bin/sh', ['-c', command], { env, stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 255 : 0)));
}
