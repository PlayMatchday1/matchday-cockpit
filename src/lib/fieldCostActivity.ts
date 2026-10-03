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

import type { FieldCostRow } from "./financeCosts";
import type { FinanceData } from "./useFinanceData";

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
