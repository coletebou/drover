// loginShellPath (core/proc.js): the PATH Drover gives the agents it launches. The login shell's entries come first,
// then any entry of the caller's PATH it dropped; noise a profile prints is ignored; no shell, a failing, silent or
// hanging one, or a profile that reads stdin falls back to (or still returns) the caller's PATH. Fake shells are
// /bin/sh scripts under a scratch dir; the real-shell case runs sh, bash and zsh with a scratch HOME and ZDOTDIR, so
// no shell config of the user runs in here.
// Run: node --test test/login-path.test.js
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loginShellPath } from '../core/proc.js';

describe('loginShellPath', () => {
  let dir;
  // A fake login shell: called as `<shell> -l -c <command>`, it runs body, then the command under /bin/sh.
  const fakeShell = async (name, body) => {
    const f = path.join(dir, name);
    await writeFile(f, `#!/bin/sh\n[ "$1" = -l ] && [ "$2" = -c ] || exit 64\n${body}\nexec /bin/sh -c "$3"\n`);
    await chmod(f, 0o755);
    return f;
  };
  const BASE = '/base/only:/usr/bin:/bin';
  before(async () => { dir = await mkdtemp(path.join(tmpdir(), 'droverlp-')); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  test("the login shell's order wins, entries it dropped follow, each dir once, profile noise ignored", async () => {
    const shell = await fakeShell('reorders', 'echo "Last login: today"; printf "no newline"; PATH=/brew/bin:/usr/bin:/bin:/brew/bin; export PATH');
    assert.equal(await loginShellPath({ env: { PATH: BASE }, shell }), '/brew/bin:/usr/bin:/bin:/base/only');
  });

  test('the shell starts from the given env and defaults to its SHELL', async () => {
    const shell = await fakeShell('prepends', 'PATH="/login/bin:$PATH"; export PATH');
    assert.equal(await loginShellPath({ env: { PATH: BASE, SHELL: shell } }), `/login/bin:${BASE}`);
  });

  test('only absolute dirs come from the shell: relative ones are dropped, and a line with none left falls back', async () => {
    const mixed = await fakeShell('mixed', 'PATH=bin:/abs/bin:.:/usr/bin; export PATH');
    assert.equal(await loginShellPath({ env: { PATH: BASE }, shell: mixed }), '/abs/bin:/usr/bin:/base/only:/bin');
    const relative = await fakeShell('relative', `printf '\\n__DROVER_LOGIN_PATH__=%s\\n' 'bin:.'; exit 0`);
    assert.equal(await loginShellPath({ env: { PATH: BASE }, shell: relative }), BASE);
  });

  test('a profile that reads stdin gets EOF instead of hanging the launch', async () => {
    const shell = await fakeShell('reads', 'read line; PATH="/after/read:$PATH"; export PATH');
    assert.equal(await loginShellPath({ env: { PATH: BASE }, shell, timeoutMs: 5000 }), `/after/read:${BASE}`);
  });

  test("falls back to the caller's PATH without a usable shell or a PATH line", async () => {
    const cases = {
      'relative shell name': 'sh',
      'missing shell': path.join(dir, 'no-such-shell'),
      'shell exits non-zero': await fakeShell('fails', 'exit 3'),
      'no PATH line printed': await fakeShell('silent', 'exit 0'),
      'shell hangs past the timeout': await fakeShell('hangs', 'exec sleep 5'),
    };
    for (const [what, shell] of Object.entries(cases)) {
      const t0 = Date.now();
      assert.equal(await loginShellPath({ env: { PATH: BASE }, shell, timeoutMs: 400 }), BASE, what);
      assert.ok(Date.now() - t0 < 3000, `${what}: returns within the timeout`);
    }
    assert.equal(await loginShellPath({ env: {}, shell: 'sh' }), '', 'no PATH at all stays empty');
  });

  for (const shell of ['/bin/sh', '/bin/bash', '/bin/zsh', '/usr/bin/zsh']) {
    test(`a real ${shell} prints its PATH through the constant command`, { skip: existsSync(shell) ? false : `${shell} is not installed here` }, async () => {
      const got = (await loginShellPath({ env: { HOME: dir, ZDOTDIR: dir, PATH: BASE }, shell })).split(':');
      for (const d of BASE.split(':')) assert.ok(got.includes(d), `${d} kept in ${got.join(':')}`);
      assert.equal(new Set(got).size, got.length, 'each dir once');
    });
  }
});
