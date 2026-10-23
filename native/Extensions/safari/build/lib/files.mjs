// File helpers for the Safari resource build. Pure except copyTree.
import fs from 'node:fs';
import path from 'node:path';

export const SHIM_TOKEN = '/*__DROVER_SAFARI_CONFIG__*/null';
export const SHIM_TAG = '<script src="/safari-shim.js"></script>';

/**
 * Exclude patterns: "dir/" (any path segment), "*.ext" (suffix of the file name),
 * ".*" (any dotfile or dot directory), otherwise an exact path or file name.
 * @param {string} relPath POSIX relative path @param {string[]} patterns
 */
export function shouldCopy(relPath, patterns) {
  const segs = relPath.split('/').filter(Boolean);
  const base = segs[segs.length - 1] ?? '';
  for (const p of patterns ?? []) {
    if (p.endsWith('/')) {
      const dir = p.slice(0, -1);
      if (segs.slice(0, -1).includes(dir)) return false;
    } else if (p === '.*') {
      if (segs.some((s) => s.startsWith('.'))) return false;
    } else if (p.startsWith('*')) {
      if (base.endsWith(p.slice(1))) return false;
    } else if (relPath === p || base === p) {
      return false;
    }
  }
  return true;
}

/** Insert the shim script tag after <meta charset>, else after <head>. Idempotent. */
export function injectShim(html) {
  if (html.includes('src="/safari-shim.js"') || html.includes("src='/safari-shim.js'")) return html;
  const at = (re) => {
    const m = re.exec(html);
    return m ? m.index + m[0].length : -1;
  };
  let i = at(/<meta\s[^>]*charset[^>]*>/i);
  if (i < 0) i = at(/<head(?=[\s>])[^>]*>/i);
  if (i < 0) return `${SHIM_TAG}\n${html}`; // no head at all: still load the shim first
  return html.slice(0, i) + SHIM_TAG + html.slice(i);
}

const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Source of safari-background.js: shim first, then the Chrome service worker. */
export function backgroundWrapper(swPath, isModule) {
  const sw = String(swPath).replace(/^\.?\//, '');
  return isModule
    ? `import './safari-shim.js';\nimport ${q('./' + sw)};\n`
    : `importScripts('safari-shim.js', ${q(sw)});\n`;
}

/** Replace the config token in the shim template with the JSON the shim needs. */
export function renderShim(template, cfg) {
  const json = JSON.stringify({
    proxyApi: cfg.proxyApi,
    storage: cfg.storage,
    notificationIdPattern: cfg.notificationIdPattern,
  });
  if (!template.includes(SHIM_TOKEN)) throw new Error('shim template is missing the config token');
  return template.replace(SHIM_TOKEN, () => json);
}

/** Copy src into dst (created), skipping excluded files. Returns sorted POSIX relative paths. */
export function copyTree(src, dst, exclude) {
  const out = [];
  const walk = (rel) => {
    const entries = fs.readdirSync(path.join(src, rel), { withFileTypes: true });
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (shouldCopy(`${r}/_`, exclude)) walk(r); // a probe file decides whether the directory is excluded
        continue;
      }
      if (!e.isFile() || !shouldCopy(r, exclude)) continue;
      fs.mkdirSync(path.dirname(path.join(dst, r)), { recursive: true });
      fs.copyFileSync(path.join(src, r), path.join(dst, r));
      out.push(r);
    }
  };
  fs.mkdirSync(dst, { recursive: true });
  walk('');
  return out.sort();
}
