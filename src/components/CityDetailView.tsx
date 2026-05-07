"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import {
  getActiveVenues,
  getCancelRate,
  getCityStatus,
  getWeeklySpots,
} from "@/lib/cityStats";
import { useMatchData } from "@/lib/useMatchData";
import { useReviewData } from "@/lib/useReviewData";
import {
  getActiveMonthWindow,
  getRecentReviewStats,
} from "@/lib/reviewStats";
import type { City } from "@/lib/types";
import { CityHealthPill } from "./StatusPill";
import TotalsBarChart from "./TotalsBarChart";
import CancelHeatmap from "./CancelHeatmap";
import CityGoalsView from "./CityGoalsView";
import CityManagerTable from "./CityManagerTable";
import ReviewsCommentsTable from "./ReviewsCommentsTable";

// Color tiers calibrated for match-cancel rate (the new metric semantics).
// Across the 8 cities the rate runs 4-30%; >25% reads as a real problem,
// 15-25% as moderate operational drag, <15% as the working baseline.
function cancelRateColor(rate: number, hasData: boolean): string {
  if (!hasData) return "text-deep-green/40";
  if (rate >= 25) return "text-coral";
  if (rate >= 15) return "text-[#d97706]";
  return "text-deep-green";
}

export default function CityDetailView({ city }: { city: City }) {
  const { rows, meta, loading } = useMatchData();
  const { rows: reviewRows, meta: reviewMeta } = useReviewData();
  const [showVenues, setShowVenues] = useState(false);
  // Pre-select the Comments month from ?month=YYYY-MM (set by the
  // monthly-report-generator deep link). Falls through to the table's
  // own previous-month default when absent or malformed.
  const searchParams = useSearchParams();
  const monthParam = searchParams?.get("month") ?? undefined;
  const defaultMonthKey =
    monthParam && /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : undefined;

  const weekly = getWeeklySpots(rows, city, 8);
  const cancel = getCancelRate(rows, city);
  const venues = getActiveVenues(rows, city, 8);
  const status = getCityStatus(rows, city);
  const currentWeek = weekly[weekly.length - 1];
  const hasData = cancel.totalMatches > 0;

  const reviews4wk = getRecentReviewStats(reviewRows, city, 4);
  const reviewWindow = getActiveMonthWindow(reviewRows);

  if (loading) {
    return (
      <>
        <BackLink />
        <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
          Loading match data…
        </div>
      </>
    );
  }

  if (!meta) {
    return (
      <>
        <BackLink />
        <h1 className="mb-4 font-display text-5xl uppercase leading-none tracking-tight text-deep-green md:text-6xl">
          {city}
        </h1>
        <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 shadow-md shadow-deep-green/10">
          <div className="text-base font-bold text-deep-green">
            No data uploaded yet.
          </div>
          <div className="mt-1 text-sm text-deep-green/60">
            Upload a CSV in{" "}
            <Link
              href="/data"
              className="font-bold text-mint-hover hover:underline"
            >
              Data →
            </Link>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <BackLink />
      <div className="mb-8 flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <h1 className="font-display text-5xl uppercase leading-none tracking-tight text-deep-green md:text-6xl">
          {city}
        </h1>
        <CityHealthPill health={status} />
      </div>

      {reviewMeta && (
        <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-bold uppercase tracking-wider text-deep-green/60 text-[11px]">
            Reviews
          </span>
          <span className="text-deep-green/40">—</span>
          {reviews4wk.count > 0 ? (
            <>
              <span className="font-bold tabular-nums text-mint-hover">
                {reviews4wk.avgRating.toFixed(1)}
              </span>
              <span className="text-mint">★</span>
              <span className="text-deep-green/65">
                from {reviews4wk.count} reviews · last 4 weeks
              </span>
            </>
          ) : (
            <span className="text-deep-green/45">
              no reviews in last 4 weeks
            </span>
          )}
        </div>
      )}

      <div className="mb-8">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard
            label="Matches this week"
            value={String(currentWeek.matches)}
            hint={`${currentWeek.spots} spots`}
          />
          <button
            type="button"
            onClick={() => {
              if (venues.length > 0) setShowVenues((v) => !v);
            }}
            className="rounded-2xl border-[1.5px] border-cream-line bg-white p-5 text-left shadow-md shadow-deep-green/10 transition hover:shadow-lg"
          >
            <div className="text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
              Venues active
            </div>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="text-3xl font-extrabold tabular-nums text-deep-green">
                {venues.length}
              </span>
              {venues.length > 0 && (
                <span className="text-xs text-deep-green/40">
                  {showVenues ? "▾" : "▸"}
                </span>
              )}
            </div>
            <div className="mt-1 text-xs text-deep-green/60">last 8 weeks</div>
          </button>
          <StatCard
            label="Cancel rate"
            value={hasData ? `${Math.round(cancel.rate)}%` : "—"}
            hint="this month"
            valueClass={cancelRateColor(cancel.rate, hasData)}
          />
          <StatCard
            label="Total spots"
            value={cancel.totalSpots.toLocaleString()}
            hint="this month"
          />
        </div>

        {showVenues && venues.length > 0 && (
          <div className="mt-4 rounded-2xl border-[1.5px] border-cream-line bg-white p-5 shadow-md shadow-deep-green/10">
            <div className="text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
              Active venues
            </div>
            <ul className="mt-2 grid gap-x-4 gap-y-1 text-sm text-deep-green sm:grid-cols-2 lg:grid-cols-3">
              {venues.map((v) => (
                <li key={v}>• {v}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <section className="mb-8 rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10">
        <h2 className="mb-4 text-2xl font-bold tracking-tight text-deep-green">
          Last 8 weeks
        </h2>
        <TotalsBarChart weeks={weekly} />
      </section>

      <div className="mb-4">
        <h2 className="text-2xl font-extrabold tracking-tight text-deep-green">
          {city} goals
        </h2>
        <p className="text-sm text-deep-green/60">
          City-specific objectives and progress.
        </p>
      </div>
      <div className="mb-8">
        <CityGoalsView city={city} />
      </div>

      <section className="mb-8">
        <h2 className="mb-4 text-2xl font-bold tracking-tight text-deep-green">
          Cancellations
        </h2>
        <CancelHeatmap city={city} />
      </section>

      {reviewMeta && (
        <section className="mb-8">
          <div className="mb-4">
            <h2 className="text-2xl font-bold tracking-tight text-deep-green">
              {city} managers
            </h2>
            <p className="text-sm text-deep-green/60">
              {reviewWindow.monthName} {reviewWindow.year} · sorted by avg rating
            </p>
          </div>
          <CityManagerTable rows={reviewRows} city={city} />
        </section>
      )}

      {reviewMeta && (
        <section id="comments" className="mb-8 scroll-mt-20">
          <ReviewsCommentsTable
            scope="monthly"
            rows={reviewRows}
            city={city}
            defaultMonthKey={defaultMonthKey}
          />
        </section>
      )}
    </>
  );
}

function BackLink() {
  return (
    <div className="mb-3 text-sm">
      <Link
        href="/cities"
        className="text-deep-green/60 transition hover:text-deep-green"
      >
        ← All cities
      </Link>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  valueClass,
}: {
  label: string;
  value: string;
  hint?: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-5 shadow-md shadow-deep-green/10">
      <div className="text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
        {label}
      </div>
      <div
        className={`mt-1 text-3xl font-extrabold tabular-nums ${valueClass ?? "text-deep-green"}`}
      >
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-deep-green/60">{hint}</div>}
    </div>
  );
}
