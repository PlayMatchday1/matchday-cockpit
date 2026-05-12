"use client";

import { useState } from "react";
import Link from "next/link";
import CitiesLegend from "@/components/CitiesLegend";
import CitiesCancellationsLens from "@/components/CitiesCancellationsLens";
import CitiesExecHero from "@/components/CitiesExecHero";
import CitiesLensNav, { type CityLens } from "@/components/CitiesLensNav";
import CitiesMembershipLens from "@/components/CitiesMembershipLens";
import CitiesReviewsLens from "@/components/CitiesReviewsLens";
import CitiesUsersLens from "@/components/CitiesUsersLens";
import { CityHealthPill } from "@/components/StatusPill";
import MiniBarSparkline from "@/components/MiniBarSparkline";
import TotalsBarChart from "@/components/TotalsBarChart";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import { useMatchWindowData } from "@/lib/useMatchData";
import {
  getActiveVenues,
  getCancelRate,
  getCityStatus,
  getWeeklySpots,
  type CityStatus,
  type WeeklySpotsEntry,
} from "@/lib/cityStats";
import { CITIES, citySlug } from "@/lib/types";

export default function CitiesIndexPage() {
  return (
    <PagePermissionGuard page="cities">
      <CitiesIndexContent />
    </PagePermissionGuard>
  );
}

type WeekScope = "current" | "last";

function CitiesIndexContent() {
  const [lens, setLens] = useState<CityLens>("overview");

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

      <div className="mb-8">
        <CitiesExecHero />
      </div>

      <CitiesLensNav value={lens} onChange={setLens} />

      {lens === "overview" && <OverviewLens />}
      {lens === "users" && <CitiesUsersLens />}
      {lens === "membership" && <CitiesMembershipLens />}
      {lens === "cancellations" && <CitiesCancellationsLens />}
      {lens === "reviews" && <CitiesReviewsLens />}
    </>
  );
}

function OverviewLens() {
  // 12-week window (covers the 8-week getWeeklySpots call + slack for
  // current-month MTD). Server-side date filter avoids the 38k-row
  // full-population pull on hydration. See useMatchWindowData header.
  const { rows, scheduledMatches, meta, loading } = useMatchWindowData(12);
  const [weekScope, setWeekScope] = useState<WeekScope>("current");

  const totals = getWeeklySpots(rows, scheduledMatches, null, 8);
  const totalSpots = totals.reduce((s, w) => s + w.spots, 0);
  const selectedIdx =
    weekScope === "current" ? totals.length - 1 : totals.length - 2;
  const safeSelectedIdx = Math.max(0, selectedIdx);
  const selectedTotal = totals[safeSelectedIdx];
  const selectedLabel =
    weekScope === "current" ? "matches this week" : "matches last week";

  const cityData = CITIES.map((city) => {
    const weekly = getWeeklySpots(rows, scheduledMatches, city, 8);
    const cancel = getCancelRate(rows, scheduledMatches, city);
    const venues = getActiveVenues(scheduledMatches, city, 8);
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

  if (loading) {
    return (
      <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
        Loading match data…
      </div>
    );
  }
  if (!meta) {
    return (
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
    );
  }

  return (
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
