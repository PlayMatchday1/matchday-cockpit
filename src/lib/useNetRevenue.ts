"use client";

/* ONE REVENUE ACROSS FINANCE (Ryan, 2026-10-10). Finance › Cost and Cities read the Revenue page's
 * net revenue — after sales tax, refunds and disputes — through the Revenue page's own code:
 * fin_txn_sums (loadRollup), byCityRows for a city, and allocateMembership + the same net rule for a
 * field (byVenueRows, byFieldRows' twin keyed by venue id), with membership credited to fields by
 * member spots (memberShares.sharesFromSpots). Nothing here re-derives a figure.
 *
 * Per month: every city's row (Unassigned included, so the cities sum to the total), every venue's
 * net, and what no field carries. Cents throughout, as revenueTxn keeps them. */
import { useMemo } from "react";
import { byCityRows, byVenueRows, UNASSIGNED, type GroupRow, type RollupRow } from "./revenueTxn";
import { loadMemberSpots, loadRollup, useAsync, useReaderId } from "./useRevenueTxn";
import { sharesFromSpots } from "./memberShares";
import { canonCity } from "./fieldEconomics";

export type NetMonth = {
  /** canonCity(label) → the Revenue page's City row. Unassigned is NOT in here; see `unassigned`. */
  cities: Map<string, GroupRow>;
  unassigned: GroupRow | null;
  /** fin_venues.id → that venue's net (DPP, its credited membership, other, reversals). */
  venues: Map<number, GroupRow>;
  /** Revenue no venue carries: DPP without a field, and membership no member spot placed. */
  noField: GroupRow;
  /** All of it, cents: the Revenue page's net revenue for the month. */
  total: number;
  /** The month's rows, for callers that narrow further (totalsOf on one city's rows). */
  rows: RollupRow[];
};

const monthEnd = (ym: string) => {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  return `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
};

/** `months` are "YYYY-MM"; `venues` are fin_venues rows (id, city) — the finance loader's. */
export function useNetRevenue(months: string[], venues: readonly { id: number; city: string | null }[] | null): {
  byMonth: Map<string, NetMonth> | null; error: string | null;
} {
  const uid = useReaderId();
  const sorted = useMemo(() => [...new Set(months)].sort(), [months]);
  const from = sorted[0], to = sorted[sorted.length - 1];
  const rollup = useAsync(uid && from ? `net|${uid}|${from}|${to}` : null,
    () => loadRollup(uid!, { from: `${from}-01`, to: monthEnd(to), grain: "month", byVenue: true }));
  const spots = useAsync(from ? `netspots|${from}|${to}` : null, () => loadMemberSpots(`${from}-01`, monthEnd(to)));

  const byMonth = useMemo(() => {
    if (!rollup.data || !spots.data || !venues) return null;
    const out = new Map<string, NetMonth>();
    for (const ym of sorted) {
      const rows = rollup.data.filter((r) => r.period.slice(0, 7) === ym);
      const cities = new Map<string, GroupRow>();
      let unassigned: GroupRow | null = null, total = 0;
      for (const g of byCityRows(rows)) {
        total += g.net;
        if (g.label === UNASSIGNED) unassigned = g;
        else cities.set(canonCity(g.label), g);
      }
      const v = byVenueRows(rows, (city, periodKey) => sharesFromSpots(venues, spots.data!, city, periodKey));
      out.set(ym, { cities, unassigned, venues: v.venues, noField: v.noField, total, rows });
    }
    return out;
  }, [rollup.data, spots.data, venues, sorted]);

  return { byMonth, error: rollup.error ?? spots.error };
}
