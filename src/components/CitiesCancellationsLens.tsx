"use client";

import CancelPatterns from "./CancelPatterns";
import { getCancelRate } from "@/lib/cityStats";
import { CITIES } from "@/lib/types";
import { useMatchData } from "@/lib/useMatchData";

// Cancellations lens: CancelPatterns heatmap on top (the operational
// signal — chronic slot detection), cancellation-rate-per-city table
// below as supporting context.

export default function CitiesCancellationsLens() {
  const { rows, loading, meta } = useMatchData();

  if (loading) {
    return (
      <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
        Loading match data…
      </div>
    );
  }
  if (!meta) {
    return (
      <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
        No match data uploaded yet.
      </div>
    );
  }

  const cityRows = CITIES.map((city) => ({
    city,
    cancel: getCancelRate(rows, city),
  }))
    .filter((c) => c.cancel.totalMatches > 0)
    .sort((a, b) => b.cancel.rate - a.cancel.rate);

  return (
    <div className="space-y-6">
      <CancelPatterns />

      <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10 sm:p-7">
        <div className="text-[11px] font-bold uppercase tracking-[0.25em] text-deep-green/60">
          Cancellation rate · this month
        </div>
        <p className="mt-1 max-w-3xl text-sm text-deep-green/65">
          Cities ranked by month-to-date cancel %.
        </p>
        <div className="mt-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-cream-line text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
                <th className="px-2 py-2 text-left">City</th>
                <th className="px-2 py-2 text-right">Cancel %</th>
                <th className="px-2 py-2 text-right">Canceled</th>
                <th className="px-2 py-2 text-right">Scheduled</th>
              </tr>
            </thead>
            <tbody>
              {cityRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    className="px-2 py-6 text-center text-sm text-deep-green/55"
                  >
                    No matches scheduled this month.
                  </td>
                </tr>
              ) : (
                cityRows.map((c) => (
                  <tr
                    key={c.city}
                    className="border-b border-cream-line/50 transition hover:bg-cream-soft/40"
                  >
                    <td className="px-2 py-2 font-medium text-deep-green">
                      {c.city}
                    </td>
                    <td
                      className={`px-2 py-2 text-right font-bold tabular-nums ${cancelToneClass(c.cancel.rate)}`}
                    >
                      {Math.round(c.cancel.rate)}%
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-deep-green/65">
                      {c.cancel.canceledMatches}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-deep-green/65">
                      {c.cancel.totalMatches}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-xs italic text-deep-green/55">
          Cancel % is month-to-date — distinct (field, match_start) matches
          canceled / scheduled.
        </p>
      </section>
    </div>
  );
}

function cancelToneClass(rate: number): string {
  if (rate >= 25) return "text-coral";
  if (rate >= 15) return "text-[#d97706]";
  return "text-deep-green";
}
