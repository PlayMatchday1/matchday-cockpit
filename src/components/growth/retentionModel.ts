// Client-side derivations over one CohortMatrixPayload (the pre-aggregated
// growth_cohort_matrix, fetched from /api/growth/retention). Both the retention
// curve and the cohort table read these — no second data source, no masks. The
// definitions still hold verbatim (cohort = first-match month, active = >=1
// match in month, age = months since cohort); the set-subtraction churn and the
// per-city split now come from their own endpoints, so they live in the panels.

// The cohort matrix payload as returned by GET /api/growth/retention. Ages run
// 0..12; ONLY non-zero (month, age) groups are present — a MISSING cell means 0
// active. `cities` are display names for the city filter; `city` is which city
// this payload is for ("all" or a display name).
export type CohortMatrixPayload = {
  cohortMonths: string[];
  nowMonth: string;
  cities: string[];
  city: string;
  cells: { month: string; age: number; players: number }[];
  generatedAt: string;
};

export const MAX_AGE = 12;
export const FREE_LAUNCH = new Set(["2023-04", "2023-05"]);

export const idxOf = (k: string): number => {
  const [y, m] = k.split("-").map(Number);
  return y * 12 + (m - 1);
};
export const isFreeLaunch = (cohortKey: string): boolean => FREE_LAUNCH.has(cohortKey);

export type CohortCell = { age: number; count: number; pct: number; observable: boolean };
export type CohortRow = { cohortKey: string; cohortIdx: number; size: number; free: boolean; cells: CohortCell[] };

// One CohortRow per distinct cohort month that has cells. size = the age-0 cell
// (every cohort has one). count = the (month, age) cell's players, or 0 when the
// cell is ABSENT (a real 0 within the observable window). Cells beyond the
// cohort's observable age render empty (never 0%). Newest cohort first.
export function cohortMatrix(payload: CohortMatrixPayload): CohortRow[] {
  const nowIdx = idxOf(payload.nowMonth);
  // month -> age -> players, so an absent (month, age) reads back as 0.
  const byMonth = new Map<string, Map<number, number>>();
  for (const cell of payload.cells) {
    let ages = byMonth.get(cell.month);
    if (!ages) byMonth.set(cell.month, (ages = new Map()));
    ages.set(cell.age, cell.players);
  }
  const rows: CohortRow[] = [];
  payload.cohortMonths.forEach((cohortKey, cohortIdx) => {
    const ages = byMonth.get(cohortKey);
    if (!ages) return; // a cohort month with no cells at all contributes no row
    const size = ages.get(0) ?? 0;
    const maxObsAge = nowIdx - idxOf(cohortKey);
    const cells: CohortCell[] = [];
    for (let n = 0; n <= MAX_AGE; n++) {
      const observable = n <= maxObsAge;
      const count = ages.get(n) ?? 0;
      cells.push({ age: n, count, pct: size ? (100 * count) / size : 0, observable });
    }
    rows.push({ cohortKey, cohortIdx, size, free: isFreeLaunch(cohortKey), cells });
  });
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
export function retentionCurve(payload: CohortMatrixPayload): {
  points: CurvePoint[];
  cohortCount: number;
  span: [string, string] | null;
} {
  const rows = cohortMatrix(payload);
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
