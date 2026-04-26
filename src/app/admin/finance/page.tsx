"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight } from "lucide-react";
import AdminGuard from "@/components/AdminGuard";
import CityPLCard from "@/components/CityPLCard";
import ExecutiveSummary from "@/components/ExecutiveSummary";
import FieldRankingTable from "@/components/FieldRankingTable";
import FinanceHeroMetrics from "@/components/FinanceHeroMetrics";
import FinanceInsightsGrid from "@/components/FinanceInsightsGrid";
import FinanceMonthlyPL from "@/components/FinanceMonthlyPL";
import FinanceTrendChart from "@/components/FinanceTrendChart";
import { CITY_DISPLAY_ORDER, cityHasAnyQ2Activity } from "@/lib/financeStats";
import { supabase } from "@/lib/supabase";
import { useFinanceData } from "@/lib/useFinanceData";

export default function FinanceLandingPage() {
  return (
    <AdminGuard>
      <FinanceLandingContent />
    </AdminGuard>
  );
}

function FinanceLandingContent() {
  const [quarterLabel, setQuarterLabel] = useState<string>("");
  const [insightsCollapsed, setInsightsCollapsed] = useState(false);
  const [monthlyCollapsed, setMonthlyCollapsed] = useState(false);
  const [cityCollapsed, setCityCollapsed] = useState(false);
  const [rankingCollapsed, setRankingCollapsed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from("fin_config")
      .select("value")
      .eq("key", "quarter_label")
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        const v = (data as { value?: string } | null)?.value;
        if (v) setQuarterLabel(v);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <div className="mb-10">
        <h1 className="font-display text-5xl uppercase leading-none tracking-tight text-deep-green md:text-6xl">
          Finance
        </h1>
        <p className="mt-2 text-sm text-deep-green/65">
          {quarterLabel || "Loading…"}
        </p>
      </div>

      <div className="mb-8">
        <ExecutiveSummary />
      </div>

      <div className="mb-8">
        <FinanceHeroMetrics />
      </div>

      <div className="mb-8">
        <FinanceInsightsGrid
          collapsed={insightsCollapsed}
          onToggle={() => setInsightsCollapsed((c) => !c)}
        />
      </div>

      <div className="mb-8">
        <FinanceTrendChart />
      </div>

      <div className="mb-12">
        <FinanceMonthlyPL
          collapsed={monthlyCollapsed}
          onToggle={() => setMonthlyCollapsed((c) => !c)}
        />
      </div>

      <SectionHeader
        title="City & Field P&L"
        subtitle="Per-market field economics, membership allocation, and overhead."
        collapsed={cityCollapsed}
        onToggle={() => setCityCollapsed((c) => !c)}
      />
      {!cityCollapsed && (
        <div className="mb-12">
          <CityCardsGrid />
        </div>
      )}

      <div className="mb-12">
        <FieldRankingTable
          collapsed={rankingCollapsed}
          onToggle={() => setRankingCollapsed((c) => !c)}
        />
      </div>

      <SectionHeader
        title="More detail"
        subtitle="Narrative + scenario thinking."
      />
      <div className="mb-12 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        <PlaceholderCard title="Forecasts" phase="Phase 5" />
      </div>

      <SectionHeader
        title="Manage"
        subtitle="Inspect, add, edit, and audit individual finance rows."
      />
      <div className="mb-10 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        <DataLink
          href="/admin/finance/revenue"
          eyebrow="Manage"
          title="Revenue"
          subtitle="Browse every fin_revenue row. Add or edit manual entries; CSV-imported rows are read-only."
        />
        <DataLink
          href="/admin/finance/expenses"
          eyebrow="Manage"
          title="Expenses"
          subtitle="Browse every fin_expenses row. Add or edit manual entries; CSV-imported rows are read-only."
        />
        <DataLink
          href="/admin/finance/changelog"
          eyebrow="Audit"
          title="Change Log"
          subtitle="Every manual add, edit, and delete with before/after diff and the user who made the change."
        />
      </div>

      <SectionHeader
        title="Data"
        subtitle="One-time historical loads and ongoing uploads."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Link
          href="/admin/finance/upload"
          className="block rounded-2xl border-l-4 border-mint border-y-[1.5px] border-r-[1.5px] border-y-cream-line border-r-cream-line bg-white p-6 shadow-md shadow-deep-green/10 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-deep-green/20"
        >
          <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-mint-hover">
            Weekly
          </div>
          <div className="mt-1 text-base font-bold text-deep-green">
            Weekly Update
          </div>
          <p className="mt-1 text-sm text-deep-green/60">
            Drop the latest Members + Stripe exports. Replaces the rows it
            covers; everything else is left alone.
          </p>
          <div className="mt-3 text-xs font-bold uppercase tracking-wider text-mint-hover">
            Open →
          </div>
        </Link>
        <Link
          href="/admin/finance/import"
          className="block rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-deep-green/20"
        >
          <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-deep-green/45">
            One-time
          </div>
          <div className="mt-1 text-base font-bold text-deep-green">
            Q2 2026 import
          </div>
          <p className="mt-1 text-sm text-deep-green/60">
            Upload the 10 Sheet tabs as CSVs to seed the database.
          </p>
          <div className="mt-3 text-xs font-bold uppercase tracking-wider text-mint-hover">
            Open →
          </div>
        </Link>
      </div>
    </>
  );
}

function CityCardsGrid() {
  const { data, loading } = useFinanceData();
  if (loading) {
    return (
      <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
        Loading…
      </div>
    );
  }
  if (!data) return null;
  const cities = CITY_DISPLAY_ORDER.filter((c) => cityHasAnyQ2Activity(data, c));
  if (cities.length === 0) {
    return (
      <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
        No city activity yet.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {cities.map((c) => (
        <CityPLCard key={c} city={c} />
      ))}
    </div>
  );
}

function SectionHeader({
  title,
  subtitle,
  collapsed,
  onToggle,
}: {
  title: string;
  subtitle: string;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const interactive = Boolean(onToggle);
  const content = (
    <>
      <span aria-hidden className="w-1 rounded-full bg-mint" />
      <div className="flex flex-1 items-center gap-2 py-0.5">
        {interactive &&
          (collapsed ? (
            <ChevronRight
              size={18}
              aria-hidden
              className="shrink-0 text-deep-green/55"
            />
          ) : (
            <ChevronDown
              size={18}
              aria-hidden
              className="shrink-0 text-deep-green/55"
            />
          ))}
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-deep-green">
            {title}
          </h2>
          <p className="mt-0.5 text-sm text-deep-green/60">{subtitle}</p>
        </div>
      </div>
    </>
  );
  if (interactive) {
    return (
      <div
        role="button"
        aria-expanded={!collapsed}
        onClick={onToggle}
        className="mb-5 flex cursor-pointer items-stretch gap-3 rounded-lg -mx-2 px-2 py-1 hover:bg-cream-soft/50"
      >
        {content}
      </div>
    );
  }
  return <div className="mb-5 flex items-stretch gap-3">{content}</div>;
}

function PlaceholderCard({
  title,
  phase,
}: {
  title: string;
  phase: string;
}) {
  return (
    <div className="rounded-2xl border-2 border-dashed border-cream-line bg-cream-soft/40 p-6">
      <div className="text-base font-bold text-deep-green/70">{title}</div>
      <div className="mt-1 text-xs font-bold uppercase tracking-wider text-deep-green/40">
        Coming in {phase}
      </div>
    </div>
  );
}

function DataLink({
  href,
  eyebrow,
  title,
  subtitle,
}: {
  href: string;
  eyebrow: string;
  title: string;
  subtitle: string;
}) {
  return (
    <Link
      href={href}
      className="block rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-deep-green/20"
    >
      <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-deep-green/45">
        {eyebrow}
      </div>
      <div className="mt-1 text-base font-bold text-deep-green">{title}</div>
      <p className="mt-1 text-sm text-deep-green/60">{subtitle}</p>
      <div className="mt-3 text-xs font-bold uppercase tracking-wider text-mint-hover">
        Open →
      </div>
    </Link>
  );
}
