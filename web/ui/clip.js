// Clipboard, file save/open and share helpers. Copy uses the async Clipboard
// API (granted to this origin); save prefers the File System Access picker so
// the user chooses where an export lands, and falls back to a download.
import { h, btn } from './dom.js';

export async function copyText(text) {
  try { await navigator.clipboard.writeText(String(text ?? '')); return true; }
  catch {
    // Older permission state: a hidden textarea and execCommand still works on a user gesture.
    const ta = h('textarea', { style: { position: 'fixed', left: '-9999px', top: '0' } }); ta.value = String(text ?? '');
    document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove(); return ok;
  }
}

/** A small "Copy" button that says "Copied" for a moment. text may be a function (computed on click). */
export function copyButton(text, label = 'Copy', { title, cls = 'sm quiet', toast } = {}) {
  const b = btn(label, async (e) => {
    e.stopPropagation();
    const v = typeof text === 'function' ? await text() : text;
    const ok = await copyText(v);
    b.firstChild.textContent = ok ? 'Copied' : 'Copy failed';
    if (toast && ok) toast(`Copied ${typeof v === 'string' && v.length > 60 ? `${v.length} characters` : v}`, 'ok', 2000);
    setTimeout(() => { b.firstChild.textContent = label; }, 1400);
  }, { cls, title: title ?? `Copy ${label.toLowerCase().replace(/^copy /, '')} to the clipboard` });
  return b;
}

const PICKER_TYPES = {
  'text/markdown': { description: 'Markdown', accept: { 'text/markdown': ['.md'] } },
  'application/json': { description: 'JSON', accept: { 'application/json': ['.json', '.jsonl'] } },
  'text/html': { description: 'HTML', accept: { 'text/html': ['.html'] } },
  'text/plain': { description: 'Text', accept: { 'text/plain': ['.txt', '.log'] } },
};

/** Save text to a file. Returns 'saved' | 'downloaded' | 'cancelled'. */
export async function saveText(suggestedName, text, mime = 'text/plain') {
  if ('showSaveFilePicker' in window) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName, types: PICKER_TYPES[mime] ? [PICKER_TYPES[mime]] : undefined });
      const w = await handle.createWritable(); await w.write(new Blob([text], { type: mime })); await w.close();
      return 'saved';
    } catch (e) { if (e?.name === 'AbortError') return 'cancelled'; /* fall through to a download */ }
  }
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = h('a', { href: url, download: suggestedName, style: { display: 'none' } });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
}

/** Pick a local text file (File System Access, else <input type=file>). Returns { name, text } or null. */
export async function openTextFile() {
  if ('showOpenFilePicker' in window) {
    try { const [handle] = await window.showOpenFilePicker({ multiple: false }); const f = await handle.getFile(); return { name: f.name, text: await f.text() }; }
    catch (e) { if (e?.name === 'AbortError') return null; }
  }
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', style: { display: 'none' } });
    input.addEventListener('change', async () => { const f = input.files?.[0]; input.remove(); resolve(f ? { name: f.name, text: await f.text() } : null); });
    document.body.append(input); input.click();
  });
}

export function canShare(data) { try { return Boolean(navigator.share) && (navigator.canShare ? navigator.canShare(data) : true); } catch { return false; } }
export async function share(data) { try { await navigator.share(data); return true; } catch (e) { if (e?.name === 'AbortError') return false; throw e; } }

/** Read a File/Blob as base64 (no data: prefix). */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result); resolve(s.slice(s.indexOf(',') + 1)); };
    r.onerror = () => reject(r.error ?? new Error('could not read the file'));
    r.readAsDataURL(file);
  });
}

/** A standalone HTML document from a rendered node (styles inlined), for exports. */
export async function standaloneHtml(title, node) {
  let css = '';
  try { css = await (await fetch('/style.css', { cache: 'no-cache' })).text(); } catch { /* unstyled export */ }
  const theme = document.documentElement.dataset.theme;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // node was built with h(): every string in it is a text node, so outerHTML is already escaped.
  return `<!doctype html>\n<html lang="en"${theme ? ` data-theme="${esc(theme)}"` : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${css}\nbody{overflow:auto}.export{padding:18px 22px 40px;max-width:1200px;margin:0 auto}</style></head><body><main class="export"><h1>${esc(title)}</h1><p class="muted small">Exported from Drover ${esc(new Date().toLocaleString())}</p>${node.outerHTML}</main></body></html>\n`;
}
