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

/* ── THE BASELINE: WHICH MONTH THE GAP, TREND AND PROGRESS ARE MEASURED FROM ──────────────────
 * Ryan, 2026-10-02: on the 2nd the live month has ONE completed day, and that day was the "now"
 * every gap, trend and progress bar read — Austin at 2.4 against a September of 6.1, a gap of +7.3,
 * a trend of -4.4; the estate at 9.2 a day and +18.4 to find, when September ran 16.5.
 *
 * THE RULE: until the live month has BASELINE_MIN_COMPLETED_DAYS completed days, the baseline is
 * the LAST FULL MONTH; from then on it is the live month to date. Seven covers each weekday once —
 * a month read on a Saturday-heavy first week is not the month. On the calendar: days 1 to 7 read
 * the last full month, the 8th onward reads the live month (the 8th is the first day with seven
 * completed behind it).
 *
 * ONE RULE, BOTH PAGES. The 2026 Daily Matches page and the 2027 Operations Plan both call
 * baselineMonth(); neither carries a copy. A person can override it with the "Compare from"
 * toggle; the override is not persisted, so every load opens on the rule.
 *
 * `today` is the CHICAGO calendar date (todayBusinessDate), never a runtime getter. */
export const BASELINE_MIN_COMPLETED_DAYS = 7;
export type CompareFrom = "last-full" | "to-date";

export const defaultCompareFrom = (completedDays: number): CompareFrom =>
  completedDays < BASELINE_MIN_COMPLETED_DAYS ? "last-full" : "to-date";

export type Baseline = {
  compareFrom: CompareFrom; defaultCompareFrom: CompareFrom;
  /** YYYY-MM-01 of the live month, and of the month the figures are measured from. */
  liveKey: string; baseKey: string;
  /** Completed days in the live month (today excluded). */
  completedDays: number;
  baseIsLive: boolean;
};

export function baselineMonth(today: string, override?: CompareFrom | null): Baseline {
  const [y, m, d] = today.split("-").map(Number);
  const completedDays = d - 1;
  const def = defaultCompareFrom(completedDays);
  const compareFrom = override ?? def;
  const pad = (n: number) => String(n).padStart(2, "0");
  const liveKey = `${y}-${pad(m)}-01`;
  const lastFull = m === 1 ? `${y - 1}-12-01` : `${y}-${pad(m - 1)}-01`;
  const baseKey = compareFrom === "last-full" ? lastFull : liveKey;
  return { compareFrom, defaultCompareFrom: def, liveKey, baseKey, completedDays, baseIsLive: baseKey === liveKey };
}

/** A month key as an index into a one-year page, or null when it falls outside that year. */
export const monthIndexIn = (key: string, year: number): number | null =>
  key.startsWith(`${year}-`) ? Number(key.slice(5, 7)) - 1 : null;

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

/* ── A 2027 ROW MUST NEVER REACH THIS PAGE ────────────────────────────────────────────────────
 * Migration 0199 put the 2027 Operations Plan into these same tables. field_goal_rows.plan_year is
 * the year a row was CREATED FOR: NULL is every row this page has ever made, and every venue and
 * unmapped-field row (those are shared across years). A row created for another year is not this
 * page's. Read defensively — `select("*")` before 0199 lands has no plan_year at all, which is null.
 *
 * AND A TARGET OUTSIDE THIS YEAR, OR IN SPOTS, IS NOT THIS PAGE'S EITHER. A shared venue row can
 * carry 2027 estimates in goal_spots; read as goal_daily they would be Number(null) = 0 under a
 * 2027 key — harmless today, and a different payload, which Ryan ruled out. */
export const rowBelongsToGoalYear = (r: Record<string, unknown>, year: number = GOAL_YEAR): boolean =>
  r.plan_year == null || Number(r.plan_year) === year;

export const targetBelongsToGoalYear = (
  t: { month: string | null; goal_daily?: number | string | null },
  year: number = GOAL_YEAR,
): boolean => t.goal_daily != null && String(t.month ?? "").startsWith(`${year}-`);

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

/* ── DORMANT, AGAINST THE BASELINE ───────────────────────────────────────────────────────────────
 * Ryan, 2026-10-02: a field is dormant when it has no match in the baseline month AND none in the
 * live month so far. On the 2nd, a field that played all September but not yet on the 1st is not
 * dormant; a field that has played in the live month is never folded, whichever baseline is active.
 * With the baseline on the live month this is exactly isDormantIn(row, live). */
export const isDormantFor = (
  row: { monthly: { matches?: number }[] },
  baselineIndex0: number,
  liveIndex0: number,
): boolean => isDormantIn(row, baselineIndex0) && isDormantIn(row, liveIndex0);

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

/* ════════════════════════════════════════════════════════════════════════════════════════════════
 * THE ONE GAP. Every gap and every trend on the 2026 Daily Matches page AND the 2027 Operations
 * Plan comes out of shownGap(), and there is no second copy of the subtraction anywhere.
 *
 * Ryan, 2026-10-02: "Every gap on screen must equal the displayed goal minus the displayed baseline
 * on that same row, using the values exactly as rendered." OKC read Sep 0.7, Dec 1.0 and a gap of
 * +0.4, because the gap was 0.96 - 0.66 = 0.30 per field, summed and rounded from unrounded parts;
 * All MatchDay read 16.5, 27.6 and +11.2 for the same reason. A reader subtracts the two numbers in
 * front of them, so that is what the gap is.
 *
 * BOTH ARGUMENTS ARE ALREADY IN THE UNIT ON SCREEN — daily, weekly (daily × 7) or monthly spots —
 * and each is rounded to what that unit prints (a tenth for daily, whole for weekly and spots)
 * before the subtraction. So Weekly subtracts the two weekly figures shown, not 7 × the daily gap.
 *
 * A MISSING BASELINE IS ZERO: a row that dashes (a field that does not exist yet, a city that has
 * never played) has the whole December goal to find. A missing goal is no gap at all.
 *
 * TREND is the same subtraction with the earliest history month in place of the goal; there, a
 * missing month is NO trend (shownTrend), never a zero. */
export type ShowUnit = "day" | "week" | "spots";

/** A figure as the page prints it, as a number: one decimal daily, whole weekly and spots. */
export const asShown = (v: number, unit: ShowUnit): number => roundTo(v, unit === "day" ? 1 : 0);

export function shownGap(goal: number | null | undefined, base: number | null | undefined, unit: ShowUnit): number | null {
  if (goal == null) return null;
  return asShown(asShown(goal, unit) - asShown(base ?? 0, unit), unit);   // re-rounded: float noise only
}

/** Displayed baseline month minus displayed earliest history month. Null when either is missing. */
export const shownTrend = (base: number | null | undefined, earliest: number | null | undefined, unit: ShowUnit): number | null =>
  base == null || earliest == null ? null : shownGap(base, earliest, unit);

/** A daily figure in the 2026 page's unit (it has no spots unit). */
export const dailyIn = (daily: number, unit: "day" | "week"): number => (unit === "week" ? daily * 7 : daily);

/** A gap or trend that is ALREADY in its unit, printed with its sign. */
export const fmtShownSigned = (v: number, unit: ShowUnit): string => {
  const s = unit === "day" ? v.toFixed(1) : v.toFixed(0);
  return v > 0 ? `+${s}` : s;
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

/* BY GAP SORTS ON THE GAP ON SCREEN, in whichever unit is showing (`gapSort`, when given), and
 * breaks ties on the daily displayed gap and then the name — Ryan, 2026-10-02 — so rows level in
 * Weekly do not shuffle at random. Without a `gapSort` the daily gap is the key, as it always was. */
export function sortGoalRows<T extends { name: string; city?: string | null; gapDaily: number | null; gapSort?: number | null }>(
  rows: T[],
  sort: GoalSort,
): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  return [...rows].sort((a, b) => {
    const aNo = a.gapDaily == null, bNo = b.gapDaily == null;
    if (aNo !== bNo) return aNo ? 1 : -1;          // no goal, no gap, last
    if (sort === "gap") {
      if (aNo && bNo) return byName(a, b);
      const ak = (a.gapSort ?? a.gapDaily) as number, bk = (b.gapSort ?? b.gapDaily) as number;
      return bk - ak || (b.gapDaily as number) - (a.gapDaily as number) || byName(a, b);
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
  /** The live month to date. Null for a new field: it has no live month, and 0.0 would be a claim.
   *  (Was `sep`, from when the page was built in September. It always meant the live month.) */
  live: number | null;
  /** The BASELINE month the gap, trend and ramp are measured from — the live month itself in
   *  month-to-date mode, else the last full month. Null for a new field, as above. */
  base: number | null;
  oct: number | null; nov: number | null;
  dec: number | null;   // null is "no goal"
  /** shownGap(dec, base) in DAILY — what the dot and the bar colour key on. Null with no goal. */
  gapDaily: number | null;
  /** The gap in the unit on screen, for the sort. */
  gapSort: number | null;
  /** The three months before the live one, oldest first. A null is "not yet a pitch", never 0.0. */
  hist: (number | null)[];
};

export type CityRow = {
  city: string; hasCity: boolean;
  /** The live month to date, and the baseline month (equal in month-to-date mode). */
  live: number; base: number;
  oct: number; nov: number; dec: number;
  /** shownGap(dec, base) in DAILY, and in the unit on screen for the sort. */
  gapDaily: number; gapSort: number;
  existing: number; slots: number; noGoal: number;
  fields: CityFieldRow[];
  /** The three months before the live one, oldest first. Null is "no market yet", never 0.0. */
  hist: (number | null)[];
  /** Baseline month minus the EARLIEST history month (the live month itself in month-to-date
   *  mode, which is today's trend unchanged). Null when there is no history to trend from. */
  trend: number | null;
  /** No activity in any history month — a market that did not exist yet, not one at zero. */
  isNew: boolean;
};

/** What cityRollup needs off a page row. Narrow on purpose, so the maths is exercisable. */
export type RollupRow = {
  key: string; kind: "existing" | "slot"; name: string; city: string | null;
  notCounted?: boolean | null;
  /* `matches` IS WHAT SAYS A PITCH EXISTED THAT MONTH, and `daily` cannot say it: a month with no
   * matches and a month whose matches carried no spots both read 0. History needs the difference,
   * because "no market yet" and "a quiet month" are opposite statements about a city. Optional so
   * every existing caller still typechecks; absent, a month is treated as having existed. */
  monthly: { daily: number; matches?: number }[];
  targets: Record<string, number>;
};

const DEC_INDEX = 11;
const RAMP_INDEXES = [9, 10] as const;   // October, November

/** How many completed months sit to the left of the live one when history is open. */
export const HISTORY_MONTHS = 3;

/** The month indexes history covers, oldest first, for a given live month. */
export const historyIndexes = (currentMonth: number): number[] =>
  Array.from({ length: HISTORY_MONTHS }, (_, i) => currentMonth - HISTORY_MONTHS + i).filter((i) => i >= 0);

/* ── THE TREND'S THREE STATES ─────────────────────────────────────────────────────────────────
 * A gap does not say whether it is closing. Austin at +3.7 having climbed from 4.1 is a city on a
 * trajectory; Austin at +3.7 having sat flat since June needs someone on a plane. Same gap,
 * opposite decisions, and the table cannot tell them apart without this.
 *
 * THE DEAD BAND IS +/-0.15, which is wider than the tenth the table prints. Without it a city that
 * moved 0.04 — noise at this scale, and invisible in the column beside it — would be decorated
 * with an arrow claiming a direction. `null` in gives `null` out: a market with no history has no
 * trend, and MUST NOT be handed a zero, which would read as "flat" and say something untrue. */
export type TrendKind = "up" | "flat" | "dn";
export const TREND_DEAD_BAND = 0.15;
export const trendKind = (t: number | null): TrendKind | null =>
  t == null ? null : t > TREND_DEAD_BAND ? "up" : t < -TREND_DEAD_BAND ? "dn" : "flat";

/** The rollup. `rows` is every row the page holds, existing AND slots: a city's December goal
 *  spans both tables and this is the only place they meet. */
export function cityRollup(
  rows: RollupRow[], year: number, currentMonth: number, sort: GoalSort = "gap",
  /** The baseline month index (baselineMonth). Defaults to the live month: month-to-date mode,
   *  which is the rollup exactly as it was before the baseline existed. */
  baseline: number = currentMonth,
  /** The unit on screen. Only the gap SORT reads it; every stored figure stays daily. */
  unit: "day" | "week" = "day",
): CityRow[] {
  const decKey = monthKey(year, DEC_INDEX);
  const byCity = new Map<string, CityRow>();
  const HIST = historyIndexes(currentMonth);

  /* ── A MONTH BEFORE A PITCH EXISTED IS A DASH, NOT A ZERO ────────────────────────────────────
   * THIS IS THE RULE THAT WOULD OTHERWISE SHIP WRONG. A 0.0 sitting in June beside a December
   * target reads as a market that collapsed. The truth is the opposite — it had not opened yet —
   * and the two are indistinguishable once a zero is printed.
   *
   * SO THE TEST IS FIRST ACTIVITY, NOT EMPTINESS. A month at or after a pitch's first match shows
   * its figure, INCLUDING a genuine 0.0 for a month that really was quiet; a month before it
   * dashes. That distinction is why RollupRow carries `matches` — `daily` is 0 in both cases.
   *
   * A SLOT HAS NO HISTORY AT ALL. It is a field that does not exist yet, which is the same
   * statement its September already makes by being null. */
  const firstActive = (r: RollupRow): number => {
    const i = r.monthly.findIndex((m) => (m?.matches ?? 1) > 0);
    return i < 0 ? Number.POSITIVE_INFINITY : i;
  };

  for (const r of rows) {
    if (!rowCountsTowardTotals(r)) continue;
    const label = r.city != null && r.city.trim() !== "" ? r.city.trim() : NO_CITY;
    let c = byCity.get(label);
    if (!c) {
      c = { city: label, hasCity: label !== NO_CITY, live: 0, base: 0, oct: 0, nov: 0, dec: 0, gapDaily: 0, gapSort: 0,
            existing: 0, slots: 0, noGoal: 0, fields: [], hist: HIST.map(() => null), trend: null, isNew: false };
      byCity.set(label, c);
    }

    const live = r.monthly[currentMonth]?.daily ?? 0;
    /* THE GAP AND THE RAMP RUN FROM THE BASELINE. In month-to-date mode that is the live month, as
     * it always was; with the last full month as baseline, October's suggestion is the line from
     * September to December, never a line from October's own partial actual. */
    const base = r.monthly[baseline]?.daily ?? 0;
    const dec = r.targets[decKey] ?? null;
    const suggested = ramp(base, dec);
    const monthAt = (i: 0 | 1): number | null =>
      r.targets[monthKey(year, RAMP_INDEXES[i])] ?? suggested[i] ?? null;
    const oct = monthAt(0), nov = monthAt(1);

    c.live += live;
    c.base += base;
    c.dec += dec ?? 0;
    c.oct += oct ?? 0;
    c.nov += nov ?? 0;
    if (r.kind === "slot") c.slots += 1; else c.existing += 1;
    if (dec == null) c.noGoal += 1;

    const fa = r.kind === "slot" ? Number.POSITIVE_INFINITY : firstActive(r);
    const fHist = HIST.map((i) => (i < fa ? null : r.monthly[i]?.daily ?? 0));

    c.fields.push({
      key: r.key, name: r.name, kind: r.kind, hist: fHist,
      /* A NEW FIELD HAS NO SEPTEMBER. Its spots are zero because it does not exist, which is not
       * the same statement as a field that ran no matches, and 0.0 would read as the second. */
      live: r.kind === "slot" ? null : live,
      base: r.kind === "slot" ? null : base,
      oct, nov, dec,
      gapDaily: shownGap(dec, base, "day"),
      gapSort: dec == null ? null : shownGap(dailyIn(dec, unit), dailyIn(base, unit), unit),
    });
  }

  /* ── A CITY IS THE SUM OF THE FIELDS AS DISPLAYED, NOT OF THE FIELDS AS STORED ──────────────
   * THE BUG: Austin printed 6.1 for September over field rows that read 0.1, 0.4, 2.2, 0.2, 0.2,
   * 1.2, 0.0, 0.5, 1.1, 0.3 — which add to 6.2. Its GAP printed 3.8 over field gaps adding to 3.7.
   * Nothing was miscomputed: the city accumulated at FULL precision and rounded once, each field
   * rounded on its own, and the two answers differ by the discarded halves. Both were defensible
   * and only one can be on screen, because a reader adds up the column in front of them.
   *
   * SO THE CITY IS SUMMED FROM THE ROUNDED FIELD VALUES, then rounded again to clear the float
   * noise that 0.1 + 0.2 produces. What the drawer shows now adds to what the row shows, by
   * construction rather than by luck.
   *
   * THIS IS A DELIBERATE EXCEPTION TO THIS FILE'S OWN "ROUND ONCE, AT THE END" RULE, and the rule
   * is still right everywhere else — the three tiles and the year chart sum the rows at full
   * precision, which is why field-goals-test still asserts the spreadsheet's 16.6/16.7 fault does
   * not reproduce. The exception is scoped to the ONE place where a total sits directly above the
   * numbers it totals. MEASURED on production 2026-09-29: with this rule the footer and the tiles
   * still agree to 0.0 on Sep, Dec and Gap, so nothing upstream had to move.
   *
   * A NULL IS A ZERO FOR SUMMING AND A DASH FOR READING. A new field has no September and a field
   * with no target has no gap; neither contributes, which is what they did before.
   *
   * THE GAP IS THE SUM OF THE FIELD GAPS, not a re-derivation from the rounded Dec and Sep. A
   * negative field gap — a pitch already past its goal — still counts toward its city. On today's
   * data the two agree for all ten cities, and summing what is displayed is the rule that keeps
   * agreeing when they diverge. */
  const sumRounded = (xs: (number | null)[]): number =>
    roundTo(xs.reduce<number>((a, v) => a + roundTo(v ?? 0, 1), 0), 1);

  for (const c of byCity.values()) {
    /* ── THE CITY'S HISTORY, UNDER THE SAME TWO RULES AS THE REST OF THE COLUMN ───────────────
     * SUMMED FROM THE FIELD VALUES AS DISPLAYED, so a history column foots to its drawer exactly
     * as September and December do. And a month where EVERY pitch dashes dashes at city level too
     * — that is a market with nothing open yet, and summing a row of dashes into 0.0 is the same
     * lie one level up. A month where some pitches dash and others do not is a real figure: the
     * ones that existed are what the city was. */
    c.hist = HIST.map((_, k) => {
      const vals = c.fields.map((f) => f.hist[k]);
      return vals.every((v) => v == null) ? null : sumRounded(vals);
    });
    /* NEW MEANS NO ACTIVITY IN ANY HISTORY MONTH — the state that earns the dash and the label. */
    c.isNew = c.hist.every((v) => v == null);
    /* THE TREND RUNS FROM THE EARLIEST HISTORY MONTH TO THE BASELINE (the live month in
     * month-to-date mode, as it always did; the last full month otherwise, so a partial month is
     * never set against a full one), and only if that month is a
     * real figure. A city whose June dashes gets NO trend rather than one computed from July: a
     * shorter window is a different measurement wearing the same column, and a reader comparing
     * two cities would be comparing three months against two without being told. */
    c.live = sumRounded(c.fields.map((f) => f.live));
    c.base = sumRounded(c.fields.map((f) => f.base));
    /* AFTER c.base, deliberately: the trend is the change in the number the ROW SHOWS, so it is
     * built from the displayed baseline and the displayed earliest month and cannot disagree. */
    c.trend = shownTrend(c.base, c.hist[0], "day");
    c.oct = sumRounded(c.fields.map((f) => f.oct));
    c.nov = sumRounded(c.fields.map((f) => f.nov));
    c.dec = sumRounded(c.fields.map((f) => f.dec));
    /* THE CITY'S GAP IS ITS OWN DISPLAYED DECEMBER MINUS ITS OWN DISPLAYED BASELINE — not the sum
     * of its fields' gaps, which is how OKC printed +0.4 under 0.7 and 1.0. */
    c.gapDaily = shownGap(c.dec, c.base, "day") as number;
    c.gapSort = shownGap(dailyIn(c.dec, unit), dailyIn(c.base, unit), unit) as number;
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
/** The footer. Summed from the city rows on screen, so it cannot be a second source.
 *
 *  EACH CITY IS ALREADY A ONE-DECIMAL NUMBER, so this rounds only to clear float noise — the
 *  footer is the sum of the column above it exactly, the same guarantee each city row now gives
 *  its own drawer. GAP is summed from the city gaps for that reason and not re-derived. */
export function cityTotals(cities: CityRow[]) {
  const r1 = (v: number) => roundTo(v, 1);
  const s = (k: "live" | "base" | "oct" | "nov" | "dec") => r1(cities.reduce((a, c) => a + c[k], 0));
  const live = s("live"), base = s("base"), dec = s("dec");
  /* THE FOOTER GAP IS THE FOOTER'S DECEMBER MINUS THE FOOTER'S BASELINE (shownGap), never the sum of
   * the city gaps above it — that sum is what printed +11.2 under 16.5 and 27.6. The "To find" tile
   * reads this same footer, so the two cannot disagree. */
  return { live, base, oct: s("oct"), nov: s("nov"), dec, gapDaily: shownGap(dec, base, "day") as number,
           existing: cities.reduce((a, c) => a + c.existing, 0),
           slots: cities.reduce((a, c) => a + c.slots, 0) };
}
