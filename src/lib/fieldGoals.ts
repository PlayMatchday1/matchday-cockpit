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

/* ── HOW MANY DAYS DIVIDE ─────────────────────────────────────────────────────────────────────
 * A finished month divides by its own length. The CURRENT month divides by the days elapsed
 * INCLUDING today — Ryan's call, and the sheet's own reading (11 of 30 on the 11th). A future month
 * has no elapsed days at all and no average to compute. */
export function daysElapsed(monthIndex0: number, year: number, now: Date): { days: number; of: number; partial: boolean } {
  const of = new Date(year, monthIndex0 + 1, 0).getDate();
  const cur = now.getFullYear() === year && now.getMonth() === monthIndex0;
  if (now.getFullYear() > year || (now.getFullYear() === year && now.getMonth() > monthIndex0)) {
    return { days: of, of, partial: false };
  }
  if (!cur) return { days: 0, of, partial: false };
  return { days: now.getDate(), of, partial: true };
}

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
