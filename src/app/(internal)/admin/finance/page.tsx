"use client";

import { useEffect, useState } from "react";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import BillingScheduleView from "@/components/BillingScheduleView";
import CashFlowTabContent from "@/components/CashFlowTabContent";
import ChangeLogView from "@/components/ChangeLogView";
import CheckInsView from "@/components/CheckInsView";
import CityPLCard from "@/components/CityPLCard";
import ExecutiveSummary from "@/components/ExecutiveSummary";
import ExpenseAdminView from "@/components/ExpenseAdminView";
import FieldCostsView from "@/components/FieldCostsView";
import FieldRankingTabContent from "@/components/FieldRankingTabContent";
import FinanceExecHero from "@/components/FinanceExecHero";
import FinanceTabNav, {
  FINANCE_TAB_IDS,
  type FinanceTabId,
} from "@/components/FinanceTabNav";
import ManagerPayGrid from "@/components/ManagerPayGrid";
import PartnerDashboardsAdmin from "@/components/PartnerDashboardsAdmin";
import RevenueAdminView from "@/components/RevenueAdminView";
import WeeklyProjectionsTab from "@/components/WeeklyProjectionsTab";
import { CITY_DISPLAY_ORDER } from "@/lib/financeStats";
import { supabase } from "@/lib/supabase";
import { useFinanceData } from "@/lib/useFinanceData";

const RETURN_TAB_KEY = "finance:returnTab";

export default function FinanceLandingPage() {
  return (
    <PagePermissionGuard page="finance">
      <FinanceLandingContent />
    </PagePermissionGuard>
  );
}

// Read the sessionStorage hint set by sub-detail pages (e.g.
// /admin/finance/partners/[id]) so a "← Back" lands on the tab the
// user came from. Single-use: cleared on read so a fresh visit
// defaults to Cities. typeof window guard for safety even though
// this is a client component.
function getInitialTab(): FinanceTabId {
  if (typeof window === "undefined") return "cities";
  const hint = window.sessionStorage.getItem(RETURN_TAB_KEY);
  if (hint) {
    window.sessionStorage.removeItem(RETURN_TAB_KEY);
    if ((FINANCE_TAB_IDS as readonly string[]).includes(hint)) {
      return hint as FinanceTabId;
    }
  }
  return "cities";
}

function FinanceLandingContent() {
  const [quarterLabel, setQuarterLabel] = useState<string>("");
  const [activeTab, setActiveTab] = useState<FinanceTabId>(() => getInitialTab());
  // Lazy-mount strategy: tabs are mounted the first time they're
  // visited, then kept mounted (display:none for inactive). This
  // preserves component-local state (sorts, filters, modal open
  // flags) across switches without firing every tab's data hook on
  // initial page load.
  const [visited, setVisited] = useState<Set<FinanceTabId>>(
    () => new Set([getInitialTab()]),
  );

  function selectTab(t: FinanceTabId) {
    setActiveTab(t);
    setVisited((prev) => (prev.has(t) ? prev : new Set([...prev, t])));
  }

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

      <FinanceTabNav value={activeTab} onChange={selectTab} />

      {/* Render only visited tabs; toggle visibility for inactive
          ones via display:none so component-local state survives
          tab switches. Each tab's own data hook (useFinanceData,
          useMatchData, etc.) is a singleton — second visit doesn't
          refetch. */}
      <TabPanel id="cities" active={activeTab} visited={visited}>
        <CitiesTabContent />
      </TabPanel>
      <TabPanel id="exec-summary" active={activeTab} visited={visited}>
        <ExecutiveSummary />
      </TabPanel>
      <TabPanel id="revenue" active={activeTab} visited={visited}>
        <RevenueAdminView />
      </TabPanel>
      <TabPanel id="expenses" active={activeTab} visited={visited}>
        <ExpenseAdminView />
      </TabPanel>
      <TabPanel id="manager-pay" active={activeTab} visited={visited}>
        <ManagerPayGrid />
      </TabPanel>
      <TabPanel id="cash-flow" active={activeTab} visited={visited}>
        <CashFlowTabContent />
      </TabPanel>
      <TabPanel id="projections" active={activeTab} visited={visited}>
        <WeeklyProjectionsTab />
      </TabPanel>
      <TabPanel id="field-ranking" active={activeTab} visited={visited}>
        <FieldRankingTabContent />
      </TabPanel>
      <TabPanel id="check-ins" active={activeTab} visited={visited}>
        <CheckInsView />
      </TabPanel>
      <TabPanel id="partner-dashboards" active={activeTab} visited={visited}>
        <PartnerDashboardsAdmin inline />
      </TabPanel>
      <TabPanel id="field-costs" active={activeTab} visited={visited}>
        <FieldCostsView />
      </TabPanel>
      <TabPanel id="billing-schedule" active={activeTab} visited={visited}>
        <BillingScheduleView />
      </TabPanel>
      <TabPanel id="change-log" active={activeTab} visited={visited}>
        <ChangeLogView />
      </TabPanel>

    </>
  );
}

// Wraps each tab's content. Lazy-mounted: returns null until the
// user has visited the tab once. After that, stays mounted; toggles
// display based on `active` so component-local state is preserved.
function TabPanel({
  id,
  active,
  visited,
  children,
}: {
  id: FinanceTabId;
  active: FinanceTabId;
  visited: Set<FinanceTabId>;
  children: React.ReactNode;
}) {
  if (!visited.has(id)) return null;
  return (
    <div
      role="tabpanel"
      hidden={id !== active}
      className={id === active ? "" : "hidden"}
    >
      {children}
    </div>
  );
}

function CitiesTabContent() {
  const { data, loading } = useFinanceData();
  if (loading) {
    return (
      <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
        Loading…
      </div>
    );
  }
  if (!data) return null;
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {CITY_DISPLAY_ORDER.map((c) => (
        <CityPLCard key={c} city={c} />
      ))}
    </div>
  );
}
