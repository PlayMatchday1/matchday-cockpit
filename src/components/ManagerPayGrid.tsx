"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { logChange } from "@/lib/financeAudit";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import {
  refetchFinanceData,
  useFinanceData,
  type FinExpense,
} from "@/lib/useFinanceData";

const CITIES = [
  "Austin",
  "Dallas",
  "Houston",
  "San Antonio",
  "Atlanta",
  "St. Louis",
  "OKC",
  "El Paso",
] as const;

const QUARTERS = ["Q1 2026", "Q2 2026", "Q3 2026"] as const;
type Quarter = (typeof QUARTERS)[number];

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

function generateThursdays(quarter: Quarter): Thursday[] {
  const m = quarter.match(/^Q(\d)\s+(\d{4})$/);
  if (!m) return [];
  const q = parseInt(m[1], 10);
  const year = parseInt(m[2], 10);
  const startMonth = (q - 1) * 3;
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

type CellState = {
  value: string;
  saving: boolean;
  error: string | null;
  flash: boolean;
};

const CATEGORY = "Match Manager Pay";
const VENDOR = "Weekly payroll";

export default function ManagerPayGrid() {
  const { data, loading } = useFinanceData();
  const { appUser } = useAuth();

  const [quarter, setQuarter] = useState<Quarter>("Q2 2026");
  const [editing, setEditing] = useState<Map<string, CellState>>(new Map());

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

  function getDisplayValue(city: string, date: string): number {
    const key = `${city}|${date}`;
    const local = editing.get(key);
    if (local && !local.saving && !local.error) {
      const n = Number(local.value);
      if (Number.isFinite(n)) return n;
    }
    return getStored(city, date);
  }

  async function saveCell(city: string, date: string, raw: string) {
    const email = appUser?.email;
    if (!email) {
      setCellState(city, date, {
        value: raw,
        saving: false,
        error: "Not signed in",
        flash: false,
      });
      return;
    }
    const trimmed = raw.trim();
    if (trimmed === "") {
      setCellState(city, date, {
        value: raw,
        saving: false,
        error: "Empty",
        flash: false,
      });
      return;
    }
    const num = Number(trimmed);
    if (!Number.isFinite(num) || num < 0) {
      setCellState(city, date, {
        value: raw,
        saving: false,
        error: "Bad number",
        flash: false,
      });
      return;
    }
    const existing = rowsByKey.get(`${city}|${date}`);
    if (existing && existing.amount === num) {
      // No-op edit; just clear local state.
      clearCellState(city, date);
      return;
    }

    setCellState(city, date, {
      value: raw,
      saving: true,
      error: null,
      flash: false,
    });

    try {
      const t = thursdays.find((x) => x.date === date);
      const monthLabel = t?.month ?? "";
      if (existing) {
        const before = { ...existing };
        const { data: updated, error } = await supabase
          .from("fin_expenses")
          .update({ amount: num })
          .eq("id", existing.id)
          .select()
          .single();
        if (error) throw new Error(error.message);
        await logChange({
          tableName: "fin_expenses",
          rowId: existing.id,
          action: "update",
          changedBy: email,
          before: before as unknown as Record<string, unknown>,
          after: updated as Record<string, unknown>,
          note: `Manager Pay edit · ${city} · ${date}`,
        });
      } else {
        const payload = {
          date,
          month: monthLabel,
          city,
          category: CATEGORY,
          vendor: VENDOR,
          amount: num,
          notes: `Weekly Thursday cash-out — week of ${date}`,
          manual_entry: true,
        };
        const { data: inserted, error } = await supabase
          .from("fin_expenses")
          .insert(payload)
          .select()
          .single();
        if (error) throw new Error(error.message);
        await logChange({
          tableName: "fin_expenses",
          rowId: (inserted as { id: number }).id,
          action: "insert",
          changedBy: email,
          after: inserted as Record<string, unknown>,
          note: `Manager Pay insert · ${city} · ${date}`,
        });
      }

      await refetchFinanceData();

      // Brief mint flash, then clear local state so the cell returns to the
      // refreshed stored value.
      setCellState(city, date, {
        value: raw,
        saving: false,
        error: null,
        flash: true,
      });
      window.setTimeout(() => clearCellState(city, date), 800);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setCellState(city, date, {
        value: raw,
        saving: false,
        error: msg,
        flash: false,
      });
    }
  }

  function setCellState(city: string, date: string, s: CellState) {
    setEditing((prev) => {
      const next = new Map(prev);
      next.set(`${city}|${date}`, s);
      return next;
    });
  }

  function clearCellState(city: string, date: string) {
    setEditing((prev) => {
      const next = new Map(prev);
      next.delete(`${city}|${date}`);
      return next;
    });
  }

  // Totals — recompute from getDisplayValue so live edits show before save.
  const totals = useMemo(() => {
    const cityMonth = new Map<string, Map<string, number>>(); // city → month → sum
    const cityQuarter = new Map<string, number>();
    const colTotals = new Map<string, number>(); // date → sum
    let grand = 0;
    for (const city of CITIES) {
      const monthMap = new Map<string, number>();
      let cityTotal = 0;
      for (const t of thursdays) {
        const v = getDisplayValue(city, t.date);
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
  }, [thursdays, rowsByKey, editing, monthsInQuarter]);

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
            Weekly Thursday cash-out per city. Edits sync to fin_expenses
            immediately and propagate to the city cards + Cash Flow.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-deep-green/55">
              Quarter
            </div>
            <select
              value={quarter}
              onChange={(e) => setQuarter(e.target.value as Quarter)}
              className="rounded-md border border-cream-line bg-cream-soft px-3 py-1.5 text-sm font-bold text-deep-green focus:border-deep-green focus:outline-none"
            >
              {QUARTERS.map((q) => (
                <option key={q} value={q}>
                  {q}
                </option>
              ))}
            </select>
          </label>
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
                    {quarter} Total
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
                      const key = `${city}|${t.date}`;
                      const state = editing.get(key) ?? null;
                      const stored = getStored(city, t.date);
                      const isCurrent = i === currentWeekIdx;
                      return (
                        <td
                          key={t.date}
                          className={`min-w-[96px] px-1.5 py-1.5 ${
                            isCurrent ? "bg-mint-soft/40" : ""
                          }`}
                        >
                          <CellInput
                            stored={stored}
                            state={state}
                            onSave={(v) => saveCell(city, t.date, v)}
                          />
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

function CellInput({
  stored,
  state,
  onSave,
}: {
  stored: number;
  state: CellState | null;
  onSave: (raw: string) => void;
}) {
  const [local, setLocal] = useState<string>(String(stored));

  // Reset local input when stored value changes (e.g. after refetch) and
  // we're not in the middle of an edit.
  useEffect(() => {
    if (!state) {
      setLocal(String(stored));
    }
  }, [stored, state]);

  const isZero = stored === 0 && !state;
  const showFlash = state?.flash;
  const showError = Boolean(state?.error);
  const showSaving = Boolean(state?.saving);

  return (
    <div
      className={`relative flex w-full items-center rounded-md ${
        showError
          ? "ring-2 ring-coral"
          : isZero
            ? "ring-1 ring-coral/40"
            : "ring-1 ring-cream-line"
      } ${showFlash ? "flash-mint" : ""}`}
    >
      <span className="pl-2 pr-0.5 text-xs text-deep-green/50">$</span>
      <input
        type="number"
        min="0"
        step="1"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          if (local !== String(stored)) onSave(local);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            (e.currentTarget as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            setLocal(String(stored));
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        disabled={showSaving}
        className="w-full bg-transparent py-2 pr-6 text-right font-mono text-sm tabular-nums text-deep-green focus:outline-none disabled:opacity-60"
      />
      {showSaving && (
        <span className="absolute right-2 top-1/2 inline-block h-2 w-2 -translate-y-1/2 animate-pulse rounded-full bg-deep-green/50" />
      )}
      {showError && (
        <span
          title={state?.error ?? ""}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-bold text-coral"
        >
          !
        </span>
      )}
    </div>
  );
}
