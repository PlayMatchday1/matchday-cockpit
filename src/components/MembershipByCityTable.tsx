"use client";

import { useFinanceData } from "@/lib/useFinanceData";
import { buildCityMembershipRows, monthLabel } from "@/lib/membershipStats";
import { CITIES } from "@/lib/types";

export default function MembershipByCityTable() {
  const { data, loading } = useFinanceData();
  const now = new Date();

  if (loading && !data) {
    return (
      <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 text-sm text-deep-green/60 shadow-md shadow-deep-green/10 sm:p-7">
        Loading membership data…
      </div>
    );
  }
  if (!data || data.members.length === 0) {
    return (
      <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10 sm:p-7">
        <div className="text-[11px] font-bold uppercase tracking-[0.25em] text-deep-green/60">
          By city · {monthLabel(now)}
        </div>
        <div className="mt-3 text-sm text-deep-green/55">
          No member data yet.
        </div>
      </div>
    );
  }

  const rows = buildCityMembershipRows(data.members, CITIES, now);

  return (
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10 sm:p-7">
      <div className="text-[11px] font-bold uppercase tracking-[0.25em] text-deep-green/60">
        By city · {monthLabel(now)}
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-cream-line text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
              <th className="px-2 py-2 text-left">City</th>
              <th className="px-2 py-2 text-right">Active</th>
              <th className="px-2 py-2 text-right">New</th>
              <th className="px-2 py-2 text-right">Cancelled</th>
              <th className="px-2 py-2 text-right">Net</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.city}
                className="border-b border-cream-line/50 transition hover:bg-cream-soft/40"
              >
                <td className="px-2 py-2 font-medium text-deep-green">
                  {r.city}
                </td>
                <td className="px-2 py-2 text-right tabular-nums text-deep-green">
                  {r.active.toLocaleString()}
                </td>
                <td className="px-2 py-2 text-right tabular-nums text-deep-green/80">
                  {r.newThisMonth}
                </td>
                <td className="px-2 py-2 text-right tabular-nums text-deep-green/80">
                  {r.cancelled}
                </td>
                <td
                  className={`px-2 py-2 text-right font-bold tabular-nums ${netClass(r.net)}`}
                >
                  {fmtSigned(r.net)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function fmtSigned(n: number): string {
  if (n === 0) return "0";
  return n > 0 ? `+${n}` : String(n);
}

function netClass(n: number): string {
  if (n > 0) return "text-mint-hover";
  if (n < 0) return "text-coral";
  return "text-deep-green/55";
}
