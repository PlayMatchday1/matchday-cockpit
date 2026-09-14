"use client";

// ONE APP BAR, FED BY WHICHEVER SECTION IS ON SCREEN.
//
// ══ WHY THIS EXISTS ══════════════════════════════════════════════════════════════════════════
// Ryan, from a phone: "On mobile alot of the pages have this big massive space. They all should
// have the same shared hamburger view with no extra space up top."
//
// The space was the iOS notch inset being paid TWICE. AuthGate's <main> paid
// max(env(safe-area-inset-top), 26px), and MatchOpsMobileBar — which lived INSIDE that main — paid
// var(--sat) again. On a Dynamic Island phone that is 59 + 59 before the bar's own 44px band, so
// the bar landed below a band of dead cream exactly its own height.
//
// The cause was that five section shells each rendered their own bar, each written as though it
// were the top of the screen. It is not; the shell is. So the shells stopped rendering a bar and
// started PUBLISHING their items here, and AuthGate renders one bar above <main>. The bar pays the
// inset. Nothing else does.
//
// ══ WHY THE BAR IS ON EVERY ROUTE ════════════════════════════════════════════════════════════
// Because that is what makes <main>'s top padding zero UNCONDITIONALLY below the rail breakpoint.
// Padding that depends on whether this particular route happens to mount a bar is the bug we
// already had, spelled differently — and it is how the next page added to the app gets it wrong.
// A route with no sibling screens still gets a bar: its own name, no chevron, not a button.

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { RailItem } from "@/app/(internal)/match-ops/sections";

/** What a section publishes: the screens inside it, and what to call the section. */
export type SectionNav = {
  items: RailItem[];
  label: string;
  /** Match Ops shows the tier switch; every other section suppresses it. */
  showSwitch: boolean;
};

/** What a PAGE publishes: its own right-hand controls and status mark, through the same one bar. */
export type PageChrome = {
  actions?: React.ReactNode;
  leading?: React.ReactNode;
  /** Overrides the title the items would derive. Gameday Ops uses it. */
  title?: string;
};

type Ctx = {
  nav: SectionNav | null;
  chrome: PageChrome;
  setNav: (v: SectionNav | null) => void;
  setChrome: (v: PageChrome) => void;
};

const SectionNavCtx = createContext<Ctx | null>(null);

export function SectionNavProvider({ children }: { children: React.ReactNode }) {
  const [nav, setNav] = useState<SectionNav | null>(null);
  const [chrome, setChrome] = useState<PageChrome>({});
  const value = useMemo(() => ({ nav, chrome, setNav, setChrome }), [nav, chrome]);
  return <SectionNavCtx.Provider value={value}>{children}</SectionNavCtx.Provider>;
}

/** Read by the bar. Returns nulls outside a provider so nothing explodes in a test harness. */
export function useSectionNavValue(): { nav: SectionNav | null; chrome: PageChrome } {
  const c = useContext(SectionNavCtx);
  return { nav: c?.nav ?? null, chrome: c?.chrome ?? {} };
}

/* ── PUBLISHING ───────────────────────────────────────────────────────────────────────────────
 * A section shell calls this instead of rendering a bar. The dependency is the ITEMS ARRAY
 * IDENTITY, so a shell that builds its list inline every render must memo it or this will loop.
 * Every caller here passes a module constant or a useMemo. */
export function useSectionNav(nav: SectionNav | null) {
  const c = useContext(SectionNavCtx);
  const setNav = c?.setNav;
  const items = nav?.items;
  const label = nav?.label;
  const showSwitch = nav?.showSwitch;
  useEffect(() => {
    if (!setNav) return;
    setNav(items ? { items, label: label ?? "", showSwitch: showSwitch ?? false } : null);
    /* CLEARED ON UNMOUNT so leaving a section cannot leave its screen list behind on the next
     * one — the bar would then offer Finance's pages from a Growth route. */
    return () => setNav(null);
  }, [setNav, items, label, showSwitch]);
}

/* ── A PAGE'S OWN SLOTS, THROUGH THE SAME SINGLE BAR ──────────────────────────────────────────
 * A FACTORY AND AN EXPLICIT DEPS ARRAY, not the nodes themselves. `actions` is JSX, so it is a new
 * object on every render; publishing it directly would set state every render, which re-renders,
 * which sets state again. The deps are the VALUES the slots are built from — Gameday's staleness
 * and refreshing flags — so the bar updates when they change and not otherwise. */
export function usePageChrome(make: () => PageChrome | null, deps: unknown[]) {
  const c = useContext(SectionNavCtx);
  const setChrome = c?.setChrome;
  useEffect(() => {
    if (!setChrome) return;
    setChrome(make() ?? {});
    return () => setChrome({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setChrome, ...deps]);
}
