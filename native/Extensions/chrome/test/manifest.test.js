import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
// Written by other slices; checked when present.
const OPTIONAL_FILES = new Set(['background.js', 'popup.html', 'options.html', 'sidepanel.html']);

test('manifest version 3', () => {
  assert.equal(manifest.manifest_version, 3);
});

test('permissions are exactly the five documented ones', () => {
  assert.deepEqual([...manifest.permissions].sort(), ['alarms', 'contextMenus', 'notifications', 'sidePanel', 'storage']);
});

test('no static host access, only optional http(s) patterns', () => {
  assert.ok(!('host_permissions' in manifest));
  assert.deepEqual([...manifest.optional_host_permissions].sort(), ['http://*/*', 'https://*/*']);
});

test('no content scripts, web accessible resources or external connections', () => {
  for (const k of ['content_scripts', 'web_accessible_resources', 'externally_connectable']) assert.ok(!(k in manifest), k);
});

test('content security policy is strict', () => {
  const csp = manifest.content_security_policy.extension_pages;
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.ok(!csp.includes('unsafe-eval'));
  assert.ok(!csp.includes('unsafe-inline'));
  const script = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'));
  assert.ok(!/https?:/.test(script), script);
});

test('background is a module service worker', () => {
  assert.equal(manifest.background.type, 'module');
  assert.ok(manifest.background.service_worker);
  assert.ok(!('scripts' in manifest.background));
});

function referencedFiles() {
  const files = new Set(Object.values(manifest.icons ?? {}));
  for (const v of Object.values(manifest.action?.default_icon ?? {})) files.add(v);
  for (const f of [manifest.action?.default_popup, manifest.options_ui?.page, manifest.side_panel?.default_path, manifest.background?.service_worker]) if (f) files.add(f);
  return [...files];
}

test('every file the manifest references exists', () => {
  const missing = referencedFiles().filter((f) => !existsSync(join(ROOT, f)) && !OPTIONAL_FILES.has(f));
  assert.deepEqual(missing, []);
});

test('files other slices add are checked when present', () => {
  for (const f of OPTIONAL_FILES) {
    if (referencedFiles().includes(f) && existsSync(join(ROOT, f))) assert.ok(readFileSync(join(ROOT, f), 'utf8').length > 0, f);
  }
});

test('icons are PNGs of the declared size', () => {
  for (const [size, f] of Object.entries(manifest.icons)) {
    const p = join(ROOT, f);
    assert.ok(existsSync(p), `${f} missing`);
    const b = readFileSync(p);
    assert.deepEqual([...b.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${f} signature`);
    assert.equal(b.subarray(12, 16).toString('ascii'), 'IHDR');
    assert.equal(b.readUInt32BE(16), Number(size), `${f} width`);
    assert.equal(b.readUInt32BE(20), Number(size), `${f} height`);
  }
});

// ---- html pages ----

const htmlFiles = readdirSync(ROOT).filter((f) => f.endsWith('.html'));
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'))?.slice(2).find((x) => x !== undefined);

for (const f of htmlFiles) {
  test(`${f}: no inline script or style, no remote resources, local files exist`, () => {
    const html = readFileSync(join(ROOT, f), 'utf8');
    const problems = [];
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const tag = `<script${m[1]}>`;
      const src = attr(tag, 'src');
      if (!src) problems.push(`inline script: ${tag}`);
      if (m[2].trim()) problems.push('script tag has content');
      if (attr(tag, 'type') !== 'module') problems.push(`script not type=module: ${src}`);
      if (src && /^([a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(src)) problems.push(`non-relative script src: ${src}`);
    }
    if (/\sstyle\s*=/i.test(html)) problems.push('style attribute');
    if (/<style\b/i.test(html)) problems.push('inline <style>');
    for (const m of html.matchAll(/<(?:link|script|img|iframe)\b[^>]*>/gi)) {
      const ref = attr(m[0], 'src') ?? attr(m[0], 'href');
      if (!ref) continue;
      if (/^https?:|^\/\//i.test(ref)) { problems.push(`remote resource: ${ref}`); continue; }
      if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('#')) continue;
      const path = ref.split(/[?#]/)[0];
      if (!existsSync(join(ROOT, path))) problems.push(`missing file: ${ref}`);
    }
    assert.deepEqual(problems, []);
  });
}
