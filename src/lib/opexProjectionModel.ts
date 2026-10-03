// OPEX PROJECTIONS — THE MODEL (pure: no Supabase, safe in node suites). The table and its writes
// are in ./opexProjections. See that file for what a projection is and why it is OpEx-only.

export type ProjCat = "pers" | "field" | "equip" | "mkt" | "subs" | "misc";
export type ProjRepeat = "once" | "weekly" | "biweekly" | "monthly";

export type OpexProjection = {
  id: number;
  category: ProjCat;
  description: string;
  /** Dollars, per payment. */
  amount: number;
  /** YYYY-MM-DD. */
  first_date: string;
  repeat: ProjRepeat;
  /** YYYY-MM-DD, the last day it may pay; null = carries forward until removed. */
  end_date: string | null;
  /** YYYY-MM-DD dates removed one at a time ("this payment only"). */
  skipped_dates: string[];
};

export type ProjectionDraft = Omit<OpexProjection, "id" | "skipped_dates">;

export const REPEAT_LABEL: Record<ProjRepeat, string> = {
  once: "Once",
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  monthly: "Monthly",
};

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m0: number, d: number) => `${y}-${pad(m0 + 1)}-${pad(d)}`;
const dayMs = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));

/**
 * Every date this projection pays in the given month, as YYYY-MM-DD, ascending.
 *   once      — first_date, if it is in the month
 *   weekly    — first_date, then every 7 days
 *   biweekly  — first_date, then every 14 days
 *   monthly   — first_date's day of the month, moved to the month's last day where that day does
 *               not exist (31 Jan → 30 Apr, 28 Feb)
 * Never before first_date, never after end_date, never on a skipped date.
 */
export function projectionDatesIn(p: Pick<OpexProjection, "first_date" | "repeat" | "end_date" | "skipped_dates">, year: number, month0: number): string[] {
  const dim = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const from = ymd(year, month0, 1), to = ymd(year, month0, dim);
  const start = p.first_date;
  const end = p.end_date && p.end_date < to ? p.end_date : to;
  if (start > end) return [];
  const skip = new Set(p.skipped_dates ?? []);
  const out: string[] = [];
  const keep = (iso: string) => { if (iso >= from && iso <= end && iso >= start && !skip.has(iso)) out.push(iso); };
  if (p.repeat === "once") keep(start);
  else if (p.repeat === "monthly") {
    const want = +start.slice(8, 10);
    keep(ymd(year, month0, Math.min(want, dim)));
  } else {
    const step = p.repeat === "weekly" ? 7 : 14;
    const s = dayMs(start), f = dayMs(from);
    // First occurrence on or after the 1st of the month.
    const k = f <= s ? 0 : Math.ceil((f - s) / 86_400_000 / step);
    for (let t = s + k * step * 86_400_000; ; t += step * 86_400_000) {
      const iso = new Date(t).toISOString().slice(0, 10);
      if (iso > end) break;
      keep(iso);
    }
  }
  return out;
}

/** Day of month → amount, for one projection in one month. Dollars, to the cent. */
export function projectionCells(p: OpexProjection, year: number, month0: number): Record<number, number> {
  const cells: Record<number, number> = {};
  const amt = Math.round(p.amount * 100) / 100;
  for (const iso of projectionDatesIn(p, year, month0)) {
    const d = +iso.slice(8, 10);
    cells[d] = Math.round(((cells[d] ?? 0) + amt) * 100) / 100;
  }
  return cells;
}
