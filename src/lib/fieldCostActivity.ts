// FIELD COSTS — which venues have nothing happening in a month, so the list can hide them.
//
// DISPLAY ONLY. Nothing here changes a cost, a total or what OpEx draws; the page decides which rows
// to RENDER from this and keeps summing the rows it always summed. A venue is INACTIVE for the month
// only when all four hold (Ryan, 2026-10-03):
//
//   1. no matches in the month — none scheduled, none charged as a cancellation;
//   2. the month's cost is $0;
//   3. no amount set by hand for the month, on any leg (a bank-loaded amount counts: it is set);
//   4. no money leaving in the month — opexSources.fieldCostPayeesIn, which is the OpEx calendar
//      PLUS the pay-schedule projection over the whole month, so a missing bank record can never
//      hide a venue that is due to be paid.
//
// A venue with matches and a $0 cost (Bob Jones Park, the $0-rate venues) fails 1 and stays.
//
// A MONTH AFTER THE CURRENT ONE (Ryan, 2026-10-03): its matches mostly do not exist in MatchDay yet
// (on Oct 3 the table ended on Nov 1), so the four tests alone hid 40 of 41 venues in November. A
// venue is inactive in a future month only if it is ALSO inactive in the current month. Past and
// current months use the four tests alone.

import { buildFieldCostRows, type FieldCostRow } from "./financeCosts";
import { fieldCostPayeesIn, monthKeyFor } from "./opexSources";
import type { FinanceData } from "./useFinanceData";

const MONS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function parts(month: string): { year: number; month0: number } | null {
  const [m, y] = month.split(" ");
  const month0 = MONS.indexOf(m);
  return month0 < 0 || !Number.isFinite(Number(y)) ? null : { year: Number(y), month0 };
}

/** The keys of the rows to hide for `month`, as of `now`. */
export function inactiveFieldCostKeys(data: FinanceData, rows: FieldCostRow[], month: string, now: Date): Set<string> {
  const out = new Set<string>();
  const p = parts(month);
  if (!p) return out;
  const payees = fieldCostPayeesIn(data, p.year, p.month0, now);
  for (const r of rows) if (isInactiveFieldCostRow(data, r, month, payees)) out.add(r.key);
  const isFuture = p.year * 12 + p.month0 > now.getFullYear() * 12 + now.getMonth();
  if (!isFuture || out.size === 0) return out;
  // Future month: keep hidden only what is inactive in the current month as well.
  const curKey = monthKeyFor(now.getFullYear(), now.getMonth());
  const curPayees = fieldCostPayeesIn(data, now.getFullYear(), now.getMonth(), now);
  const idleNow = new Set<number>();
  for (const r of buildFieldCostRows(data, curKey as never)) {
    if (isInactiveFieldCostRow(data, r, curKey, curPayees)) idleNow.add(r.primaryVenueId);
  }
  for (const r of rows) if (out.has(r.key) && !idleNow.has(r.primaryVenueId)) out.delete(r.key);
  return out;
}

export function isInactiveFieldCostRow(
  data: FinanceData,
  row: FieldCostRow,
  month: string,
  payees: Set<number>,
): boolean {
  if (row.matchCount !== 0 || row.rawMatchCount !== 0) return false;
  if (Math.abs(row.amount) >= 0.005 || Math.abs(row.autoAmount) >= 0.005) return false;
  const legs = new Set([row.primaryVenueId, ...row.secondaryVenueIds]);
  if (data.overrides.some((o) => o.month === month && legs.has(o.venue_id))) return false;
  return !payees.has(row.primaryVenueId);
}

/** The footer's figures for a set of rows. The page computes them from EVERY row the filters keep,
 *  hidden or not; scripts/field-cost-activity-test.ts proves the inactive rows add nothing, so the
 *  figures are the same with the toggle on or off. */
export function fieldCostTotals(rows: FieldCostRow[]): { matches: number; amount: number } {
  return {
    matches: rows.reduce((a, r) => a + r.matchCount, 0),
    amount: Math.round(rows.reduce((a, r) => a + r.amount, 0) * 100) / 100,
  };
}
