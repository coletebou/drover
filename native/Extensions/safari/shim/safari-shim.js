// Safari shim: loaded before any Chrome extension code, in the background worker and in
// every extension page. It fills in the chrome.* APIs Safari lacks, reroutes /api/op/*
// calls through the native app (no CORS, no host permission prompt) and seeds the
// extension settings from the shared Keychain. Plain script on purpose: no import or
// export, so it works as a classic script, an importScripts target and a module import.
// It never logs. Never add logging of the token or of URLs.
(function () {
  'use strict';
  const g = globalThis;
  if (g.__droverSafari) return; // idempotent: pages can include it twice

  // The build replaces the token below with JSON. Unreplaced (null) means these defaults.
  const CFG = /*__DROVER_SAFARI_CONFIG__*/null;
  const DEFAULTS = {
    proxyApi: true,
    storage: { key: 'settings', baseUrlField: 'baseUrl', tokenField: 'token', actorField: 'actor', actor: 'safari', chromeActor: 'chrome' },
    notificationIdPattern: '^drover\\|(?<host>[^|]*)\\|(?<session>[^|]*)\\|[^|]*$',
  };
  const cfg = {
    proxyApi: CFG?.proxyApi ?? DEFAULTS.proxyApi,
    storage: { ...DEFAULTS.storage, ...(CFG?.storage ?? {}) },
    notificationIdPattern: CFG?.notificationIdPattern ?? DEFAULTS.notificationIdPattern,
  };

  // Safari exposes `browser` (promises); give Chrome code its `chrome` name when missing.
  if (!g.chrome && g.browser) g.chrome = g.browser;
  const api = g.browser ?? g.chrome;
  // Patch every distinct namespace object, in case chrome and browser are separate objects.
  const spaces = [...new Set([g.chrome, g.browser].filter(Boolean))];

  const NATIVE_APP = 'application.id';
  const NATIVE_TIMEOUT_MS = 10000;

  // ---- native messaging -------------------------------------------------------------

  const unavailable = () => ({ ok: false, error: 'native-unavailable' });
  // The handler ran (or may have) but its answer was lost or unusable: not proof that nothing happened.
  const ambiguous = () => ({ ok: false, error: 'native-no-answer' });
  // The native op proxy gives the daemon 20 s, so wait longer than that before giving up on it.
  const NATIVE_OP_TIMEOUT_MS = 25000;

  /**
   * Send one message to the Swift handler. Always resolves to { ok, result?, error? }.
   * `native-unavailable`: sendNativeMessage is missing or threw synchronously (nothing was sent anywhere).
   * `native-no-answer`: the call rejected or answered garbage (the handler may have acted on it).
   * `native-timeout`: no answer in time (the handler may still be acting on it).
   */
  function native(msg, timeoutMs = NATIVE_TIMEOUT_MS) {
    return new Promise((resolve) => {
      let timer = null;
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        if (timer !== null) clearTimeout(timer);
        resolve(v);
      };
      try {
        timer = setTimeout(() => finish({ ok: false, error: 'native-timeout' }), timeoutMs);
        Promise.resolve(api.runtime.sendNativeMessage(NATIVE_APP, { v: 1, ...msg })).then(
          (r) => finish(r && typeof r === 'object' && typeof r.ok === 'boolean' ? r : ambiguous()),
          () => finish(ambiguous()),
        );
      } catch {
        finish(unavailable());
      }
    });
  }

  // Native config (set once the config call returns). Holds the token: keep it in here only.
  let nativeCfg = null; // { baseURL, token, origin } when both exist
  const proxyReady = () => cfg.proxyApi && nativeCfg !== null;
  const originOf = (u) => { try { return new URL(u).origin; } catch { return null; } };

  // ---- small helpers ----------------------------------------------------------------

  /** Event object that stores listeners and never fires (APIs Safari does not have). */
  function inertEvent() {
    const ls = new Set();
    return {
      addListener: (fn) => { ls.add(fn); },
      removeListener: (fn) => { ls.delete(fn); },
      hasListener: (fn) => ls.has(fn),
    };
  }

  /** Assign a property, falling back to defineProperty when the host object resists. */
  function put(obj, key, value) {
    try {
      obj[key] = value;
      if (obj[key] === value) return;
    } catch { /* fall through */ }
    try { Object.defineProperty(obj, key, { value, configurable: true, writable: true }); } catch { /* give up */ }
  }

  /** Promise result, plus the optional trailing callback Chrome-style callers pass. */
  function withCallback(promise, cb) {
    if (typeof cb === 'function') promise.then((v) => cb(v), () => cb());
    return promise;
  }

  // ---- stubs ------------------------------------------------------------------------

  let idCounter = 0;
  // Id parts are URI-encoded by Chrome's encodeNotificationId; empty or undecodable means none.
  const decodePart = (v) => { if (!v) return null; try { return decodeURIComponent(v) || null; } catch { return null; } };
  const idPattern = (() => { try { return new RegExp(cfg.notificationIdPattern); } catch { return null; } })();

  function makeNotifications() {
    return {
      // create(id?, options, cb?). Ids look like drover|<host>|<session>|<item>.
      create(a, b, c) {
        const hasId = typeof a === 'string';
        const options = (hasId ? b : a) || {};
        const cb = hasId ? c : b;
        const id = hasId && a ? a : `drover-safari-${++idCounter}`;
        const groups = idPattern?.exec(id)?.groups ?? {};
        const p = native({
          type: 'notify',
          id,
          title: options.title,
          body: options.message,
          sessionId: decodePart(groups.session),
          host: decodePart(groups.host),
          kind: null, // Chrome's options carry no kind (contextMessage is the host)
        }).then(() => id);
        return withCallback(p, cb);
      },
      clear(id, cb) {
        return withCallback(native({ type: 'clearNotification', id }).then(() => true), cb);
      },
      getAll: (cb) => withCallback(Promise.resolve({}), cb),
      getPermissionLevel: (cb) => withCallback(Promise.resolve('granted'), cb),
      onClicked: inertEvent(),
      onButtonClicked: inertEvent(),
      onClosed: inertEvent(),
      onPermissionLevelChanged: inertEvent(),
      onShowSettings: inertEvent(),
    };
  }

  function makeOffscreen() {
    return {
      createDocument: () => Promise.reject(new Error('offscreen is not available in Safari')),
      hasDocument: () => Promise.resolve(false),
      closeDocument: () => Promise.resolve(),
      Reason: {
        AUDIO_PLAYBACK: 'AUDIO_PLAYBACK', BLOBS: 'BLOBS', CLIPBOARD: 'CLIPBOARD', DOM_PARSER: 'DOM_PARSER',
        DOM_SCRAPING: 'DOM_SCRAPING', IFRAME_SCRIPTING: 'IFRAME_SCRIPTING', LOCAL_STORAGE: 'LOCAL_STORAGE',
        TESTING: 'TESTING', USER_MEDIA: 'USER_MEDIA', WEB_RTC: 'WEB_RTC',
      },
    };
  }

  function makeOmnibox() {
    return {
      onInputChanged: inertEvent(),
      onInputEntered: inertEvent(),
      onInputStarted: inertEvent(),
      onInputCancelled: inertEvent(),
      setDefaultSuggestion: () => {},
    };
  }

  const notifications = makeNotifications();
  const offscreen = makeOffscreen();
  const omnibox = makeOmnibox();
  // NOTE: chrome.sidePanel is deliberately not stubbed. ext/panel.js feature-detects it and
  // falls back to a popup window; a stub would break that fallback.
  for (const ns of spaces) {
    if (!ns.notifications) put(ns, 'notifications', notifications);
    if (!ns.offscreen) put(ns, 'offscreen', offscreen);
    if (!ns.omnibox) put(ns, 'omnibox', omnibox);
    if (ns.runtime && !ns.runtime.getContexts) put(ns.runtime, 'getContexts', () => Promise.resolve([]));
  }

  // ---- config seed ------------------------------------------------------------------

  // Copy the server URL and token from the shared Keychain into extension storage, so the
  // copied Chrome code finds them where it expects them. Resolves when done; never rejects.
  async function seed() {
    const r = await native({ type: 'config' });
    const res = r.ok ? r.result : null;
    const origin = res && typeof res.baseURL === 'string' && res.baseURL && typeof res.token === 'string' && res.token ? originOf(res.baseURL) : null;
    if (!origin) { nativeCfg = null; return; } // nothing shared (any more): no proxying, storage left alone
    nativeCfg = { baseURL: res.baseURL, token: res.token, origin };

    const s = cfg.storage;
    const area = api.storage?.local;
    if (!area || !rawLocalGet) return;
    const keys = s.key ? [s.key] : [s.baseUrlField, s.tokenField, s.actorField];
    const got = (await rawLocalGet(keys)) || {};
    const cur = s.key ? (got[s.key] && typeof got[s.key] === 'object' ? got[s.key] : {}) : got;

    const next = { ...cur };
    next[s.baseUrlField] = res.baseURL;
    next[s.tokenField] = res.token;
    if (typeof cur[s.actorField] !== 'string' || !cur[s.actorField] || cur[s.actorField] === s.chromeActor) {
      next[s.actorField] = s.actor;
    }
    const changed = [s.baseUrlField, s.tokenField, s.actorField].some((f) => next[f] !== cur[f]);
    if (!changed) return;
    await area.set(s.key ? { [s.key]: next } : { [s.baseUrlField]: next[s.baseUrlField], [s.tokenField]: next[s.tokenField], [s.actorField]: next[s.actorField] });
  }
  // Keep the original storage.local.get for the seed, then make every other reader wait for the
  // seed, so Chrome code reading settings on first run sees the Keychain values, not empty ones.
  // Listener registration stays synchronous; only the reads wait (at most the native timeout).
  const localArea = api.storage?.local;
  const rawLocalGet = typeof localArea?.get === 'function' ? localArea.get.bind(localArea) : null;
  const ready = seed().catch(() => {});
  if (rawLocalGet) {
    const gatedGet = (keys, cb) => withCallback(ready.then(() => rawLocalGet(keys)), cb);
    for (const area of new Set(spaces.map((ns) => ns.storage?.local).filter(Boolean))) put(area, 'get', gatedGet);
  }

  // ---- permissions ------------------------------------------------------------------

  // Proxied calls never touch the network from the extension, so the server origin needs no
  // host permission: report it as granted instead of showing a prompt that cannot help.
  function coversOnlyServer(p) {
    const origins = p?.origins;
    if (!Array.isArray(origins) || origins.length === 0) return false;
    if (Array.isArray(p.permissions) && p.permissions.length > 0) return false;
    return origins.every((o) => o === `${nativeCfg.origin}/*`);
  }

  if (cfg.proxyApi) {
    for (const ns of spaces) {
      if (!ns.permissions) put(ns, 'permissions', {});
      const perms = ns.permissions;
      const origContains = typeof perms.contains === 'function' ? perms.contains.bind(perms) : null;
      const origRequest = typeof perms.request === 'function' ? perms.request.bind(perms) : null;
      put(perms, 'contains', (p, cb) => withCallback((async () => {
        await ready;
        if (proxyReady() && coversOnlyServer(p)) return true;
        return origContains ? origContains(p) : false;
      })(), cb));
      // request() needs the click's user gesture, so it never awaits: decide with what is known now.
      put(perms, 'request', (p, cb) => {
        if (proxyReady() && coversOnlyServer(p)) return withCallback(Promise.resolve(true), cb);
        return withCallback(origRequest ? Promise.resolve(origRequest(p)) : Promise.resolve(false), cb);
      });
    }
  }

  // ---- fetch proxy ------------------------------------------------------------------

  const OP_PREFIX = '/api/op/';

  function abortError() {
    return typeof DOMException === 'function'
      ? new DOMException('The operation was aborted.', 'AbortError')
      : Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
  }

  /** The bearer token a request carries (init headers win over a Request's), or null. */
  function bearerOf(input, init) {
    const pick = (h) => {
      if (!h) return null;
      if (typeof h.get === 'function') return h.get('authorization');
      if (Array.isArray(h)) { const e = h.find(([k]) => String(k).toLowerCase() === 'authorization'); return e ? e[1] : null; }
      for (const k of Object.keys(h)) if (k.toLowerCase() === 'authorization') return h[k];
      return null;
    };
    const v = pick(init?.headers) ?? pick(input?.headers);
    const m = typeof v === 'string' ? /^Bearer\s+(.+)$/i.exec(v.trim()) : null;
    return m ? m[1].trim() : null;
  }

  // Failures where the native side certainly sent nothing to the daemon: safe to use the network.
  const NOT_SENT = new Set(['native-unavailable', 'notConfigured', 'badRequest']);
  // Read-only ops (Chrome posts every op) may also use the network after an ambiguous failure.
  const READ_OPS = new Set(['fleet.summary', 'native.summary', 'native.notifications', 'native.board', 'sessions.list',
    'sessions.get', 'sessions.transcript', 'sessions.lastReply', 'openclaw.threads', 'openclaw.status', 'openclaw.feed',
    'tmux.capture', 'host.list', 'events.state', 'events.tail']);

  if (cfg.proxyApi && typeof g.fetch === 'function') {
    const realFetch = g.fetch;
    const passthrough = (input, init) => realFetch.call(g, input, init);

    g.fetch = async function droverSafariFetch(input, init) {
      let url;
      try {
        url = new URL(typeof input === 'string' ? input : (input?.url ?? String(input)));
      } catch {
        return passthrough(input, init);
      }
      const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
      // Cheap check first so unrelated requests (including /api/stream) never wait for config.
      if (!url.pathname.startsWith(OP_PREFIX) || (method !== 'GET' && method !== 'POST')) return passthrough(input, init);

      await ready;
      if (!proxyReady() || url.origin !== nativeCfg.origin) return passthrough(input, init);
      // A different token (e.g. the options page testing a newly typed one) must really be tested: the
      // native side then uses it instead of the stored one for this request only. Still no host permission.
      const bearer = bearerOf(input, init);
      const typedToken = bearer !== null && bearer !== nativeCfg.token ? bearer : null;

      let op;
      let args;
      try {
        op = decodeURIComponent(url.pathname.slice(OP_PREFIX.length));
        if (method === 'GET') {
          args = Object.fromEntries(url.searchParams);
        } else {
          const body = init?.body;
          let text;
          if (body === undefined || body === null) text = typeof input?.clone === 'function' ? await input.clone().text() : '';
          else if (typeof body === 'string') text = body;
          else return passthrough(input, init); // streams, FormData and the like: not ours
          args = JSON.parse(text || '{}');
        }
      } catch {
        return passthrough(input, init);
      }

      const signal = init?.signal ?? input?.signal;
      if (signal?.aborted) throw abortError();
      // `origin` lets the native side refuse when the shared server changed since this page loaded.
      const call = native({ type: 'op', op, method, args, origin: nativeCfg.origin, ...(typedToken ? { token: typedToken } : {}) }, NATIVE_OP_TIMEOUT_MS);
      const r = signal
        ? await Promise.race([call, new Promise((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true }))])
        : await call;
      if (r === null || signal?.aborted) throw abortError();

      const res = r.ok ? r.result : null;
      if (res && Number.isInteger(res.status) && typeof res.body === 'string') {
        try {
          const nullBody = [101, 204, 205, 304].includes(res.status);
          return new Response(nullBody ? null : res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
        } catch { /* bad status for Response: treated as a network failure below */ }
      }
      if (!r.ok && (NOT_SENT.has(r.error) || READ_OPS.has(op))) {
        // notConfigured also covers "the shared server changed": refresh, then let the page's own request go out.
        if (r.error === 'notConfigured') seed().catch(() => {});
        return passthrough(input, init);
      }
      // A mutation may have reached the daemon (timeout, lost answer, network error): never replay it.
      throw new TypeError('Failed to fetch');
    };
  }

  // ---- export -----------------------------------------------------------------------

  // `config` is this shim's own (secret-free) configuration, handy for debugging.
  g.__droverSafari = { native, ready, config: cfg };
})();
