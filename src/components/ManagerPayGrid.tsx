"use client";

// Read-only Manager Pay grid.
//
// Numbers are computed by /managers and persisted into fin_expenses
// by the daily recompute step in /api/sync/cron (see
// src/lib/managerPayCompute.ts:recomputeManagerPayIntoFinExpenses).
// This grid just reads those rows back out of fin_expenses; it does
// not edit them.
//
// Pre-cutover rows (pay-date < MANAGER_PAY_CUTOVER_PAY_DATE) stay
// frozen as the existing manual Thursday rows — the recompute never
// touches them. Post-cutover pay lands on Tuesdays; the grid generates
// cutover-aware columns so both regimes render side by side. Adjustments
// to individual managers ("Additional Pay") are edited on /managers and
// feed into the next computed total.

import { useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { useFinanceQuarter } from "@/lib/financeQuarter";
import type { QuarterInfo } from "@/lib/quarters";
import { useFinanceData, type FinExpense } from "@/lib/useFinanceData";
import { MANAGER_PAY_CUTOVER_PAY_DATE } from "@/lib/managerPayCompute";
import { VISIBLE_CITIES } from "@/lib/types";

// Forward-facing grid — hidden cities (e.g. paused markets) are excluded
// via VISIBLE_CITIES. Historical pay data is unaffected (it's data-driven).
const CITIES = VISIBLE_CITIES;

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

type PayColumn = {
  date: string; // YYYY-MM-DD
  month: string; // "Apr 2026"
  monthIdx: number; // 3 = Apr
  label: string; // "Apr 2"
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function isoLocal(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// The Monday of the first recomputed work week. The cutover pay date is
// the Tuesday of that week (Mon + 8), so back off 8 days. Work weeks whose
// Monday is before this stay on the frozen Thursday pay date (Mon + 10);
// from here forward pay moves to Tuesday (Mon + 8).
const CUTOVER_MONDAY: Date = (() => {
  const [y, m, d] = MANAGER_PAY_CUTOVER_PAY_DATE.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 8);
  return dt;
})();

// The pay date for a work-week Monday: Tuesday (Mon + 8) once the week is
// at/after cutover, Thursday (Mon + 10) for the frozen pre-cutover history.
// Keeps both regimes' columns aligned to the dates actually stored in
// fin_expenses, so the grid renders frozen Thursdays and computed Tuesdays
// side by side.
function payDateForMonday(monday: Date): Date {
  const offset = monday.getTime() < CUTOVER_MONDAY.getTime() ? 10 : 8;
  const pay = new Date(monday);
  pay.setDate(pay.getDate() + offset);
  return pay;
}

// One pay-date column per work week whose pay date falls in the displayed
// quarter, oldest first. Walks Mondays with a 2-week buffer on each side so
// no boundary week is missed.
function generatePayColumns(quarter: QuarterInfo): PayColumn[] {
  const year = quarter.year;
  const startMonth = (quarter.quarter - 1) * 3;
  const endMonth = startMonth + 2;

  // Start two weeks before the quarter's first month, on a Monday.
  const cursor = new Date(year, startMonth, 1);
  const dow = cursor.getDay(); // 0=Sun..6=Sat
  cursor.setDate(cursor.getDate() - ((dow + 6) % 7) - 14); // back to Monday, -2wk
  const limit = new Date(year, endMonth + 1, 1);
  limit.setDate(limit.getDate() + 14);

  const out: PayColumn[] = [];
  for (
    const mon = new Date(cursor);
    mon.getTime() < limit.getTime();
    mon.setDate(mon.getDate() + 7)
  ) {
    const pay = payDateForMonday(mon);
    if (pay.getFullYear() !== year) continue;
    const mi = pay.getMonth();
    if (mi < startMonth || mi > endMonth) continue;
    out.push({
      date: isoLocal(pay),
      month: `${MONTH_LABELS[mi]} ${year}`,
      monthIdx: mi,
      label: `${MONTH_LABELS[mi]} ${pay.getDate()}`,
    });
  }
  return out;
}

function fmtMoney(n: number): string {
  if (n === 0) return "—";
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

// Index of the column whose date is the pay date of the work week that
// closed for the calendar week containing `now`. That work week is the one
// starting last Monday (this Monday − 7); its pay lands this week (Tuesday
// now, Thursday for any pre-cutover week). Returns -1 if not in the quarter.
function findCurrentWeekColumnIndex(cols: PayColumn[], now: Date): number {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dow = today.getDay();
  const daysToMon = dow === 0 ? 6 : dow - 1;
  const thisMonday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - daysToMon,
  );
  const workWeekMonday = new Date(thisMonday);
  workWeekMonday.setDate(workWeekMonday.getDate() - 7);
  const target = isoLocal(payDateForMonday(workWeekMonday));
  return cols.findIndex((t) => t.date === target);
}

const CATEGORY = "Match Manager Pay";

export default function ManagerPayGrid() {
  const { data, loading } = useFinanceData();
  const quarter = useFinanceQuarter();

  const payCols = useMemo(() => generatePayColumns(quarter), [quarter]);
  const currentWeekIdx = useMemo(
    () => findCurrentWeekColumnIndex(payCols, new Date()),
    [payCols],
  );
  const currentHeaderRef = useRef<HTMLTableCellElement>(null);

  // Bring the current-week column into view on mount + on quarter
  // change. inline:"center" scrolls the parent overflow-x container
  // horizontally; block:"nearest" avoids vertical jump.
  useEffect(() => {
    if (currentWeekIdx === -1 || !currentHeaderRef.current) return;
    currentHeaderRef.current.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "center",
    });
  }, [currentWeekIdx]);

  const monthsInQuarter = useMemo(() => {
    const set = new Set<string>();
    for (const t of payCols) set.add(t.month);
    return [...set];
  }, [payCols]);

  const rowsByKey = useMemo(() => {
    const map = new Map<string, FinExpense>();
    if (!data) return map;
    for (const r of data.expenses) {
      if (r.category !== CATEGORY) continue;
      map.set(`${r.city}|${r.date}`, r);
    }
    return map;
  }, [data]);

  function getStored(city: string, date: string): number {
    const row = rowsByKey.get(`${city}|${date}`);
    return row?.amount ?? 0;
  }

  const totals = useMemo(() => {
    const cityMonth = new Map<string, Map<string, number>>(); // city → month → sum
    const cityQuarter = new Map<string, number>();
    const colTotals = new Map<string, number>(); // date → sum
    let grand = 0;
    for (const city of CITIES) {
      const monthMap = new Map<string, number>();
      let cityTotal = 0;
      for (const t of payCols) {
        const v = getStored(city, t.date);
        monthMap.set(t.month, (monthMap.get(t.month) ?? 0) + v);
        cityTotal += v;
        colTotals.set(t.date, (colTotals.get(t.date) ?? 0) + v);
        grand += v;
      }
      cityMonth.set(city, monthMap);
      cityQuarter.set(city, cityTotal);
    }
    const monthGrand = new Map<string, number>();
    for (const m of monthsInQuarter) {
      let s = 0;
      for (const city of CITIES) {
        s += cityMonth.get(city)?.get(m) ?? 0;
      }
      monthGrand.set(m, s);
    }
    return { cityMonth, cityQuarter, colTotals, monthGrand, grand };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payCols, rowsByKey, monthsInQuarter]);

  return (
    <>
      <div className="mb-6 text-sm">
        <Link
          href="/admin/finance"
          className="text-deep-green/60 transition hover:text-deep-green"
        >
          ← Back to Finance
        </Link>
      </div>

      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-5xl uppercase leading-none tracking-tight text-deep-green md:text-6xl">
            Manager Pay
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-deep-green/65">
            Computed from{" "}
            <Link
              href="/managers"
              className="font-bold text-deep-green underline-offset-2 hover:underline"
            >
              /managers
            </Link>
            . One row per (city, pay-date Tuesday), refreshed by the daily
            sync. Edit Additional Pay on /managers — it flows into the next
            recompute.
          </p>
        </div>
        {/* Quarter selector lives on the Finance page header — this
            grid reads the active quarter from FinanceQuarter context
            and re-renders when it changes. No internal selector here. */}
        <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-deep-green/55">
          Quarter ·{" "}
          <span className="text-deep-green">{quarter.label}</span>
        </div>
      </div>

      {loading && !data ? (
        <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
          Loading manager pay data…
        </div>
      ) : (
        <section className="overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-deep-green text-cream">
                <tr>
                  <th className="sticky left-0 z-10 bg-deep-green px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wider">
                    City
                  </th>
                  {payCols.map((t, i) => {
                    const isCurrent = i === currentWeekIdx;
                    return (
                      <th
                        key={t.date}
                        ref={isCurrent ? currentHeaderRef : undefined}
                        className={`min-w-[96px] whitespace-nowrap px-3 py-2 text-center text-[11px] font-bold uppercase tracking-wider ${
                          isCurrent ? "bg-mint text-deep-green" : ""
                        }`}
                      >
                        {t.label}
                        {isCurrent && (
                          <div className="mt-0.5 text-[8px] font-bold tracking-[0.18em] text-deep-green/75">
                            THIS WEEK
                          </div>
                        )}
                      </th>
                    );
                  })}
                  {monthsInQuarter.map((m) => (
                    <th
                      key={m}
                      className="whitespace-nowrap bg-mint-soft px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wider text-deep-green"
                    >
                      {m.replace(" 2026", "")} Total
                    </th>
                  ))}
                  <th className="whitespace-nowrap bg-mint px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wider text-deep-green">
                    {quarter.label} Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {CITIES.map((city) => (
                  <tr
                    key={city}
                    className="border-t border-cream-line/40 hover:bg-cream-soft/50"
                  >
                    <td className="sticky left-0 z-10 bg-white px-3 py-2 font-bold text-deep-green">
                      {city}
                    </td>
                    {payCols.map((t, i) => {
                      const stored = getStored(city, t.date);
                      const isCurrent = i === currentWeekIdx;
                      return (
                        <td
                          key={t.date}
                          className={`min-w-[96px] px-3 py-2 text-right font-mono tabular-nums text-deep-green ${
                            stored === 0 ? "text-deep-green/40" : ""
                          } ${isCurrent ? "bg-mint-soft/40" : ""}`}
                        >
                          {fmtMoney(stored)}
                        </td>
                      );
                    })}
                    {monthsInQuarter.map((m) => {
                      const v = totals.cityMonth.get(city)?.get(m) ?? 0;
                      return (
                        <td
                          key={m}
                          className="bg-mint-soft/60 px-3 py-2 text-right font-mono font-bold tabular-nums text-deep-green"
                        >
                          {fmtMoney(v)}
                        </td>
                      );
                    })}
                    <td className="bg-mint/60 px-3 py-2 text-right font-mono font-bold tabular-nums text-deep-green">
                      {fmtMoney(totals.cityQuarter.get(city) ?? 0)}
                    </td>
                  </tr>
                ))}
                <tr className="border-t-2 border-deep-green/30 bg-cream-soft">
                  <td className="sticky left-0 z-10 bg-cream-soft px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-deep-green/65">
                    Grand Total
                  </td>
                  {payCols.map((t, i) => {
                    const isCurrent = i === currentWeekIdx;
                    return (
                      <td
                        key={t.date}
                        className={`px-2 py-2 text-center font-mono font-bold tabular-nums text-deep-green ${
                          isCurrent ? "bg-mint-soft/60" : ""
                        }`}
                      >
                        {fmtMoney(totals.colTotals.get(t.date) ?? 0)}
                      </td>
                    );
                  })}
                  {monthsInQuarter.map((m) => (
                    <td
                      key={m}
                      className="bg-mint-soft px-3 py-2 text-right font-mono font-bold tabular-nums text-deep-green"
                    >
                      {fmtMoney(totals.monthGrand.get(m) ?? 0)}
                    </td>
                  ))}
                  <td className="bg-mint px-3 py-2 text-right font-mono font-bold tabular-nums text-deep-green">
                    {fmtMoney(totals.grand)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
