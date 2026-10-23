// Where a repo's memory lives (core/memory.js homeFor): its memory-homes.conf line, else DROVER_MEMORY_ROOT/<repo>,
// else the dotfiles identity's memory folder when ~/.df-profile (or DF_IDENTITY) names one, else <dotfiles>/claude/memory.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = await mkdtemp(path.join(tmpdir(), 'drover-memory-home-'));
const DOT = path.join(ROOT, 'dotfiles');
const saved = Object.fromEntries(['HOME', 'DROVER_DOTFILES', 'APXW_DOTFILES', 'DROVER_MEMORY_ROOT', 'APXW_MEMORY_ROOT', 'DF_IDENTITY'].map((k) => [k, process.env[k]]));
await mkdir(path.join(DOT, 'claude'), { recursive: true });
await writeFile(path.join(DOT, 'claude', 'memory-homes.conf'), `# repo  home\nwebapp  ${path.join(ROOT, 'elsewhere', 'webapp')}\n`);
process.env.DROVER_DOTFILES = DOT;
delete process.env.APXW_DOTFILES;
const memory = await import('../core/memory.js');

const home = async (name, profile) => {
  const h = path.join(ROOT, name);
  await mkdir(h, { recursive: true });
  if (profile !== undefined) await writeFile(path.join(h, '.df-profile'), profile);
  process.env.HOME = h;
};

describe('homeFor', () => {
  before(() => { for (const k of ['DROVER_MEMORY_ROOT', 'APXW_MEMORY_ROOT', 'DF_IDENTITY']) delete process.env[k]; });
  after(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(ROOT, { recursive: true, force: true });
  });

  test('a repo listed in memory-homes.conf lives there, whatever else is set', async () => {
    await home('h-conf', 'DF_IDENTITY=work\n');
    process.env.DROVER_MEMORY_ROOT = path.join(ROOT, 'root');
    try { assert.equal(await memory.homeFor('webapp'), path.join(ROOT, 'elsewhere', 'webapp')); } finally { delete process.env.DROVER_MEMORY_ROOT; }
  });

  test('DROVER_MEMORY_ROOT wins over a dotfiles identity; a leading ~ is the home folder', async () => {
    await home('h-root', 'DF_IDENTITY=work\n');
    process.env.DROVER_MEMORY_ROOT = '~/mem';
    try { assert.equal(await memory.homeFor('Billing'), path.join(ROOT, 'h-root', 'mem', 'billing')); } finally { delete process.env.DROVER_MEMORY_ROOT; }
  });

  test('the identity ~/.df-profile names, as before the setting existed', async () => {
    await home('h-profile', 'DF_MACHINE=box-a\nDF_IDENTITY=personal\n');
    assert.equal(await memory.homeFor('Billing'), path.join(DOT, 'identities', 'personal', 'claude', 'memory', 'billing'));
  });

  test('DF_IDENTITY when there is no ~/.df-profile; a value that is not a word is ignored', async () => {
    await home('h-env');
    process.env.DF_IDENTITY = 'work';
    try {
      assert.equal(await memory.homeFor('billing'), path.join(DOT, 'identities', 'work', 'claude', 'memory', 'billing'));
      process.env.DF_IDENTITY = '../x';
      assert.equal(await memory.homeFor('billing'), path.join(DOT, 'claude', 'memory', 'billing'));
    } finally { delete process.env.DF_IDENTITY; }
  });

  test('no identity anywhere: <dotfiles>/claude/memory/<repo>', async () => {
    await home('h-none');
    assert.equal(await memory.homeFor('billing'), path.join(DOT, 'claude', 'memory', 'billing'));
  });
});
