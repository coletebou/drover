import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { shouldCopy, injectShim, backgroundWrapper, renderShim, SHIM_TOKEN } from '../build/lib/files.mjs';

const cfg = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../safari.config.json', import.meta.url)), 'utf8'));
const TAG = '<script src="/safari-shim.js"></script>';

test('shouldCopy applies dir, suffix, dotfile and exact patterns', () => {
  const ex = cfg.exclude;
  for (const p of ['test/a.js', 'tests/x/y.js', 'lib/test/z.js', 'node_modules/q/i.js', 'lib/a.test.js', 'a.test.mjs', 'README.md', 'docs/NOTES.md', 'package.json', 'package-lock.json', '.eslintrc', 'lib/.hidden', '.git/config']) {
    assert.equal(shouldCopy(p, ex), false, p);
  }
  for (const p of ['manifest.json', 'lib/a.js', 'popup.html', 'icons/icon-16.png', 'latest.js', 'ext/contest.js']) {
    assert.equal(shouldCopy(p, ex), true, p);
  }
});

test('injectShim goes after meta charset', () => {
  const out = injectShim('<!doctype html><html><head><meta charset="utf-8"><title>x</title></head></html>');
  assert.ok(out.includes(`<meta charset="utf-8">${TAG}<title>`));
});

test('injectShim goes after head when there is no charset, keeping head attributes', () => {
  const out = injectShim('<html><head lang="en" data-x="1"><title>x</title></head></html>');
  assert.ok(out.includes(`<head lang="en" data-x="1">${TAG}<title>`));
  assert.ok(!injectShim('<header></header><head><title>x</title></head>').startsWith(TAG + '<header'));
});

test('injectShim is idempotent', () => {
  const once = injectShim('<head><meta charset="utf-8"></head>');
  assert.equal(injectShim(once), once);
  assert.equal(once.split('safari-shim.js').length - 1, 1);
});

test('backgroundWrapper: module and classic', () => {
  assert.equal(backgroundWrapper('background.js', true), "import './safari-shim.js';\nimport './background.js';\n");
  assert.equal(backgroundWrapper('background.js', false), "importScripts('safari-shim.js', 'background.js');\n");
  assert.equal(backgroundWrapper('./sw/bg.js', true), "import './safari-shim.js';\nimport './sw/bg.js';\n");
});

test('renderShim replaces the token with the config JSON', () => {
  const out = renderShim(`const CFG = ${SHIM_TOKEN};`, cfg);
  assert.ok(!out.includes('__DROVER_SAFARI_CONFIG__'));
  const json = JSON.parse(out.slice('const CFG = '.length, -1));
  assert.deepEqual(Object.keys(json).sort(), ['notificationIdPattern', 'proxyApi', 'storage']);
  assert.equal(json.storage.actor, 'safari');
  assert.throws(() => renderShim('no token', cfg));
});
