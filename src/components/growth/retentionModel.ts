// Client-side derivations over the one RetentionAggregate. Both the retention
// curve and the cohort table read these — no second data source. All the exact
// definitions (cohort = first-match month, active = >=1 match in month, age =
// months since cohort, churn = set subtraction active(N-1)\active(N)) live here.

import type { RetentionAggregate, RetentionPlayer } from "@/lib/retentionEngine";

export const MAX_AGE = 12;
export const FREE_LAUNCH = new Set(["2023-04", "2023-05"]);

export const idxOf = (k: string): number => {
  const [y, m] = k.split("-").map(Number);
  return y * 12 + (m - 1);
};
export const isFreeLaunch = (cohortKey: string): boolean => FREE_LAUNCH.has(cohortKey);

export type CohortCell = { age: number; count: number; pct: number; observable: boolean };
export type CohortRow = { cohortKey: string; cohortIdx: number; size: number; free: boolean; cells: CohortCell[] };

export type Filter = { cityIdx?: number };

function inFilter(p: RetentionPlayer, f: Filter): boolean {
  return f.cityIdx == null || p.ct === f.cityIdx;
}

// One cohort → age matrix. Cells beyond the cohort's observable age are marked
// observable=false and must render empty (never 0%).
export function cohortMatrix(agg: RetentionAggregate, filter: Filter = {}): CohortRow[] {
  const nowIdx = idxOf(agg.nowMonth);
  const byCohort = new Map<number, RetentionPlayer[]>();
  for (const p of agg.players) {
    if (!inFilter(p, filter)) continue;
    (byCohort.get(p.c) ?? byCohort.set(p.c, []).get(p.c)!).push(p);
  }
  const rows: CohortRow[] = [];
  for (const [cIdx, members] of byCohort) {
    const cohortKey = agg.cohortMonths[cIdx];
    const maxObsAge = nowIdx - idxOf(cohortKey);
    const size = members.length;
    const cells: CohortCell[] = [];
    for (let n = 0; n <= MAX_AGE; n++) {
      const observable = n <= maxObsAge;
      let count = 0;
      if (observable) for (const p of members) if (p.k & (1 << n)) count++;
      cells.push({ age: n, count, pct: size ? (100 * count) / size : 0, observable });
    }
    rows.push({ cohortKey, cohortIdx: cIdx, size, free: isFreeLaunch(cohortKey), cells });
  }
  rows.sort((a, b) => b.cohortIdx - a.cohortIdx); // newest first
  return rows;
}

// Per-column unweighted mean across the visible cohorts, EXCLUDING free-launch.
// null where no non-free-launch cohort is observable at that age.
export function columnAverages(rows: CohortRow[]): (number | null)[] {
  const out: (number | null)[] = [];
  for (let n = 0; n <= MAX_AGE; n++) {
    const vals: number[] = [];
    for (const r of rows) {
      if (r.free) continue;
      const c = r.cells[n];
      if (c.observable) vals.push(c.pct);
    }
    out.push(vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null);
  }
  return out;
}

// Heat is relative to the column mean (the same value shown in the footer):
// above mean+2pp / within ±2pp / below mean-2pp; no observation → na.
export function heatClass(cell: CohortCell, colMean: number | null): "above" | "average" | "below" | "na" {
  if (!cell.observable) return "na";
  if (colMean == null) return "average";
  if (cell.pct > colMean + 2) return "above";
  if (cell.pct < colMean - 2) return "below";
  return "average";
}

// Retention curve = unweighted mean of per-cohort retentions at each age, over
// the cohorts old enough to be observed at that age. Break (null) where zero.
export type CurvePoint = { age: number; pct: number | null; cohorts: number };
export function retentionCurve(agg: RetentionAggregate, filter: Filter = {}): {
  points: CurvePoint[];
  cohortCount: number;
  span: [string, string] | null;
} {
  const rows = cohortMatrix(agg, filter);
  const points: CurvePoint[] = [];
  for (let n = 0; n <= MAX_AGE; n++) {
    const vals: number[] = [];
    for (const r of rows) if (r.cells[n].observable) vals.push(r.cells[n].pct);
    points.push({ age: n, pct: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null, cohorts: vals.length });
  }
  const keys = rows.map((r) => r.cohortKey).sort();
  return {
    points,
    cohortCount: rows.length,
    span: keys.length ? [keys[0], keys[keys.length - 1]] : null,
  };
}

// Churn at age N (N>=1) for one cohort = players active at N-1 and NOT at N.
// SET subtraction on the masks — never a difference of counts.
export function churnedAt(
  agg: RetentionAggregate,
  cohortKey: string,
  age: number,
  filter: Filter = {},
): RetentionPlayer[] {
  const cIdx = agg.cohortMonths.indexOf(cohortKey);
  if (cIdx < 0 || age < 1) return [];
  const prev = 1 << (age - 1);
  const cur = 1 << age;
  const out: RetentionPlayer[] = [];
  for (const p of agg.players) {
    if (p.c !== cIdx || !inFilter(p, filter)) continue;
    if (p.k & prev && !(p.k & cur)) out.push(p);
  }
  out.sort((a, b) => (a.l < b.l ? 1 : a.l > b.l ? -1 : 0)); // last match date desc
  return out;
}

// Every player in a cohort (age-0 click target), sorted by last match date desc.
export function cohortMembers(agg: RetentionAggregate, cohortKey: string, filter: Filter = {}): RetentionPlayer[] {
  const cIdx = agg.cohortMonths.indexOf(cohortKey);
  if (cIdx < 0) return [];
  const out = agg.players.filter((p) => p.c === cIdx && inFilter(p, filter));
  out.sort((a, b) => (a.l < b.l ? 1 : a.l > b.l ? -1 : 0));
  return out;
}

// "Mature cohorts only" footer: at every age, the unweighted mean over the
// non-free-launch cohorts that have been observable for a FULL 12 months (their
// age-12 cell has an observation). A fixed cohort set → the comparable curve.
export function matureColumnAverages(rows: CohortRow[]): (number | null)[] {
  const mature = rows.filter((r) => !r.free && r.cells[MAX_AGE].observable);
  const out: (number | null)[] = [];
  for (let n = 0; n <= MAX_AGE; n++) {
    // mature cohorts are observable at every age 0..12 by definition.
    const vals = mature.map((r) => r.cells[n].pct);
    out.push(vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null);
  }
  return out;
}

// One cohort split by first-match city: one row per city + a total row. The
// city Month-0 counts MUST sum to the cohort size — the caller asserts this.
export type CityDetailRow = { city: string; size: number; cells: CohortCell[]; total: boolean };
export function cohortCityDetail(agg: RetentionAggregate, cohortKey: string): CityDetailRow[] {
  const cIdx = agg.cohortMonths.indexOf(cohortKey);
  const nowIdx = idxOf(agg.nowMonth);
  const maxObsAge = nowIdx - idxOf(cohortKey);
  const members = agg.players.filter((p) => p.c === cIdx);
  const byCity = new Map<number, RetentionPlayer[]>();
  for (const p of members) (byCity.get(p.ct) ?? byCity.set(p.ct, []).get(p.ct)!).push(p);
  const mkCells = (ps: RetentionPlayer[]): CohortCell[] => {
    const size = ps.length;
    const cells: CohortCell[] = [];
    for (let n = 0; n <= MAX_AGE; n++) {
      const observable = n <= maxObsAge;
      let count = 0;
      if (observable) for (const p of ps) if (p.k & (1 << n)) count++;
      cells.push({ age: n, count, pct: size ? (100 * count) / size : 0, observable });
    }
    return cells;
  };
  const rows: CityDetailRow[] = [...byCity.entries()]
    .map(([ct, ps]) => ({ city: agg.cities[ct], size: ps.length, cells: mkCells(ps), total: false }))
    .sort((a, b) => b.size - a.size);
  rows.push({ city: "All cities", size: members.length, cells: mkCells(members), total: true });
  return rows;
}
