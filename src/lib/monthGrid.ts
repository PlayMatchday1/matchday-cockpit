/* THE MONTH GRID — pure. Nothing here fetches, nothing renders.
 *
 * ── EVERY DATE IS A YYYY-MM-DD STRING ─────────────────────────────────────────────────────────
 * A match's `date` came off `start_date` by slicing the string, because start_date is LOCAL WALL
 * CLOCK despite the Z. Bucketing it through a Date would re-shift it and drop a 9pm Sunday match
 * into Monday. The grid therefore does its arithmetic on UTC-midnight Dates — which are calendar
 * bounds, not instants, and cannot shift — and compares everything else as text.
 *
 * ── WHOLE WEEKS, MONDAY FIRST ─────────────────────────────────────────────────────────────────
 * The grid is padded out to whole weeks at both ends, so a range starting on a Thursday still
 * renders a full row. Padding days are OUT OF RANGE: dimmed, and they hold no matches even if a
 * match falls on them, because showing a match on a day the operator did not ask for is showing
 * them something outside the range they set.
 */

export type GridMatch = {
  apiId: number; city: string; date: string; time: string; minutes: number;
  venue: string; name: string; veo: boolean;
};

export type GridDay = {
  iso: string;
  /** Day of the month, 1-31 — what the cell shows. */
  day: number;
  /** False for the padding days at either end: dimmed, and never given matches. */
  inRange: boolean;
  isToday: boolean;
  matches: GridMatch[];
};

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const shift = (isoStr: string, n: number) => { const d = D(isoStr); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

/** ISO weekday, 1 = Monday … 7 = Sunday. getUTCDay is 0 = Sunday, hence the rotation. */
export const isoDow = (isoStr: string): number => ((D(isoStr).getUTCDay() + 6) % 7) + 1;

/** The Monday on or before `isoStr`. */
export const mondayOnOrBefore = (isoStr: string): string => shift(isoStr, -(isoDow(isoStr) - 1));
/** The Sunday on or after `isoStr`. */
export const sundayOnOrAfter = (isoStr: string): string => shift(isoStr, 7 - isoDow(isoStr));

/**
 * Build the grid. Weeks are rows of exactly seven days, Monday first, from the Monday on or before
 * `from` to the Sunday on or after `to` — so a range crossing a month boundary simply keeps going
 * as consecutive weeks rather than starting a second calendar.
 */
export function buildMonthGrid(
  from: string, to: string, matches: readonly GridMatch[], todayIso: string,
): GridDay[][] {
  const byDate = new Map<string, GridMatch[]>();
  for (const m of matches) {
    // OUT-OF-RANGE MATCHES ARE DROPPED HERE, not hidden at render time — a padding cell must be
    // genuinely empty, not merely styled as though it were.
    if (m.date < from || m.date > to) continue;
    byDate.set(m.date, [...(byDate.get(m.date) ?? []), m]);
  }
  for (const list of byDate.values()) {
    list.sort((a, b) => a.minutes - b.minutes || a.venue.localeCompare(b.venue) || a.apiId - b.apiId);
  }

  const weeks: GridDay[][] = [];
  const last = sundayOnOrAfter(to);
  let cursor = mondayOnOrBefore(from);
  /* A HARD CEILING. The route caps the range at 92 days, so 20 weeks is unreachable in practice —
   * it is here so a bad `to` can never spin this loop rather than throw. */
  for (let guard = 0; cursor <= last && guard < 20; guard++) {
    const week: GridDay[] = [];
    for (let i = 0; i < 7; i++) {
      const dIso = shift(cursor, i);
      const inRange = dIso >= from && dIso <= to;
      week.push({
        iso: dIso,
        day: Number(dIso.slice(8, 10)),
        inRange,
        isToday: dIso === todayIso,
        matches: inRange ? (byDate.get(dIso) ?? []) : [],
      });
    }
    weeks.push(week);
    cursor = shift(cursor, 7);
  }
  return weeks;
}

/* ── THE FILTERS ───────────────────────────────────────────────────────────────────────────────
 * City is single-select, as it already is on the week view. Field is MULTI-select, and an empty
 * selection means ALL — the same convention the city chips use, so the two rows behave alike. */
export function applyFilters(
  matches: readonly GridMatch[], city: string | null, fields: ReadonlySet<string>,
): GridMatch[] {
  return matches.filter((m) => (!city || m.city === city) && (fields.size === 0 || fields.has(m.venue)));
}

/** The fields that actually have a match in what is on screen — the chip row is built from THIS,
 *  so it can never offer a filter with nothing behind it. */
export const fieldsAvailable = (matches: readonly GridMatch[], city: string | null): string[] =>
  [...new Set(matches.filter((m) => !city || m.city === city).map((m) => m.venue))].sort();

/**
 * RECONCILE A SELECTION AGAINST WHAT IS NOW AVAILABLE. When the range or the city changes, a
 * selected field may no longer have any matches. Keeping it would silently filter the grid down to
 * nothing on a filter the operator can no longer see; dropping it silently would change what they
 * are looking at without saying so. So it is dropped AND reported, and the header says which.
 */
export function reconcileFields(
  selected: ReadonlySet<string>, available: readonly string[],
): { kept: Set<string>; dropped: string[] } {
  const have = new Set(available);
  const kept = new Set<string>();
  const dropped: string[] = [];
  for (const f of selected) {
    if (have.has(f)) kept.add(f);
    else dropped.push(f);
  }
  return { kept, dropped: dropped.sort() };
}

/** "3 of 6 fields" — or "All fields" when nothing is selected. The count is always the truth about
 *  what is on screen, so a subset can never be mistaken for the whole. */
export function fieldCountLabel(selected: ReadonlySet<string>, available: readonly string[]): string {
  if (selected.size === 0) return `All fields (${available.length})`;
  return `${selected.size} of ${available.length} field${available.length === 1 ? "" : "s"}`;
}

/** The default range: the calendar month containing `todayIso`. */
export function defaultRange(todayIso: string): { from: string; to: string } {
  const first = `${todayIso.slice(0, 7)}-01`;
  const d = D(first);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);                       // day 0 of the next month = last day of this one
  return { from: first, to: iso(d) };
}

/** "September 2026", or "Sep 2026 – Oct 2026" when the range spans months. */
const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
export function rangeTitle(from: string, to: string): string {
  const a = `${MONTHS[Number(from.slice(5, 7)) - 1]} ${from.slice(0, 4)}`;
  const b = `${MONTHS[Number(to.slice(5, 7)) - 1]} ${to.slice(0, 4)}`;
  return a === b ? a : `${a} – ${b}`;
}
