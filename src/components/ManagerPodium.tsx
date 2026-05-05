"use client";

import { useMemo, useState } from "react";
import {
  MIN_REVIEWS_PAST,
  getRankedManagersForPeriod,
  type ManagerStat,
  type ReviewPeriod,
} from "@/lib/reviewStats";
import type { ReviewRow } from "@/lib/useReviewData";

const MEDALS = ["🥇", "🥈", "🥉"];

const PERIOD_OPTIONS: { id: ReviewPeriod; label: string }[] = [
  { id: "thisMonth", label: "This Month" },
  { id: "lastMonth", label: "Last Month" },
  { id: "last6Months", label: "Last 6 Months" },
  { id: "allTime", label: "All Time" },
];

const TITLES: Record<ReviewPeriod, { top: string; bottom: string }> = {
  thisMonth: {
    top: "Top 3 · on pace to 50+ this month",
    bottom: "Bottom 3 · lowest avg this month",
  },
  lastMonth: {
    top: "Top 3 · best of last month",
    bottom: "Bottom 3 · lowest avg last month",
  },
  last6Months: {
    top: "Top 3 · best of last 6 months",
    bottom: "Bottom 3 · lowest avg last 6 months",
  },
  allTime: {
    top: "Top 3 · all-time best",
    bottom: "Bottom 3 · all-time lowest",
  },
};

export default function ManagerPodium({ rows }: { rows: ReviewRow[] }) {
  const [period, setPeriod] = useState<ReviewPeriod>("thisMonth");

  const ranked = useMemo(
    () => getRankedManagersForPeriod(rows, period),
    [rows, period],
  );

  const titles = TITLES[period];
  const isClosedPeriod = period !== "thisMonth";

  return (
    <div className="space-y-4">
      {/* Period selector — same tab style as Cancel Patterns toggle. */}
      <div
        role="tablist"
        aria-label="Review period"
        className="inline-flex rounded-md border border-cream-line bg-cream-soft/60 p-0.5"
      >
        {PERIOD_OPTIONS.map((opt) => {
          const active = period === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setPeriod(opt.id)}
              className={`rounded px-3 py-1 text-[11px] font-bold uppercase tracking-wider transition ${
                active
                  ? "bg-white text-deep-green shadow-sm"
                  : "text-deep-green/55 hover:text-deep-green"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <PodiumCard
          title={titles.top}
          managers={ranked.top}
          accent="top"
          isClosedPeriod={isClosedPeriod}
          qualifyingCount={ranked.topQualifyingCount}
          empty={
            isClosedPeriod
              ? `No match managers meet the ${MIN_REVIEWS_PAST}-review threshold for this period.`
              : "No qualified or on-pace managers yet."
          }
        />
        <PodiumCard
          title={titles.bottom}
          managers={ranked.bottom}
          accent="bottom"
          isClosedPeriod={isClosedPeriod}
          qualifyingCount={ranked.bottomQualifyingCount}
          empty={
            isClosedPeriod
              ? `No match managers meet the ${MIN_REVIEWS_PAST}-review threshold for this period.`
              : "No reviews yet this month."
          }
        />
      </div>
    </div>
  );
}

function PodiumCard({
  title,
  managers,
  accent,
  isClosedPeriod,
  qualifyingCount,
  empty,
}: {
  title: string;
  managers: ManagerStat[];
  accent: "top" | "bottom";
  // True for past periods (lastMonth / last6Months / allTime).
  // Suppresses the "On pace" / "Qualified" badge — those are
  // current-month concepts. The review count remains visible inline
  // for both, so closed periods just lose the badge with no
  // additional copy needed.
  isClosedPeriod: boolean;
  qualifyingCount: number;
  empty: string;
}) {
  const showShortNote =
    isClosedPeriod && managers.length > 0 && managers.length < 3;

  return (
    <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-5 shadow-md shadow-deep-green/10">
      <div className="text-[11px] font-bold uppercase tracking-wider text-deep-green/60">
        {title}
      </div>
      {managers.length === 0 ? (
        <div className="mt-4 text-sm text-deep-green/50">{empty}</div>
      ) : (
        <>
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
                      !isClosedPeriod &&
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
          {showShortNote && (
            <p className="mt-3 text-[11px] italic text-deep-green/55">
              Only {qualifyingCount}{" "}
              {qualifyingCount === 1 ? "MM qualifies" : "MMs qualify"} with{" "}
              {MIN_REVIEWS_PAST}+ reviews in this period.
            </p>
          )}
        </>
      )}
    </div>
  );
}
