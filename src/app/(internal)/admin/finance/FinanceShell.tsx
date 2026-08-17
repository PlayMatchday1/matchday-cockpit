"use client";

// THE FINANCE SECTION SHELL — the app's own rail, six flat items, mounted exactly as Growth,
// Match Ops and /city mount theirs.
//
// WHAT MOVED. Finance was ONE page holding nine tab panels behind local state, lazy-mounted and
// hidden with display:none. Four of those panels were reachable from a pill row; the rest hung off
// a secondary nav. Nothing about the panels changes here — CityPnlTable, CashFlowTabContent,
// OpExCalendarView and FieldRankingTabContent are the same components, now reached by URL instead
// of by setState. Revenue and Cost are the two genuinely new sections.
//
// WHY THE QUARTER LIVES HERE. FinanceQuarterProvider wraps the whole subtree, so the quarter
// selector is one control serving every section and survives rail clicks — the layout does not
// remount between /admin/finance/* routes. On the old page the quarter was page state and could
// not have been anything else.
//
// CONFIGURE / CHECK-INS ARE AN OVERLAY, NOT A ROUTE. They were never section peers: they are
// admin surfaces reachable from wherever you happen to be, and they keep their own sub-tab memory.
// Modelling them as routes would have put them in the rail and made them look like a seventh and
// eighth section. So they render OVER the routed section and dismiss back to it, which is what the
// old in-page tab swap did — the same behaviour, minus the pretence that it was navigation.

import { createContext, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import ChatsRail from "../../match-ops/ChatsRail";
import MatchOpsMobileBar from "../../match-ops/MatchOpsMobileBar";
import QuarterSelector from "@/components/QuarterSelector";
import ChangeLogView from "@/components/ChangeLogView";
import CheckInsView from "@/components/CheckInsView";
import ExpenseAdminView from "@/components/ExpenseAdminView";
import FieldCostsView from "@/components/FieldCostsView";
import RevenueAdminView from "@/components/RevenueAdminView";
import FinanceExecHero from "@/components/FinanceExecHero";
import FinanceConfigureSubNav, {
  isConfigureSubTab,
  type ConfigureSubTabId,
} from "@/components/FinanceConfigureSubNav";
import FinanceSecondaryNav, { type SecondaryId } from "@/components/FinanceSecondaryNav";
import { FinanceQuarterProvider } from "@/lib/financeQuarter";
import {
  getAvailableQuarters,
  getCurrentQuarter,
  isPlanningQuarter,
  resolveQuarterFromUrl,
  type QuarterInfo,
} from "@/lib/quarters";
import { FINANCE_SECTIONS } from "./financeSections";

const COLLAPSE_KEY = "finance:rail-collapsed";
// Which Configure sub-tab was last open, so leaving Configure and coming back lands where you
// were instead of resetting to Revenue. Session-scoped — carried over verbatim from the old page.
const LAST_CONFIGURE_KEY = "finance:lastConfigureSubTab";

// The overlay is either a Configure sub-tab or Check-Ins. `null` means the routed section shows.
type Overlay = ConfigureSubTabId | "check-ins" | null;

// OpEx Calendar's "add an expense" affordance used to be `selectTab("expenses")` on the old page.
// The Expenses editor is a Configure surface, not a section, so a routed section reaches it the
// only way it still can: by asking the shell to open the overlay.
const OverlayCtx = createContext<{ openExpenses: () => void } | null>(null);
export function useFinanceOverlay(): { openExpenses: () => void } {
  return useContext(OverlayCtx) ?? { openExpenses: () => {} };
}

function getLastConfigureSubTab(): ConfigureSubTabId {
  if (typeof window === "undefined") return "revenue";
  const v = window.sessionStorage.getItem(LAST_CONFIGURE_KEY);
  return v && isConfigureSubTab(v) ? v : "revenue";
}

export default function FinanceShell({ children }: { children: React.ReactNode }) {
  return (
    <PagePermissionGuard page="finance">
      <Suspense fallback={null}>
        <FinanceShellInner>{children}</FinanceShellInner>
      </Suspense>
    </PagePermissionGuard>
  );
}

function FinanceShellInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const searchParams = useSearchParams();

  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try { setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1"); } catch { /* private mode */ }
  }, []);
  const toggle = () =>
    setCollapsed((prev) => {
      const next = !prev;
      try { window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0"); } catch { /* private mode */ }
      return next;
    });

  const [overlay, setOverlay] = useState<Overlay>(null);

  // Remember the last Configure sub-tab. Same key, same session scope as before the split.
  useEffect(() => {
    if (overlay && overlay !== "check-ins" && typeof window !== "undefined") {
      window.sessionStorage.setItem(LAST_CONFIGURE_KEY, overlay);
    }
  }, [overlay]);

  // Child views render `<Link href="/admin/finance">← Back to Finance</Link>`. That href now
  // redirects to /admin/finance/cities, which would throw you off whichever section you opened
  // Configure from. Intercept it and just close the overlay — "back to Finance" means "leave this
  // admin surface", not "go to Cities".
  const overlayRef = useRef<Overlay>(overlay);
  overlayRef.current = overlay;
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (overlayRef.current === null) return;
      const hit = (e.target as Element | null)?.closest?.('a[href="/admin/finance"]');
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      setOverlay(null);
    }
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  // Leaving a section closes any open overlay, so a rail click always shows the section you asked
  // for rather than the admin surface you left open on the previous one.
  useEffect(() => { setOverlay(null); }, [pathname]);

  function openSecondary(s: SecondaryId) {
    if (s === "configure") setOverlay(getLastConfigureSubTab());
    else if (s === "managers") router.push("/managers");
    else setOverlay("check-ins");
  }

  // === Quarter selector + URL state. Moved verbatim from the old page. ===
  const availableQuarters = useMemo(() => getAvailableQuarters(), []);
  const quarter = useMemo<QuarterInfo>(
    () => resolveQuarterFromUrl(searchParams?.get("q") ?? null, new Date()),
    [searchParams],
  );
  const handleQuarterChange = useCallback(
    (key: string) => {
      const qs = new URLSearchParams(searchParams?.toString() ?? "");
      if (key === getCurrentQuarter().key) qs.delete("q");
      else qs.set("q", key);
      const s = qs.toString();
      router.replace(s ? `?${s}` : "?");
    },
    [router, searchParams],
  );
  const planning = isPlanningQuarter(quarter, new Date());
  const openExpenses = useMemo(() => ({ openExpenses: () => setOverlay("expenses") }), []);

  const railW = collapsed ? "60px" : "212px";
  const secondary: SecondaryId | null =
    overlay === null ? null : overlay === "check-ins" ? "check-ins" : "configure";

  return (
    <FinanceQuarterProvider quarter={quarter}>
      <div className="fixed left-0 z-30 hidden lg:block"
        style={{
          top: "calc(env(safe-area-inset-top, 0px) + 4rem)",
          height: "calc(100dvh - env(safe-area-inset-top, 0px) - 4rem)",
          width: railW, transition: "width .18s ease-out",
        }}>
        <ChatsRail collapsed={collapsed} onToggle={toggle} items={FINANCE_SECTIONS} showSwitch={false} label="Finance" />
      </div>
      <div
        style={{ "--mo-rail-w": railW } as React.CSSProperties}
        className="lg:pl-[var(--mo-rail-w)] max-[899px]:w-screen max-[899px]:ml-[calc(50%-50vw)]"
      >
        <MatchOpsMobileBar items={FINANCE_SECTIONS} sheetTitle="Finance" showSwitch={false} />

        <div className="mb-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div>
            <h1 data-testid="finance-title" className="font-display text-5xl uppercase leading-none tracking-tight text-deep-green md:text-6xl">
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
            <span className="font-bold text-deep-green">{quarter.label}</span> · Planning quarter —
            actuals will populate as the quarter begins. Enter expenses, revenue projections, and
            starting cash now to forecast.
          </div>
        )}

        <FinanceSecondaryNav active={secondary} onChange={openSecondary} />

        {secondary === "configure" && (
          <FinanceConfigureSubNav
            value={overlay && overlay !== "check-ins" ? overlay : "revenue"}
            onChange={(id) => setOverlay(id)}
          />
        )}

        {/* The exec banner is Cash-Flow context (quarter P&L, current-month gross, MTD vs prior).
            It stayed with that tab before the split and stays with that route now. */}
        {overlay === null && pathname === "/admin/finance/cash-flow" && (
          <div className="mb-8"><FinanceExecHero /></div>
        )}

        <OverlayCtx.Provider value={openExpenses}>
          {overlay === null ? children : <OverlayView overlay={overlay} />}
        </OverlayCtx.Provider>
      </div>
    </FinanceQuarterProvider>
  );
}

function OverlayView({ overlay }: { overlay: Exclude<Overlay, null> }) {
  if (overlay === "check-ins") return <CheckInsView />;
  if (overlay === "revenue") return <RevenueAdminView />;
  if (overlay === "expenses") return <ExpenseAdminView />;
  if (overlay === "field-costs") return <FieldCostsView />;
  return <ChangeLogView />;
}
