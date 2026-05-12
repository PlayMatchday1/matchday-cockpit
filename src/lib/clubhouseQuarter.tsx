"use client";

// Active-quarter context for the Clubhouse page. Provider at the page
// level passes the currently-selected quarter; Goals / Topics tabs
// (and their consumers) read it via useClubhouseQuarter().
//
// Pattern mirrors financeQuarter.tsx — two contexts rather than one
// shared so each page tree owns its own URL state without
// accidentally cross-coupling (e.g. selecting Q3 on /clubhouse must
// not change what /finance shows when the user navigates over).

import { createContext, useContext } from "react";
import { getCurrentQuarter, type QuarterInfo } from "./quarters";

const ClubhouseQuarterContext = createContext<QuarterInfo | null>(null);

export function ClubhouseQuarterProvider({
  quarter,
  children,
}: {
  quarter: QuarterInfo;
  children: React.ReactNode;
}) {
  return (
    <ClubhouseQuarterContext.Provider value={quarter}>
      {children}
    </ClubhouseQuarterContext.Provider>
  );
}

// Returns the active quarter. Falls back to getCurrentQuarter() when
// called outside the provider, so any embedded use of a Clubhouse
// component on another route doesn't crash.
export function useClubhouseQuarter(): QuarterInfo {
  const ctx = useContext(ClubhouseQuarterContext);
  return ctx ?? getCurrentQuarter();
}
