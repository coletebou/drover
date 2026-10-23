// Imported first by tests that load core/cache.js through the op table, so its
// snapshots go to a temp dir instead of ~/.cache/drover. A test that created the
// real dir would also stop the one-time move of ~/.cache/apx-web on this machine.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DROVER_CACHE ??= mkdtempSync(path.join(tmpdir(), 'drover-cache-'));
