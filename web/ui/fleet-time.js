// How long a host took in a fleet search, shared by the Search view and the CLI (core/search/format.js).
// perHost[].ms is the round trip from the daemon that fanned the search out; searchMs is that host's own
// search. When the round trip is much longer, the time went to the link or to a busy front daemon, not to
// the host's index (2026-10-19: six hosts at 6.5 s alike while the Mac front sat at load 43).

/** "6.6 s" or "212 ms". */
export function fmtMs(ms) {
  const r = Math.round(ms);
  return r >= 1000 ? `${(r / 1000).toFixed(1)} s` : `${r} ms`;
}

/** A host worth calling out by time (the Search view shows these inline): a second or more. */
export const slowHost = (p) => Number.isFinite(p?.ms) && p.ms >= 1000;

/** True when a second or more of the round trip was spent outside the host's own search. */
export const waitedElsewhere = (p) => Number.isFinite(p?.ms) && Number.isFinite(p?.searchMs) && p.ms - p.searchMs >= 1000;

/** "6.6 s (search 212 ms)", "212 ms", or '' when the time is unknown. */
export function hostTime(p) {
  if (!Number.isFinite(p?.ms)) return '';
  return `${fmtMs(p.ms)}${waitedElsewhere(p) ? ` (search ${fmtMs(p.searchMs)})` : ''}`;
}

/** The tooltip line: "answered in 6574 ms; its own search took 212 ms". */
export function hostTimeTitle(p) {
  if (!Number.isFinite(p?.ms)) return '';
  return `answered in ${Math.round(p.ms)} ms${Number.isFinite(p.searchMs) ? `; its own search took ${Math.round(p.searchMs)} ms` : ''}`;
}
