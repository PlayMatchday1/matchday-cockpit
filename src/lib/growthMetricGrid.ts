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
  | "spotsPerPlayer";

export const GRID_METRICS: GridMetric[] = [
  "registrations",
  "newPlayers",
  "totalPlayers",
  "spots",
  "spotsPerPlayer",
];

export const METRIC_LABEL: Record<GridMetric, string> = {
  registrations: "Registrations",
  newPlayers: "New players",
  totalPlayers: "Total players",
  spots: "Spots booked",
  spotsPerPlayer: "Spots per player",
};

const ADDITIVE = new Set<GridMetric>(["registrations", "newPlayers", "spots"]);
export const isAdditive = (m: GridMetric): boolean => ADDITIVE.has(m);
export const isRatio = (m: GridMetric): boolean => m === "spotsPerPlayer";
// A registration attaches to a market, never a pitch → no field dimension.
export const hasFieldDimension = (m: GridMetric): boolean => m !== "registrations";

/** The metric's value at one monthly point. spotsPerPlayer is derived. */
export function metricValue(p: BehaviorPoint | undefined, m: GridMetric): number | null {
  if (!p) return null;
  if (m === "spotsPerPlayer") {
    return p.spots != null && p.totalPlayers ? p.spots / p.totalPlayers : null;
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
