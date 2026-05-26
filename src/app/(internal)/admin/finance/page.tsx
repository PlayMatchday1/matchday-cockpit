"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import QuarterSelector from "@/components/QuarterSelector";
import BillingScheduleView from "@/components/BillingScheduleView";
import CashFlowTabContent from "@/components/CashFlowTabContent";
import ChangeLogView from "@/components/ChangeLogView";
import CheckInsView from "@/components/CheckInsView";
import CityPLCard, {
  type CityCostMode,
  type CityCostScope,
} from "@/components/CityPLCard";
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
import CancelHeatmap from "@/components/CancelHeatmap";
import CancelPatterns from "@/components/CancelPatterns";
import CitiesMasterScheduleLens from "@/components/CitiesMasterScheduleLens";
import FieldRankingTable from "@/components/FieldRankingTable";
import CollapsibleSection from "@/components/CollapsibleSection";
import FinanceActions from "@/components/FinanceActions";
import MatchPnL from "@/components/MatchPnL";
import SlateMatchPnLSection from "@/components/SlateMatchPnLSection";
import PartnerDashboardsAdmin from "@/components/PartnerDashboardsAdmin";
import RevenueAdminView from "@/components/RevenueAdminView";
import TotalsBarChart from "@/components/TotalsBarChart";
import { CITIES, type City } from "@/lib/types";
import { useMatchWindowData } from "@/lib/useMatchData";
import { getWeeklySpots, getMonday } from "@/lib/cityStats";
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
  "slate-review",
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

      {/* The 3-card exec banner is Cash-Flow-specific context (Q2
          P&L, current-month gross, MTD vs prior). Hide on every
          other tab so they get more vertical room for their own
          content. */}
      {activeTab === "cash-flow" && (
        <div className="mb-8">
          <FinanceExecHero />
        </div>
      )}

      <FinanceTabNav value={activeTab} onChange={selectTab} />

      {/* Shared Actions list — renders at the top of every non-
          Cash-Flow tab's content. Single instance kept mounted
          across tab switches so the filter state survives. Hidden
          (display:none) on Cash Flow rather than unmounted so the
          fetched list doesn't re-load every time you bounce back. */}
      <div className={activeTab === "cash-flow" ? "hidden" : "mt-4"}>
        <FinanceActions />
      </div>

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
      <TabPanel id="slate-review" active={activeTab} visited={visited}>
        <SlateReviewTabContent />
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
  // Page-level cost view, applied to every CityPLCard at once. Defaults
  // to per_match so the page opens with billing-timing lumps already
  // smoothed (NEMP's Q2 permit, Bicentennial's prepay, etc.). Field
  // Ranking defaults to as_billed instead — different default per
  // surface, but both pages share groupPerMatchCostFor under the hood
  // so the numbers reconcile when an operator flips either toggle.
  const [costMode, setCostMode] = useState<CityCostMode>("per_match");
  // Realized = field cost through today only (current month filters by
  // match_date <= today; past months auto-collapse to full canonical;
  // future months return 0). Full Month = full month projected cost
  // (current behavior). Revenue is actual in both modes; overhead stays
  // full-month in both modes (committed monthly, not match-by-match).
  // Default Realized so the card opens on the point-in-time read.
  const [costScope, setCostScope] = useState<CityCostScope>("realized");
  if (loading) {
    return (
      <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
        Loading…
      </div>
    );
  }
  if (!data) return null;
  return (
    <div>
      <div className="mb-4 flex flex-wrap justify-end gap-2">
        <div
          className="inline-flex rounded-full border border-cream-line bg-cream-soft p-0.5 text-xs font-bold"
          role="radiogroup"
          aria-label="Cost view"
        >
          {(["as_billed", "per_match"] as const).map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => setCostMode(opt)}
              className={`rounded-full px-3 py-1.5 transition ${
                costMode === opt
                  ? "bg-mint text-deep-green"
                  : "text-deep-green/65 hover:text-deep-green"
              }`}
              aria-pressed={costMode === opt}
            >
              {opt === "as_billed" ? "As Billed" : "Per-Match"}
            </button>
          ))}
        </div>
        <div
          className="inline-flex rounded-full border border-cream-line bg-cream-soft p-0.5 text-xs font-bold"
          role="radiogroup"
          aria-label="Cost timing"
        >
          {(["realized", "fullMonth"] as const).map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => setCostScope(opt)}
              className={`rounded-full px-3 py-1.5 transition ${
                costScope === opt
                  ? "bg-mint text-deep-green"
                  : "text-deep-green/65 hover:text-deep-green"
              }`}
              aria-pressed={costScope === opt}
            >
              {opt === "realized" ? "Realized" : "Full Month"}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {CITY_DISPLAY_ORDER.map((c) => (
          <CityPLCard
            key={c}
            city={c}
            costMode={costMode}
            costScope={costScope}
          />
        ))}
      </div>
    </div>
  );
}

// Slate Review — per-city decision snapshot. Sections from existing
// components, scoped to one selected city + selected week via state
// owned at this level:
//   1. City selector   (single-select pill row, this file)
//   2. Last 8 weeks    (TotalsBarChart fed by useMatchWindowData + getWeeklySpots)
//   3. Field Ranking   (FieldRankingTable city-filtered + costScope=realized)
//   4. Master schedule (CitiesMasterScheduleLens controlled via weekStart)
//   5. Cancel patterns (CancelPatterns city-scoped)
//   6. Cancellations   (CancelHeatmap with full-slate + recent-cancel row markers)
//   7. Match P&L       (SlateMatchPnLSection scoped to selected city)
// Defaults to Austin + current Monday. Local state; no URL persistence.
// Action items used to live mid-page here; replaced by the shared
// FinanceActions section that renders above every non-Cash-Flow tab.
function SlateReviewTabContent() {
  const [selectedCity, setSelectedCity] = useState<City>("Austin");
  const [weekStart, setWeekStart] = useState<string>(() => {
    const mon = getMonday(new Date());
    const y = mon.getFullYear();
    const m = String(mon.getMonth() + 1).padStart(2, "0");
    const d = String(mon.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  });
  return (
    <div className="space-y-4">
      <SlateReviewCityPills value={selectedCity} onChange={setSelectedCity} />
      <CollapsibleSection title="Last 8 weeks">
        <SlateReviewEightWeekChart city={selectedCity} />
      </CollapsibleSection>
      <CollapsibleSection title="Field Ranking">
        <FieldRankingTable city={selectedCity} costScope="realized" />
      </CollapsibleSection>
      <CollapsibleSection title="Master Schedule">
        <CitiesMasterScheduleLens
          city={selectedCity}
          weekStart={weekStart}
          onWeekStartChange={setWeekStart}
        />
      </CollapsibleSection>
      <CollapsibleSection title="Cancel patterns">
        <CancelPatterns city={selectedCity} />
      </CollapsibleSection>
      <CollapsibleSection title="Cancellations">
        <SlateReviewCancelSection city={selectedCity} />
      </CollapsibleSection>
      <CollapsibleSection title="Match P&L">
        <SlateMatchPnLSection city={selectedCity} />
      </CollapsibleSection>
    </div>
  );
}

function SlateReviewCityPills({
  value,
  onChange,
}: {
  value: City;
  onChange: (next: City) => void;
}) {
  return (
    <section
      className="sticky top-14 z-20 -mx-4 border-y border-cream-line bg-cream-soft/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-cream-soft/80 sm:-mx-6 sm:px-6"
      aria-label="City selector"
    >
      <div
        role="radiogroup"
        aria-label="Selected city"
        className="scrollbar-hide flex flex-nowrap items-center gap-1.5 overflow-x-auto"
      >
        {CITIES.map((c) => {
          const active = c === value;
          return (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(c)}
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition ${
                active
                  ? "bg-deep-green text-cream"
                  : "border border-deep-green/20 bg-transparent text-deep-green/70 hover:bg-cream-soft"
              }`}
            >
              {c}
            </button>
          );
        })}
      </div>
    </section>
  );
}

// Wraps CancelHeatmap with a Slate-Review-only mode toggle.
// "Cancelled only" (default) is the original CancelHeatmap behavior:
// only slots with at least one cancellation in the window. "All
// matches" expands to every recurring slot with cancellations
// rendered inline alongside played matches. highlightRecentCancels
// stays on in both modes so the row marker keeps surfacing recently-
// cancelled slots regardless of filter. The CancelHeatmap usages on
// /cities/[city] and /cities?tab=cancellations don't get this toggle —
// it's a Slate Review affordance only.
function SlateReviewCancelSection({ city }: { city: City }) {
  const [showAllSlots, setShowAllSlots] = useState(false);
  return (
    <div>
      <div className="mb-3 flex justify-end">
        <div
          className="inline-flex rounded-full border border-cream-line bg-cream-soft p-0.5 text-xs font-bold"
          role="radiogroup"
          aria-label="Cancellation view"
        >
          {(["all", "cancelled"] as const).map((opt) => {
            const active =
              (opt === "all" && showAllSlots) ||
              (opt === "cancelled" && !showAllSlots);
            return (
              <button
                key={opt}
                type="button"
                onClick={() => setShowAllSlots(opt === "all")}
                aria-pressed={active}
                className={`rounded-full px-3 py-1.5 transition ${
                  active
                    ? "bg-mint text-deep-green"
                    : "text-deep-green/65 hover:text-deep-green"
                }`}
              >
                {opt === "all" ? "All matches" : "Cancelled only"}
              </button>
            );
          })}
        </div>
      </div>
      <CancelHeatmap
        city={city}
        showAllSlots={showAllSlots}
        highlightRecentCancels
      />
    </div>
  );
}

function SlateReviewEightWeekChart({ city }: { city: City }) {
  // Same call pattern as CityDetailView (12-week pull, last 8 rendered).
  // Cache shared with /cities/[city] so this hook is effectively free
  // after the user visits either surface.
  const { rows, scheduledMatches, loading } = useMatchWindowData(12, city);
  const weekly = useMemo(
    () => getWeeklySpots(rows, scheduledMatches, city, 8),
    [rows, scheduledMatches, city],
  );
  return (
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10">
      <h2 className="mb-4 text-2xl font-bold tracking-tight text-deep-green">
        Last 8 weeks
      </h2>
      {loading && weekly.length === 0 ? (
        <div className="text-sm text-deep-green/60">Loading…</div>
      ) : (
        <TotalsBarChart weeks={weekly} />
      )}
    </section>
  );
}
