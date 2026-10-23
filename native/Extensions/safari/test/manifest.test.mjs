import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformManifest } from '../build/lib/manifest.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const cfg = JSON.parse(fs.readFileSync(here('../safari.config.json'), 'utf8'));
const chrome = () => JSON.parse(fs.readFileSync(here('./fixtures/chrome-mini/manifest.json'), 'utf8'));

test('removes Chrome-only keys with a note each', () => {
  const m = { ...chrome(), key: 'k', update_url: 'u', offline_enabled: true, externally_connectable: {}, chrome_url_overrides: {} };
  const { manifest, notes } = transformManifest(m, cfg);
  for (const k of ['side_panel', 'omnibox', 'key', 'update_url', 'minimum_chrome_version', 'offline_enabled', 'externally_connectable', 'chrome_url_overrides']) {
    assert.ok(!(k in manifest), k);
    assert.ok(notes.some((n) => n.includes(`"${k}"`)), `note for ${k}`);
  }
});

test('permissions: drops sidePanel/offscreen/notifications, adds nativeMessaging once, keeps order', () => {
  const m = chrome();
  m.permissions.push('offscreen');
  const { manifest } = transformManifest(m, cfg);
  assert.deepEqual(manifest.permissions, ['storage', 'alarms', 'contextMenus', 'nativeMessaging']);
  const again = transformManifest({ ...m, permissions: ['nativeMessaging', 'storage'] }, cfg).manifest;
  assert.deepEqual(again.permissions, ['nativeMessaging', 'storage']);
  assert.deepEqual(transformManifest({ manifest_version: 3 }, cfg).manifest.permissions, ['nativeMessaging']);
});

test('background: service worker keeps the module type', () => {
  const { manifest } = transformManifest(chrome(), cfg);
  assert.deepEqual(manifest.background, { service_worker: 'safari-background.js', type: 'module' });
  const classic = chrome();
  delete classic.background.type;
  assert.deepEqual(transformManifest(classic, cfg).manifest.background, { service_worker: 'safari-background.js' });
});

test('background: scripts mode', () => {
  const { manifest } = transformManifest(chrome(), { ...cfg, background: 'scripts' });
  assert.deepEqual(manifest.background, { scripts: ['safari-background.js'], type: 'module', persistent: false });
});

test('popup falls back to the side panel page only when absent', () => {
  const m = chrome();
  assert.equal(transformManifest(m, cfg).manifest.action.default_popup, 'popup.html');
  delete m.action.default_popup;
  const { manifest, notes } = transformManifest(m, cfg);
  assert.equal(manifest.action.default_popup, 'sidepanel.html');
  assert.ok(notes.some((n) => n.includes('default_popup')));
  const noAction = chrome();
  delete noAction.action;
  assert.equal(transformManifest(noAction, cfg).manifest.action.default_popup, 'sidepanel.html');
});

test('adds the Safari minimum version and merges existing browser_specific_settings', () => {
  const m = chrome();
  m.browser_specific_settings = { gecko: { id: 'x@y' }, safari: { other: 1 } };
  const { manifest } = transformManifest(m, cfg);
  assert.equal(manifest.browser_specific_settings.safari.strict_min_version, '17.0');
  assert.equal(manifest.browser_specific_settings.safari.other, 1);
  assert.equal(manifest.browser_specific_settings.gecko.id, 'x@y');
});

test('everything else passes through unchanged', () => {
  const m = chrome();
  const { manifest } = transformManifest(m, cfg);
  for (const k of ['manifest_version', 'name', 'short_name', 'description', 'version', 'icons', 'optional_host_permissions', 'content_security_policy', 'options_ui']) {
    assert.deepEqual(manifest[k], m[k], k);
  }
  assert.equal(manifest.action.default_title, 'Drover');
});

test('does not mutate its input', () => {
  const m = chrome();
  const snap = structuredClone(m);
  transformManifest(m, cfg);
  assert.deepEqual(m, snap);
});
