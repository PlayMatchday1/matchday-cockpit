"use client";

// THE PERIOD, AND THE ONE `now` EVERY SECTION SHARES.
//
// WHY `now` LIVES HERE. There is no server-side date on the finance path — no /api/finance, the
// data comes straight from Supabase in the browser, and until now every section minted its own
// `new Date()`. Independent clocks are fine to the millisecond and wrong across a midnight
// boundary: the partial chip could read "17 of 31" while a realized-cost figure beside it had
// already rolled to the 18th. One instant, provided once, removes that class of disagreement.
//
// The quarter context is still fed from here — fifteen components read useFinanceQuarter() and
// expect three months. They get the quarter CONTAINING the period, so they behave exactly as they
// did while the sections that understand periods read this one.

import { createContext, useContext } from "react";
import type { FinancePeriod } from "./financePeriod";

export type FinancePeriodCtx = {
  period: FinancePeriod;
  now: Date;
  setPeriod: (p: FinancePeriod) => void;
};

const Ctx = createContext<FinancePeriodCtx | null>(null);

export const FinancePeriodProvider = Ctx.Provider;

export function useFinancePeriod(): FinancePeriodCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useFinancePeriod must be used inside the Finance shell");
  return c;
}
