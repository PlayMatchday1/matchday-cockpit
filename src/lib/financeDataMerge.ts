// MERGING TWO QUARTERS OF FinanceData, BY MONTH OWNERSHIP.
//
// THE PROBLEM. useFinanceData fetches ONE quarter, padded 14 days either side. Finance › Revenue
// plots the current month plus the prior three — four months always cross a quarter boundary, so
// the page holds two quarters and has to combine them.
//
// WHY NOT JUST CONCATENATE. Two reasons, both of which produce a wrong number silently:
//
//   1. DOUBLE COUNTING. The ±14d pad means the last fortnight of the previous quarter appears in
//      BOTH fetches. Concatenating fin_revenue would count those rows twice.
//   2. PARTIAL MONTHS WEARING WHOLE-MONTH LABELS. The pad delivers a FRAGMENT of the boundary
//      month — Q3 2026's window opened covering only Jun 17–30. A fragment carrying the label
//      "Jun 2026" is worse than no June at all: it looks complete. quarters.ts records this
//      exact failure inflating a city benchmark rate roughly fourfold.
//
// SO: each month is served by the quarter that CONTAINS it, and by that quarter only. Rows are
// partitioned on their month label, never merged within a month. A month nobody owns is absent,
// which reads as a gap rather than as a small number.
//
// Non-month-scoped facts (venues, pricing, aliases, config, partner dashboard configs) are
// identical in both fetches and are taken from the primary quarter.

import type { FinanceData } from "./useFinanceData";
import type { Q2Month } from "./financeStats";

// Split a `${something}|${month}` map key. The month is the last segment because a venue id and a
// city name both sit on the left and a city name can itself contain no pipe.
function monthOfKey(key: string): string {
  const i = key.lastIndexOf("|");
  return i < 0 ? "" : key.slice(i + 1);
}

function pickMap<V>(
  primary: Map<string, V>,
  secondary: Map<string, V>,
  secondaryMonths: ReadonlySet<Q2Month>,
): Map<string, V> {
  const out = new Map<string, V>();
  for (const [k, v] of primary) if (!secondaryMonths.has(monthOfKey(k))) out.set(k, v);
  for (const [k, v] of secondary) if (secondaryMonths.has(monthOfKey(k))) out.set(k, v);
  return out;
}

function pickRows<T extends { month: string }>(
  primary: T[],
  secondary: T[],
  secondaryMonths: ReadonlySet<Q2Month>,
): T[] {
  const out: T[] = [];
  for (const r of primary) if (!secondaryMonths.has(r.month)) out.push(r);
  for (const r of secondary) if (secondaryMonths.has(r.month)) out.push(r);
  return out;
}

// `primary` owns every month except those listed in `secondaryMonths`, which `secondary` owns
// outright. Returns null until both halves have loaded — a half-merged object would render as a
// real answer with a quarter of its months quietly missing.
export function mergeFinanceDataByMonth(
  primary: FinanceData | null,
  secondary: FinanceData | null,
  secondaryMonths: ReadonlySet<Q2Month>,
): FinanceData | null {
  if (!primary) return null;
  if (!secondary || secondaryMonths.size === 0) return primary;
  return {
    ...primary,
    revenue: pickRows(primary.revenue, secondary.revenue, secondaryMonths),
    expenses: pickRows(primary.expenses, secondary.expenses, secondaryMonths),
    managerPay: pickRows(primary.managerPay, secondary.managerPay, secondaryMonths),
    masterSchedule: pickRows(primary.masterSchedule, secondary.masterSchedule, secondaryMonths),
    cancelledSchedule: pickRows(primary.cancelledSchedule, secondary.cancelledSchedule, secondaryMonths),
    memberSpots: pickRows(primary.memberSpots, secondary.memberSpots, secondaryMonths),
    overrides: pickRows(primary.overrides, secondary.overrides, secondaryMonths),
    partnerPayoutsByVenueMonth: pickMap(
      primary.partnerPayoutsByVenueMonth,
      secondary.partnerPayoutsByVenueMonth,
      secondaryMonths,
    ),
    mdapiMemberSpots: {
      byVenueMonth: pickMap(
        primary.mdapiMemberSpots.byVenueMonth,
        secondary.mdapiMemberSpots.byVenueMonth,
        secondaryMonths,
      ),
      byCityMonth: pickMap(
        primary.mdapiMemberSpots.byCityMonth,
        secondary.mdapiMemberSpots.byCityMonth,
        secondaryMonths,
      ),
    },
  };
}
