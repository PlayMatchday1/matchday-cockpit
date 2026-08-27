// Player Data Room pivot engine. Every figure is an aggregation of a per-play
// FACT table (one row per participation spot), so any cell can be recomputed and
// any cell can be drilled to the exact players behind it. Facts come from
// growth_participation (city/field/month/amount) joined to growth_player_profile
// (cohort = first-match month; isNew = cohort month === activity month). The fact
// table is built once per warm instance and cached on the max participation month
// so the interactive pivot doesn't re-scan 145k rows every request.
//
// Two aggregation rules that pivot tools get wrong and we hold to:
//   • Players / New players are DISTINCT players — row values do NOT sum to the
//     grand total when a player appears in more than one row. That's correct.
//   • Average is always PER PLAYER: sum over distinct players in the cell, never
//     over the underlying rows.

import type { SupabaseClient } from "@supabase/supabase-js";
import { CITY_CODE_TO_DISPLAY } from "./scheduleReconcile";
import { canonicalVenueName } from "./venueResolver";

const MN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthIdx = (m: string) => { const [y, mo] = m.split("-").map(Number); return y * 12 + (mo - 1); };
const mLab = (m: string) => `${MN[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const cLab = (i: number) => `${MN[i % 12]} ${Math.floor(i / 12)}`;

export type Fact = {
  id: number;
  city: string; // display
  field: string; // canonical
  month: string; // YYYY-MM
  cohortIdx: number; // months since epoch of first-match month
  spots: number; // 1 per play
  matches: number; // 1 per play
  revenue: number; // dollars
  isNew: boolean; // first-match month === activity month
};

export const DIMS = ["City", "Field", "Month", "Year", "Cohort year", "Cohort month"] as const;
export type Dim = (typeof DIMS)[number];
const dimValue = (f: Fact, d: Dim): string => {
  switch (d) {
    case "City": return f.city;
    case "Field": return f.field;
    case "Month": return mLab(f.month);
    case "Year": return f.month.slice(0, 4);
    case "Cohort year": return String(Math.floor(f.cohortIdx / 12));
    case "Cohort month": return cLab(f.cohortIdx);
  }
};
// deterministic order per dim (chronological where meaningful, else alphabetical)
const dimSortKey = (d: Dim, v: string): number | null => {
  if (d === "Month") return monthIdx(`${v.slice(-4)}-${String(MN.indexOf(v.slice(0, 3)) + 1).padStart(2, "0")}`);
  if (d === "Cohort month") { const [m, y] = v.split(" "); return Number(y) * 12 + MN.indexOf(m); }
  if (d === "Year" || d === "Cohort year") return Number(v);
  return null;
};

export type Metric = "Players" | "New players" | "Spots booked" | "Revenue" | "Matches";
export const METRICS: Record<Metric, { aggs: ("Count" | "Sum" | "Average")[]; money?: boolean }> = {
  Players: { aggs: ["Count"] },
  "New players": { aggs: ["Count"] },
  "Spots booked": { aggs: ["Sum", "Average"] },
  Revenue: { aggs: ["Sum", "Average"], money: true },
  Matches: { aggs: ["Sum", "Average"] },
};
export type Agg = "Count" | "Sum" | "Average";
export type ValueSpec = { metric: Metric; agg: Agg };

/** One measured value over a set of facts. Average = per DISTINCT player. */
export function measure(facts: Fact[], { metric, agg }: ValueSpec): number {
  if (metric === "Players") return new Set(facts.map((f) => f.id)).size;
  if (metric === "New players") return new Set(facts.filter((f) => f.isNew).map((f) => f.id)).size;
  const field = metric === "Revenue" ? "revenue" : metric === "Matches" ? "matches" : "spots";
  const sum = facts.reduce((a, f) => a + (f[field] as number), 0);
  if (agg === "Sum") return metric === "Revenue" ? Math.round(sum * 100) / 100 : sum;
  const players = new Set(facts.map((f) => f.id)).size || 1; // Average = sum / distinct players
  return Math.round((sum / players) * 100) / 100;
}

const keyOf = (f: Fact, dims: Dim[]) => dims.map((d) => dimValue(f, d)).join(" · ");
function sortKeys(keys: string[], dims: Dim[]): string[] {
  const last = dims[dims.length - 1];
  return keys.slice().sort((a, b) => {
    const pa = a.split(" · ").pop()!, pb = b.split(" · ").pop()!;
    const oa = dimSortKey(last, pa), ob = dimSortKey(last, pb);
    if (oa != null && ob != null && oa !== ob) return oa - ob;
    return a.localeCompare(b);
  });
}

export type PivotConfig = {
  rows: Dim[];
  cols: Dim[]; // 0 or 1
  vals: ValueSpec[];
  filters: { from: string; to: string; city: string; field: string }; // months YYYY-MM; city/field "all" or a value
};

function scope(facts: Fact[], filters: PivotConfig["filters"]): Fact[] {
  const from = monthIdx(filters.from), to = monthIdx(filters.to);
  return facts.filter(
    (f) => monthIdx(f.month) >= from && monthIdx(f.month) <= to &&
      (filters.city === "all" || f.city === filters.city) &&
      (filters.field === "all" || f.field === filters.field),
  );
}

export type PivotTable = {
  rowKeys: string[];
  colKeys: string[]; // [""] when no column dim
  hasCols: boolean;
  cells: Record<string, Record<string, (number | null)[]>>; // rowKey -> colKey -> [value per valueSpec]
  rowTotals: Record<string, number[]>; // rowKey -> [value per valueSpec] over all columns
  colTotals: number[][]; // per colKey: [value per valueSpec]  (grand-total row)
  grandTotal: number[]; // per valueSpec over ALL facts (distinct — not the sum of rows)
  distinctPlayers: number;
  months: { from: string; to: string };
};

export function pivot(allFacts: Fact[], cfg: PivotConfig): PivotTable {
  const facts = scope(allFacts, cfg.filters);
  const hasCols = cfg.cols.length > 0;
  const rowKeys = sortKeys([...new Set(facts.map((f) => keyOf(f, cfg.rows)))], cfg.rows);
  const colKeys = hasCols ? sortKeys([...new Set(facts.map((f) => keyOf(f, cfg.cols)))], cfg.cols) : [""];

  const bucket = new Map<string, Fact[]>();
  for (const f of facts) {
    const k = keyOf(f, cfg.rows) + "||" + (hasCols ? keyOf(f, cfg.cols) : "");
    (bucket.get(k) ?? bucket.set(k, []).get(k)!).push(f);
  }
  const at = (r: string, c: string) => bucket.get(r + "||" + c) ?? [];

  const cells: PivotTable["cells"] = {};
  const rowTotals: PivotTable["rowTotals"] = {};
  for (const r of rowKeys) {
    cells[r] = {};
    for (const c of colKeys) {
      const fs = at(r, c);
      cells[r][c] = cfg.vals.map((v) => (fs.length ? measure(fs, v) : null));
    }
    const rowFacts = facts.filter((f) => keyOf(f, cfg.rows) === r);
    rowTotals[r] = cfg.vals.map((v) => measure(rowFacts, v));
  }
  const colTotals = colKeys.map((c) => {
    const fs = hasCols ? facts.filter((f) => keyOf(f, cfg.cols) === c) : facts;
    return cfg.vals.map((v) => (fs.length ? measure(fs, v) : 0));
  });
  return {
    rowKeys, colKeys, hasCols, cells, rowTotals, colTotals,
    grandTotal: cfg.vals.map((v) => measure(facts, v)),
    distinctPlayers: new Set(facts.map((f) => f.id)).size,
    months: { from: cfg.filters.from, to: cfg.filters.to },
  };
}

export type DrilledPlayer = { id: number; city: string; field: string; cohort: string; months: number; spots: number; revenue: number };
/** The distinct players inside one cell (rowKey r, colKey c). c === "__all__" or
 * no column dim = the whole row. Respects the same filters as the table. */
export function cellPlayers(allFacts: Fact[], cfg: PivotConfig, r: string, c: string): DrilledPlayer[] {
  const facts = scope(allFacts, cfg.filters).filter(
    (f) => keyOf(f, cfg.rows) === r && (c === "__all__" || !cfg.cols.length || keyOf(f, cfg.cols) === c),
  );
  const byId = new Map<number, DrilledPlayer & { monthsSet: Set<string> }>();
  for (const f of facts) {
    let p = byId.get(f.id);
    if (!p) byId.set(f.id, (p = { id: f.id, city: f.city, field: f.field, cohort: cLab(f.cohortIdx), months: 0, spots: 0, revenue: 0, monthsSet: new Set() }));
    p.monthsSet.add(f.month);
    p.spots += f.spots;
    p.revenue = Math.round((p.revenue + f.revenue) * 100) / 100;
  }
  return [...byId.values()]
    .map((p) => ({ id: p.id, city: p.city, field: p.field, cohort: p.cohort, months: p.monthsSet.size, spots: p.spots, revenue: p.revenue }))
    .sort((a, b) => b.spots - a.spots || a.id - b.id);
}

// ── fact table (cached per warm instance, keyed on max participation month) ────
let cache: { key: string; facts: Fact[]; monthsAvailable: string[]; cities: string[]; fieldsByCity: Record<string, string[]> } | null = null;

async function selectAll<T>(sb: SupabaseClient, table: string, cols: string, order: string): Promise<T[]> {
  const { count } = await sb.from(table).select("*", { count: "exact", head: true });
  const total = count ?? 0;
  if (!total) return [];
  const PAGE = 1000, CONC = 8, pages = Math.ceil(total / PAGE);
  const out: T[] = new Array(total);
  let next = 0;
  async function worker() {
    for (;;) {
      const p = next++;
      if (p >= pages) return;
      const { data, error } = await sb.from(table).select(cols).order(order, { ascending: true }).range(p * PAGE, p * PAGE + PAGE - 1);
      if (error) throw new Error(`${table} p${p}: ${error.message}`);
      const rows = (data ?? []) as unknown as T[];
      for (let i = 0; i < rows.length; i++) out[p * PAGE + i] = rows[i];
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, pages) }, worker));
  return out.filter((r) => r !== undefined);
}

// Keyset (seek) pagination: `where key > last order by key limit 1000` — an index
// seek per page, no deep-offset scan. Required for VIEW sources that re-join.
async function keysetAll<T extends Record<string, unknown>>(sb: SupabaseClient, table: string, cols: string, keyCol: string): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  let last: number | null = null;
  for (;;) {
    let q = sb.from(table).select(cols).order(keyCol, { ascending: true }).limit(PAGE);
    if (last != null) q = q.gt(keyCol, last);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as unknown as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    last = rows[rows.length - 1][keyCol] as number;
  }
  return out;
}

export async function getFacts(sb: SupabaseClient): Promise<NonNullable<typeof cache>> {
  const { data: maxRow } = await sb.from("growth_participation").select("match_month").order("match_month", { ascending: false }).limit(1).maybeSingle();
  const key = String(maxRow?.match_month ?? "");
  if (cache && cache.key === key) return cache;

  const [parts, profs] = await Promise.all([
    // growth_participation is a VIEW (a 145k-row join), so OFFSET pagination
    // re-joins + deep-skips and hits the statement timeout on later pages. KEYSET
    // (seek on the indexed player_api_id) reads each page with an index seek.
    keysetAll<{ player_api_id: number; user_id: number; match_month: string; city_identifier: string | null; field_title: string | null; field_id: number | null; total_amount: number | string }>(
      sb, "growth_participation", "player_api_id, user_id, match_month, city_identifier, field_title, field_id, total_amount", "player_api_id",
    ),
    selectAll<{ user_id: number; first_match_month: string }>(sb, "growth_player_profile", "user_id, first_match_month", "user_id"),
  ]);
  const cohortOf = new Map<number, number>();
  for (const p of profs) cohortOf.set(p.user_id, monthIdx(p.first_match_month));

  const cityOf = (c: string | null) => (c ? CITY_CODE_TO_DISPLAY[c] ?? c : "Unknown city");
  const fieldOf = (t: string | null, id: number | null) => canonicalVenueName(t ?? "") || (id != null ? `Field ${id}` : "Unknown field");

  const facts: Fact[] = [];
  const monthsSet = new Set<string>();
  const fieldsByCity: Record<string, Set<string>> = {};
  for (const r of parts) {
    const cohortIdx = cohortOf.get(r.user_id);
    if (cohortIdx == null) continue; // played user always has a profile; guard anyway
    const city = cityOf(r.city_identifier);
    const field = fieldOf(r.field_title, r.field_id);
    monthsSet.add(r.match_month);
    (fieldsByCity[city] ?? (fieldsByCity[city] = new Set())).add(field);
    facts.push({
      id: r.user_id, city, field, month: r.match_month, cohortIdx,
      spots: 1, matches: 1, revenue: Number(r.total_amount) / 100, isNew: cohortIdx === monthIdx(r.match_month),
    });
  }
  const monthsAvailable = [...monthsSet].sort();
  const cities = Object.keys(fieldsByCity).filter((c) => c !== "Unknown city").sort();
  cache = { key, facts, monthsAvailable, cities, fieldsByCity: Object.fromEntries(Object.entries(fieldsByCity).map(([c, s]) => [c, [...s].sort()])) };
  return cache;
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE REBUILD (2026-08-27) — the total's window, the heat scale, the swap, and the memo.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── THE TOTAL COLUMN, AND THE ONE THING THE BRIEF ASKED FOR THAT IS NOT TRUE ─────────────────
 * The brief: "assert that a row's total equals the sum of that row's visible cells". That holds
 * for the ADDITIVE measures and CANNOT hold for the DISTINCT ones, measured on production:
 *
 *   window Feb–Sep 2026, row Austin, Spots booked : cells sum 23,577 · total 23,577   equal
 *   window Feb–Sep 2026, row Austin, Players      : cells sum  6,712 · total  2,927   NOT equal
 *
 * 6,712 is how many times an Austin player appeared in a month; 2,927 is how many people that is.
 * A player active in five months is one player and five cells. Summing the cells would answer a
 * question nobody asked and would be wrong by 3,785 on that row alone.
 *
 * So the rule is per-measure and both halves are asserted:
 *   · ADDITIVE (Spots booked, Revenue, Matches) — total EQUALS the sum of the visible cells.
 *   · DISTINCT (Players, New players)           — total is the distinct count over the window,
 *     which is <= the sum of the cells and >= the largest single cell.
 * And for BOTH: narrowing the window can only lower it.
 *
 * WHAT WAS ACTUALLY BROKEN. The 7,450 on screen against 6,712 of visible cells is Austin's total
 * over Apr 2023 – Sep 2026 while the columns showed Feb – Sep 2026 — the total and the columns were
 * computed over different windows. `totalWindow` makes the window the total covers a value the
 * header prints, so the two cannot drift without the label being wrong in a way anyone can see. */

export const ADDITIVE_METRICS: readonly Metric[] = ["Spots booked", "Revenue", "Matches"];
export const DISTINCT_METRICS: readonly Metric[] = ["Players", "New players"];
export const isAdditive = (m: Metric): boolean => ADDITIVE_METRICS.includes(m);

/** "Feb 2026 – Sep 2026", or a single month when the window is one month wide. */
export function windowLabel(from: string, to: string): string {
  const a = mLab(from), b = mLab(to);
  return a === b ? a : `${a} – ${b}`;
}

/** How the Total column is headed. A distinct measure is not a sum and must not be labelled one. */
export function totalHeader(from: string, to: string, metric: Metric): { window: string; kind: "sum" | "distinct" } {
  return { window: windowLabel(from, to), kind: isAdditive(metric) ? "sum" : "distinct" };
}

/* ── SWAP ──────────────────────────────────────────────────────────────────────────────────────
 * Exchanging the axes is the most common move in any pivot table and it took four clicks. It is
 * one, and it is pure: same fields, opposite zones.
 *
 * COLUMNS HOLD AT MOST ONE FIELD and rows may hold several, so a swap of two-deep rows would have
 * to drop one. It does not — it refuses, and the caller leaves the button disabled with that
 * reason. Silently discarding a field the operator chose is worse than not swapping. */
export function swapAxes(cfg: PivotConfig): PivotConfig | null {
  if (cfg.rows.length > 1) return null;
  if (!cfg.rows.length && !cfg.cols.length) return null;
  return { ...cfg, rows: [...cfg.cols], cols: [...cfg.rows] };
}
export const canSwap = (cfg: PivotConfig): boolean => swapAxes(cfg) !== null;

/** The table's own title, so it retitles itself on a swap rather than describing the old shape. */
export function tableTitle(cfg: PivotConfig): string {
  const v = cfg.vals[0];
  const head = v ? (v.agg === "Count" ? v.metric : `${v.metric} · ${v.agg}`) : "—";
  const r = cfg.rows.join(" · ") || "All";
  return cfg.cols.length ? `${head} — ${r} by ${cfg.cols.join(" · ")}` : `${head} — ${r}`;
}

/* ── HEAT SHADING ──────────────────────────────────────────────────────────────────────────────
 * One hue, light to dark, scaled across the WHOLE grid — that is what makes a 9×8 table readable
 * without reading it. The ceiling is the constraint: a step dark enough to fight the text is worse
 * than no shading, so the ramp stops well short of the ink and the suite asserts the CONTRAST
 * RATIO rather than anybody squinting at it.
 *
 * Relative luminance and contrast are the WCAG definitions, so "readable" is a number here and not
 * a matter of taste. */
export const HEAT_HUE = { r: 0x0f, g: 0x33, b: 0x23 }; // the forest green the app already uses
export const HEAT_STEPS = 5;
export const HEAT_INK = "#10231A";
/** The lightest step is plain white — an empty or minimum cell must not look shaded at all. */
export const HEAT_MIN_ALPHA = 0;
export const HEAT_MAX_ALPHA = 0.30;

const srgb = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
}
export const hexToRgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};
export function contrastRatio(fg: string, bg: string): number {
  const [a, b] = [hexToRgb(fg), hexToRgb(bg)].map(([r, g, bl]) => luminance(r, g, bl));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/** Step 0..HEAT_STEPS-1 for a value against the grid's own min and max. null renders unshaded. */
export function heatStep(v: number | null, min: number, max: number, steps = HEAT_STEPS): number {
  if (v == null || !Number.isFinite(v) || max <= min) return 0;
  const t = (v - min) / (max - min);
  return Math.min(steps - 1, Math.max(0, Math.floor(t * steps)));
}

/** The composited background for a step, as a hex string — composited so contrast is computable. */
export function heatColour(step: number, steps = HEAT_STEPS): string {
  const a = steps <= 1 ? HEAT_MIN_ALPHA : HEAT_MIN_ALPHA + ((HEAT_MAX_ALPHA - HEAT_MIN_ALPHA) * step) / (steps - 1);
  const mix = (c: number) => Math.round(255 + (c - 255) * a);
  const hx = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hx(mix(HEAT_HUE.r))}${hx(mix(HEAT_HUE.g))}${hx(mix(HEAT_HUE.b))}`;
}

/** min/max across every cell of the grid — the scale is the WHOLE table, not per row. */
export function heatRange(t: PivotTable, valIdx = 0): { min: number; max: number } {
  let min = Infinity, max = -Infinity;
  for (const r of t.rowKeys) for (const c of t.colKeys) {
    const v = t.cells[r]?.[c]?.[valIdx];
    if (v == null || !Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return Number.isFinite(min) ? { min, max } : { min: 0, max: 0 };
}

/* ── THE MEMO ──────────────────────────────────────────────────────────────────────────────────
 * The full cross-tab was recomputed on every change. Measured on production, 151,559 facts:
 * 928 ms for 42 columns of Players, 111 ms for 8. A swap is the same cube read the other way, so
 * it should not cost a recompute at all.
 *
 * Keyed on the CONFIG, not on the facts — the fact table is already cached per warm instance and
 * rebuilt only when a new participation month lands, and `factsKey` ties this cache to that one so
 * a fresh fact table cannot be served through a stale cube. */
const cubeCache = new Map<string, PivotTable>();
const CUBE_CACHE_MAX = 24;

export const configKey = (cfg: PivotConfig): string => JSON.stringify([
  cfg.rows, cfg.cols, cfg.vals.map((v) => [v.metric, v.agg]),
  [cfg.filters.from, cfg.filters.to, cfg.filters.city, cfg.filters.field],
]);

export function pivotCached(allFacts: Fact[], cfg: PivotConfig, factsKey: string): { table: PivotTable; hit: boolean } {
  const k = factsKey + "|" + configKey(cfg);
  const got = cubeCache.get(k);
  if (got) {
    // Refresh recency so the entries in active rotation are the ones that survive.
    cubeCache.delete(k); cubeCache.set(k, got);
    return { table: got, hit: true };
  }
  const table = pivot(allFacts, cfg);
  cubeCache.set(k, table);
  // Oldest out first. A bounded map, because an operator dragging fields around would otherwise
  // hold every cube they have ever built for the life of the instance.
  while (cubeCache.size > CUBE_CACHE_MAX) cubeCache.delete(cubeCache.keys().next().value as string);
  return { table, hit: false };
}
export const cubeCacheSize = () => cubeCache.size;
export const clearCubeCache = () => cubeCache.clear();
