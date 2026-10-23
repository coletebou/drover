import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../build/build-resources.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const FIXTURE = here('./fixtures/chrome-mini');
const quiet = () => {};

function freshOut() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'drover-safari-test-'));
  const out = path.join(base, 'Resources');
  fs.mkdirSync(out);
  return out;
}
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const snapshot = (dir) => {
  const o = {};
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r); else o[r] = fs.readFileSync(path.join(dir, r), 'utf8');
    }
  };
  walk('');
  return o;
};

test('builds the Chrome fixture', () => {
  const out = freshOut();
  fs.writeFileSync(path.join(out, 'stale.txt'), 'old');
  const r = build({ chromeDir: FIXTURE, outDir: out, log: quiet });
  assert.equal(r.source, 'Extensions/chrome');
  const files = Object.keys(snapshot(out)).sort();
  assert.deepEqual(files, ['BUILD-INFO.json', 'background.js', 'lib/a.js', 'manifest.json', 'options.html', 'popup.html', 'safari-background.js', 'safari-shim.js', 'sidepanel.html']);
  assert.deepEqual(r.files, files);

  assert.equal(read(out, 'safari-background.js'), "import './safari-shim.js';\nimport './background.js';\n");
  assert.ok(read(out, 'safari-shim.js').includes('"proxyApi":true'));
  assert.ok(!read(out, 'safari-shim.js').includes('__DROVER_SAFARI_CONFIG__'));
  for (const h of ['popup.html', 'options.html', 'sidepanel.html']) {
    assert.ok(read(out, h).includes('<meta charset="utf-8"><script src="/safari-shim.js"></script>'), h);
  }
  const m = JSON.parse(read(out, 'manifest.json'));
  assert.equal(m.background.service_worker, 'safari-background.js');
  assert.ok(m.permissions.includes('nativeMessaging'));
  assert.ok(read(out, 'manifest.json').endsWith('}\n'));
  const info = JSON.parse(read(out, 'BUILD-INFO.json'));
  assert.equal(info.source, 'Extensions/chrome');
  assert.ok(info.chromeCommit === null || /^[0-9a-f]{4,}$/.test(info.chromeCommit));
  assert.ok(Array.isArray(info.notes) && info.notes.length > 0);
  assert.deepEqual(Object.keys(info).sort(), ['chromeCommit', 'notes', 'source']);
});

test('two builds are byte-identical', () => {
  const a = freshOut();
  const b = freshOut();
  build({ chromeDir: FIXTURE, outDir: a, log: quiet });
  build({ chromeDir: FIXTURE, outDir: b, log: quiet });
  assert.deepEqual(snapshot(a), snapshot(b));
});

test('classic service worker uses importScripts', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'drover-safari-src-'));
  fs.writeFileSync(path.join(src, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'x', version: '1', background: { service_worker: 'sw.js' } }));
  fs.writeFileSync(path.join(src, 'sw.js'), '');
  const out = freshOut();
  build({ chromeDir: src, outDir: out, log: quiet });
  assert.equal(read(out, 'safari-background.js'), "importScripts('safari-shim.js', 'sw.js');\n");
});

test('falls back to the placeholder without a Chrome manifest, --strict fails', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'drover-safari-empty-'));
  const out = freshOut();
  const logs = [];
  const r = build({ chromeDir: empty, outDir: out, log: (s) => logs.push(s) });
  assert.equal(r.source, 'placeholder');
  assert.ok(logs.some((l) => l.includes('warning')));
  const info = JSON.parse(read(out, 'BUILD-INFO.json'));
  assert.equal(info.source, 'placeholder');
  assert.equal(info.chromeCommit, null);
  const m = JSON.parse(read(out, 'manifest.json'));
  assert.equal(m.name, 'Drover (build pending)');
  assert.equal(m.background.service_worker, 'safari-background.js');
  assert.ok(read(out, 'popup.html').includes('/safari-shim.js'));
  assert.ok(read(out, 'safari-shim.js').length > 0);

  const out2 = freshOut();
  fs.writeFileSync(path.join(out2, 'keep.txt'), 'x');
  assert.throws(() => build({ chromeDir: empty, outDir: out2, strict: true, log: quiet }), /strict/);
  assert.ok(fs.existsSync(path.join(out2, 'keep.txt')), 'strict failure must not clean the out dir');
});

test('out dir guard refuses unsafe paths before deleting anything', () => {
  const bad = '/tmp/../Users/somewhere/not-resources';
  assert.throws(() => build({ chromeDir: FIXTURE, outDir: bad, log: quiet }), /refusing/);

  const home = fs.mkdtempSync(path.join(process.cwd(), 'drover-guard-'));
  try {
    fs.writeFileSync(path.join(home, 'precious.txt'), 'x');
    assert.throws(() => build({ chromeDir: FIXTURE, outDir: home, log: quiet }), /refusing/);
    assert.ok(fs.existsSync(path.join(home, 'precious.txt')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  // A directory named Resources outside tmp is allowed by the guard (not built here).
  const tmp = fs.realpathSync(os.tmpdir());
  assert.throws(() => build({ chromeDir: FIXTURE, outDir: tmp, log: quiet }), /refusing/);
});
