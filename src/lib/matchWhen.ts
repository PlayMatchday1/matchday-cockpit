/* MATCH WHEN — the wall-clock model behind the drawer's DATE / START TIME / END TIME controls.
 *
 * ── THE TRAP THIS FILE IMPLEMENTS AROUND ──────────────────────────────────────────────────────
 * `startDate` and `endDate` come back from the MatchDay API with a `Z` suffix AND THEY ARE NOT
 * UTC. They are LOCAL WALL CLOCK at the pitch. `2026-08-16T19:00:00.000Z` means seven in the
 * evening in Dallas, not seven in the evening in London. The DST-aware true instants are the
 * separate server-derived `startDateUtc` / `endDateUtc`, which are READ-ONLY — we never write
 * them, the server recomputes them from the pair. (Proven again on staging 2560 this phase: a
 * lone `endDate` write moved `endDateUtc` by exactly the field's +5h CDT offset and left
 * `startDateUtc` alone.)
 *
 * ── WHY new Date() APPEARS HERE AT ALL ────────────────────────────────────────────────────────
 * The instruction is "never round-trip through a Date object", and the REASON is that a Date
 * re-reads the Z as UTC and any LOCAL accessor then lands hours off. This module constructs a
 * Date and only ever reads it back through getUTC* accessors, which return the same labelled
 * components that went in — so the round-trip is exactly lossless and carries no timezone at any
 * point. `wallRoundTrips()` below proves it on cross-midnight, cross-month, cross-year and
 * DST-boundary strings, and matchwhen-test.ts runs that proof.
 *
 * THE LINE THAT WOULD BREAK IT: a single `getHours()`, `getDate()`, `toISOString()` or
 * `toLocaleString()` in this file. Every accessor here is getUTC*. If you add one that is not,
 * every non-UTC city silently shifts by its offset and the tests above will NOT catch it unless
 * you extend them — they compare wall strings, and a local accessor is wrong by the machine's
 * own zone, which on CI is UTC.
 *
 * These four primitives lived in MatchPanel.tsx. They moved here whole, unchanged, because a
 * second surface now needs them and two copies of a timezone helper is how two screens start
 * disagreeing about when a match is. */

const p2 = (n: number) => String(n).padStart(2, "0");

/** "2026-08-16T19:00:00.000Z" -> { date: "2026-08-16", time: "19:00" }. Wall clock, verbatim. */
export function parseWall(z: string): { date: string; time: string } {
  const d = new Date(z);
  return {
    date: `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`,
    time: `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`,
  };
}

/** The value the API wants, built as TEXT. No parsing, no conversion. */
export function buildWall(date: string, time: string): string { return `${date}T${time}:00.000Z`; }

/** Wall-clock minutes since the epoch label. Only ever compared against another wallMin. */
export function wallMin(z: string): number {
  const d = new Date(z);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()) / 60000;
}

/** The inverse of wallMin. */
export function fromWallMin(min: number): string {
  const d = new Date(min * 60000);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:00.000Z`;
}

/** A date+time input pair is USABLE only when both halves are filled. An empty half must never
 *  reach buildWall — `buildWall("", "19:00")` is the string "T19:00:00.000Z", which is not a
 *  date, is not "" either, and would sail past a naive empty check straight onto the wire. */
export const wallInputsReady = (date: string, time: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(time);

/** Proof that the Date round-trip above is lossless. Exported so a test can run it rather than
 *  a comment asserting it. Returns the strings that did NOT survive; empty means all did. */
export function wallRoundTrips(samples: readonly string[]): string[] {
  return samples.filter((s) => fromWallMin(wallMin(s)) !== s);
}

export const WALL_SAMPLES: readonly string[] = [
  "2026-08-16T19:00:00.000Z",   // ordinary evening
  "2026-08-16T23:30:00.000Z",   // late, before midnight
  "2026-08-17T00:15:00.000Z",   // just after midnight
  "2026-08-31T23:45:00.000Z",   // month boundary
  "2026-12-31T23:59:00.000Z",   // year boundary
  "2026-03-08T02:30:00.000Z",   // US spring-forward morning — a real local clock skips this
  "2026-11-01T01:30:00.000Z",   // US fall-back morning — a real local clock repeats this
  "2026-02-28T12:00:00.000Z",   // non-leap end of February
];

/* ── MOVING THE WHOLE MATCH ────────────────────────────────────────────────────────────────────
 * Changing DATE or START TIME moves the match and KEEPS ITS LENGTH: the same delta is applied to
 * the end. This is the Phase 7 decision and it is why the end date follows a date change instead
 * of being clamped to the new start date — a match that ran 23:00 to 00:30 still ends the next
 * morning after you move it a week. The delta is taken from the CURRENT staged pair, not the
 * loaded one, so an end-time edit made first is not silently undone by a date edit made second. */
export function movePair(curStart: string, curEnd: string, date: string, time: string):
  { startDate: string; endDate: string } | null {
  if (!wallInputsReady(date, time)) return null;
  const newStart = buildWall(date, time);
  const delta = wallMin(newStart) - wallMin(curStart);
  return { startDate: newStart, endDate: fromWallMin(wallMin(curEnd) + delta) };
}

/* ── MOVING ONLY THE END ───────────────────────────────────────────────────────────────────────
 * END TIME changes the LENGTH, so it moves endDate and nothing else. The wire body is the diff,
 * so an end-only edit sends `{ endDate }` alone — proven writable on its own against staging 2560
 * (a match with players attached), startDate untouched.
 *
 * THE AFTER-MIDNIGHT CASE. The control is a time, but the end carries a DATE too. The end's date
 * component is kept as staged and only rolled FORWARD, by whole days, if the chosen time would
 * otherwise land at or before the start. So 23:00 -> 00:30 becomes the next morning rather than
 * a negative duration, and the end date is never clamped back to the start date.
 *
 * KEEPING THE DATE (rather than always deriving it from the start) is what lets a match longer
 * than 24 hours keep its length: staging carries 24h and 34h fixtures, and deriving "same day, or
 * next day if the time is earlier" would silently collapse those to under a day. */
export function moveEnd(curStart: string, curEnd: string, endTime: string): string | null {
  const endDate = parseWall(curEnd).date;
  if (!wallInputsReady(endDate, endTime)) return null;
  const startM = wallMin(curStart);
  let out = buildWall(endDate, endTime);
  // At most two rolls: one covers "past midnight", the second only matters for a pair that was
  // already inverted on load. Bounded so a pathological pair cannot spin.
  for (let i = 0; i < 2 && wallMin(out) <= startM; i++) out = fromWallMin(wallMin(out) + 1440);
  return out;
}

/** Whole minutes from start to end, wall clock. Negative when the pair is inverted. */
export const durationMin = (startZ: string, endZ: string) => wallMin(endZ) - wallMin(startZ);

/** "1h 30m" · "45m" · "2h". Null when there is nothing honest to show. */
export function durationLabel(startZ: string | null | undefined, endZ: string | null | undefined): string | null {
  if (!startZ || !endZ) return null;
  const m = durationMin(startZ, endZ);
  if (m <= 0) return null;                       // the error line says what is wrong instead
  const h = Math.floor(m / 60), mm = m % 60;
  return h && mm ? `${h}h ${mm}m` : h ? `${h}h` : `${mm}m`;
}

/* THE ONLY GUARD THERE IS. The API does NOT validate the pair — proven on staging 2557: an
 * endDate set one hour BEFORE startDate returned 2xx and read back inverted. Retool inverted a
 * staging match the same way. So this check is not belt-and-braces on a server rule, it IS the
 * rule, and a Save must be blocked on it rather than warned about. */
export function whenError(startZ: string | null | undefined, endZ: string | null | undefined): string | null {
  if (!startZ || !endZ) return null;
  const m = durationMin(startZ, endZ);
  if (m === 0) return "End time is the same as the start. Nothing will be saved until it is later.";
  if (m < 0) return "End time is before the start. Nothing will be saved until it is later.";
  return null;
}
