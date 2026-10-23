import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function walk(dir, skip, exts, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = relative(ROOT, p);
    if (skip.some((s) => rel === s || rel.startsWith(`${s}/`))) continue;
    if (statSync(p).isDirectory()) walk(p, skip, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

const CODE_SKIP = ['test', 'tools', 'node_modules', '.git'];
const codeFiles = walk(ROOT, CODE_SKIP, ['.js', '.mjs', '.html']);

const FORBIDDEN = [
  ['innerHTML', /\binnerHTML\b/],
  ['outerHTML', /\bouterHTML\b/],
  ['insertAdjacentHTML', /\binsertAdjacentHTML\b/],
  ['document.write', /\bdocument\.write(ln)?\b/],
  ['eval(', /(^|[^\w.])eval\s*\(/],
  ['new Function', /\bnew\s+Function\b/],
  ['chrome.storage.sync', /\bstorage\.sync\b/],
  ['setAttribute style', /setAttribute\(\s*['"]style['"]/],
  ['import from http', /\bimport\b[^;\n]*\bfrom\s*['"]https?:/],
  ['dynamic import of http', /\bimport\s*\(\s*['"]https?:/],
  ['importScripts(', /\bimportScripts\s*\(/],
  ['console call with token or settings', /\bconsole\.(log|info|debug|warn|error)\s*\(.*\b(token|settings)\b/i],
];

const isComment = (l) => /^\s*(\/\/|\/\*|\*)/.test(l);

test('no forbidden APIs or patterns in extension code', () => {
  const hits = [];
  for (const file of codeFiles) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (isComment(line)) return;
      for (const [name, re] of FORBIDDEN) if (re.test(line)) hits.push(`${relative(ROOT, file)}:${i + 1}: ${name}`);
    });
  }
  assert.deepEqual(hits, []);
});

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '*']);
const COMMENT_HOSTS = new Set(['developer.chrome.com', 'html.spec.whatwg.org']);

test('no URLs to other hosts in code, html or json', () => {
  const files = walk(ROOT, ['test/fixtures', 'test', 'tools', 'node_modules', '.git'], ['.js', '.mjs', '.html', '.json']);
  const hits = [];
  for (const file of files) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/https?:\/\/([A-Za-z0-9*$][^\s'"`)<>/:?#]*)/g)) {
        const host = m[1];
        if (ALLOWED_HOSTS.has(host) || host.startsWith('$')) continue;
        if (COMMENT_HOSTS.has(host) && (isComment(line) || /\s\/\/\s/.test(line))) continue;
        hits.push(`${relative(ROOT, file)}:${i + 1}: ${m[0]}`);
      }
    });
  }
  assert.deepEqual(hits, []);
});

test('the scan finds extension files (sanity)', () => {
  assert.ok(codeFiles.some((f) => f.endsWith('lib/api.js')));
});
