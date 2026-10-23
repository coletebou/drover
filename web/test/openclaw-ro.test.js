// The manager's read-only shell (openclaw-manager/bin/ro): every writing or endless form is refused before
// anything runs, on any platform; the read verbs that exist on this one answer. Run: node --test test/openclaw-ro.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'openclaw-manager', 'bin', 'ro');
const ro = (...args) => spawnSync('/bin/bash', [RO, ...args], { encoding: 'utf8', timeout: 60_000 });

test('writing, destructive and never-ending forms are refused before they run', () => {
  for (const args of [
    ['git', 'push'], ['git', 'branch', '-D', 'x'], ['cat', '/etc/passwd'], ['rg', '--pre', 'sh', 'x'],
    ['systemctl', 'restart', 'x'], ['tmux', 'send-keys', 'x'], ['docker', 'rm', 'x'],
    ['sysctl', '-w', 'kern.maxfiles=1'], ['sysctl', 'kern.maxfiles=1'], ['launchctl', 'bootout', 'gui/501/x'], ['launchctl', 'kickstart', '-k', 'gui/501/x'],
    ['log', 'erase'], ['log', 'stream'], ['log', 'show', '--last', '2h'], ['log', 'show', '--start', '2026-10-01'], ['log', 'show'],
    ['pmset', 'sleepnow'], ['pmset', '-a', 'sleep', '0'], ['diskutil', 'eraseDisk', 'x'], ['diskutil', 'apfs', 'deleteVolume', 'x'],
    ['ifconfig', 'en0', 'down'], ['scutil', '--set', 'HostName', 'x'], ['netstat', '-w', '1'], ['top', '-l', '9'], ['lsof', '-r', '1'], ['vm_stat', '1'],
    ['rm', '-rf', 'x'], ['sh', '-c', 'true'],
  ]) {
    const r = ro(...args);
    assert.equal(r.status, 2, `ro ${args.join(' ')} -> ${r.status} ${r.stderr}`);
    assert.match(r.stderr, /^ro: refused: /, args.join(' '));
  }
});

test('read verbs answer on this platform, and help lists the macOS ones', () => {
  const help = ro('help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /launchctl print\|list/);
  assert.match(help.stdout, /ro help: this list/);
  assert.equal(ro('date').status, 0);
  if (process.platform === 'darwin') {
    for (const args of [['sw_vers'], ['vm_stat'], ['sysctl', '-n', 'hw.ncpu'], ['launchctl', 'list'], ['pmset', '-g'], ['scutil', '--nc', 'list'], ['top', '-n', '3', '-o', 'cpu']]) {
      const r = ro(...args);
      assert.equal(r.status, 0, `ro ${args.join(' ')} -> ${r.status} ${r.stderr}`);
    }
  } else {
    assert.equal(ro('uptime').status, 0);
  }
});
