// Which clients have talked to this daemon lately, from the User-Agent of authenticated requests. Native apps
// send their app name ("DroverWatch/1 CFNetwork/... Darwin/..."), so this answers "is the watch actually
// reaching the daemon?" without guessing from sockets: the phone and watch both arrive through tailscale serve.
// Browser extensions send the browser's own User-Agent, so their Origin (chrome-extension://...) tells them apart
// from a tab. In memory only; no tokens, paths or bodies are kept.
const MAX = 64;
const DAY_MS = 24 * 60 * 60 * 1000;

export const _deps = { now: () => Date.now() };

const seen = new Map(); // key -> { userAgent, extension, scope, via, firstSeen, lastSeen, requests }, least recent first

const clean = (ua) => String(ua ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) || '(none)';

/** A browser extension's origin, else ''. A page's own origin is dropped: it would split one tab into two rows. */
export const extensionOf = (origin) => (/^(chrome|safari-web|moz)-extension:\/\/[\w.-]{1,64}$/.test(String(origin ?? '')) ? origin : '');

/** The app a User-Agent names: a native app's executable, else the browser family ("Chrome extension" from one). */
export function appOf(userAgent, extension = '') {
  const ua = clean(userAgent);
  const native = ua.match(/^([A-Za-z][\w .-]*?)\/[\w.()-]+ CFNetwork\//);
  if (native) return native[1];
  const browser = /\bEdg\//.test(ua) ? 'Edge' : /\bChrome\//.test(ua) ? 'Chrome' : /\bFirefox\//.test(ua) ? 'Firefox'
    : /\bVersion\/[\d.]+ .*Safari\//.test(ua) ? 'Safari' : null;
  if (browser) return extension ? `${browser} extension` : browser;
  if (/^node\b|undici/i.test(ua)) return 'node';
  return ua.split(/[\s/]/)[0];
}

/** Note one authenticated request. scope is 'main' or 'widget'; via is 'local' or 'tailnet'. */
export function record({ userAgent, origin, scope, via }) {
  const ua = clean(userAgent);
  const extension = extensionOf(origin);
  const key = `${ua}\n${extension}\n${scope}\n${via}`;
  const now = _deps.now();
  const e = seen.get(key) ?? { userAgent: ua, extension, scope, via, firstSeen: now, requests: 0 };
  e.lastSeen = now;
  e.requests += 1;
  seen.delete(key);
  seen.set(key, e);
  while (seen.size > MAX) seen.delete(seen.keys().next().value);
}

/** Clients seen in the last day, most recent first. */
export function recent({ withinMs = DAY_MS } = {}) {
  const now = _deps.now();
  return [...seen.values()].reverse().filter((e) => now - e.lastSeen <= withinMs).map((e) => ({
    app: appOf(e.userAgent, e.extension), via: e.via, scope: e.scope, requests: e.requests, extension: e.extension,
    lastSeen: new Date(e.lastSeen).toISOString(), firstSeen: new Date(e.firstSeen).toISOString(), userAgent: e.userAgent,
  }));
}

/** Tests only. */
export function _reset() { seen.clear(); }
