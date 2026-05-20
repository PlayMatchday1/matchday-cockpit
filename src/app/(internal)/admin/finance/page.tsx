"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import QuarterSelector from "@/components/QuarterSelector";
import BillingScheduleView from "@/components/BillingScheduleView";
import CashFlowTabContent from "@/components/CashFlowTabContent";
import ChangeLogView from "@/components/ChangeLogView";
import CheckInsView from "@/components/CheckInsView";
import CityPLCard from "@/components/CityPLCard";
import ExpenseAdminView from "@/components/ExpenseAdminView";
import FieldCostsView from "@/components/FieldCostsView";
import FieldRankingTabContent from "@/components/FieldRankingTabContent";
import FinanceExecHero from "@/components/FinanceExecHero";
import FinanceConfigureSubNav, {
  isConfigureSubTab,
  type ConfigureSubTabId,
} from "@/components/FinanceConfigureSubNav";
import FinanceSecondaryNav, {
  type SecondaryId,
} from "@/components/FinanceSecondaryNav";
import FinanceTabNav, {
  FINANCE_TAB_IDS,
  type FinanceTabId,
} from "@/components/FinanceTabNav";
import ManagerPayGrid from "@/components/ManagerPayGrid";
import MatchPnL from "@/components/MatchPnL";
import PartnerDashboardsAdmin from "@/components/PartnerDashboardsAdmin";
import RevenueAdminView from "@/components/RevenueAdminView";
import { CITY_DISPLAY_ORDER } from "@/lib/financeStats";
import { FinanceQuarterProvider } from "@/lib/financeQuarter";
import {
  getAvailableQuarters,
  getCurrentQuarter,
  isPlanningQuarter,
  resolveQuarterFromUrl,
  type QuarterInfo,
} from "@/lib/quarters";
import { useFinanceData } from "@/lib/useFinanceData";

const RETURN_TAB_KEY = "finance:returnTab";
// Persists which Configure sub-tab was last viewed, so re-opening
// Configure (after navigating to a primary pill and back) lands on
// the same view instead of resetting to Revenue. Session-scoped.
const LAST_CONFIGURE_KEY = "finance:lastConfigureSubTab";
// Cross-tab handoff for "I just added a venue — open the Billing
// Schedule's add editor prefilled with this venue_id." Set by the
// Field Costs post-save banner; consumed (and cleared) by
// BillingScheduleView on first render after the tab switch.
export const BILLING_SCHEDULE_PREFILL_VENUE_KEY = "billing-schedule:prefillVenueId";

const PRIMARY_TAB_IDS: ReadonlySet<FinanceTabId> = new Set<FinanceTabId>([
  "cities",
  "cash-flow",
  "field-ranking",
  "match-pnl",
]);

// Derive which secondary nav slot is "active" given the current tab.
// Returns null when the user is on a primary pill instead.
function deriveSecondary(tab: FinanceTabId): SecondaryId | null {
  if (isConfigureSubTab(tab)) return "configure";
  if (tab === "check-ins") return "check-ins";
  if (tab === "partner-dashboards") return "partner-dashboards";
  return null;
}

function getLastConfigureSubTab(): ConfigureSubTabId {
  if (typeof window === "undefined") return "revenue";
  const v = window.sessionStorage.getItem(LAST_CONFIGURE_KEY);
  if (v && isConfigureSubTab(v)) return v;
  return "revenue";
}

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
  const router = useRouter();
  const searchParams = useSearchParams();
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

  // Secondary nav click. "configure" opens the sub-strip and lands
  // on the last-viewed Configure tab (default: Revenue). "managers"
  // navigates away to the public /managers page. The remaining two
  // (check-ins, partner-dashboards) are direct in-page tab swaps.
  function openSecondary(s: SecondaryId) {
    if (s === "configure") {
      selectTab(getLastConfigureSubTab());
    } else if (s === "managers") {
      router.push("/managers");
    } else {
      selectTab(s);
    }
  }

  // Remember the last Configure sub-tab in sessionStorage so the
  // user can leave Configure (click a primary pill) and come back
  // to the same view.
  useEffect(() => {
    if (isConfigureSubTab(activeTab) && typeof window !== "undefined") {
      window.sessionStorage.setItem(LAST_CONFIGURE_KEY, activeTab);
    }
  }, [activeTab]);

  // Track the last primary pill so "← Back to Finance" links
  // inside secondary views return to whichever pill the user was
  // on (default: Cities).
  const lastPrimaryRef = useRef<FinanceTabId>(
    PRIMARY_TAB_IDS.has(activeTab) ? activeTab : "cities",
  );
  useEffect(() => {
    if (PRIMARY_TAB_IDS.has(activeTab)) lastPrimaryRef.current = activeTab;
  }, [activeTab]);

  // Child views (Configure tabs, Check-Ins, Partner Dashboards)
  // each render a `<Link href="/admin/finance">← Back to Finance</Link>`.
  // Same-route Link clicks don't reset our local tab state, so
  // intercept them here via event delegation and route to the last
  // primary pill. Sub-detail routes like /admin/finance/partners/[id]
  // mount on a different page and aren't affected.
  const selectTabRef = useRef(selectTab);
  selectTabRef.current = selectTab;
  useEffect(() => {
    // Capture phase so this runs before Next.js's <Link> onClick
    // (which would call preventDefault + router.push and leave us
    // on the same route with stale tab state).
    function onClick(e: MouseEvent) {
      if (e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = (e.target as Element | null)?.closest?.(
        'a[href="/admin/finance"]',
      );
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      selectTabRef.current(lastPrimaryRef.current);
    }
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  const secondary = deriveSecondary(activeTab);

  // === Quarter selector + URL state (Wave 2) ===
  // useMemo + searchParams so the resolution recomputes when the URL
  // changes (back/forward, programmatic router.replace). `now` is
  // captured per render — getCurrentQuarter calls are cheap.
  const availableQuarters = useMemo(() => getAvailableQuarters(), []);
  const quarter = useMemo<QuarterInfo>(
    () => resolveQuarterFromUrl(searchParams?.get("q") ?? null, new Date()),
    [searchParams],
  );
  const handleQuarterChange = useCallback(
    (key: string) => {
      const qs = new URLSearchParams(searchParams?.toString() ?? "");
      // Default-quarter selection drops the param (clean URL); explicit
      // non-default selection writes it.
      if (key === getCurrentQuarter().key) qs.delete("q");
      else qs.set("q", key);
      const s = qs.toString();
      router.replace(s ? `?${s}` : "?");
    },
    [router, searchParams],
  );

  const planning = isPlanningQuarter(quarter, new Date());

  return (
    <FinanceQuarterProvider quarter={quarter}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <h1 className="font-display text-5xl uppercase leading-none tracking-tight text-deep-green md:text-6xl">
            Finance
          </h1>
          <p className="mt-2 text-sm text-deep-green/65">{quarter.label}</p>
        </div>
        <QuarterSelector
          available={availableQuarters}
          value={quarter.key}
          onChange={handleQuarterChange}
          now={new Date()}
        />
      </div>

      {planning && (
        <div
          role="note"
          className="mb-6 rounded-2xl border-[1.5px] border-cream-line bg-cream-soft/60 px-5 py-3 text-sm text-deep-green/70 shadow-sm shadow-deep-green/5"
        >
          <span className="font-bold text-deep-green">{quarter.label}</span> ·
          Planning quarter — actuals will populate as the quarter begins. Enter
          expenses, revenue projections, and starting cash now to forecast.
        </div>
      )}

      <FinanceSecondaryNav active={secondary} onChange={openSecondary} />

      <div className="mb-8">
        <FinanceExecHero />
      </div>

      <FinanceTabNav value={activeTab} onChange={selectTab} />

      {secondary === "configure" && (
        <FinanceConfigureSubNav
          value={
            isConfigureSubTab(activeTab)
              ? (activeTab as ConfigureSubTabId)
              : "revenue"
          }
          onChange={(id) => selectTab(id)}
        />
      )}

      {/* Render only visited tabs; toggle visibility for inactive
          ones via display:none so component-local state survives
          tab switches. Each tab's own data hook (useFinanceData,
          useMatchData, etc.) is a singleton — second visit doesn't
          refetch. */}
      <TabPanel id="cities" active={activeTab} visited={visited}>
        <CitiesTabContent />
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
      <TabPanel id="match-pnl" active={activeTab} visited={visited}>
        <MatchPnL />
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
        <FieldCostsView
          onAddedVenueGotoSchedule={(venueId) => {
            try {
              window.sessionStorage.setItem(
                BILLING_SCHEDULE_PREFILL_VENUE_KEY,
                String(venueId),
              );
            } catch {
              // sessionStorage unavailable; user can still navigate
              // manually
            }
            selectTab("billing-schedule");
          }}
        />
      </TabPanel>
      <TabPanel id="billing-schedule" active={activeTab} visited={visited}>
        <BillingScheduleView />
      </TabPanel>
      <TabPanel id="change-log" active={activeTab} visited={visited}>
        <ChangeLogView />
      </TabPanel>
    </FinanceQuarterProvider>
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
