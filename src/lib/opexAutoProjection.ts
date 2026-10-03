// OPEX — THE AUTOMATIC MATCH MANAGER PAY PROJECTION (Ryan, 2026-10-03).
//
// Match manager pay leaves every Tuesday, for the Monday–Sunday work week before it. The daily
// recompute (managerPayCompute.recomputeManagerPayIntoFinExpenses) writes it into fin_expenses as
// "Match Manager Pay" rows, one per city per Tuesday, up to the week in progress — so OpEx already
// shows the coming Tuesday's computed amount and nothing after it.
//
// THE RULE, AND NOTHING MORE:
//   · A Tuesday that HAS match manager pay rows shows that real amount, as it always has.
//   · A Tuesday with NONE, from today through two months out, shows ONE projected total: the mean
//     of the last 4 Tuesdays whose work week has CLOSED (its Sunday is before today). The week in
//     progress is never in the mean. The window rolls forward on its own as weeks close.
//   · Calculated, never stored. Match managers only — city manager and other pay are not in it.
//   · OpEx only: buildOpexCalendarAsOf adds it only when the OpEx page asks (Show projections on).
//
// Pure: no Supabase, safe in node suites (scripts/opex-projections-test.ts).

import type { FinExpense } from "./useFinanceData";

export const MATCH_PAY_CATEGORY = "Match Manager Pay";

export type AutoBasisWeek = {
  /** The pay Tuesday, YYYY-MM-DD. */
  tuesday: string;
  /** The Monday the work week starts. */
  weekStart: string;
  /** All cities, dollars. */
  total: number;
};

export type AutoMatchPay = {
  /** The Tuesdays that get a projection, YYYY-MM-DD, ascending. */
  tuesdays: string[];
  /** The projected total for each of them (the mean of `basis`), dollars to the cent. */
  amount: number;
  /** The four closed weeks the mean is taken over, newest first. */
  basis: AutoBasisWeek[];
};

const pad = (n: number) => String(n).padStart(2, "0");
const isoOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDaysIso = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const isTuesday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay() === 2;

/** Total match manager pay per pay date, from the Expenses rows. */
function totalsByTuesday(expenses: readonly FinExpense[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of expenses) {
    if (e.category !== MATCH_PAY_CATEGORY || !e.date) continue;
    const d = e.date.slice(0, 10);
    m.set(d, Math.round(((m.get(d) ?? 0) + Number(e.amount)) * 100) / 100);
  }
  return m;
}

/**
 * The automatic projection as of `now`. `tuesdays` is empty when there are fewer than 4 closed
 * weeks to average — no projection is shown rather than a mean of fewer weeks.
 */
export function autoMatchManagerPay(expenses: readonly FinExpense[], now: Date): AutoMatchPay {
  const today = isoOf(now);
  const totals = totalsByTuesday(expenses);

  // CLOSED: the work week's Sunday (Tuesday − 2) is before today. The week in progress is out.
  const closed = [...totals.keys()].filter((t) => isTuesday(t) && addDaysIso(t, -2) < today).sort().reverse();
  const basis = closed.slice(0, 4).map((t) => ({ tuesday: t, weekStart: addDaysIso(t, -8), total: totals.get(t)! }));
  if (basis.length < 4) return { tuesdays: [], amount: 0, basis };
  const amount = Math.round((basis.reduce((s, w) => s + w.total, 0) / 4) * 100) / 100;

  // Every Tuesday from today through the same date two months out (Oct 3 → Dec 3), skipping any
  // Tuesday that already has real rows.
  const end = isoOf(new Date(now.getFullYear(), now.getMonth() + 2, now.getDate()));
  const tuesdays: string[] = [];
  let t = today;
  while (!isTuesday(t)) t = addDaysIso(t, 1);
  for (; t <= end; t = addDaysIso(t, 7)) if (!totals.has(t)) tuesdays.push(t);

  return { tuesdays, amount, basis };
}
