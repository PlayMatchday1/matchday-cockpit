"use client";

import Link from "next/link";
import ManagerOfTheMonth from "./ManagerOfTheMonth";
import { useReviewData } from "@/lib/useReviewData";

// Manager of the Month leaderboard, behind its own /cities tab. Same
// loading + empty-state shape as CitiesReviewsLens — different render
// body. The leaderboard's dark theme is scoped under
// .manager-leaderboard inside ManagerOfTheMonth, so the loading/empty
// cards above stay on the cream/green app theme.
export default function CitiesLeaderboardLens() {
  const { rows, meta, loading } = useReviewData();

  if (loading) {
    return (
      <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
        Loading review data…
      </div>
    );
  }
  if (!meta) {
    return (
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
    );
  }
  return <ManagerOfTheMonth rows={rows} />;
}
