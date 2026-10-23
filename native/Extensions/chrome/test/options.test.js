// Static checks on the options page, which needs chrome.* and a DOM to run: the
// elements options.js looks up exist, and Save and connect and pairing store the
// server and token through the same code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const js = read('options.js');
const html = read('options.html');

test('every element options.js looks up is in options.html', () => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const used = [...js.matchAll(/\$\('([^']+)'\)|\bnb\('([^']+)'/g)].map((m) => m[1] ?? m[2]);
  for (const list of js.matchAll(/for \(const id of \[([^\]]+)\]\)/g)) used.push(...[...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  for (const id of ['pair', 'pairing', 'pair-code', 'pair-msg', 'pair-timer', 'pair-actions', 'pair-copy', 'pair-cancel', 'pair-retry', 'url', 'token', 'save']) assert.ok(used.includes(id), id);
  assert.deepEqual(used.filter((id) => !ids.has(id)), []);
});

test('Save and connect and pairing store the server and token through one store()', () => {
  assert.equal(js.match(/saveSettings\(chrome\.storage\.local, \{ baseUrl/g)?.length, 1, 'one place writes server and token');
  const store = js.slice(js.indexOf('async function store('), js.indexOf('async function save('));
  assert.match(store, /saveSettings\(chrome\.storage\.local, \{ baseUrl: origin, token, actor: \$\('actor'\)\.value \}\)/);
  assert.match(js, /await store\(target\.origin, \$\('token'\)\.value\.trim\(\) \|\| undefined\)/, 'Save and connect');
  assert.match(js, /saveToken: \(token\) => store\(target\.origin, token\)/, 'pairing');
});

test('the pairing countdown is outside the live region, so it is not announced every second', () => {
  assert.match(html, /<p id="pair-msg" role="status" aria-live="polite"><\/p>/);
  const timer = html.match(/<p id="pair-timer"[^>]*>/)?.[0] ?? '';
  assert.ok(timer && !/aria-live|role=/.test(timer), timer);
});
