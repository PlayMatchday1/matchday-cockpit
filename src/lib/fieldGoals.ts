/* 2026 DAILY MATCHES — the arithmetic, and the one filter that decides which matches count.
 *
 * ── "DAILY MATCHES" IS NOT MATCHES COUNTED ────────────────────────────────────────────────────
 *     one match = 18 spots · daily = (spots ÷ 18) ÷ days elapsed · weekly = daily × 7
 * A 36-spot match counts as two. Checked against two venues whose real capacity was known: ATH
 * Pearland runs 40-spot matches and the sheet says 2.4 a day (40/18 = 2.2); Soccer Central ran 36
 * and 32 on 2026-09-10 and the sheet says 3.9 (68/18 = 3.8).
 *
 * ── FILLED SPOTS, NOT CAPACITY, AND IT IS MEASURED ────────────────────────────────────────────
 * player_count, never max_player_count. September 2026 reads 18.0 a day on filled spots and 50.3 on
 * capacity, and 13 of 25 name-matched venues reproduce the sheet exactly on filled spots against 1
 * on capacity. This page measures DEMAND. A supply version would be a different page.
 *
 * ── THE SEPTEMBER COLUMN IS AS OF READ, NOT AS OF DATE ────────────────────────────────────────
 * player_count is LIVE and has no history: a match on the 8th that held 14 spots when Ryan's sheet
 * was made may hold 18 now, and this page will read the 18. So September's number moves overnight
 * without any match being added, and that is correct rather than a bug — it is the current truth
 * about a past day. It is also why the sheet cannot be reproduced exactly: reconstructing the match
 * set as of 2026-09-11 (start_date <= the 11th, D=11) lands 12 of 22 venues exactly against 13 of
 * 23 reading today, so the residual is spot drift and no divisor fixes it. 17 of 22 are within 0.1
 * in every combination, which is what confirms the formula.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { todayBusinessDate } from "./goalPace";

/** One match is eighteen spots. The whole page is arithmetic on this. */
export const SPOTS_PER_MATCH = 18;

/** A match as this page needs it. Narrow on purpose: the maths must be exercisable without a row. */
export type GoalMatch = {
  field_id: number | null;
  start_date: string;
  player_count: number | null;
  is_cancelled?: boolean | null;
};

/* ── THE MATCH-SET FILTER, AND IT IS THE ONLY ONE ─────────────────────────────────────────────
 * THE ROW TABLE AND THE TWELVE-MONTH CHART BOTH READ THIS FUNCTION AND NOTHING ELSE. If a market is
 * later excluded from these goals, it is one line here and the table and the chart move together.
 * The fault this prevents is the spreadsheet's own: a total that disagrees with the rows under it —
 * bars sitting above a table that no longer counts the same matches.
 *
 * Today it excludes exactly two things, both of which are "this match did not happen":
 *   · a cancelled match — is_cancelled is the policy flag's opposite and the one that means it
 *   · a match with no field_id, which cannot belong to any row
 * Deleted rows never arrive here: the queries filter deleted_at IS NULL in SQL. */
export function countsTowardGoals(m: GoalMatch): boolean {
  if (m.is_cancelled === true) return false;
  if (m.field_id == null) return false;
  return true;
}

/** The year this page is about. One constant so the route, the chart and the seed agree. */
export const GOAL_YEAR = 2026;

export const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "2026-09-01" — the key a target row is stored under. */
export const monthKey = (year: number, monthIndex0: number): string =>
  `${year}-${String(monthIndex0 + 1).padStart(2, "0")}-01`;

/** The wall-clock month a match belongs to. start_date carries a Z it does not mean, so it is
 *  SLICED, never parsed — the trap that costs hours every time it is forgotten. */
export const matchMonthIndex = (startDate: string, year: number = GOAL_YEAR): number | null => {
  const s = String(startDate);
  if (!s.startsWith(`${year}-`)) return null;
  const m = Number(s.slice(5, 7));
  return m >= 1 && m <= 12 ? m - 1 : null;
};

/* ── THE CALENDAR IS CHICAGO'S, NOT THE RUNTIME'S ─────────────────────────────────────────────
 * daysElapsed used now.getFullYear() / getMonth() / getDate(). Those are LOCAL getters, and the
 * fix is not to swap them for the UTC ones: a Vercel function's local zone IS UTC, so they were
 * already returning UTC calendar parts. The zone has to be named.
 *
 * MEASURED: at 2026-09-26T00:05Z the Chicago date is still 25 Sep, but the runtime read 26, so the
 * divisor stepped at 7pm Chicago instead of midnight and the average fell for five hours — 3.8% on
 * the 25th, 50% on the 1st. And the boundary MOVES: UTC midnight is 7pm Chicago today and 6pm from
 * 1 November, so offset arithmetic would go wrong that day. todayBusinessDate formats through Intl
 * in BUSINESS_TZ and is DST-correct by construction.
 *
 * ── AND THE CURRENT MONTH COUNTS COMPLETED DAYS ONLY ────────────────────────────────────────
 * Through the END OF YESTERDAY, today excluded. The figure then changes once a day instead of
 * drifting all afternoon as bookings land. A finished month is untouched: it divides by its own
 * length. A future month has no elapsed days and no average.
 *
 * DAY ONE HAS NO COMPLETED DAY. It returns days 0 with partial true, which is not the same state
 * as a future month (days 0, partial false) and must not render as 0.0 — see hasNoCompletedDay. */
export function daysElapsed(monthIndex0: number, year: number, now: Date): { days: number; of: number; partial: boolean } {
  const of = new Date(year, monthIndex0 + 1, 0).getDate();
  const [ty, tm, td] = todayBusinessDate(now).split("-").map(Number);
  const curMonth = tm - 1;
  if (ty > year || (ty === year && curMonth > monthIndex0)) return { days: of, of, partial: false };
  if (!(ty === year && curMonth === monthIndex0)) return { days: 0, of, partial: false };
  return { days: td - 1, of, partial: true };
}

/* ── THE ONE DAY WITH NOTHING TO AVERAGE ──────────────────────────────────────────────────────
 * On the 1st, no day has completed, so the current month has no average — a different statement
 * from "the average is zero", which is what dividing by one would have said. Distinguished from a
 * FUTURE month by `partial`, because a future month is not awaiting anything. */
export const hasNoCompletedDay = (cell: { days: number; partial?: boolean }): boolean =>
  cell.partial === true && cell.days === 0;

/** The Chicago calendar date one day before `now`, as YYYY-MM-DD. Differenced through Date.UTC on
 *  the calendar parts, so a DST boundary cannot add or drop an hour and move the date. */
export function businessYesterday(now: Date): string {
  const [y, m, d] = todayBusinessDate(now).split("-").map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}-${String(prev.getUTCDate()).padStart(2, "0")}`;
}

/** The month index (0-11) and year the page is CURRENTLY on, in Chicago rather than the runtime. */
export function businessMonthIndex(now: Date): { year: number; monthIndex0: number } {
  const [y, m] = todayBusinessDate(now).split("-").map(Number);
  return { year: y, monthIndex0: m - 1 };
}

/* ── WHICH MATCHES THE CURRENT MONTH'S NUMERATOR MAY COUNT ────────────────────────────────────
 * Only those that have actually been played: start_date on or before yesterday. A match later
 * today, or later this month, brings its bookings-so-far with it and inflates a figure whose
 * divisor covers completed days only — worst at the start of a month, when most of the month's
 * matches are still ahead. MEASURED on 2026-09-25: 73 of September's 383 counted matches were
 * still to come and carried 172 of 7,897 spots, reading 17.55 against 17.17 on played matches.
 *
 * SLICED, NEVER PARSED. start_date is local wall clock carrying a Z it does not mean, so the
 * comparison is string against string — the same trap matchMonthIndex exists to avoid.
 *
 * ONE BOUNDARY, CHICAGO'S. Atlanta runs an hour ahead, so a late Atlanta match could in principle
 * sit either side of a midnight that is not its own; the estate is otherwise America/Chicago and
 * one business calendar is what every other figure on this page already uses. */
export const playedByYesterday = (startDate: string, yesterdayYmd: string): boolean =>
  String(startDate).slice(0, 10) <= yesterdayYmd;

/** spots ÷ 18 ÷ days, at FULL PRECISION. Rounding happens at render and nowhere else: the sheet's
 *  own 29 rows sum to 16.6 against a stored total of 16.7, which is what rounding early looks
 *  like. Zero days elapsed is no average rather than a division by zero. */
export const dailyAverage = (spots: number, days: number): number =>
  days > 0 ? spots / SPOTS_PER_MATCH / days : 0;

export const weekly = (daily: number): number => daily * 7;

/* ── THE BAND IS THE SHEET'S OWN LEGEND, KEYED ON THE DAILY GAP ───────────────────────────────
 * In both units. A threshold that moves when you press Weekly is a different metric wearing one
 * name. LEVEL IS NOT ABOVE: a field sitting exactly on its goal has a gap of 0 and belongs in
 * "within 0.49", which is what the legend says. */
export type Band = "behind" | "warn" | "near" | "over";
export function band(dailyGap: number): Band {
  if (dailyGap < 0) return "over";
  if (dailyGap < 0.5) return "near";
  if (dailyGap < 1) return "warn";
  return "behind";
}

/* ── THE RAMP IS DERIVED, NEVER STORED ────────────────────────────────────────────────────────
 * October and November are a straight line from the CURRENT September actual to whatever the
 * December goal is right now, so editing December moves both suggestions with it. Storing them
 * would leave two numbers ramping toward a target nobody holds any more.
 * Null December means nothing to ramp to — an absent target, not a zero. */
export function ramp(septemberActual: number, decemberGoal: number | null, steps = 3): (number | null)[] {
  if (decemberGoal == null) return Array.from({ length: steps }, () => null);
  return Array.from({ length: steps }, (_, i) =>
    septemberActual + (decemberGoal - septemberActual) * ((i + 1) / steps));
}

/** The December total counts only the rows that HAVE a December target. An absent target is not a
 *  zero and must never be summed as one. */
export const sumTargets = (targets: (number | null | undefined)[]): number =>
  targets.reduce<number>((s, t) => s + (t ?? 0), 0);

/** One decimal for daily, whole numbers for weekly — the precision each unit can carry. */
export const fmtUnit = (daily: number, unit: "day" | "week"): string =>
  unit === "day" ? daily.toFixed(1) : weekly(daily).toFixed(0);

/* ── WHAT A ROW IS KEYED ON ───────────────────────────────────────────────────────────────────
 * A venue, through fin_venue_fields — an ID join the estate already keeps. mdapi_matches carries 46
 * field_ids in 2026 for 35 venues, because a venue runs several fields (ATH Pearland is field 22
 * AND "Tourney ATH Pearland"; Soccer Central is 102 and 199). One goal belongs to the venue.
 * A field with no venue mapping keys on itself — Warsaw's Bemowo (1684) is the only one today, and
 * a venue-only key would have dropped a whole city silently. */
export const rowKeyForField = (fieldId: number, venueOf: Map<number, number>): string =>
  venueOf.has(fieldId) ? `v${venueOf.get(fieldId)}` : `f${fieldId}`;

export const rowKeyOf = (r: { venue_id: number | null; field_id: number | null; id: string }): string =>
  r.venue_id != null ? `v${r.venue_id}` : r.field_id != null ? `f${r.field_id}` : `s${r.id}`;

/** Pull every 2026 match this page counts, through the caller's own client (so RLS applies). */
export async function fetchGoalMatches(
  supabase: SupabaseClient,
  selectAll: <T>(make: () => { range: (a: number, b: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }> }) => Promise<T[]>,
  year: number = GOAL_YEAR,
): Promise<GoalMatch[]> {
  const rows = await selectAll<GoalMatch>(() =>
    supabase
      .from("mdapi_matches")
      .select("field_id, start_date, player_count, is_cancelled")
      .gte("start_date", `${year}-01-01T00:00:00`)
      .lt("start_date", `${year + 1}-01-01T00:00:00`)
      .is("deleted_at", null)
      .order("api_id") as never);
  return rows.filter(countsTowardGoals);
}

/* ════════════════════════════════════════════════════════════════════════════════════════════════
 * WHICH ROWS COUNT, WHICH ROWS FOLD, AND IN WHAT ORDER
 *
 * Ryan: "there should be a way to hide to old rows we dont have games anymore also to remove count
 * fields like for instance warsaw is a partner on a different stripe so that one too" and
 * "there should also be organize by gap or by city".
 *
 * TWO EXCLUSIONS THAT MUST NOT BE CONFLATED:
 *
 *   DORMANT — computed. No match in the month on screen. It folds into one line at the foot of the
 *   table and STILL COUNTS everywhere: a field that ran matches in June contributed to June, and
 *   the year chart keeps it. Dormancy is about the table's length, not the arithmetic. A control
 *   that did both would mean a field going quiet for a month silently left the year's numbers.
 *
 *   NOT COUNTED — stored, deliberate, and the only one that changes a number. It leaves every total
 *   AND the chart, through rowCountsTowardTotals() and nothing else. Rows that exclude and bars
 *   that do not would put the chart above the table's own sum, which is the exact fault the
 *   spreadsheet has.
 */

/** THE PREDICATE. The row table and the twelve-month chart both read this and nothing else. */
export const rowCountsTowardTotals = (row: { notCounted?: boolean | null }): boolean =>
  row.notCounted !== true;

/** Quiet in the month on screen: no match played, whatever the spots say. */
export const isDormantIn = (
  row: { monthly: { matches?: number }[] },
  monthIndex0: number,
): boolean => (row.monthly?.[monthIndex0]?.matches ?? 0) === 0;

/* ── NO NUMBER RENDERS AS "-0" ───────────────────────────────────────────────────────────────────
 * ATH Pearland sits 0.004 above its goal, so the gap rounded to one decimal and printed with its
 * sign came out as "-0.0". A minus sign in front of a zero is not a number anybody means. The fix
 * is to normalise the ROUNDED value, so what is printed and what is banded are the same thing. */
export const roundTo = (v: number, dp: number): number => {
  const f = 10 ** dp;
  const r = Math.round(v * f) / f;
  return r === 0 ? 0 : r;   // kills -0 before it can be formatted
};

/** The displayed daily/weekly figure, sign-safe. */
export const fmtSigned = (daily: number, unit: "day" | "week"): string => {
  const shown = unit === "day" ? roundTo(daily, 1) : roundTo(weekly(daily), 0);
  const s = unit === "day" ? shown.toFixed(1) : shown.toFixed(0);
  return shown > 0 ? `+${s}` : s;
};

/* ── THE BAND IS KEYED ON WHAT THE PAGE SHOWS ────────────────────────────────────────────────────
 * Still the DAILY gap in both units — a threshold that moves when you press Weekly is a different
 * metric wearing one name — but on the ROUNDED daily gap, so the dot and the printed number can
 * never disagree. That is what makes ATH Pearland green: 0.004 above goal prints as 0.0, and the
 * sheet's own legend puts level in "within 0.49" rather than "already above". A field genuinely
 * ahead (-0.2) is still dark. */
export const bandForDisplay = (dailyGap: number): Band => band(roundTo(dailyGap, 1));

/* ── THE ORDER, AND IT IS WHY THE COLOURS LOOKED WRONG ───────────────────────────────────────────
 * In an alphabetical list nobody can infer a rule where +3 weekly is green and +4 is amber (0.43
 * and 0.57 daily — the rule is right, the order hid it). In gap order the dots run red, amber,
 * green, dark in sequence and the rule explains itself with no legend.
 *
 * A ROW WITH NO GOAL HAS NO GAP, so it cannot take part in a gap sort: it goes LAST under every
 * order rather than being treated as a zero gap and landing in the middle of the work. Ties break
 * on the field name, so the order is stable between loads. */
export type GoalSort = "gap" | "city" | "name";

export function sortGoalRows<T extends { name: string; city?: string | null; gapDaily: number | null }>(
  rows: T[],
  sort: GoalSort,
): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  return [...rows].sort((a, b) => {
    const aNo = a.gapDaily == null, bNo = b.gapDaily == null;
    if (aNo !== bNo) return aNo ? 1 : -1;          // no goal, no gap, last
    if (sort === "gap") {
      if (aNo && bNo) return byName(a, b);
      return (b.gapDaily as number) - (a.gapDaily as number) || byName(a, b);
    }
    if (sort === "city") {
      return (a.city ?? "").localeCompare(b.city ?? "") || byName(a, b);
    }
    return byName(a, b);
  });
}

/* ════════════════════════════════════════════════════════════════════════════════════════════════
 * THE CITY GRAIN
 *
 * Ryan: "I want to add a city view so I can see the gap per city too for each month" and "should
 * have drop down per city to see the fields under each city if you want."
 *
 * ── IT ROLLS UP THE ROWS THE PAGE ALREADY COUNTS, AND NOTHING ELSE ────────────────────────────
 * Same predicate (rowCountsTowardTotals), same September figure (monthly[cur].daily), same
 * December rule (an absent target is not a zero). A city sum built on its own filter would miss
 * the headline above it by a rounding amount nobody could find.
 *
 * ── OCTOBER AND NOVEMBER ARE THE SUM OF THE ROWS' OWN RAMPS, NOT A RAMP OF THE CITY TOTAL ─────
 * The two are equal ONLY when every row in the city has a December target, and on this estate they
 * do not: eleven counted fields carry a September actual and no December goal, so their September
 * is inside the city's total and their December is inside nothing. MEASURED on production
 * 2026-09-23: the estate October is 20.54 summed from the rows' ramps — which is what the year
 * chart draws — against 20.64 ramped from the aggregate. 0.11 apart, with no visible symptom.
 *
 * So this sums each row's own ramp, exactly as the twelve-month chart does. The city view then
 * equals the sum of its fields BY CONSTRUCTION rather than by a linearity argument that the data
 * does not satisfy.
 *
 * ── A ROW WITH NO CITY LANDS SOMEWHERE VISIBLE ────────────────────────────────────────────────
 * MEASURED on production 2026-09-23: every counted EXISTING row has a city (it comes off
 * fin_venues.city through fin_venue_fields, and all 40 venues carry one). All nine SLOTS have a
 * null city, and five of them hold 3.5 of the 28.2 December goal — 12.4% of the number the company
 * is held to. Dropping them would leave the city column summing to 24.7 under a tile reading 28.2,
 * which fails as arithmetic and reads as a bug in the rollup.
 *
 * They are not folded into a city by parsing their names. The convention is "New Field - Houston",
 * it is enforced nowhere, and it is ALREADY broken: "New Field - Oklahoma" against a venue city
 * string of "OKC" would have produced an eighth city that is really the seventh.
 */

/** The row a city-less field lands under. It is a bucket, not a city, and it says so. */
export const NO_CITY = "No city set";

/** A field inside a city's drawer. Nulls are absences and render as a dash, never as a zero. */
export type CityFieldRow = {
  key: string; name: string; kind: "existing" | "slot";
  sep: number | null;   // null for a new field: it has no September, and 0.0 would be a claim
  oct: number | null; nov: number | null;
  dec: number | null;   // null is "no goal"
  gapDaily: number | null;
};

export type CityRow = {
  city: string; hasCity: boolean;
  sep: number; oct: number; nov: number; dec: number; gapDaily: number;
  existing: number; slots: number; noGoal: number;
  fields: CityFieldRow[];
};

/** What cityRollup needs off a page row. Narrow on purpose, so the maths is exercisable. */
export type RollupRow = {
  key: string; kind: "existing" | "slot"; name: string; city: string | null;
  notCounted?: boolean | null;
  monthly: { daily: number }[];
  targets: Record<string, number>;
};

const DEC_INDEX = 11;
const RAMP_INDEXES = [9, 10] as const;   // October, November

/** The rollup. `rows` is every row the page holds, existing AND slots: a city's December goal
 *  spans both tables and this is the only place they meet. */
export function cityRollup(rows: RollupRow[], year: number, currentMonth: number, sort: GoalSort = "gap"): CityRow[] {
  const decKey = monthKey(year, DEC_INDEX);
  const byCity = new Map<string, CityRow>();

  for (const r of rows) {
    if (!rowCountsTowardTotals(r)) continue;
    const label = r.city != null && r.city.trim() !== "" ? r.city.trim() : NO_CITY;
    let c = byCity.get(label);
    if (!c) {
      c = { city: label, hasCity: label !== NO_CITY, sep: 0, oct: 0, nov: 0, dec: 0, gapDaily: 0,
            existing: 0, slots: 0, noGoal: 0, fields: [] };
      byCity.set(label, c);
    }

    const sep = r.monthly[currentMonth]?.daily ?? 0;
    const dec = r.targets[decKey] ?? null;
    const suggested = ramp(sep, dec);
    const monthAt = (i: 0 | 1): number | null =>
      r.targets[monthKey(year, RAMP_INDEXES[i])] ?? suggested[i] ?? null;
    const oct = monthAt(0), nov = monthAt(1);

    c.sep += sep;
    c.dec += dec ?? 0;
    c.oct += oct ?? 0;
    c.nov += nov ?? 0;
    if (r.kind === "slot") c.slots += 1; else c.existing += 1;
    if (dec == null) c.noGoal += 1;

    c.fields.push({
      key: r.key, name: r.name, kind: r.kind,
      /* A NEW FIELD HAS NO SEPTEMBER. Its spots are zero because it does not exist, which is not
       * the same statement as a field that ran no matches, and 0.0 would read as the second. */
      sep: r.kind === "slot" ? null : sep,
      oct, nov, dec,
      gapDaily: dec == null ? null : dec - sep,
    });
  }

  for (const c of byCity.values()) {
    c.gapDaily = c.dec - c.sep;
    c.fields = sortGoalRows(c.fields.map((f) => ({ ...f, city: c.city })), sort);
  }

  /* NO CITY SET GOES LAST UNDER EVERY ORDER, the same treatment a row with no goal already gets:
   * it is not a city, so it cannot take part in a ranking of cities, and putting it in the middle
   * of the work would answer "which city is worst" with something that is not a city. It keeps its
   * real gap and its real band, so how much is unassigned is still on the screen. */
  const list = sortGoalRows([...byCity.values()].map((c) => ({ ...c, name: c.city })), sort);
  return [...list.filter((c) => c.hasCity), ...list.filter((c) => !c.hasCity)];
}

/** The footer. Summed from the city rows on screen, so it cannot be a second source. */
export function cityTotals(cities: CityRow[]) {
  const s = (k: "sep" | "oct" | "nov" | "dec") => cities.reduce((a, c) => a + c[k], 0);
  const sep = s("sep"), dec = s("dec");
  return { sep, oct: s("oct"), nov: s("nov"), dec, gapDaily: dec - sep,
           existing: cities.reduce((a, c) => a + c.existing, 0),
           slots: cities.reduce((a, c) => a + c.slots, 0) };
}
