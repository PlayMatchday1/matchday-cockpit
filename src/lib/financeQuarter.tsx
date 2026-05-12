"use client";

// Active-quarter context for the Finance page. Provider at the page
// level passes the currently-selected quarter; any descendant
// component can read it via useFinanceQuarter().
//
// Wave 2 ships the provider + selector + URL state only — no
// component reads from this yet. Wave 3 migrates each consumer
// from Q2-hardcoded helpers to quarter-aware versions and starts
// calling useFinanceQuarter() where the helper signature now
// expects a QuarterInfo argument.

import { createContext, useContext } from "react";
import { getCurrentQuarter, type QuarterInfo } from "./quarters";

const FinanceQuarterContext = createContext<QuarterInfo | null>(null);

export function FinanceQuarterProvider({
  quarter,
  children,
}: {
  quarter: QuarterInfo;
  children: React.ReactNode;
}) {
  return (
    <FinanceQuarterContext.Provider value={quarter}>
      {children}
    </FinanceQuarterContext.Provider>
  );
}

// Returns the active quarter. Falls back to getCurrentQuarter() when
// called outside the provider — keeps secondary surfaces (e.g.
// /managers, /cities) that import a Finance component for a one-off
// embed from crashing. Inside the Finance tree the provider always
// wraps so the fallback is only a safety net.
export function useFinanceQuarter(): QuarterInfo {
  const ctx = useContext(FinanceQuarterContext);
  return ctx ?? getCurrentQuarter();
}
