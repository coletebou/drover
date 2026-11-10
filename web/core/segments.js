// Where a truth file's daily segments live (core/events.js explains why they exist). No other imports, so the
// search indexer and any other reader can list the files without loading the event store.
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export const SEGMENT_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
/** The directory that holds a truth file's segments: the file's path without .jsonl. */
export function segmentDir(file) { return file.endsWith('.jsonl') ? file.slice(0, -'.jsonl'.length) : `${file}.d`; }
/**
 * The segment an event with this timestamp belongs in: its day (stored timestamps are ISO in UTC). A caller can set
 * its own ts; one that does not start with a date goes in today's, never in a file the reader would not list.
 */
export function segmentFor(ts, file) {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(String(ts ?? ''))?.[0] ?? new Date().toISOString().slice(0, 10);
  return path.join(segmentDir(file), `${day}.jsonl`);
}
/** Whether appends to this truth file go to segments: its segment directory exists. */
export async function segmented(file) {
  try { return (await stat(segmentDir(file))).isDirectory(); } catch { return false; }
}
export async function segmentNames(file) {
  try { return (await readdir(segmentDir(file))).filter((n) => SEGMENT_RE.test(n)).sort(); } catch { return []; }
}
/** Every file of a truth file, oldest first: the base, then each segment by day. Missing files are left to the reader. */
export async function storeFiles(file) {
  return [file, ...(await segmentNames(file)).map((n) => path.join(segmentDir(file), n))];
}
