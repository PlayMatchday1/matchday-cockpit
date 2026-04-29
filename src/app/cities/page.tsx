"use client";

import { useState } from "react";
import Link from "next/link";
import CitiesLegend from "@/components/CitiesLegend";
import { CityHealthPill } from "@/components/StatusPill";
import MiniBarSparkline from "@/components/MiniBarSparkline";
import TotalsBarChart from "@/components/TotalsBarChart";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import { useMatchData } from "@/lib/useMatchData";
import { useReviewData } from "@/lib/useReviewData";
import {
  getActiveVenues,
  getCancelRate,
  getCityStatus,
  getWeeklySpots,
  type CityStatus,
  type WeeklySpotsEntry,
} from "@/lib/cityStats";
import { getActiveMonthWindow } from "@/lib/reviewStats";
import { CITIES, citySlug } from "@/lib/types";
import CancelPatterns from "@/components/CancelPatterns";
import ManagerPodium from "@/components/ManagerPodium";
import MembershipActiveChart from "@/components/MembershipActiveChart";
import MembershipByCityTable from "@/components/MembershipByCityTable";
import MembershipSnapshot from "@/components/MembershipSnapshot";
import MembershipTrendChart from "@/components/MembershipTrendChart";
import Reviews8WeekCard from "@/components/Reviews8WeekCard";
import ReviewsCommentsTable from "@/components/ReviewsCommentsTable";

export default function CitiesIndexPage() {
  return (
    <PagePermissionGuard page="cities">
      <CitiesIndexContent />
    </PagePermissionGuard>
  );
}

type WeekScope = "current" | "last";

function CitiesIndexContent() {
  const { rows, meta, loading } = useMatchData();
  const { rows: reviewRows, meta: reviewMeta, loading: reviewLoading } =
    useReviewData();
  const reviewWindow = getActiveMonthWindow(reviewRows);
  const [weekScope, setWeekScope] = useState<WeekScope>("current");

  const totals = getWeeklySpots(rows, null, 8);
  const totalSpots = totals.reduce((s, w) => s + w.spots, 0);
  // Selected week index: last entry is the in-progress current week,
  // second-to-last is the most recently completed week.
  const selectedIdx =
    weekScope === "current" ? totals.length - 1 : totals.length - 2;
  const safeSelectedIdx = Math.max(0, selectedIdx);
  const selectedTotal = totals[safeSelectedIdx];
  const selectedLabel =
    weekScope === "current" ? "matches this week" : "matches last week";

  const cityData = CITIES.map((city) => {
    const weekly = getWeeklySpots(rows, city, 8);
    const cancel = getCancelRate(rows, city);
    const venues = getActiveVenues(rows, city, 8);
    const status = getCityStatus(rows, city);
    return {
      city,
      weekly,
      cancel,
      venues,
      status,
      selectedWeek: weekly[safeSelectedIdx],
    };
  });

  const venueKeys = new Set<string>();
  for (const c of cityData) {
    for (const v of c.venues) venueKeys.add(`${c.city}|${v}`);
  }
  const totalActiveVenues = venueKeys.size;
  const activeCities = cityData.filter(
    (c) => c.selectedWeek.matches > 0,
  ).length;

  return (
    <>
      <div className="mb-6">
        <h1 className="text-3xl font-extrabold tracking-tight text-deep-green">
          Cities
        </h1>
        <p className="mt-1 text-sm text-deep-green/70">
          Per-market venues, weekly matches, and goals.
        </p>
      </div>

      {loading ? (
        <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
          Loading match data…
        </div>
      ) : !meta ? (
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
      ) : (
        <>
          <section className="mb-8 rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10 sm:p-7">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="text-[11px] font-bold uppercase tracking-[0.25em] text-deep-green/60">
                MatchDay total · last 8 weeks
              </div>
              <WeekScopeToggle value={weekScope} onChange={setWeekScope} />
            </div>
            <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-display text-5xl uppercase leading-none tracking-tight text-deep-green md:text-6xl">
                {selectedTotal.matches}
              </span>
              <span className="text-sm font-medium text-deep-green/60">
                {selectedLabel}
              </span>
            </div>
            <div className="mt-1 text-sm text-deep-green/70">
              {totalSpots.toLocaleString()} spots booked ·{" "}
              {totalActiveVenues} venues active across {activeCities} cities
            </div>
            <div className="mt-6">
              <TotalsBarChart weeks={totals} highlightIndex={safeSelectedIdx} />
            </div>
          </section>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {cityData.map((c) => (
              <CityCard key={c.city} {...c} />
            ))}
          </div>

          <div className="mt-8 text-xs text-deep-green/60">
            Last data refresh: {relativeFrom(meta.uploadedAt)} ·{" "}
            <span className="text-deep-green/80">{meta.filename}</span> ·{" "}
            {meta.rowCount.toLocaleString()} rows ·{" "}
            <Link
              href="/data"
              className="font-bold text-mint-hover hover:underline"
            >
              Update →
            </Link>
          </div>
        </>
      )}

      <div className="mt-12">
        <CancelPatterns />
      </div>

      <section className="mt-12">
        <div className="mb-6">
          <h2 className="text-2xl font-bold tracking-tight text-deep-green">
            Membership
          </h2>
          <p className="mt-1 text-sm text-deep-green/70">
            Active members, growth, and per-city breakdown
          </p>
        </div>
        <div className="space-y-6">
          <MembershipSnapshot />
          <MembershipActiveChart />
          <MembershipTrendChart />
          <MembershipByCityTable />
        </div>
      </section>

      <section className="mt-12">
        <div className="mb-6">
          <h2 className="text-2xl font-bold tracking-tight text-deep-green">
            Reviews
          </h2>
          {reviewMeta ? (
            <p className="mt-1 text-sm text-deep-green/70">
              Manager performance · {reviewWindow.monthName} {reviewWindow.year}
            </p>
          ) : (
            <p className="mt-1 text-sm text-deep-green/70">
              Manager performance
            </p>
          )}
        </div>
        {reviewLoading ? (
          <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
            Loading review data…
          </div>
        ) : !reviewMeta ? (
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
            <Reviews8WeekCard rows={reviewRows} />
            <ManagerPodium rows={reviewRows} />
            <ReviewsCommentsTable rows={reviewRows} />
          </div>
        )}
      </section>
    </>
  );
}

function CityCard({
  city,
  weekly,
  cancel,
  venues,
  status,
  selectedWeek,
}: {
  city: string;
  weekly: WeeklySpotsEntry[];
  cancel: {
    totalMatches: number;
    canceledMatches: number;
    rate: number;
    totalSpots: number;
  };
  venues: string[];
  status: CityStatus;
  selectedWeek: WeeklySpotsEntry;
}) {
  const dim = status === "Just launched";
  const sparkData = weekly.map((w) => w.matches);
  return (
    <Link
      href={`/cities/${citySlug(city as never)}`}
      className={`block rounded-2xl border-[1.5px] border-cream-line bg-white p-5 shadow-md shadow-deep-green/10 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-deep-green/20 ${
        dim ? "opacity-50" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="text-base font-bold text-deep-green">{city}</div>
        <div className="flex items-center gap-1.5">
          <CityHealthPill health={status} />
          <CitiesLegend />
        </div>
      </div>
      <div className="mt-4 grid grid-cols-4 gap-3">
        <Stat label="Matches/wk" value={String(selectedWeek.matches)} />
        <Stat label="Venues" value={String(venues.length)} />
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
            8wk trend
          </div>
          <div className="mt-1.5">
            <MiniBarSparkline data={sparkData} className="h-6 w-full" />
          </div>
        </div>
        <Stat
          label="Cancel %"
          value={
            cancel.totalMatches === 0 ? "—" : `${Math.round(cancel.rate)}%`
          }
          title={
            cancel.totalMatches === 0
              ? "No matches scheduled this month."
              : `${cancel.canceledMatches} of ${cancel.totalMatches} matches canceled this month.`
          }
        />
      </div>
    </Link>
  );
}

function WeekScopeToggle({
  value,
  onChange,
}: {
  value: WeekScope;
  onChange: (v: WeekScope) => void;
}) {
  return (
    <div className="inline-flex rounded-full bg-cream-soft p-1 ring-1 ring-cream-line">
      <button
        type="button"
        onClick={() => onChange("current")}
        className={`rounded-full px-3 py-1 text-[11px] font-bold transition ${
          value === "current"
            ? "bg-mint text-deep-green shadow-sm"
            : "text-deep-green/60 hover:text-deep-green"
        }`}
      >
        This week
      </button>
      <button
        type="button"
        onClick={() => onChange("last")}
        className={`rounded-full px-3 py-1 text-[11px] font-bold transition ${
          value === "last"
            ? "bg-mint text-deep-green shadow-sm"
            : "text-deep-green/60 hover:text-deep-green"
        }`}
      >
        Last week
      </button>
    </div>
  );
}

function Stat({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <div className="min-w-0" title={title}>
      <div className="text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
        {label}
      </div>
      <div className="mt-0.5 text-lg font-extrabold tabular-nums text-deep-green">
        {value}
      </div>
    </div>
  );
}

function relativeFrom(d: Date): string {
  const ms = Date.now() - d.getTime();
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  return `${days}d ago`;
}
