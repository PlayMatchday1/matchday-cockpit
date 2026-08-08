// Pure wall-clock date math for MatchDay's Z-labelled LOCAL timestamps.
//
// These timestamps carry a `Z` suffix but are LOCAL wall time, not UTC (see
// docs/matchday-api-facts.md — "the biggest landmine in the whole API"). NOTHING
// in this file constructs a Date or touches a timezone: it is all string and
// integer surgery, so a wall clock labelled `Z` stays exactly where it is. That
// is deliberate. `new Date("2026-08-07T18:30:00.000Z")` would parse the Z as UTC
// and, rendered anywhere but UTC, land the match hours off.
//
// Used by the Master Schedule drawer to move a match's start time and shift its
// end by the SAME amount (Phase 7 decision: a time edit owns the start/end pair
// so the duration is preserved and the pair can never silently invert).

const RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

// Days since 1970-01-01 for a proleptic-Gregorian Y-M-D (Howard Hinnant's
// days_from_civil). Integer-only; valid for any date. No Date object.
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor((yy >= 0 ? yy : yy - 399) / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
function civilFromDays(z: number): [number, number, number] {
  const zz = z + 719468;
  const era = Math.floor((zz >= 0 ? zz : zz - 146096) / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return [m <= 2 ? y + 1 : y, m, d];
}

// Wall-clock minutes since 1970-01-01T00:00 (label taken at face value, no zone).
export function wallEpochMin(iso: string): number {
  const m = RE.exec(iso);
  if (!m) throw new Error(`bad wall-clock timestamp: ${JSON.stringify(iso)}`);
  return daysFromCivil(+m[1], +m[2], +m[3]) * 1440 + (+m[4]) * 60 + (+m[5]);
}

const p2 = (n: number) => String(n).padStart(2, "0");
// Inverse of wallEpochMin — always minute-granular, seconds/millis zeroed.
export function wallFromEpochMin(min: number): string {
  const days = Math.floor(min / 1440);
  const mod = min - days * 1440;
  const [y, mo, d] = civilFromDays(days);
  return `${y}-${p2(mo)}-${p2(d)}T${p2(Math.floor(mod / 60))}:${p2(mod % 60)}:00.000Z`;
}

export const wallDate = (iso: string) => iso.slice(0, 10);   // "YYYY-MM-DD"
export const wallTime = (iso: string) => iso.slice(11, 16);  // "HH:mm"

// The value a date/time control sends: the wall clock VERBATIM (Phase 7). Never
// converted, never round-tripped through a Date.
export const buildStartDate = (date: string, time: string) => `${date}T${time}:00.000Z`;

// New endDate that preserves the loaded duration under a start-time move. Pure
// minute arithmetic; the duration is measured to the minute (the edit's grain).
export function shiftedEndDate(loadedStart: string, loadedEnd: string, newStart: string): string {
  const durMin = wallEpochMin(loadedEnd) - wallEpochMin(loadedStart);
  return wallFromEpochMin(wallEpochMin(newStart) + durMin);
}

// endDate at or before startDate — an inverted pair (reachable; the server does
// not validate it). Detected on load so the UI can warn instead of editing it.
export function isInvertedPair(startIso: string, endIso: string): boolean {
  return wallEpochMin(endIso) <= wallEpochMin(startIso);
}
