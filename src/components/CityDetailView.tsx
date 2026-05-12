"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import {
  getActiveVenues,
  getCancelRate,
  getCityStatus,
  getWeeklySpots,
} from "@/lib/cityStats";
import { useMatchWindowData } from "@/lib/useMatchData";
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
  // 12-week city-scoped window. Server-side `city_identifier` filter
  // means we only pull this city's matches/players — STL is ~486KB,
  // ATX is ~4.4MB (vs ~12MB unbounded). Cache key is
  // `12|<abbr>` so it never collides with the network-wide /cities
  // entry (`12|`).
  const { rows, scheduledMatches, meta, loading } = useMatchWindowData(
    12,
    city,
  );
  const { rows: reviewRows, meta: reviewMeta } = useReviewData();
  const [showVenues, setShowVenues] = useState(false);
  // Pre-select the Comments month from ?month=YYYY-MM (set by the
  // monthly-report-generator deep link). Falls through to the table's
  // own previous-month default when absent or malformed.
  const searchParams = useSearchParams();
  const monthParam = searchParams?.get("month") ?? undefined;
  const defaultMonthKey =
    monthParam && /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : undefined;

  // Memoize aggregations — defensive against re-render storms. All
  // O(N) over the (now-bounded) row set; deps are the data arrays +
  // the city (city changes on route swap, which is also when the
  // hook switches cache entries).
  const weekly = useMemo(
    () => getWeeklySpots(rows, scheduledMatches, city, 8),
    [rows, scheduledMatches, city],
  );
  const cancel = useMemo(
    () => getCancelRate(rows, scheduledMatches, city),
    [rows, scheduledMatches, city],
  );
  const venues = useMemo(
    () => getActiveVenues(scheduledMatches, city, 8),
    [scheduledMatches, city],
  );
  const status = useMemo(() => getCityStatus(rows, city), [rows, city]);
  const currentWeek = weekly[weekly.length - 1];
  const hasData = cancel.totalMatches > 0;

  const reviews4wk = getRecentReviewStats(reviewRows, city, 4);
  const reviewWindow = getActiveMonthWindow(reviewRows);

  if (loading) {
    return <CityDetailSkeleton city={city} />;
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

// Loading skeleton: same outer dimensions as the real header + tiles
// + bar chart + heatmap so there's no layout shift when the data
// arrives. Subdued gray bars (cream-line over white) with a slow
// pulse animation. Renders the city name and back link immediately
// so the page feels responsive even before any fetch resolves.
function CityDetailSkeleton({ city }: { city: string }) {
  return (
    <>
      <BackLink />
      <div className="mb-8 flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <h1 className="font-display text-5xl uppercase leading-none tracking-tight text-deep-green md:text-6xl">
          {city}
        </h1>
        <div className="h-6 w-24 animate-pulse rounded-full bg-cream-line" />
      </div>

      <div className="mb-8">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="rounded-2xl border-[1.5px] border-cream-line bg-white p-5 shadow-md shadow-deep-green/10"
            >
              <div className="h-3 w-20 animate-pulse rounded bg-cream-line" />
              <div className="mt-2 h-8 w-16 animate-pulse rounded bg-cream-line" />
              <div className="mt-2 h-3 w-12 animate-pulse rounded bg-cream-line" />
            </div>
          ))}
        </div>
      </div>

      <section className="mb-8 rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10">
        <div className="mb-4 h-6 w-32 animate-pulse rounded bg-cream-line" />
        {/* Bar chart skeleton — 8 vertical bars of varying heights,
            matching TotalsBarChart's approximate dimensions. */}
        <div className="flex items-end justify-between gap-2 px-1" style={{ height: 140 }}>
          {[60, 90, 75, 110, 95, 130, 100, 120].map((h, i) => (
            <div
              key={i}
              className="flex-1 animate-pulse rounded-t bg-cream-line"
              style={{ height: `${h}px` }}
            />
          ))}
        </div>
      </section>

      <section className="mb-8 rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10">
        <div className="h-3 w-64 animate-pulse rounded bg-cream-line" />
        <div className="mt-4 space-y-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-6 w-full animate-pulse rounded bg-cream-line/70"
            />
          ))}
        </div>
      </section>
    </>
  );
}
