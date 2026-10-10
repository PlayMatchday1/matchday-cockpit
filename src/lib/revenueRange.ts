/* FINANCE › REVENUE — the month range (From / To and the 4M / 6M / 12M / Since launch presets) and
 * the sortable City / Field tables. Pure helpers; no figure is computed here, only months and order. Month keys are "YYYY-MM" (the rollup's period is "YYYY-MM-01").
 * Calendar arithmetic only — no Date parsing of stored timestamps, so no timezone can shift a month. */

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type Ym = string; // "2026-10"

export const ymOfDate = (d: Date): Ym => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
export const ymOfPeriodKey = (k: string): Ym => k.slice(0, 7);
export const periodKeyOfYm = (ym: Ym) => `${ym}-01`;
export function addMonths(ym: Ym, n: number): Ym {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, "0")}`;
}
/** Inclusive, oldest first. Empty when from > to. */
export function monthsBetween(from: Ym, to: Ym): Ym[] {
  const out: Ym[] = [];
  for (let m = from; m <= to && out.length < 600; m = addMonths(m, 1)) out.push(m);
  return out;
}
export const shortYm = (ym: Ym) => `${MONTH_SHORT[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
export const dateOfYm = (ym: Ym) => new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1);

export type Preset = "4" | "6" | "12" | "since";
export type MonthRange = { from: Ym; to: Ym; preset: Preset | null };

/** The range a preset means, ending at `to`. "since" starts at the launch month, clamped to the data. */
export function presetRange(p: Preset, to: Ym, launch: Ym | null, first: Ym | null): MonthRange {
  if (p === "since") {
    const from = launch ?? first ?? to;
    return { from: first && from < first ? first : from > to ? to : from, to, preset: p };
  }
  const from = addMonths(to, -(Number(p) - 1));
  return { from: first && from < first ? first : from, to, preset: p };
}

/** SORTING. Numbers start highest first, text A to Z; a second click reverses. A missing value (a
 *  dash) sorts LAST in both directions. Ties keep the incoming order. */
export type SortKey = string;
export type SortState = { key: SortKey; dir: 1 | -1 };
export function nextSort(cur: SortState, key: SortKey, isText: boolean): SortState {
  return cur.key === key ? { key, dir: cur.dir === 1 ? -1 : 1 } : { key, dir: isText ? 1 : -1 };
}
export function sortBy<T>(rows: T[], valueOf: (r: T) => number | string | null, dir: 1 | -1): T[] {
  return rows.map((r, i) => ({ r, i, v: valueOf(r) })).sort((a, b) => {
    if (a.v == null && b.v == null) return a.i - b.i;
    if (a.v == null) return 1;
    if (b.v == null) return -1;
    const c = typeof a.v === "string" && typeof b.v === "string"
      ? a.v.localeCompare(b.v)
      : (a.v as number) - (b.v as number);
    return c * dir || a.i - b.i;
  }).map((x) => x.r);
}
