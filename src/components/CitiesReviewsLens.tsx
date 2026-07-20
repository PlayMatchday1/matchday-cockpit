"use client";

import { useState } from "react";
import Link from "next/link";
import ManagerOfTheMonth from "./ManagerOfTheMonth";
import ManagerPodium from "./ManagerPodium";
import Reviews8WeekCard from "./Reviews8WeekCard";
import ReviewsCommentsTable from "./ReviewsCommentsTable";
import CitiesMatchReviewsLens from "./CitiesMatchReviewsLens";
import { useReviewData } from "@/lib/useReviewData";
import { getActiveMonthWindow } from "@/lib/reviewStats";

// Reviews tab: three sub-tabs.
//   "Match Reviews" (default) — per-match review performance (highlights,
//                               tags, comments) — CitiesMatchReviewsLens.
//   "Performance"             — 8-week chart, ManagerPodium, comments table.
//   "Leaderboard"             — ManagerOfTheMonth (dark themed).
//
// Sub-tab visual is intentionally smaller / underline-style so the
// hierarchy reads clearly against the top-level pill nav above.

type SubTab = "match-reviews" | "performance" | "leaderboard";

export default function CitiesReviewsLens() {
  const { rows, meta, loading } = useReviewData();
  const monthWindow = getActiveMonthWindow(rows);
  const [subTab, setSubTab] = useState<SubTab>("match-reviews");

  return (
    <section>
      <div className="mb-6">
        <h2 className="text-2xl font-bold tracking-tight text-deep-green">
          Reviews
        </h2>
      </div>
      {loading ? (
        <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
          Loading review data…
        </div>
      ) : !meta ? (
        <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 shadow-md shadow-deep-green/10">
          <div className="text-base font-bold text-deep-green">
            No review data yet.
          </div>
          <div className="mt-1 text-sm text-deep-green/60">
            Sync mdapi_reviews in{" "}
            <Link
              href="/data"
              className="font-bold text-mint-hover hover:underline"
            >
              Data →
            </Link>
          </div>
        </div>
      ) : (
        <>
          <div
            role="tablist"
            aria-label="Reviews view"
            className="mb-5 flex items-center gap-5 border-b border-cream-line"
          >
            <SubTabButton
              active={subTab === "match-reviews"}
              onClick={() => setSubTab("match-reviews")}
              label="Match Reviews"
            />
            <SubTabButton
              active={subTab === "performance"}
              onClick={() => setSubTab("performance")}
              label="Performance"
            />
            <SubTabButton
              active={subTab === "leaderboard"}
              onClick={() => setSubTab("leaderboard")}
              label="Leaderboard"
            />
          </div>
          {subTab === "match-reviews" ? (
            <CitiesMatchReviewsLens embedded />
          ) : subTab === "performance" ? (
            <div className="space-y-6">
              <p className="text-sm text-deep-green/70">
                Manager performance · {monthWindow.monthName}{" "}
                {monthWindow.year}
              </p>
              <Reviews8WeekCard rows={rows} />
              <ManagerPodium rows={rows} />
              <ReviewsCommentsTable rows={rows} />
            </div>
          ) : (
            <ManagerOfTheMonth rows={rows} />
          )}
        </>
      )}
    </section>
  );
}

function SubTabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={
        active
          ? "-mb-px border-b-2 border-mint-hover px-0.5 pb-2 text-[13px] font-bold tracking-tight text-deep-green"
          : "-mb-px border-b-2 border-transparent px-0.5 pb-2 text-[13px] font-medium tracking-tight text-deep-green/55 transition hover:text-deep-green"
      }
    >
      {label}
    </button>
  );
}
