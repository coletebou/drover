// A reply from an MCP server over the streamable HTTP transport: one JSON-RPC message, a JSON array of them, or an
// SSE body whose data lines carry them. Returns the messages in order (keep-alives and non-JSON data are skipped).
export function parseMcpBody(contentType, text) {
  const ct = String(contentType ?? '').toLowerCase();
  const body = String(text ?? '');
  if (!body.trim()) return [];
  const isSse = ct.includes('text/event-stream') || (!ct.includes('json') && /^(event|data|id|retry):/m.test(body));
  if (!isSse) { const j = JSON.parse(body); return Array.isArray(j) ? j : [j]; }
  const out = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, ''));
    if (!data.length) continue;
    try { const j = JSON.parse(data.join('\n')); if (Array.isArray(j)) out.push(...j); else out.push(j); } catch { /* keep-alive or non-JSON data; skip */ }
  }
  return out;
}
