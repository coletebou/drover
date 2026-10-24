// Paths read ~ under any home: the front daemon names its own HOME in host.list's local entry, the web UI and the TUI
// write paths under it (and under any /Users/<name> or /home/<name>) as ~, and so does the text the daemon shapes for
// native clients (core/native.js clean).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('host.list: the local entry names the daemon\'s HOME', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'drover-home-'));
  mkdirSync(path.join(dir, 'dotfiles', 'claude'), { recursive: true });
  writeFileSync(path.join(dir, 'dotfiles', 'claude', 'fleet-hosts.txt'), 'devbox\n');
  process.env.HOME = path.join(dir, 'home');
  process.env.DROVER_DOTFILES = path.join(dir, 'dotfiles');
  const hosts = await import('../core/hosts.js');
  const list = await hosts.knownHosts();
  assert.equal(list[0].name, 'local');
  assert.equal(list[0].home, path.join(dir, 'home'));
  assert.equal(list.find((h) => h.name === 'devbox')?.home, undefined, 'only this host\'s home is known');
});

test('native clean(): the daemon\'s own home reads ~, wherever it is, and the usual homes still do', async () => {
  // HOME is the test's own home (set by the test above, before any import that reads it).
  const { clean, noPaths } = await import('../core/native.js');
  const home = process.env.HOME;
  assert.equal(clean(`working in ${home}/code/demo`), 'working in ~/code/demo');
  // (the temporary folder's random-looking name may be redacted as a secret; it must not read as under the home)
  assert.ok(!clean(`${home}x/y`).startsWith('~'), 'a home matches whole folders only');
  assert.equal(clean('in /Users/sam/code and /home/sam/src'), 'in ~/code and ~/src');
  assert.equal(noPaths(`edited ${home}/code/demo/src/a.js`), 'edited a.js');
});

for (const [name, load] of [['web UI', async () => { const m = await import('../ui/dom.js'); return { setHomes: m.setHomes, tilde: m.tildePath, short: m.shortPath }; }], ['TUI', async () => { const m = await import('../tui/ui.js'); return { setHomes: m.setHomes, tilde: m.tilde }; }]]) {
  test(`${name}: a path under the daemon's home reads ~, the usual homes still do`, async () => {
    const { setHomes, tilde, short } = await load();
    setHomes([]);
    assert.equal(tilde('/Users/sam/code/demo'), '~/code/demo');
    assert.equal(tilde('/home/sam/code/demo'), '~/code/demo');
    assert.equal(tilde('/srv/me/code/demo'), '/srv/me/code/demo');
    setHomes(['/srv/me/', null, '/srv']);
    assert.equal(tilde('/srv/me/code/demo'), '~/code/demo', 'the longest home that holds it wins; a trailing slash is ignored');
    assert.equal(tilde('/srv/me'), '~');
    assert.equal(tilde('/srv/meta/x'), '~/meta/x', 'a home matches whole folders only (/srv/me does not hold /srv/meta)');
    assert.equal(tilde('/opt/x'), '/opt/x');
    assert.equal(tilde('/Users/sam/x'), '~/x', 'the usual homes still read ~');
    if (short) assert.equal(short(`/srv/me/${'a'.repeat(60)}`, 20), `…${'a'.repeat(19)}`);
    setHomes([]);
  });
}
