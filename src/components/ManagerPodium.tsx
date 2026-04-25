"use client";

import {
  getBottom3,
  getTop3Eligible,
  type ManagerStat,
} from "@/lib/reviewStats";
import type { ReviewRow } from "@/lib/useReviewData";

const MEDALS = ["🥇", "🥈", "🥉"];

export default function ManagerPodium({ rows }: { rows: ReviewRow[] }) {
  const top = getTop3Eligible(rows);
  const bottom = getBottom3(rows);

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <PodiumCard
        title="Top 3 · on pace to 50+ this month"
        managers={top}
        accent="top"
        empty="No qualified or on-pace managers yet."
      />
      <PodiumCard
        title="Bottom 3 · lowest avg this month"
        managers={bottom}
        accent="bottom"
        empty="No reviews yet this month."
      />
    </div>
  );
}

function PodiumCard({
  title,
  managers,
  accent,
  empty,
}: {
  title: string;
  managers: ManagerStat[];
  accent: "top" | "bottom";
  empty: string;
}) {
  return (
    <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-5 shadow-md shadow-deep-green/10">
      <div className="text-[11px] font-bold uppercase tracking-wider text-deep-green/60">
        {title}
      </div>
      {managers.length === 0 ? (
        <div className="mt-4 text-sm text-deep-green/50">{empty}</div>
      ) : (
        <ul className="mt-4 space-y-2">
          {managers.map((m, i) => (
            <li
              key={m.key}
              className={`flex items-start gap-3 rounded-lg border-l-4 px-3 py-2 ${
                accent === "bottom"
                  ? "border-coral bg-coral-soft/15"
                  : "border-mint bg-mint-soft/15"
              }`}
            >
              <span className="text-xl leading-none">
                {accent === "top" ? MEDALS[i] : `#${i + 1}`}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="truncate text-base font-bold text-deep-green">
                    {m.displayName}
                  </span>
                  {m.city && (
                    <span className="inline-flex rounded-full bg-cream-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-deep-green/60 ring-1 ring-inset ring-cream-line">
                      {m.city}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
                  <span
                    className={`font-bold tabular-nums ${
                      accent === "top" ? "text-mint-hover" : "text-coral"
                    }`}
                  >
                    {m.avgRating.toFixed(2)}★
                  </span>
                  <span className="tabular-nums text-deep-green/60">
                    {m.count} {m.count === 1 ? "review" : "reviews"}
                  </span>
                  {accent === "top" &&
                    (m.qualified ? (
                      <span className="inline-flex rounded-full bg-mint-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-deep-green ring-1 ring-inset ring-mint/40">
                        Qualified
                      </span>
                    ) : m.onPace ? (
                      <span className="inline-flex rounded-full bg-blue-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-blue-info ring-1 ring-inset ring-blue-info/30">
                        On pace · {m.projected} proj
                      </span>
                    ) : null)}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
