// The ONE metric × group-by × month computation, shared by the Player behavior
// panel and the Player Data Room so they can never disagree. Reads GrowthData's
// per-group monthly series (behaviorOverall / behaviorByCity / behaviorByField);
// it never writes a second query path.
//
// Additive vs not is the crux:
//   registrations / newPlayers / spots  → additive across months AND markets, so
//        a row's Period = Σ months, a month's Network = Σ markets, and both foot.
//   totalPlayers                        → a DISTINCT count; summing double-counts
//        anyone active in two months/markets, so it is read per group, never
//        summed. Period + column-sum are not shown for it.
//   spotsPerPlayer                      → a ratio; likewise never summed.

import type { GrowthData, BehaviorPoint } from "./growthAnalytics";

export type GridMetric =
  | "registrations"
  | "newPlayers"
  | "totalPlayers"
  | "spots"
  | "spotsPerPlayer"
  // RECURRING — two metrics, not one, because they answer different questions.
  //   recurring    = totalPlayers − newPlayers   → HOW MANY came back
  //   pctRecurring = recurring / totalPlayers    → WHETHER we are keeping them
  // The count falls whenever the month is smaller even if loyalty is unchanged, so the RATE is the
  // one to watch; the count is what you act on. Neither is sufficient alone.
  | "recurring"
  | "pctRecurring";

export const GRID_METRICS: GridMetric[] = [
  "registrations",
  "newPlayers",
  "totalPlayers",
  "recurring",
  "pctRecurring",
  "spots",
  "spotsPerPlayer",
];

export const METRIC_LABEL: Record<GridMetric, string> = {
  registrations: "Registrations",
  newPlayers: "New players",
  totalPlayers: "Total players",
  /* RETURNING, NOT RECURRING. Ryan's wording, and the better word: "recurring" is what a
   * subscription does, "returning" is what a player does. The KEYS are untouched, so nothing that
   * reads the data changes; only the label does. METRIC_LABEL has ONE consumer (BehaviorPanel) despite
   * this file's header claiming the Data Room shares it, so there is no second page to keep in step. */
  recurring: "Returning players",
  pctRecurring: "Returning player %",
  spots: "Spots booked",
  spotsPerPlayer: "Spots per player",
};

/** A rate, charted 0–100 and moved in PERCENTAGE POINTS rather than percent. */
export const IS_RATE = new Set<GridMetric>(["pctRecurring"]);

/* ── SUMMING A DISTINCT COUNT IS NOW A COMPILE ERROR ─────────────────────────────────────────
 *
 * This file's own header has said "totalPlayers -> a DISTINCT count; summing double-counts anyone
 * active in two months/markets, so it is read per group, never summed" since it was written. The
 * Period total column summed it anyway, for six months, and the figure was 86.9% too high:
 *
 *   sum of six monthly Set sizes, Apr-Sep 2026   15,619
 *   COUNT(DISTINCT user_id) over the same range   8,357
 *
 * AND IT SURVIVED BECAUSE IT LOOKED RIGHT. 15,619 is 0.9% off the all-time player count, so it read
 * as "almost everyone who ever played, played this half-year" - a plausible and flattering story.
 * The truth is 53% of all time, which is a different claim about the business.
 *
 * DOCUMENTING THE RULE AGAIN WOULD CHANGE NOTHING; it was documented and the bug shipped. So the
 * rule is a TYPE: anything that sums across buckets takes AdditiveMetric, and a distinct count will
 * not typecheck as one. `isAdditive` is a type guard rather than a boolean, so narrowing is what a
 * caller gets for checking.
 */
export type AdditiveMetric = Extract<GridMetric, "registrations" | "newPlayers" | "spots">;
const ADDITIVE: ReadonlySet<GridMetric> = new Set<GridMetric>(["registrations", "newPlayers", "spots"]);
export const isAdditive = (m: GridMetric): m is AdditiveMetric => ADDITIVE.has(m);

/** A count that is a DISTINCT set per bucket. Never summed across buckets; see above. */
export type DistinctMetric = Extract<GridMetric, "totalPlayers" | "recurring">;
export const isDistinct = (m: GridMetric): m is DistinctMetric =>
  m === "totalPlayers" || m === "recurring";

/**
 * Sum one metric across buckets. THE ONLY SANCTIONED SUMMING PATH.
 *
 * It accepts AdditiveMetric and nothing else, so `sumAcrossBuckets("totalPlayers", ...)` is a
 * compile error rather than a number that is 87% too high. A distinct count over a range comes from
 * the route's own window aggregate instead.
 */
export function sumAcrossBuckets(m: AdditiveMetric, values: readonly (number | null)[]): number {
  void m; // named so the call site reads as "sum THIS metric", and so the type is load-bearing
  return values.reduce<number>((a, b) => a + (b ?? 0), 0);
}
export const isRatio = (m: GridMetric): boolean => m === "spotsPerPlayer";
// A registration attaches to a market, never a pitch → no field dimension.
export const hasFieldDimension = (m: GridMetric): boolean => m !== "registrations";

/** The metric's value at one monthly point. spotsPerPlayer is derived. */
export function metricValue(p: BehaviorPoint | undefined, m: GridMetric): number | null {
  if (!p) return null;
  if (m === "spotsPerPlayer") {
    return p.spots != null && p.totalPlayers ? p.spots / p.totalPlayers : null;
  }
  if (m === "recurring" || m === "pctRecurring") {
    if (p.totalPlayers == null || p.newPlayers == null) return null;
    // NEVER CLAMPED, AND NEVER RENDERED AS A NUMBER. new > total is impossible when the
    // definitions agree — new players at a scope are a SUBSET of the players at that scope — so a
    // negative recurring figure is a DEFINITION error. Math.max(0, …) would paint it as 0% and
    // hide the only condition worth catching.
    //
    // It returns null (a dash) rather than throwing: a throw takes the whole page down, which
    // punishes the reader for a data problem and hides every other metric too. The loud part is
    // the SUITE — verify-growth-sections fails on any scope/month where new exceeds total, so a
    // violation cannot reach main quietly.
    if (p.newPlayers > p.totalPlayers) return null;
    const recurring = p.totalPlayers - p.newPlayers;
    if (m === "recurring") return recurring;
    return p.totalPlayers ? (recurring / p.totalPlayers) * 100 : null;
  }
  return p[m];
}

export type GridRow = {
  label: string;
  city: string | null; // set for field rows (the pitch's market), null for city rows
  cells: (number | null)[]; // one per month; null → dash, never a fabricated 0
  period: number | null; // Σ months for additive metrics; null otherwise
};

export type MetricGrid = {
  metric: GridMetric;
  group: "city" | "field";
  months: string[];
  rows: GridRow[];
  additive: boolean;
  hasData: boolean;
  // Network "All markets" row — only for the CITY group of an additive metric
  // (fields are regular-play-only + not exhaustive, so they don't foot to the
  // network). null otherwise.
  netByMonth: (number | null)[] | null;
  netPeriod: number | null;
};

function seriesFor(
  data: GrowthData,
  group: "city" | "field",
): { label: string; city: string | null; points: BehaviorPoint[] }[] {
  if (group === "city") {
    return data.cities.map((c) => ({ label: c, city: null, points: data.behaviorByCity[c] ?? [] }));
  }
  return Object.values(data.behaviorByField)
    .map((v) => ({ label: v.label, city: v.city, points: v.points }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

const indexPoints = (pts: BehaviorPoint[]): Map<string, BehaviorPoint> => {
  const m = new Map<string, BehaviorPoint>();
  for (const p of pts) m.set(p.m, p);
  return m;
};

/**
 * Build the rows × months grid for one metric + group over a month range.
 * For the CITY group of an additive metric it ALSO computes the network row and
 * ASSERTS the footing — a column that doesn't sum to the network figure throws
 * rather than rendering a wrong total.
 */
export function buildMetricGrid(
  data: GrowthData,
  metric: GridMetric,
  group: "city" | "field",
  months: string[],
): MetricGrid {
  const additive = isAdditive(metric);
  const rows: GridRow[] = seriesFor(data, group).map((s) => {
    const idx = indexPoints(s.points);
    const cells = months.map((m) => metricValue(idx.get(m), metric));
    const has = cells.some((c) => c != null);
    const period = additive && has ? cells.reduce<number>((a, c) => a + (c ?? 0), 0) : null;
    return { label: s.label, city: s.city, cells, period };
  });

  // Rank by period (additive) else by summed activity — display order only.
  rows.sort((a, b) => {
    const av = a.period ?? a.cells.reduce<number>((s, c) => s + (c ?? 0), 0);
    const bv = b.period ?? b.cells.reduce<number>((s, c) => s + (c ?? 0), 0);
    return bv - av;
  });

  const hasData = rows.some((r) => r.cells.some((c) => c != null));

  let netByMonth: (number | null)[] | null = null;
  let netPeriod: number | null = null;
  if (group === "city" && additive) {
    const overall = indexPoints(data.behaviorOverall);
    netByMonth = months.map((_, i) => rows.reduce<number>((a, r) => a + (r.cells[i] ?? 0), 0));
    // FOOTING ASSERTION — throw rather than render a wrong number.
    months.forEach((m, i) => {
      const net = metricValue(overall.get(m), metric);
      if (net != null && Math.abs(net - (netByMonth as number[])[i]) > 0.5) {
        throw new Error(
          `growthMetricGrid: ${metric} ${m} — city columns sum to ${(netByMonth as number[])[i]} but the network figure is ${net}`,
        );
      }
    });
    netPeriod = (netByMonth as number[]).reduce((a, b) => a + b, 0);
  }

  return { metric, group, months, rows, additive, hasData, netByMonth, netPeriod };
}

/** Network monthly series for the chart (behaviorOverall), metric-derived. */
export function networkSeries(data: GrowthData, metric: GridMetric, months: string[]): (number | null)[] {
  const idx = indexPoints(data.behaviorOverall);
  return months.map((m) => metricValue(idx.get(m), metric));
}
