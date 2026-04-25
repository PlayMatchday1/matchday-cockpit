"use client";

import {
  getMonthlyManagerStats,
  type ManagerStat,
} from "@/lib/reviewStats";
import type { ReviewRow } from "@/lib/useReviewData";

const LOW_RATING_THRESHOLD = 4.0;

export default function CityManagerTable({
  rows,
  city,
}: {
  rows: ReviewRow[];
  city: string;
}) {
  const managers = getMonthlyManagerStats(rows, city);

  if (managers.length === 0) {
    return (
      <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-center text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
        No managers with reviews this month.
      </div>
    );
  }

  const sorted = [...managers].sort((a, b) => {
    const aActive = a.qualified || a.onPace;
    const bActive = b.qualified || b.onPace;
    if (aActive !== bActive) return aActive ? -1 : 1;
    return b.avgRating - a.avgRating;
  });

  return (
    <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10">
      <div className="-mx-2 overflow-x-auto px-2">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
              <th className="px-3 py-2 text-left">Rank</th>
              <th className="px-3 py-2 text-left">Manager</th>
              <th className="px-3 py-2 text-right">Avg</th>
              <th className="px-3 py-2 text-right">Count</th>
              <th className="px-3 py-2 text-right">Status</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((m, i) => (
              <ManagerRow key={m.key} manager={m} rank={i + 1} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ManagerRow({ manager: m, rank }: { manager: ManagerStat; rank: number }) {
  const isActive = m.qualified || m.onPace;
  const lowRating = m.avgRating < LOW_RATING_THRESHOLD;

  return (
    <tr
      className={`border-t border-cream-line/40 ${!isActive ? "opacity-60" : ""} ${
        lowRating ? "border-l-4 border-l-coral" : ""
      }`}
    >
      <td className="px-3 py-2 font-bold tabular-nums text-deep-green">
        #{rank}
      </td>
      <td className="px-3 py-2 font-semibold text-deep-green">
        {m.displayName}
      </td>
      <td
        className={`whitespace-nowrap px-3 py-2 text-right font-bold tabular-nums ${
          lowRating ? "text-coral" : "text-deep-green"
        }`}
      >
        {m.avgRating.toFixed(2)}★
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-deep-green/70">
        {m.count}
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right">
        {m.qualified ? (
          <Badge tone="mint">Qualified</Badge>
        ) : m.onPace ? (
          <Badge tone="blue">On pace · {m.projected}</Badge>
        ) : (
          <Badge tone="muted">Off pace</Badge>
        )}
      </td>
    </tr>
  );
}

function Badge({
  tone,
  children,
}: {
  tone: "mint" | "blue" | "muted";
  children: React.ReactNode;
}) {
  const cls =
    tone === "mint"
      ? "bg-mint-soft text-deep-green ring-mint/40"
      : tone === "blue"
        ? "bg-blue-soft text-blue-info ring-blue-info/30"
        : "bg-muted-soft text-muted ring-cream-line";
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1 ring-inset ${cls}`}
    >
      {children}
    </span>
  );
}
