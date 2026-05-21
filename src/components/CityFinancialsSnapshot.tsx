"use client";

// Slate-Review-scoped field-level financials table. Mirrors the
// per-venue Venue / DPP Rev / Cost / Net section of CityPLCard
// (src/components/CityPLCard.tsx:262-355) but with COST sourced from
// venueRealizedCostFor (alive + charge-on-cancel matches with
// match_date <= today, summed per leg) instead of the full-month
// canonicalVenueCost.
//
// Reads venues, the master schedule, and revenue out of useFinanceData
// + useMatchData — same hooks the Cities tab card uses, so the two
// surfaces agree by construction on revenue and reconcile on
// realized cost to fieldCostsActualFor's aggregate.
//
// Period: current calendar month, fixed. The Slate Review tab is a
// "snapshot for slate decisions" — locking the window keeps the
// numbers focused on what we're committing to right now.

import { useMemo } from "react";
import { useFinanceData } from "@/lib/useFinanceData";
import { useMatchData } from "@/lib/useMatchData";
import { useFinanceQuarter } from "@/lib/financeQuarter";
import {
  getCurrentMonthInQuarter,
  venueMatchCountFor,
  venuePartnerRevenueFor,
  venueRealizedCostFor,
  type Q2Month,
} from "@/lib/financeStats";
import { groupVenues } from "@/lib/venueGroups";

function fmt(n: number): string {
  const r = Math.round(n);
  if (r === 0) return "—";
  return r.toLocaleString("en-US");
}

export default function CityFinancialsSnapshot({ city }: { city: string }) {
  const { data } = useFinanceData();
  const { rows: matchRegistrations } = useMatchData();
  const quarter = useFinanceQuarter();

  const result = useMemo(() => {
    if (!data) return null;
    const month: Q2Month | null = getCurrentMonthInQuarter(quarter, new Date());
    if (!month) return null;
    const now = new Date();

    const cityGroups = groupVenues(data.venues).filter((g) => g.city === city);

    type Row = {
      venue: string;
      dppRev: number;
      cost: number;
      matchCount: number;
      net: number;
      isCombined: boolean;
    };

    const rows: Row[] = cityGroups
      .map((g) => {
        const legVenueIds = new Set(g.legs.map((l) => l.id));
        let cost = 0;
        let matchCount = 0;
        for (const leg of g.legs) {
          cost += venueRealizedCostFor(data, leg.id, month, now);
          matchCount += venueMatchCountFor(data, leg.id, month);
        }
        const dppRev = venuePartnerRevenueFor(
          data,
          matchRegistrations,
          legVenueIds,
          month,
        );
        return {
          venue: g.displayName,
          dppRev,
          cost,
          matchCount,
          net: dppRev - cost,
          isCombined: g.isCombined,
        };
      })
      .filter((r) => r.dppRev > 0 || r.cost > 0 || r.matchCount > 0)
      .sort((a, b) => b.dppRev - a.dppRev || b.cost - a.cost);

    const totalDpp = rows.reduce((s, r) => s + r.dppRev, 0);
    const totalCost = rows.reduce((s, r) => s + r.cost, 0);
    const totalNet = totalDpp - totalCost;
    return { rows, totalDpp, totalCost, totalNet, month };
  }, [data, matchRegistrations, city, quarter]);

  if (!data) return null;
  if (!result) {
    return (
      <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
        No active month in this quarter.
      </div>
    );
  }

  return (
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-5 shadow-md shadow-deep-green/10">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-2xl font-bold tracking-tight text-deep-green">
          {city} financials
        </h2>
        <span className="text-[11px] font-bold uppercase tracking-wider text-deep-green/55">
          {result.month} · realized through today
        </span>
      </div>
      {result.rows.length === 0 ? (
        <div className="text-xs italic text-deep-green/45">
          No field activity this month yet
        </div>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
              <th className="py-1 text-left">Venue</th>
              <th className="py-1 pl-2 text-right">DPP Rev</th>
              <th className="py-1 pl-2 text-right">Cost</th>
              <th className="py-1 pl-2 text-right">Net</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.map((f) => (
              <tr key={f.venue} className="border-t border-cream-line/40">
                <td className="py-1.5 pr-2">
                  <div className="text-deep-green">
                    {f.venue}
                    {f.isCombined && (
                      <span className="ml-1 text-[9px] font-normal lowercase tracking-normal text-deep-green/45">
                        (combined)
                      </span>
                    )}
                  </div>
                  {f.matchCount > 0 && (
                    <div className="text-[10px] text-deep-green/45">
                      {f.matchCount} match{f.matchCount === 1 ? "" : "es"} so far
                    </div>
                  )}
                </td>
                <td className="py-1.5 pl-2 text-right font-mono tabular-nums text-mint-hover">
                  {fmt(f.dppRev)}
                </td>
                <td className="py-1.5 pl-2 text-right font-mono tabular-nums text-coral">
                  {fmt(f.cost)}
                </td>
                <td
                  className={`py-1.5 pl-2 text-right font-mono font-bold tabular-nums ${
                    f.net >= 0 ? "text-mint-hover" : "text-coral"
                  }`}
                >
                  {fmt(f.net)}
                </td>
              </tr>
            ))}
            <tr className="border-t-2 border-deep-green/15">
              <td className="py-1.5 pr-2 text-[10px] font-bold uppercase tracking-wider text-deep-green/65">
                Total field
              </td>
              <td className="py-1.5 pl-2 text-right font-mono font-bold tabular-nums text-mint-hover">
                {fmt(result.totalDpp)}
              </td>
              <td className="py-1.5 pl-2 text-right font-mono font-bold tabular-nums text-coral">
                {fmt(result.totalCost)}
              </td>
              <td
                className={`py-1.5 pl-2 text-right font-mono font-bold tabular-nums ${
                  result.totalNet >= 0 ? "text-mint-hover" : "text-coral"
                }`}
              >
                {fmt(result.totalNet)}
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </section>
  );
}
