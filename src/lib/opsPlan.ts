/* 2027 OPERATIONS PLAN — the arithmetic. The 2026 Daily Matches page's rules, one year on.
 *
 * ── WHAT CARRIES OVER FROM lib/fieldGoals, UNCHANGED ─────────────────────────────────────────
 * One match is 18 spots. Spots are FILLED spots (player_count). A month's daily figure is
 * spots ÷ 18 ÷ the REAL days in that month — a finished month divides by its own length, the live
 * month by its completed Chicago days, and only matches played by yesterday count. The match filter
 * is countsTowardGoals(), the not-counted predicate is rowCountsTowardTotals(). Nothing here
 * re-derives any of them.
 *
 * ── WHAT IS DIFFERENT, AND WHY ────────────────────────────────────────────────────────────────
 * THE UNIT OF RECORD IS MONTHLY SPOTS, not matches a day. The forecast is built in spots, a launch
 * city's first month is 29 of them (0.05 a day), and the totals are sums of spots at a tenth's
 * precision, so a city is EXACTLY the sum of its rows and a region exactly the sum of its cities.
 * Daily and weekly are display transforms applied at each level, never summed. (The 2026 page sums
 * rounded dailies instead; here that would lose a launch city's fields to rounding — 174 fields
 * each rounding to 0.0 would drop whole matches a day off the headline.)
 *
 * THE FORECAST QUOTES ITS HEADLINE ON A 30-DAY MONTH. This page does not: Ryan ruled that estimate
 * and actual are both shown on real days, and compared in spots for the month.
 */

import { SPOTS_PER_MATCH, monthKey, MONTH_LABELS, roundTo, shownGap } from "./fieldGoals";

/** The year this plan is about. */
export const PLAN_YEAR = 2027;

/* ── THE DEFAULT RAMP, in spots per field per month since opening ──────────────────────────────
 * From MatchDay Forecast, Sep 2026. Month 1 is the opening month. From the 12th month on, the
 * field runs at its CITY's mature rate (plan_cities.mature_spots_per_field) — Ryan, 2026-10-02:
 * "a Dallas field opening January 2027 reads 292.0 in December 2027". */
export const RAMP_SPOTS = [14.3, 28.1, 60.5, 74.1, 76.0, 76.0, 76.0, 86.1, 86.1, 88.0, 102.3] as const;

/** The forecast's Dec 2026 starting point, all cities, in spots. The "Dec 2026 start" tile shows
 *  this, labelled forecast, until December 2026 completes — then the real December actual. */
export const FORECAST_DEC_2026_SPOTS = 14550;
export const START_MONTH = "2026-12-01";

/** The anchor threshold's default. The live value is app_settings, never this constant. */
export const DEFAULT_ANCHOR_THRESHOLD = 670;
export const ANCHOR_SETTING_KEY = "ops_plan_anchor_threshold_spots";
/** The trailing window actual fields, anchors and satellites are measured over. */
export const TRAILING_DAYS = 30;

/** "2027-03-01" for each month of the plan year. */
export const planMonthKeys = (year: number = PLAN_YEAR): string[] =>
  MONTH_LABELS.map((_, i) => monthKey(year, i));

/** Whole months from `fromKey` to `toKey` (both YYYY-MM-01). 0 = same month, negative = before. */
export const monthsBetween = (fromKey: string, toKey: string): number => {
  const [fy, fm] = fromKey.split("-").map(Number);
  const [ty, tm] = toKey.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm);
};

/** "2026-10-01" → "2026-11-01". Calendar arithmetic on the parts, never a Date in a zone. */
export const addMonths = (key: string, n: number): string => {
  const [y, m] = key.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}-01`;
};

/** Real days in the month a key names. */
export const daysInMonthOf = (key: string): number => {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/** "Mar 27" for a month key. */
export const shortMonth = (key: string): string => {
  const [y, m] = key.split("-").map(Number);
  return `${MONTH_LABELS[m - 1]} ${String(y).slice(2)}`;
};

/** A field's ramp value in its n-th month (0 = the opening month). Null before it opens. */
export function rampAt(n: number, mature: number): number | null {
  if (n < 0) return null;
  return n < RAMP_SPOTS.length ? RAMP_SPOTS[n] : mature;
}

/** The default estimate for each month of the plan year, for a field opening `openKey`.
 *  An already-open field (null) has no default — its estimate is whatever someone typed. */
export function defaultRamp(openKey: string | null, mature: number, year: number = PLAN_YEAR): (number | null)[] {
  if (openKey == null) return planMonthKeys(year).map(() => null);
  return planMonthKeys(year).map((k) => rampAt(monthsBetween(openKey, k), mature));
}

/* ── SPLITTING A LAUNCH CITY'S MONTH ACROSS ITS FIELDS ─────────────────────────────────────────
 * Ryan, 2026-10-02: in a launch city, each month's seeded spots are split across its open fields
 * in proportion to each field's ramp value that month, rounded to 0.1, with any leftover tenth
 * going to the EARLIEST-OPENED field — so the fields sum to the city figure exactly.
 *
 * Done in integer tenths, so "exactly" is integer equality and not a float tolerance. `weights`
 * must be ordered earliest-opened first; the leftover (which may be negative) lands on index 0. */
export function splitByWeights(total: number, weights: number[]): number[] {
  const T = Math.round(total * 10);
  const W = weights.reduce((a, w) => a + w, 0);
  if (T === 0) return weights.map(() => 0);
  if (!(W > 0)) throw new Error(`cannot split ${total} spots across fields with no ramp weight`);
  const shares = weights.map((w) => Math.round((T * w) / W));
  const left = T - shares.reduce((a, s) => a + s, 0);
  if (shares.length) shares[0] += left;
  return shares.map((s) => s / 10);
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
 * THE ROWS AND THE ROLLUP
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

export type PlanStatus = "live" | "planned" | "removed";
export type PlanType = "anchor" | "satellite";
/** "unplanned" is a field playing in a plan city with no 2027 plan entry: it counts in the
 *  actuals (the matches happened) and in nothing on the plan side. */
export type PlanRole = "field" | "forecast_base" | "unplanned";

export type PlanField = {
  key: string; rowId: string | null; name: string;
  kind: "venue" | "field" | "slot";
  /** A slot row CREATED FOR this plan year (field_goal_rows.plan_year). Only these can be linked to a
   *  venue from the plan page: 0199's ops_plan_link_venue refuses a 2026 slot, so the 2026 page is
   *  never changed from this one. */
  createdForPlan?: boolean;
  venueId: number | null; fieldId: number | null;
  cityId: string;
  role: PlanRole;
  status: PlanStatus | null;          // null only for role "unplanned"
  plannedType: PlanType | null;
  openMonth: string | null;           // YYYY-MM-01, null = already open / unknown
  /** Typed monthly spots for the plan year, by month key. Absent = not typed. */
  targets: Record<string, number>;
  /** Played spots and matches by month key, over every month the route read. */
  actual: Record<string, { spots: number; matches: number }>;
  /** Played spots and matches in the trailing 30 completed days. */
  trailing: { spots: number; matches: number };
};

export type PlanCity = {
  id: string; name: string; regionKey: string;
  launchMonth: string | null; anchorSlots: number; mature: number;
  status: "active" | "removed"; sortOrder: number;
};

export type PlanRegion = { key: string; name: string; shortName: string; note: string | null; sortOrder: number };

/** In the plan's arithmetic at all: not removed, and not a field nobody planned. */
export const inPlan = (f: Pick<PlanField, "role" | "status">): boolean =>
  f.role !== "unplanned" && f.status !== "removed";

/** A field's estimate for one month: the typed figure, else its default ramp, else none. A
 *  removed or unplanned field estimates nothing. */
export function estimateAt(f: PlanField, key: string, mature: number): number | null {
  if (!inPlan(f)) return null;
  if (f.targets[key] != null) return f.targets[key];
  if (f.role !== "field") return null;
  const n = f.openMonth == null ? -1 : monthsBetween(f.openMonth, key);
  return f.openMonth == null ? null : rampAt(n, mature);
}

/** Whether the estimate shown is a default rather than a typed number. */
export const isDefaultEstimate = (f: PlanField, key: string): boolean =>
  f.targets[key] == null && f.role === "field" && f.openMonth != null && monthsBetween(f.openMonth, key) >= 0;

/** Sum in TENTHS, so a total is the exact sum of its parts. Null when every part is null — a
 *  month nothing estimates is a dash, never 0.0. */
export function sumSpots(xs: (number | null | undefined)[]): number | null {
  let any = false, t = 0;
  for (const x of xs) { if (x == null) continue; any = true; t += Math.round(x * 10); }
  return any ? t / 10 : null;
}

/* ── ACTUALS ───────────────────────────────────────────────────────────────────────────────────
 * A month's actual is the sum of every counted row in the city, planned or not: the matches
 * happened. A month with no matches is NULL — a dash — whether the city had not launched or
 * simply played nothing, which is Ryan's rule ("Months with no matches or before a city's launch
 * show a dash, never 0.0"). */
export function actualSpots(fields: PlanField[], key: string): number | null {
  let m = 0, s = 0;
  for (const f of fields) { const a = f.actual[key]; if (!a) continue; m += a.matches; s += a.spots; }
  return m > 0 ? s : null;
}

/* ── FIELDS, ANCHORS, SATELLITES: ACTUAL / PLAN ────────────────────────────────────────────────
 * PLAN as of a month: in-plan fields (not the forecast-base row) whose opening month is on or
 * before it, split by PLANNED type. An open month of null is already open.
 * ACTUAL: fields with a played match in the trailing 30 days; an anchor is one at or above the
 * threshold in that window (670 exactly IS an anchor), a satellite one below it. Actual counts
 * every counted row in the city, planned or not — they are what is running. */
export type Counts = { fields: number; anchors: number; satellites: number };

export function planCounts(fields: PlanField[], asOf: string): Counts {
  const c: Counts = { fields: 0, anchors: 0, satellites: 0 };
  for (const f of fields) {
    if (!inPlan(f) || f.role !== "field") continue;
    if (f.openMonth != null && f.openMonth > asOf) continue;
    c.fields += 1;
    if (f.plannedType === "anchor") c.anchors += 1;
    else if (f.plannedType === "satellite") c.satellites += 1;
  }
  return c;
}

export const isActuallyLive = (f: PlanField): boolean => f.trailing.matches > 0;
export const isActualAnchor = (f: PlanField, threshold: number): boolean =>
  isActuallyLive(f) && f.trailing.spots >= threshold;

export function actualCounts(fields: PlanField[], threshold: number): Counts {
  const c: Counts = { fields: 0, anchors: 0, satellites: 0 };
  for (const f of fields) {
    if (f.role === "forecast_base" || !isActuallyLive(f)) continue;
    c.fields += 1;
    if (isActualAnchor(f, threshold)) c.anchors += 1; else c.satellites += 1;
  }
  return c;
}

export const addCounts = (a: Counts, b: Counts): Counts =>
  ({ fields: a.fields + b.fields, anchors: a.anchors + b.anchors, satellites: a.satellites + b.satellites });
export const ZERO_COUNTS: Counts = { fields: 0, anchors: 0, satellites: 0 };

/* ── A FIELD'S FLAGS ──────────────────────────────────────────────────────────────────────────
 * Planned type and actual status are separate facts and both are kept. The flags are where they
 * disagree, and "late" is a planned field past its opening month with nothing played. */
export type FieldFlag = "late" | "anchor-below" | "satellite-at-anchor";
export function fieldFlags(f: PlanField, threshold: number, currentMonth: string): FieldFlag[] {
  if (!inPlan(f) || f.role !== "field") return [];
  const out: FieldFlag[] = [];
  const live = isActuallyLive(f);
  if (f.status === "planned" && !live && (f.openMonth == null || f.openMonth < currentMonth)) out.push("late");
  if (live && f.plannedType === "anchor" && !isActualAnchor(f, threshold)) out.push("anchor-below");
  if (live && f.plannedType === "satellite" && isActualAnchor(f, threshold)) out.push("satellite-at-anchor");
  return out;
}

/* ── THE ROLLUP ───────────────────────────────────────────────────────────────────────────────
 * One function builds every level from the same rows, so a city is the sum of its rows, a region
 * the sum of its cities and the footer the sum of the regions, by construction. */
export type Rollup = {
  /** Estimate spots per plan-year month. Null where nothing estimates it. */
  est: (number | null)[];
  /** Actual spots per plan-year month. Null where nothing was played. */
  act: (number | null)[];
  plan: Counts; actual: Counts;
};

export function rollFields(fields: PlanField[], city: Pick<PlanCity, "mature">, keys: string[], asOf: string, threshold: number): Rollup {
  return {
    est: keys.map((k) => sumSpots(fields.map((f) => estimateAt(f, k, city.mature)))),
    act: keys.map((k) => actualSpots(fields, k)),
    plan: planCounts(fields, asOf),
    actual: actualCounts(fields, threshold),
  };
}

export function sumRollups(parts: Rollup[], months: number): Rollup {
  return {
    est: Array.from({ length: months }, (_, i) => sumSpots(parts.map((p) => p.est[i]))),
    act: Array.from({ length: months }, (_, i) => sumSpots(parts.map((p) => p.act[i]))),
    plan: parts.reduce((a, p) => addCounts(a, p.plan), ZERO_COUNTS),
    actual: parts.reduce((a, p) => addCounts(a, p.actual), ZERO_COUNTS),
  };
}

/* ── DISPLAY ──────────────────────────────────────────────────────────────────────────────────── */
export type Unit = "day" | "week" | "spots";

/** Spots for a month → the figure shown, on the REAL days of that month. */
export function spotsToUnit(spots: number, days: number, unit: Unit): number {
  if (unit === "spots") return spots;
  const d = days > 0 ? spots / SPOTS_PER_MATCH / days : 0;
  return unit === "day" ? d : d * 7;
}

/** The figure a person typed, in the unit on screen → monthly spots to store, at a tenth. */
export function unitToSpots(v: number, days: number, unit: Unit): number {
  if (unit === "spots") return roundTo(v, 1);
  const daily = unit === "day" ? v : v / 7;
  return roundTo(daily * SPOTS_PER_MATCH * days, 1);
}

/* ── A GAP ON THIS PAGE, as displayed ─────────────────────────────────────────────────────────────
 * lib/fieldGoals.shownGap — the one subtraction both pages use — applied to two monthly-spot figures,
 * each converted to the unit exactly as its own cell converts it (spots ÷ 18 ÷ ITS month's real
 * days). In Spots it is the plain difference of the two totals shown. `daily` is the same gap in
 * matches a day, which the colours read so a unit press never recolours anything. A missing
 * baseline is zero (the whole goal to find); a missing goal, or a baseline month with no days to
 * divide by, is no gap. */
export type PlanGap = { shown: number; daily: number };
export function planGap(goalSpots: number | null, goalDays: number, baseSpots: number | null, baseDays: number, unit: Unit): PlanGap | null {
  if (goalSpots == null || baseDays <= 0) return null;
  const g = (u: Unit) => shownGap(spotsToUnit(goalSpots, goalDays, u), baseSpots == null ? null : spotsToUnit(baseSpots, baseDays, u), u) as number;
  return { shown: g(unit), daily: g("day") };
}

export function fmtPlan(v: number, unit: Unit): string {
  if (unit === "spots") return Math.round(v).toLocaleString("en-US");
  return unit === "day" ? roundTo(v, 1).toFixed(1) : roundTo(v, 0).toFixed(0);
}

/* ── SORTING CITIES ───────────────────────────────────────────────────────────────────────────
 * The 2026 page's three orders. By gap puts the most to find first; a city with no gap (no Dec
 * estimate) goes last under every order. */
export type PlanSort = "gap" | "city" | "name";
/* `gap` is the gap ON SCREEN in the unit showing (lib/fieldGoals.shownGap); ties break on the daily
 * displayed gap, then the name — Ryan, 2026-10-02 — so rows do not shuffle between units. */
export function sortCities<T extends { name: string; gap: { shown: number; daily: number } | null; sortOrder: number }>(xs: T[], sort: PlanSort): T[] {
  return [...xs].sort((a, b) => {
    const an = a.gap == null, bn = b.gap == null;
    if (an !== bn) return an ? 1 : -1;
    if (sort === "gap" && !an) {
      const ag = a.gap as { shown: number; daily: number }, bg = b.gap as { shown: number; daily: number };
      return bg.shown - ag.shown || bg.daily - ag.daily || a.name.localeCompare(b.name);
    }
    if (sort === "city") return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
    return a.name.localeCompare(b.name);
  });
}

/* ── THE STAT TILES ───────────────────────────────────────────────────────────────────────────
 * NOW, DEC 2027 GOAL, TO FIND read across: To find is the goal minus Now AS DISPLAYED (planGap), and
 * Now is the very baseline that subtraction uses — the footer's baseline, not the Dec 2026 start.
 * A baseline month with no completed day (month to date on the 1st) has no Now and no gap; a
 * baseline of nothing played is a dash, and the whole goal is to find. */
const TILE_DASH = "–";
export function headlineTiles(decSpots: number | null, decDays: number, baseSpots: number | null, baseDays: number, unit: Unit):
  { now: string; goal: string; toFind: string } {
  const now = baseDays <= 0 || baseSpots == null ? TILE_DASH : fmtPlan(spotsToUnit(baseSpots, baseDays, unit), unit);
  const goal = decSpots == null ? TILE_DASH : fmtPlan(spotsToUnit(decSpots, decDays, unit), unit);
  const gap = planGap(decSpots, decDays, baseSpots, baseDays, unit);
  return { now, goal, toFind: gap == null ? TILE_DASH : fmtPlan(gap.shown, unit) };
}

/** "Oct 2026" — the year spelled out, where "Oct 26" would read as a date. */
export const monthYear = (key: string): string => {
  const [y, m] = key.split("-").map(Number);
  return `${MONTH_LABELS[m - 1]} ${y}`;
};

/* A CITY'S STATE, BY RULE (Ryan, 2026-10-02):
 *   playing     at least one field played in the BASELINE month (the window the tiles and chart use)
 *   to launch   has a launch month and has never played
 *   not playing everything else — has played before, or has no launch month, and is not playing now
 * So the three always add up to the total. "Never played" is over every counted match on record. */
export type CityState = "playing" | "to-launch" | "not-playing";
export const cityState = (c: { launchMonth: string | null; everPlayed: boolean; playingNow: boolean }): CityState =>
  c.playingNow ? "playing" : c.launchMonth != null && !c.everPlayed ? "to-launch" : "not-playing";

export type CityTally = { total: number; playing: number; toLaunch: number; notPlaying: number };
export function cityTally(cities: { launchMonth: string | null; everPlayed: boolean; playingNow: boolean }[]): CityTally {
  const t: CityTally = { total: cities.length, playing: 0, toLaunch: 0, notPlaying: 0 };
  for (const c of cities) {
    const s = cityState(c);
    if (s === "playing") t.playing += 1; else if (s === "to-launch") t.toLaunch += 1; else t.notPlaying += 1;
  }
  return t;
}
/** "7 playing now · 16 to launch", with "· N not playing" only when there are any. */
export const citiesLine = (t: CityTally): string =>
  `${t.playing} playing now · ${t.toLaunch} to launch${t.notPlaying > 0 ? ` · ${t.notPlaying} not playing` : ""}`;

/* UNASSIGNED IS NOT A REGION. It holds cities with no regional manager (St. Louis); it keeps its card
 * and its bar, but it is never counted as one. */
export const UNASSIGNED_REGION_KEY = "unassigned";
export function regionTally(regions: { key: string; cityNames: string[] }[]): { regions: number; unassigned: string[] } {
  const withCities = regions.filter((r) => r.cityNames.length > 0);
  return {
    regions: withCities.filter((r) => r.key !== UNASSIGNED_REGION_KEY).length,
    unassigned: withCities.filter((r) => r.key === UNASSIGNED_REGION_KEY).flatMap((r) => r.cityNames),
  };
}
/** "6 regions, St. Louis unassigned". */
export const regionsLine = (t: { regions: number; unassigned: string[] }): string =>
  `${t.regions} region${t.regions === 1 ? "" : "s"}${t.unassigned.length ? `, ${t.unassigned.join(" and ")} unassigned` : ""}`;

/* ── CITY MATCHING ────────────────────────────────────────────────────────────────────────────
 * A row reaches a plan city by its 2027 plan entry if it has one, else by alias: a venue's
 * fin_venues.city, an unmapped field's mdapi city_identifier, a 2026 slot's typed city. Case and
 * surrounding space are ignored; nothing is parsed out of a name. */
export const normAlias = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase();
