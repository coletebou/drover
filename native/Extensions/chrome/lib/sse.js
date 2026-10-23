// Server-sent events client for GET /api/stream. Pure: fetch and timers are
// injected so node --test can drive it. The token only travels in the request
// headers built by lib/api.js (client.streamRequest()), never in logs.

/**
 * WHATWG event-stream parser.
 * @param {(e: {event: string, data: string, id: string|null, retry: number|null}) => void} onEvent
 */
export function createSseParser(onEvent) {
  let buf = '';
  let first = true;
  let skipLf = false; // previous chunk ended with CR
  let event = '';
  let data = [];
  let hasData = false;
  let id = null;
  let retry = null;

  function dispatch() {
    if (hasData) onEvent({ event: event || 'message', data: data.join('\n'), id, retry });
    event = ''; data = []; hasData = false; id = null; retry = null;
  }

  function line(l) {
    if (l === '') return dispatch();
    if (l.startsWith(':')) return;
    const i = l.indexOf(':');
    let field = l;
    let value = '';
    if (i >= 0) {
      field = l.slice(0, i);
      value = l.slice(i + 1);
      if (value.startsWith(' ')) value = value.slice(1);
    }
    if (field === 'event') event = value;
    else if (field === 'data') { data.push(value); hasData = true; }
    else if (field === 'id') { if (!value.includes('\0')) id = value; }
    else if (field === 'retry') { if (/^\d+$/.test(value)) retry = Number(value); }
  }

  return {
    push(chunk) {
      let s = String(chunk ?? '');
      if (first && s.length) { if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); first = false; }
      if (skipLf && s.length) { if (s[0] === '\n') s = s.slice(1); skipLf = false; }
      buf += s;
      let start = 0;
      for (let i = 0; i < buf.length; i++) {
        const c = buf[i];
        if (c === '\n') { line(buf.slice(start, i)); start = i + 1; }
        else if (c === '\r') {
          line(buf.slice(start, i));
          if (i + 1 < buf.length) { if (buf[i + 1] === '\n') i++; }
          else skipLf = true;
          start = i + 1;
        }
      }
      buf = buf.slice(start);
    },
    end() {
      buf = ''; event = ''; data = []; hasData = false; id = null; retry = null;
    },
  };
}

/**
 * Keep an SSE connection open, reconnecting with jittered exponential backoff.
 * @param {{ request: {url: string, init?: object}, fetch?: Function, onEvent: (event: string, data: any) => void,
 *   onState?: (state: 'connecting'|'open'|'retrying'|'error'|'closed', info?: object) => void,
 *   backoff?: {min: number, max: number}, random?: () => number, setTimer?: Function, clearTimer?: Function }} opts
 */
export function connectStream({ request, fetch: fetchImpl = globalThis.fetch, onEvent, onState = () => {}, backoff = { min: 1000, max: 30000 }, random = Math.random, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let closed = false;
  let ctrl = null;
  let timer = null;
  let attempt = 0;
  let serverRetry = null;

  const state = (s, info) => { if (!closed) { try { onState(s, info); } catch { /* ignore */ } } };

  function scheduleRetry() {
    if (closed) return;
    state('retrying');
    const base = serverRetry ?? backoff.min;
    const delay = Math.round(Math.min(backoff.max, base * 2 ** attempt) * (0.5 + random() * 0.5));
    attempt += 1;
    timer = setTimer(() => { timer = null; run(); }, delay);
  }

  async function run() {
    if (closed) return;
    state('connecting');
    ctrl = new AbortController();
    const signal = ctrl.signal;
    let res;
    try {
      res = await fetchImpl(request.url, { ...(request.init ?? {}), signal });
    } catch {
      return scheduleRetry();
    }
    if (closed) return;
    if (res.status === 401 || res.status === 403) {
      state('error', { status: res.status });
      return;
    }
    if (!res.ok || !res.body) return scheduleRetry();

    state('open');
    attempt = 0;
    const parser = createSseParser((e) => {
      if (closed) return;
      if (e.retry != null) serverRetry = e.retry;
      let parsed = e.data;
      try { parsed = JSON.parse(e.data); } catch { /* keep raw string */ }
      try { onEvent(e.event, parsed); } catch { /* a bad handler must not kill the stream */ }
    });
    const decoder = new TextDecoder();
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || closed) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
      parser.end();
    } catch { /* network error or abort */ }
    scheduleRetry();
  }

  run();

  return {
    close() {
      if (closed) return;
      const wasTimer = timer;
      if (wasTimer != null) clearTimer(wasTimer);
      timer = null;
      try { ctrl?.abort(); } catch { /* ignore */ }
      try { onState('closed'); } catch { /* ignore */ }
      closed = true;
    },
  };
}
