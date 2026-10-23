// Server-sent events from a byte stream: `event:` and `data:` fields, a blank line ends an event, `:` lines are
// comments (the daemon's pings). Chunks may end anywhere, a line included. Pure; tests in test/tui-client.test.js.

export function createSseParser(onEvent) {
  let buf = '', from = 0, type = '', data = null;
  return {
    feed(chunk) {
      buf += chunk;
      for (;;) {
        const nl = buf.indexOf('\n', from);
        if (nl < 0) { from = buf.length; break; }
        let line = buf.slice(0, nl); if (line.endsWith('\r')) line = line.slice(0, -1);
        buf = buf.slice(nl + 1); from = 0;
        if (line === '') { if (data !== null) onEvent(type || 'message', data); type = ''; data = null; continue; }
        if (line[0] === ':') continue;
        const c = line.indexOf(':');
        const field = c < 0 ? line : line.slice(0, c);
        let value = c < 0 ? '' : line.slice(c + 1); if (value[0] === ' ') value = value.slice(1);
        if (field === 'event') type = value;
        else if (field === 'data') data = data === null ? value : `${data}\n${value}`;
      }
    },
  };
}
