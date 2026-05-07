"use client";

import Link from "next/link";
import ManagerOfTheMonth from "./ManagerOfTheMonth";
import ManagerPodium from "./ManagerPodium";
import Reviews8WeekCard from "./Reviews8WeekCard";
import ReviewsCommentsTable from "./ReviewsCommentsTable";
import { useReviewData } from "@/lib/useReviewData";
import { getActiveMonthWindow } from "@/lib/reviewStats";

// Wraps the three existing review components in their prior render
// order. Same data hook (useReviewData), same components, same
// loading + empty-state behavior — just relocated under the
// Reviews lens.
export default function CitiesReviewsLens() {
  const { rows, meta, loading } = useReviewData();
  const window = getActiveMonthWindow(rows);

  return (
    <section>
      <div className="mb-6">
        <h2 className="text-2xl font-bold tracking-tight text-deep-green">
          Reviews
        </h2>
        {meta ? (
          <p className="mt-1 text-sm text-deep-green/70">
            Manager performance · {window.monthName} {window.year}
          </p>
        ) : (
          <p className="mt-1 text-sm text-deep-green/70">Manager performance</p>
        )}
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
            Upload reviews CSV in{" "}
            <Link
              href="/data"
              className="font-bold text-mint-hover hover:underline"
            >
              Data →
            </Link>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {/* New section, placed ABOVE the existing 8-week chart per
              spec. Dark-themed leaderboard scoped under
              .manager-leaderboard so its CSS doesn't leak into the
              cream/green app theme. */}
          <ManagerOfTheMonth rows={rows} />
          <Reviews8WeekCard rows={rows} />
          <ManagerPodium rows={rows} />
          <ReviewsCommentsTable rows={rows} />
        </div>
      )}
    </section>
  );
}
