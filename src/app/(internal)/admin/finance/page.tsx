"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight } from "lucide-react";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import CheckInsButtonCard from "@/components/CheckInsButtonCard";
import CityPLCard from "@/components/CityPLCard";
import ExecutiveSummary from "@/components/ExecutiveSummary";
import FinanceAnchorNav from "@/components/FinanceAnchorNav";
import FinanceExecHero from "@/components/FinanceExecHero";
import { CITY_DISPLAY_ORDER } from "@/lib/financeStats";
import { supabase } from "@/lib/supabase";
import { useFinanceData } from "@/lib/useFinanceData";

export default function FinanceLandingPage() {
  return (
    <PagePermissionGuard page="finance">
      <FinanceLandingContent />
    </PagePermissionGuard>
  );
}

function FinanceLandingContent() {
  const [quarterLabel, setQuarterLabel] = useState<string>("");
  const [cityCollapsed, setCityCollapsed] = useState(false);

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
      <div className="mb-8">
        <h1 className="font-display text-5xl uppercase leading-none tracking-tight text-deep-green md:text-6xl">
          Finance
        </h1>
        <p className="mt-2 text-sm text-deep-green/65">
          {quarterLabel || "Loading…"}
        </p>
      </div>

      <div className="mb-8">
        <FinanceExecHero />
      </div>

      <FinanceAnchorNav />

      {/* Cities — primary visual focus. scroll-mt offsets for the
          sticky nav so anchor jumps don't land under it. */}
      <section id="cities" className="scroll-mt-20">
        <SectionHeader
          title="City & Field P&L"
          subtitle="Per-market field economics, membership allocation, and overhead."
          collapsed={cityCollapsed}
          onToggle={() => setCityCollapsed((c) => !c)}
        />
        {!cityCollapsed && (
          <div className="mb-8">
            <CityCardsGrid />
          </div>
        )}

        {/* Sub-page entry buttons — same shell as DataLink and the
            existing CheckInsButtonCard so the row reads as one unit. */}
        <div className="mb-12 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          <DataLink
            href="/admin/finance/fields"
            eyebrow="View"
            title="Field Ranking"
            subtitle="Per-venue financial breakdown ranked by net contribution."
          />
          <DataLink
            href="/admin/finance/cash-flow"
            eyebrow="View"
            title="Cash Flow"
            subtitle="Monthly P&L, revenue trend, and operational financial detail."
          />
          <CheckInsButtonCard />
        </div>
      </section>

      <section id="exec-summary" className="mb-12 scroll-mt-20">
        <ExecutiveSummary />
      </section>

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
          href="/admin/finance/field-costs"
          eyebrow="Manage"
          title="Field Costs"
          subtitle="Per-venue monthly cost. Override any (venue, month) where the real arrangement differs from the formula."
        />
        <DataLink
          href="/admin/finance/billing-schedule"
          eyebrow="Manage"
          title="Billing Schedule"
          subtitle="What each venue bills MatchDay for. Add / edit individual matches; the Sheet import preserves your manual entries."
        />
        <DataLink
          href="/admin/finance/manager-pay"
          eyebrow="Manage"
          title="Manager Pay"
          subtitle="Weekly Thursday cash-out per city. Edits sync to fin_expenses → city cards + Cash Flow."
        />
        <DataLink
          href="/admin/finance/changelog"
          eyebrow="Audit"
          title="Change Log"
          subtitle="Every manual add, edit, and delete with before/after diff and the user who made the change."
        />
        <DataLink
          href="/admin/finance/partners"
          eyebrow="Manage"
          title="Partner Dashboards"
          subtitle="Tokenized partner-facing dashboards. One enabled URL per venue; regenerate to invalidate."
        />
      </div>

      <SectionHeader
        title="Data"
        subtitle="Ongoing uploads."
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
  // Render every city in CITY_DISPLAY_ORDER (alphabetical, hardcoded).
  // CityPLCard handles missing-data months gracefully — zero-state card
  // in its alphabetical slot rather than dropping it from the layout.
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {CITY_DISPLAY_ORDER.map((c) => (
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
