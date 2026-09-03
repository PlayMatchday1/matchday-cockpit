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
  /** `mdapi_matches.registration_price`, in CENTS. See priceLabel — null is not zero. */
  price?: number | null;
  /** `mdapi_matches.is_cancelled`. Cancelled matches are CARRIED, not dropped, so the grid's
   *  "Show cancelled" toggle has something to show. The endpoint used to filter them out. */
  cancelled?: boolean;
  /* ── THE COUNT IS TWO FIELDS, AND IT HAS TO BE ────────────────────────────────────────────
   * `players` is the TOTAL occupied count (real + fake); `fakePlayers` is the fakes among them.
   * They are `mdapi_matches.player_count` / `fake_player_count`, which the mirror sync writes
   * straight from `_count.players` / `_count.fakePlayers` (mdapiMatchesSync.ts:810-811) — so
   * they are the same two numbers gamedayModel.realCount subtracts, not a parallel measure.
   *
   * A SINGLE OCCUPANCY NUMBER WOULD BE WRONG AND WOULD LOOK RIGHT. Measured on the real
   * September 2026 Austin board: 9 matches carry fakes, and `player_count` alone overstates the
   * month by 59 players. PARMER on the 3rd is players 30, fake 22 — 8 real of 36. A grid drawing
   * 30/36 there is not slightly off, it is describing a full match that is nearly empty. */
  players?: number | null;
  fakePlayers?: number | null;
  /** `max_player_count` — the denominator. */
  capacity?: number | null;
  /** `min_player_count`. 0 means the match carries no minimum (the tourney slots). */
  minPlayers?: number | null;
};

/* THE REAL COUNT, DERIVED IN ONE PLACE. Same rule as gamedayModel.realCount and for the same
 * reason: a fake is a placeholder, not somebody who will show up. Never re-derive it at a call
 * site — that is how `players` gets drawn on a screen by accident. null when the mirror has no
 * count at all, which is distinct from a real zero. */
export function realCount(m: Pick<GridMatch, "players" | "fakePlayers">): number | null {
  if (m.players == null) return null;
  return Math.max(0, m.players - (m.fakePlayers ?? 0));
}

/* HOW FULL, AS A WORD. The only two states worth colouring:
 *   "full" — at or over capacity, anywhere in the month. Actionable in the useful direction: add
 *            a slot. This one is not time-sensitive, so it is not restricted to today.
 *   "low"  — below the match's own minimum, and ONLY on today's column. Measured on the real
 *            board: 143 of Austin's 165 September matches are below their minimum, so coloring
 *            every day would light 87% of the grid permanently with what is simply the normal
 *            state of a match that has not filled yet. Today is the one column where being short
 *            is something you can still do anything about.
 * A match with no minimum (min 0 — the tourney capacity) can never be "low". */
export function fillTone(m: GridMatch, isToday: boolean): "full" | "low" | "" {
  const real = realCount(m);
  if (real == null) return "";
  if (m.capacity != null && m.capacity > 0 && real >= m.capacity) return "full";
  if (isToday && (m.minPlayers ?? 0) > 0 && real < (m.minPlayers as number)) return "low";
  return "";
}

/** "12/18", or "—" when the mirror carries no count. A real 0 renders "0/18", not "—". */
export function countLabel(m: GridMatch): string {
  const real = realCount(m);
  if (real == null) return "—";
  return m.capacity != null && m.capacity > 0 ? `${real}/${m.capacity}` : String(real);
}

/* ── THE PRICE, IN CENTS, AND NULL IS NOT ZERO ─────────────────────────────────────────────────
 * registration_price is CENTS: 1500 is $15.00, not $1,500. Dividing by 100 is the whole
 * conversion and there is nowhere else in this file it may be done.
 *
 * A NULL RENDERS NOTHING. Not "$0.00", not "—", not "free". A missing price and a genuinely free
 * match are different facts and $0.00 asserts the second one. The caller omits the element
 * entirely when this returns null, so the entry is `time · field` with no gap where a price was.
 *
 * A ZERO RENDERS "$0", because that is what it is. This is not hypothetical: 347 of the 10,170
 * matches in the mirror carry price 0 — 18 in June 2026 alone. Collapsing zero into the null case
 * would hide every free match on the calendar.
 *
 * THE CENTS GO ONLY WHEN THERE ARE NONE. $12.00 is $12 and the ".00" was noise in a 145px cell;
 * $9.90 keeps its cents, because rounding it to $10 states a price nobody is charged. Both cases
 * are real in the mirror: every September 2026 match across all cities is a whole dollar, and the
 * 70 Dallas matches at 990 cents (Oct 2025 – Jun 2026) are the ones that prove the other branch.
 *
 * MEASURED 2026-09-01: 0 of 10,170 non-deleted matches have a NULL price — proven by the
 * complementary count, `registration_price >= 0` returning all 10,170. The null branch is
 * therefore defensive rather than load-bearing, and it is kept because the column is nullable and
 * a create that omits the field would land one. */
export function priceLabel(cents: number | null | undefined): string | null {
  if (cents == null || typeof cents !== "number" || !Number.isFinite(cents)) return null;
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

export type GridDay = {
  iso: string;
  /** Day of the month, 1-31 — what the cell shows. */
  day: number;
  /** False for the padding days at either end: dimmed, and never given matches. */
  inRange: boolean;
  isToday: boolean;
  /** Strictly before today. A day that has run has nothing left to decide, so the grid lets it
   *  recede rather than compete with the days that do. */
  isPast: boolean;
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
        isPast: dIso < todayIso,
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

/* ── WHAT THE ARROWS DO IN MONTH VIEW ─────────────────────────────────────────────────────────
 * Step a WHOLE CALENDAR MONTH, taken from where the current range STARTS. Two things follow from
 * that, and both are deliberate:
 *
 *   - It writes the SAME `range` state the from/to inputs edit. There is one piece of state and
 *     two ways to set it, so they cannot disagree — which is the entire defect being fixed here.
 *     The old arrows moved `week.weekStart`, which the month grid does not read, so they changed
 *     the header and left the grid where it was.
 *   - From a custom range (say the 5th to the 20th) it snaps to a whole month rather than sliding
 *     the span, because "next" beside a month grid means the next month. The header prints the
 *     real range either way, so a custom span is never labelled as a month it is not.
 */
export function shiftRangeMonth(r: { from: string; to: string }, delta: number): { from: string; to: string } {
  const d = D(`${r.from.slice(0, 7)}-01`);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return defaultRange(iso(d));
}

/** "September 2026", or "Sep 2026 – Oct 2026" when the range spans months. */
const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
export function rangeTitle(from: string, to: string): string {
  const a = `${MONTHS[Number(from.slice(5, 7)) - 1]} ${from.slice(0, 4)}`;
  const b = `${MONTHS[Number(to.slice(5, 7)) - 1]} ${to.slice(0, 4)}`;
  return a === b ? a : `${a} – ${b}`;
}
