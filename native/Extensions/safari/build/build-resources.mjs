#!/usr/bin/env node
// Builds Extensions/safari/Resources from the Chrome extension (or the placeholder).
// Zero dependencies, node >= 18. See DESIGN.md "Build" for the numbered steps.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { transformManifest } from './lib/manifest.mjs';
import { copyTree, injectShim, backgroundWrapper, renderShim } from './lib/files.mjs';

const SAFARI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** realpath of the nearest existing ancestor, with the missing tail re-appended. */
function realish(p) {
  const tail = [];
  let cur = path.resolve(p);
  while (!fs.existsSync(cur)) {
    tail.unshift(path.basename(cur));
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return path.join(fs.realpathSync(cur), ...tail);
}

/** Only ever empty a directory named Resources or one inside the temp dir. */
function assertSafeOutDir(outDir, sourceDir) {
  const out = realish(outDir);
  const tmp = fs.realpathSync(os.tmpdir());
  const inTmp = out !== tmp && out.startsWith(tmp + path.sep);
  if (path.basename(out) !== 'Resources' && !inTmp) {
    throw new Error(`refusing to clean "${outDir}": the out dir must be named Resources or live inside the temp dir`);
  }
  const src = realish(sourceDir);
  if (out === src || src.startsWith(out + path.sep) || out.startsWith(src + path.sep)) {
    throw new Error('refusing to clean an out dir that overlaps the source dir');
  }
}

function gitShortSha(dir) {
  try {
    const sha = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%h', '--', '.'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return sha || null;
  } catch {
    return null;
  }
}

/**
 * @param {{ chromeDir?: string, outDir?: string, configPath?: string, strict?: boolean, log?: (s: string) => void }} opts
 * @returns {{ source: string, files: string[], notes: string[], outDir: string }}
 */
export function build({ chromeDir, outDir, configPath, strict = false, log = console.log } = {}) {
  const cfg = JSON.parse(fs.readFileSync(configPath ?? path.join(SAFARI_DIR, 'safari.config.json'), 'utf8'));
  const chrome = path.resolve(chromeDir ?? path.join(SAFARI_DIR, cfg.chromeDir));
  const out = path.resolve(outDir ?? path.join(SAFARI_DIR, cfg.outDir));

  const hasChrome = fs.existsSync(path.join(chrome, 'manifest.json'));
  const placeholder = path.join(SAFARI_DIR, 'placeholder');
  const srcDir = hasChrome ? chrome : placeholder;

  // Guard first so a bad --out never deletes anything (also before the strict failure).
  assertSafeOutDir(out, srcDir);
  const notes = [];
  if (!hasChrome) {
    const msg = 'Chrome extension manifest.json not found, building the placeholder';
    if (strict) throw new Error(`${msg} (--strict)`);
    log(`warning: ${msg}`);
    notes.push(msg);
  }

  // 2. empty the out dir
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  // 3. copy everything not excluded
  const copied = copyTree(srcDir, out, cfg.exclude);

  // 4. shim
  const template = fs.readFileSync(path.join(SAFARI_DIR, 'shim', 'safari-shim.js'), 'utf8');
  fs.writeFileSync(path.join(out, 'safari-shim.js'), renderShim(template, cfg));

  // 5. background wrapper
  const chromeManifest = JSON.parse(fs.readFileSync(path.join(srcDir, 'manifest.json'), 'utf8'));
  const sw = chromeManifest.background?.service_worker ?? chromeManifest.background?.scripts?.[0];
  if (sw) {
    fs.writeFileSync(path.join(out, 'safari-background.js'), backgroundWrapper(sw, chromeManifest.background.type === 'module'));
  } else {
    notes.push('no background script in the Chrome manifest, no safari-background.js written');
  }

  // 6. shim in every html page
  let pages = 0;
  for (const rel of copied.filter((f) => f.endsWith('.html'))) {
    const p = path.join(out, rel);
    fs.writeFileSync(p, injectShim(fs.readFileSync(p, 'utf8')));
    pages++;
  }

  // 7. manifest
  const t = transformManifest(chromeManifest, cfg);
  notes.push(...t.notes);
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(t.manifest, null, 2) + '\n');

  // 8. build info (no timestamps: deterministic)
  const source = hasChrome ? 'Extensions/chrome' : 'placeholder';
  const info = { source, chromeCommit: hasChrome ? gitShortSha(chrome) : null, notes };
  fs.writeFileSync(path.join(out, 'BUILD-INFO.json'), JSON.stringify(info, null, 2) + '\n');

  const files = [...new Set([...copied, 'safari-shim.js', ...(sw ? ['safari-background.js'] : []), 'manifest.json', 'BUILD-INFO.json'])].sort();
  log(`safari resources: source=${source}, ${copied.length} files copied, ${pages} html pages patched, ${notes.length} notes`);
  for (const n of notes) log(`  - ${n}`);
  return { source, files, notes, outDir: out };
}

function parseArgs(argv) {
  const o = { strict: false };
  const val = (i, flag) => {
    if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--strict') o.strict = true;
    else if (a === '--chrome') o.chromeDir = path.resolve(val(i++, a));
    else if (a === '--out') o.outDir = path.resolve(val(i++, a));
    else if (a === '--config') o.configPath = path.resolve(val(i++, a));
    else throw new Error(`unknown argument "${a}"`);
  }
  return o;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    build(parseArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(`build-resources: ${err.message}`);
    process.exit(1);
  }
}
