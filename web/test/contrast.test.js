// Readability guard: every text color token must clear WCAG contrast on every
// surface it can sit on, in both schemes. Parsed from ui/style.css so a palette
// tweak that hurts legibility fails here before anyone squints at it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const css = await readFile(path.join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'style.css'), 'utf8');

function tokens(block) {
  const out = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)) out[m[1]] = m[2];
  return out;
}
const rootBlock = css.match(/:root\s*{([\s\S]*?)}/)[1];
const lightBlock = css.match(/:root\[data-theme="light"\]\s*{([\s\S]*?)}/)[1];
const dark = tokens(rootBlock);
const light = { ...dark, ...tokens(lightBlock) };

function lum(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); }

const SURFACES = ['bg', 'bg-2', 'bg-3', 'bg-4'];
// Minimum ratio for each text token on every surface. Primary and secondary text
// aim well above AA; muted and state colors stay above AA (4.5) everywhere.
const MIN = { ink: 10, 'ink-2': 7, 'ink-3': 5.2, 'ink-4': 4.5, amber: 4.5, steel: 4.5, moss: 4.5, brick: 4.5, lilac: 4.5 };

for (const [scheme, t] of [['dark', dark], ['light', light]]) {
  for (const [name, min] of Object.entries(MIN)) {
    test(`${scheme}: --${name} reads on every surface (>= ${min}:1)`, () => {
      assert.ok(t[name], `token --${name} missing`);
      for (const s of SURFACES) {
        const r = contrast(t[name], t[s]);
        assert.ok(r >= min, `--${name} ${t[name]} on --${s} ${t[s]} is ${r.toFixed(2)}:1, need ${min}:1`);
      }
    });
  }
  test(`${scheme}: primary button label reads on the ink fill`, () => {
    assert.ok(contrast(t.bg, t.ink) >= 10);
  });
}

test('mono and small sizes are not below 13px', () => {
  const fs0 = Number(css.match(/--fs-0:\s*(\d+(?:\.\d+)?)px/)[1]);
  assert.ok(fs0 >= 13, `--fs-0 is ${fs0}px; the smallest machine text must stay readable`);
});
