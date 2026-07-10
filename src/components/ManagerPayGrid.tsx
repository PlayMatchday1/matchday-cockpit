"use client";

// Read-only Manager Pay grid.
//
// Numbers are computed by /managers and persisted into fin_expenses
// by the daily recompute step in /api/sync/cron (see
// src/lib/managerPayCompute.ts:recomputeManagerPayIntoFinExpenses).
// This grid just reads those rows back out of fin_expenses; it does
// not edit them.
//
// Pre-cutover Thursdays (pay-date < MANAGER_PAY_CUTOVER_PAY_DATE)
// stay frozen as the existing manual rows — the recompute never
// touches them. Adjustments to individual managers ("Additional Pay")
// are edited on /managers and feed into the next computed total.

import { useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { useFinanceQuarter } from "@/lib/financeQuarter";
import type { QuarterInfo } from "@/lib/quarters";
import { useFinanceData, type FinExpense } from "@/lib/useFinanceData";
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

type Thursday = {
  date: string; // YYYY-MM-DD
  month: string; // "Apr 2026"
  monthIdx: number; // 3 = Apr
  label: string; // "Apr 2"
};

function generateThursdays(quarter: QuarterInfo): Thursday[] {
  const year = quarter.year;
  const startMonth = (quarter.quarter - 1) * 3;
  const out: Thursday[] = [];
  for (let mi = startMonth; mi < startMonth + 3; mi++) {
    const firstOfMonth = new Date(year, mi, 1);
    const dow = firstOfMonth.getDay(); // 0=Sun, 4=Thu
    const offset = (4 - dow + 7) % 7;
    let day = 1 + offset;
    while (true) {
      const d = new Date(year, mi, day);
      if (d.getMonth() !== mi) break;
      const mm = String(mi + 1).padStart(2, "0");
      const dd = String(day).padStart(2, "0");
      out.push({
        date: `${year}-${mm}-${dd}`,
        month: `${MONTH_LABELS[mi]} ${year}`,
        monthIdx: mi,
        label: `${MONTH_LABELS[mi]} ${day}`,
      });
      day += 7;
    }
  }
  return out;
}

function fmtMoney(n: number): string {
  if (n === 0) return "—";
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

// Index in `thursdays` of the column whose date is the Thursday of
// the ISO week containing `now` (Mon-Sun anchor — Thursday is Mon+3).
// Returns -1 if that Thursday isn't in the displayed quarter.
function findCurrentWeekThursdayIndex(
  thursdays: Thursday[],
  now: Date,
): number {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dow = today.getDay();
  const daysToMon = dow === 0 ? 6 : dow - 1;
  const monday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - daysToMon,
  );
  const thursday = new Date(
    monday.getFullYear(),
    monday.getMonth(),
    monday.getDate() + 3,
  );
  const yyyy = thursday.getFullYear();
  const mm = String(thursday.getMonth() + 1).padStart(2, "0");
  const dd = String(thursday.getDate()).padStart(2, "0");
  const target = `${yyyy}-${mm}-${dd}`;
  return thursdays.findIndex((t) => t.date === target);
}

const CATEGORY = "Match Manager Pay";

export default function ManagerPayGrid() {
  const { data, loading } = useFinanceData();
  const quarter = useFinanceQuarter();

  const thursdays = useMemo(() => generateThursdays(quarter), [quarter]);
  const currentWeekIdx = useMemo(
    () => findCurrentWeekThursdayIndex(thursdays, new Date()),
    [thursdays],
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
    for (const t of thursdays) set.add(t.month);
    return [...set];
  }, [thursdays]);

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
      for (const t of thursdays) {
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
  }, [thursdays, rowsByKey, monthsInQuarter]);

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
            . One row per (city, pay-date Thursday), refreshed by the daily
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
                  {thursdays.map((t, i) => {
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
                    {thursdays.map((t, i) => {
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
                  {thursdays.map((t, i) => {
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
