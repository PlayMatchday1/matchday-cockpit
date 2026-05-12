"use client";

import { useMemo } from "react";
import { useFinanceData } from "@/lib/useFinanceData";
import { useMatchData } from "@/lib/useMatchData";
import { useFinanceQuarter } from "@/lib/financeQuarter";
import {
  buildMembershipHealthRows,
  getCurrentMonthInQuarter,
  membershipHealthAvailable,
  monthScopedTitle,
  type MembershipHealthRow,
  type Q2Month,
} from "@/lib/financeStats";

// Self-contained card. Same data, same columns, same row order
// (ratio descending, baked into buildMembershipHealthRows). Pulled
// out of FinanceInsightsGrid so it can render on /cities under the
// Membership lens — finance/cash-flow now links here instead.
export default function MembershipHealthTable() {
  const { data, loading: financeLoading } = useFinanceData();
  const { rows: matchRows, loading: matchLoading } = useMatchData();
  const quarter = useFinanceQuarter();

  // Default to current month in the active quarter; fall back to the
  // last month of the quarter (so viewing past quarters lands on the
  // final closed month, where the data is most meaningful).
  const month: Q2Month = useMemo(() => {
    return (
      getCurrentMonthInQuarter(quarter, new Date()) ??
      quarter.months[quarter.months.length - 1].key
    );
  }, [quarter]);

  const mhAvailable = data ? membershipHealthAvailable(data) : false;
  const rows = useMemo(
    () =>
      data && mhAvailable ? buildMembershipHealthRows(data, matchRows, month) : [],
    [data, matchRows, month, mhAvailable],
  );

  if (financeLoading || matchLoading) {
    return (
      <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 text-sm text-deep-green/60 shadow-md shadow-deep-green/10 sm:p-7">
        Loading membership health…
      </div>
    );
  }
  if (!data) return null;

  return (
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10 sm:p-7">
      <div className="text-[11px] font-bold uppercase tracking-[0.25em] text-deep-green/60">
        {monthScopedTitle("Membership Health", month).toUpperCase()}
      </div>
      <p className="mt-1 max-w-3xl text-sm text-deep-green/65">
        Average matches played per member this month vs. matches needed to cover
        their membership cost. Ranked by ratio descending.
      </p>

      <div className="mt-5">
        {!mhAvailable ? (
          <div className="text-xs italic text-deep-green/55">
            Membership Health requires mdapi_subscriptions + fin_venues with
            member_price set + recent mdapi_matches data — re-sync from /data
            to enable.
          </div>
        ) : rows.length === 0 ? (
          <div className="text-xs italic text-deep-green/55">
            No qualifying cities this month.
          </div>
        ) : (
          <MembershipHealthList rows={rows} />
        )}
      </div>
    </section>
  );
}

function MembershipHealthList({ rows }: { rows: MembershipHealthRow[] }) {
  const verdictLabel: Record<MembershipHealthRow["verdict"], string> = {
    strong: "Strong",
    break_even_plus: "BE+",
    marginal: "Marginal",
    at_risk: "At Risk",
  };
  const verdictCls: Record<MembershipHealthRow["verdict"], string> = {
    strong: "bg-[#C8F1DD] text-[#0F6E56]",
    break_even_plus: "bg-[#DCF5E8] text-[#1D9E75]",
    marginal: "bg-[#FCE8C7] text-[#854F0B]",
    at_risk: "bg-[#F7C1C1] text-[#A32D2D]",
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px]">
        <thead className="text-[10px] font-bold uppercase tracking-wider text-deep-green/50">
          <tr>
            <th className="py-1 pr-3 text-left">City</th>
            <th className="px-2.5 py-1 text-right">Members</th>
            <th className="px-2.5 py-1 text-right">Played</th>
            <th className="px-2.5 py-1 text-right">Need</th>
            <th className="px-2.5 py-1 text-right">Ratio</th>
            <th className="py-1 pl-3 text-right">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.city} className="border-t border-cream-line/40">
              <td className="py-1.5 pr-3 text-deep-green/85">{r.city}</td>
              <td className="px-2.5 py-1.5 text-right font-mono tabular-nums text-deep-green/75">
                {r.members}
              </td>
              <td className="px-2.5 py-1.5 text-right font-mono tabular-nums text-deep-green/85">
                {r.actualMatchesPerMember.toFixed(1)}
              </td>
              <td className="px-2.5 py-1.5 text-right font-mono tabular-nums text-deep-green/55">
                {r.breakEvenMatches.toFixed(1)}
              </td>
              <td
                className="px-2.5 py-1.5 text-right font-mono tabular-nums text-deep-green/85"
                title={`${r.actualMatchesPerMember.toFixed(1)} played / ${r.breakEvenMatches.toFixed(1)} need`}
              >
                {Number.isFinite(r.ratio) && r.ratio > 0
                  ? `${r.ratio.toFixed(1)}x`
                  : "—"}
              </td>
              <td className="py-1.5 pl-3 text-right">
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${verdictCls[r.verdict]}`}
                >
                  {verdictLabel[r.verdict]}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
