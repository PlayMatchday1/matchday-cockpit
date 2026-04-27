"use client";

import { useEffect, useMemo, useState } from "react";
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

// Q2 2026 seed CSV. Used by the "Seed Q2 2026 from CSV" button below — it
// DELETEs existing Match Manager Pay rows for Apr/May/Jun 2026 then bulk-
// inserts these 104 rows. Idempotent: safe to re-run whenever the CSV is
// the canonical source.
const Q2_2026_SEED_AMOUNTS: Record<string, number[]> = {
  Austin: [980, 870, 910, 910, 900, 980, 870, 910, 910, 980, 870, 910, 910],
  Dallas: [130, 110, 170, 170, 170, 130, 110, 170, 170, 130, 110, 170, 170],
  Houston: [440, 380, 390, 370, 370, 440, 380, 390, 370, 440, 380, 390, 370],
  "San Antonio": [
    340, 340, 320, 320, 280, 340, 340, 320, 320, 340, 340, 320, 320,
  ],
  Atlanta: [60, 60, 80, 120, 120, 60, 60, 80, 120, 60, 60, 80, 120],
  "St. Louis": [120, 120, 100, 70, 120, 120, 120, 100, 70, 120, 120, 100, 70],
  OKC: [120, 120, 120, 120, 40, 120, 120, 120, 120, 120, 120, 120, 120],
  "El Paso": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
};

const Q2_2026_THURSDAYS_ISO = [
  "2026-04-02",
  "2026-04-09",
  "2026-04-16",
  "2026-04-23",
  "2026-04-30",
  "2026-05-07",
  "2026-05-14",
  "2026-05-21",
  "2026-05-28",
  "2026-06-04",
  "2026-06-11",
  "2026-06-18",
  "2026-06-25",
];

const Q2_2026_MONTHS = ["Apr 2026", "May 2026", "Jun 2026"];

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
  const [seedingState, setSeedingState] = useState<{
    running: boolean;
    message: string | null;
    error: string | null;
  }>({ running: false, message: null, error: null });

  const thursdays = useMemo(() => generateThursdays(quarter), [quarter]);

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

  async function seedQ2() {
    if (
      !window.confirm(
        "Replace ALL Match Manager Pay rows for Apr–Jun 2026 with the CSV seed?\n\n" +
          "This deletes any existing Q2 2026 Match Manager Pay rows in fin_expenses, " +
          "then inserts 104 weekly rows (8 cities × 13 Thursdays).\n\n" +
          "Run once. Re-running is safe — it always overwrites Q2.",
      )
    ) {
      return;
    }
    setSeedingState({ running: true, message: "Clearing Q2 rows…", error: null });
    try {
      const { error: delErr } = await supabase
        .from("fin_expenses")
        .delete()
        .eq("category", CATEGORY)
        .in("month", Q2_2026_MONTHS);
      if (delErr) throw new Error(`Delete failed: ${delErr.message}`);

      const payload: Array<{
        date: string;
        month: string;
        city: string;
        category: string;
        vendor: string;
        amount: number;
        notes: string;
        manual_entry: boolean;
      }> = [];
      for (const [city, amounts] of Object.entries(Q2_2026_SEED_AMOUNTS)) {
        for (let i = 0; i < Q2_2026_THURSDAYS_ISO.length; i++) {
          const date = Q2_2026_THURSDAYS_ISO[i];
          const monthIdx = parseInt(date.slice(5, 7), 10) - 1;
          const monthLabel = `${MONTH_LABELS[monthIdx]} 2026`;
          payload.push({
            date,
            month: monthLabel,
            city,
            category: CATEGORY,
            vendor: VENDOR,
            amount: amounts[i],
            notes: `Weekly Thursday cash-out — week of ${date}`,
            manual_entry: true,
          });
        }
      }

      setSeedingState({
        running: true,
        message: `Inserting ${payload.length} rows…`,
        error: null,
      });
      const { error: insErr } = await supabase
        .from("fin_expenses")
        .insert(payload);
      if (insErr) throw new Error(`Insert failed: ${insErr.message}`);

      await refetchFinanceData();
      setSeedingState({
        running: false,
        message: `✓ Seeded ${payload.length} rows. Verify Apr totals: Austin 4570, Houston 1950, Dallas 750, San Antonio 1600, Atlanta 440, St. Louis 530, OKC 520, El Paso 0.`,
        error: null,
      });
    } catch (e) {
      setSeedingState({
        running: false,
        message: null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
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
          <button
            type="button"
            onClick={seedQ2}
            disabled={seedingState.running}
            className="rounded-full border border-cream-line bg-white px-4 py-2 text-xs font-bold text-deep-green hover:bg-cream-soft disabled:opacity-50"
            title="One-time: clears Q2 2026 Match Manager Pay rows and inserts the CSV seed (104 rows)."
          >
            {seedingState.running ? "Seeding…" : "Seed Q2 2026 from CSV"}
          </button>
        </div>
      </div>

      {seedingState.message && !seedingState.error && (
        <div
          className={`mb-4 rounded-md border px-3 py-2 text-xs ${
            seedingState.running
              ? "border-cream-line bg-cream-soft text-deep-green"
              : "border-mint/40 bg-mint-soft text-deep-green"
          }`}
        >
          {seedingState.message}
        </div>
      )}
      {seedingState.error && (
        <div className="mb-4 rounded-md border border-coral/40 bg-coral-soft/40 px-3 py-2 text-xs text-coral">
          {seedingState.error}
        </div>
      )}

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
                  {thursdays.map((t) => (
                    <th
                      key={t.date}
                      className="min-w-[96px] whitespace-nowrap px-3 py-2.5 text-center text-[11px] font-bold uppercase tracking-wider"
                    >
                      {t.label}
                    </th>
                  ))}
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
                    {thursdays.map((t) => {
                      const key = `${city}|${t.date}`;
                      const state = editing.get(key) ?? null;
                      const stored = getStored(city, t.date);
                      return (
                        <td key={t.date} className="min-w-[96px] px-1.5 py-1.5">
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
                  {thursdays.map((t) => (
                    <td
                      key={t.date}
                      className="px-2 py-2 text-center font-mono font-bold tabular-nums text-deep-green"
                    >
                      {fmtMoney(totals.colTotals.get(t.date) ?? 0)}
                    </td>
                  ))}
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
