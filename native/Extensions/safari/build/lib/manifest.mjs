// Pure Chrome -> Safari manifest transform. No I/O, does not mutate its input.

const DROP_KEYS = [
  'side_panel', 'omnibox', 'key', 'update_url', 'minimum_chrome_version',
  'offline_enabled', 'externally_connectable', 'chrome_url_overrides',
];
const DROP_PERMISSIONS = ['sidePanel', 'offscreen', 'notifications'];

/** @returns {{ manifest: object, notes: string[] }} */
export function transformManifest(input, cfg) {
  const m = structuredClone(input);
  const notes = [];

  const sidePath = m.side_panel?.default_path;
  for (const k of DROP_KEYS) {
    if (k in m) {
      delete m[k];
      notes.push(`removed manifest key "${k}"`);
    }
  }

  if (Array.isArray(m.permissions)) {
    const kept = m.permissions.filter((p) => !DROP_PERMISSIONS.includes(p));
    for (const p of m.permissions) if (DROP_PERMISSIONS.includes(p)) notes.push(`removed permission "${p}"`);
    m.permissions = kept;
  } else {
    m.permissions = [];
  }
  if (!m.permissions.includes('nativeMessaging')) {
    m.permissions.push('nativeMessaging');
    notes.push('added permission "nativeMessaging"');
  }

  const bg = m.background;
  if (bg && (bg.service_worker || bg.scripts)) {
    const next = cfg.background === 'scripts' ? { scripts: ['safari-background.js'] } : { service_worker: 'safari-background.js' };
    if (bg.type) next.type = bg.type;
    if (cfg.background === 'scripts') next.persistent = false;
    m.background = next;
    notes.push(`background rewritten to safari-background.js (${cfg.background === 'scripts' ? 'scripts' : 'service_worker'})`);
  }

  if (sidePath && !m.action?.default_popup) {
    m.action = { ...(m.action ?? {}), default_popup: sidePath };
    notes.push(`action.default_popup set from side_panel.default_path (${sidePath})`);
  }

  m.browser_specific_settings = {
    ...(m.browser_specific_settings ?? {}),
    safari: { ...(m.browser_specific_settings?.safari ?? {}), strict_min_version: cfg.strictMinVersion },
  };

  return { manifest: m, notes };
}
