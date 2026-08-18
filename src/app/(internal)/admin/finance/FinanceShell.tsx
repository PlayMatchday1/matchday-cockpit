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
import FinanceExecHero from "@/components/FinanceExecHero";
import FinancePeriodBar from "@/components/finance/FinancePeriodBar";
import { FinancePeriodProvider } from "@/lib/financePeriodContext";
import {
  changeGrain, containingQuarter, currentPeriod, periodFromUrl, stepPeriod,
  type FinancePeriod, type Grain,
} from "@/lib/financePeriod";
import { FinanceQuarterProvider } from "@/lib/financeQuarter";
import { FINANCE_SECTIONS, SECTION_GRAINS } from "./financeSections";

const COLLAPSE_KEY = "finance:rail-collapsed";
// Which Configure sub-tab was last open, so leaving Configure and coming back lands where you
// were instead of resetting to Revenue. Session-scoped — carried over verbatim from the old page.
const LAST_CONFIGURE_KEY = "finance:lastConfigureSubTab";




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






  // === THE PERIOD. One control, three grains, ?p= in the URL. ===
  //
  // ONE `now` FOR THE WHOLE SUBTREE. There is no server date on this path, and every section used
  // to mint its own `new Date()`. Minting it once here is what lets the partial chip and the
  // realized-cost figures beside it agree about which day it is.
  const now = useMemo(() => new Date(), []);
  const period = useMemo<FinancePeriod>(
    () => periodFromUrl(searchParams?.get("p") ?? null, now),
    [searchParams, now],
  );
  const setPeriod = useCallback(
    (p: FinancePeriod) => {
      const qs = new URLSearchParams(searchParams?.toString() ?? "");
      // The default (current month) drops the param, so the clean URL is the common case.
      if (p.key === currentPeriod("month", now).key && p.grain === "month") qs.delete("p");
      else qs.set("p", p.key);
      const s = qs.toString();
      router.replace(s ? `?${s}` : "?");
    },
    [router, searchParams, now],
  );
  // The quarter CONTAINING the period, for the fifteen components that still read
  // useFinanceQuarter() and expect three months. They keep behaving exactly as before.
  const quarter = useMemo(() => containingQuarter(period), [period]);

  const grainSupport = SECTION_GRAINS[pathname] ?? { grains: ["month", "quarter", "year"] as const, why: "" };
  // If the section cannot render the current grain, fall back to one it can rather than showing a
  // window it will silently ignore.
  const shownPeriod = grainSupport.grains.includes(period.grain)
    ? period
    : changeGrain(period, grainSupport.grains[0], now);

  const railW = collapsed ? "60px" : "212px";

  return (
    <FinancePeriodProvider value={{ period: shownPeriod, now, setPeriod }}>
    <FinanceQuarterProvider quarter={quarter}>
      <div className="fixed left-0 z-30 hidden lg:block"
        style={{
          top: "calc(env(safe-area-inset-top, 0px) + var(--nav-h))",
          height: "calc(100dvh - env(safe-area-inset-top, 0px) - var(--nav-h))",
          width: railW, transition: "width .18s ease-out",
        }}>
        <ChatsRail collapsed={collapsed} onToggle={toggle} items={FINANCE_SECTIONS} showSwitch={false} label="Finance" />
      </div>
      <div
        style={{ "--mo-rail-w": railW } as React.CSSProperties}
        className="lg:pl-[var(--mo-rail-w)] max-[899px]:w-screen max-[899px]:ml-[calc(50%-50vw)]"
      >
        <MatchOpsMobileBar items={FINANCE_SECTIONS} sheetTitle="Finance" showSwitch={false} />

        <h1 data-testid="finance-title" className="font-display text-5xl uppercase leading-none tracking-tight text-deep-green md:text-6xl">
          Finance
        </h1>

        {/* ONE control, THREE grains, read by every section. The Configure / Check-Ins / Managers
            links ride in this bar rather than a strip of their own — they were already a quiet
            right-aligned row, and the bar is where the page-level controls now live. */}
        <FinancePeriodBar
          period={shownPeriod}
          now={now}
          supportedGrains={grainSupport.grains}
          unsupportedReason={grainSupport.why}
          onChangeGrain={(g: Grain) => setPeriod(changeGrain(shownPeriod, g, now))}
          onStep={(dir) => setPeriod(stepPeriod(shownPeriod, dir, now))}
          onJumpToNow={() => setPeriod(currentPeriod(shownPeriod.grain, now))}
          links={null}
        />

        {/* The exec banner is Cash-Flow context (quarter P&L, current-month gross, MTD vs prior).
            It stayed with that tab before the split and stays with that route now. */}
        {pathname === "/admin/finance/cash-flow" && (
          <div className="mb-8"><FinanceExecHero /></div>
        )}

        {children}
      </div>
    </FinanceQuarterProvider>
    </FinancePeriodProvider>
  );
}

