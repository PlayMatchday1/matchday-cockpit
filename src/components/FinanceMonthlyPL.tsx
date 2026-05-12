"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useFinanceData } from "@/lib/useFinanceData";
import { useFinanceQuarter } from "@/lib/financeQuarter";
import {
  type Mode,
  type Q2Month,
  distinctCitiesFromRevenue,
  distinctExpenseCategories,
  feesFor,
  grossRevenueFor,
  managerPayFor,
  monthlyExpenseCategoryFor,
  netPLFor,
  netRevenueByCityFor,
  netRevenueFor,
  otherExpensesByCategoryFor,
  startingCash,
  totalExpensesFor,
} from "@/lib/financeStats";
import { fieldCostsFor } from "@/lib/financeCosts";
import { isCurrentMonth, isCurrentQuarter, isFutureMonth } from "@/lib/quarters";

const DELETED_ACCOUNT_CITY = "Deleted Account Revenue";

function fmt(n: number): string {
  const r = Math.round(n);
  if (r === 0) return "—";
  return r.toLocaleString("en-US");
}

// Color treatment matches the per-city P&L cards: revenue is mint, costs/
// deductions are coral, signed totals (Net P&L, Ending Cash) flip color
// with sign, and zero-or-dash entries fall back to the muted deep-green
// the dashboard uses for inactive cells.
type Tone = "revenue" | "expense" | "signed" | "neutral";

function toneClass(n: number, tone: Tone, bold = false): string {
  const weight = bold ? "font-bold" : "";
  if (Math.round(n) === 0) return `${weight} text-deep-green/45`;
  switch (tone) {
    case "revenue":
      return `${weight} ${n < 0 ? "text-coral" : "text-mint-hover"}`;
    case "expense":
      return `${weight} ${n < 0 ? "text-mint-hover" : "text-coral"}`;
    case "signed":
      return `${weight} ${n < 0 ? "text-coral" : "text-mint-hover"}`;
    case "neutral":
      return `${weight} text-deep-green`;
  }
}

type RowKind =
  | "section"
  | "data"
  | "memo"
  | "subtotal"
  | "totalExpenses"
  | "startingCash"
  | "netPL"
  | "endingCash"
  | "divider";

type Row = {
  kind: RowKind;
  label?: string;
  values?: number[];
  tone?: Tone;
};

// Forces "Deleted Account Revenue" to the bottom of the city list so it
// reads as a separate bucket below the real markets, not as just another
// city sandwiched alphabetically between Austin and Dallas.
function sortCitiesForDisplay(cities: string[]): string[] {
  const realCities = cities.filter((c) => c !== DELETED_ACCOUNT_CITY).sort();
  const hasDeleted = cities.includes(DELETED_ACCOUNT_CITY);
  return hasDeleted ? [...realCities, DELETED_ACCOUNT_CITY] : realCities;
}

export default function FinanceMonthlyPL({
  collapsed = false,
  onToggle,
}: {
  collapsed?: boolean;
  onToggle?: () => void;
} = {}) {
  const { data, loading, error } = useFinanceData();
  const quarter = useFinanceQuarter();
  const monthKeys = useMemo(
    () => quarter.months.map((m) => m.key),
    [quarter],
  );
  // Past quarters lock to MTD/realized — projection-mode extrapolation
  // is meaningless once every month in the window is closed.
  const isPastQuarter = !isCurrentQuarter(quarter, new Date());
  const [mode, setMode] = useState<Mode>("mtd");
  const effectiveMode: Mode = isPastQuarter ? "mtd" : mode;

  const rows = useMemo<Row[]>(() => {
    if (!data) return [];

    const cities = sortCitiesForDisplay(
      distinctCitiesFromRevenue(data, quarter),
    );
    const otherCats = distinctExpenseCategories(data, quarter, effectiveMode);
    const start = startingCash(data, quarter);

    const sumAcross = (perMonth: number[]) =>
      perMonth.reduce((s, n) => s + n, 0);

    const cityRows: Row[] = cities.map((city) => {
      const perMonth = monthKeys.map(
        (m) => netRevenueByCityFor(data, m, effectiveMode).get(city) ?? 0,
      );
      return {
        kind: "data",
        label: city,
        tone: "revenue",
        values: [...perMonth, sumAcross(perMonth)],
      };
    });

    const grossPerMonth = monthKeys.map((m) => grossRevenueFor(data, m, effectiveMode));
    const feesPerMonth = monthKeys.map((m) => feesFor(data, m, effectiveMode));
    const netRevPerMonth = monthKeys.map((m) => netRevenueFor(data, m, effectiveMode));

    const matchPayPerMonth = monthKeys.map((m) => managerPayFor(data, m));
    const fieldCostsPerMonth = monthKeys.map((m) => fieldCostsFor(data, m));
    const cityMgrPerMonth = monthKeys.map((m) =>
      monthlyExpenseCategoryFor(data, m, "city_manager"),
    );
    const marketingPerMonth = monthKeys.map((m) =>
      monthlyExpenseCategoryFor(data, m, "marketing"),
    );
    const equipmentPerMonth = monthKeys.map((m) =>
      monthlyExpenseCategoryFor(data, m, "equipment"),
    );

    const otherCatRows: Row[] = otherCats.map((cat) => {
      const perMonth = monthKeys.map(
        (m) => otherExpensesByCategoryFor(data, m, effectiveMode).get(cat) ?? 0,
      );
      return {
        kind: "data",
        label: cat,
        tone: "expense",
        values: [...perMonth, sumAcross(perMonth)],
      };
    });

    const totalExpPerMonth = monthKeys.map((m) =>
      totalExpensesFor(data, m, effectiveMode),
    );
    const netPLPerMonth = monthKeys.map((m) => netPLFor(data, m, effectiveMode));

    const endingCash: number[] = [];
    let runningCash = start;
    for (let i = 0; i < monthKeys.length; i++) {
      runningCash += netPLPerMonth[i];
      endingCash.push(runningCash);
    }

    return [
      { kind: "section", label: "Revenue by city" },
      ...cityRows,
      {
        kind: "memo",
        label: "Gross Revenue",
        tone: "revenue",
        values: [...grossPerMonth, sumAcross(grossPerMonth)],
      },
      {
        kind: "memo",
        label: "Stripe Fees",
        tone: "expense",
        values: [...feesPerMonth, sumAcross(feesPerMonth)],
      },
      {
        kind: "subtotal",
        label: "Net Revenue",
        tone: "revenue",
        values: [...netRevPerMonth, sumAcross(netRevPerMonth)],
      },
      { kind: "divider" },
      { kind: "section", label: "Expenses" },
      {
        kind: "data",
        label: "Match Manager Pay",
        tone: "expense",
        values: [...matchPayPerMonth, sumAcross(matchPayPerMonth)],
      },
      {
        kind: "data",
        label: "Field Costs",
        tone: "expense",
        values: [...fieldCostsPerMonth, sumAcross(fieldCostsPerMonth)],
      },
      {
        kind: "data",
        label: "City Manager",
        tone: "expense",
        values: [...cityMgrPerMonth, sumAcross(cityMgrPerMonth)],
      },
      {
        kind: "data",
        label: "Marketing",
        tone: "expense",
        values: [...marketingPerMonth, sumAcross(marketingPerMonth)],
      },
      {
        kind: "data",
        label: "Equipment",
        tone: "expense",
        values: [...equipmentPerMonth, sumAcross(equipmentPerMonth)],
      },
      ...otherCatRows,
      {
        kind: "totalExpenses",
        label: "Total Expenses",
        tone: "expense",
        values: [...totalExpPerMonth, sumAcross(totalExpPerMonth)],
      },
      { kind: "divider" },
      {
        kind: "startingCash",
        label: "Starting Cash",
        tone: "neutral",
        // First month gets the starting balance, middle months 0,
        // total column repeats the starting balance.
        values: [
          start,
          ...monthKeys.slice(1).map(() => 0),
          start,
        ],
      },
      {
        kind: "netPL",
        label: "Net P&L",
        tone: "signed",
        values: [...netPLPerMonth, sumAcross(netPLPerMonth)],
      },
      {
        kind: "endingCash",
        label: "Ending Cash",
        tone: "signed",
        values: [...endingCash, endingCash[endingCash.length - 1]],
      },
    ];
  }, [data, effectiveMode, monthKeys]);

  // Per-column projection markers — used to (a) tag every cell in a fully-
  // projected month with " (proj)" and (b) tint that column's background.
  // Q2 Total (index 3) is mixed by definition in projection mode (Apr
  // realized + extrapolation; May/Jun pure projection) so it isn't tagged
  // here.
  const now = useMemo(() => new Date(), []);
  const projectionFlags = useMemo(
    () =>
      quarter.months.map((m) => ({
        month: m.key,
        isFuture: isFutureMonth(m, now),
        isCurrent: isCurrentMonth(m, now),
      })),
    [quarter, now],
  );
  const colIsProjected = (colIdx: number): boolean => {
    if (effectiveMode !== "projection") return false;
    if (colIdx >= quarter.months.length) return false; // total column
    return projectionFlags[colIdx].isFuture;
  };
  const colIsMixed = (colIdx: number): boolean => {
    if (effectiveMode !== "projection") return false;
    if (colIdx >= quarter.months.length) return false;
    return projectionFlags[colIdx].isCurrent;
  };

  if (loading) {
    return (
      <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
        Loading…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-2xl border border-coral/40 bg-coral-soft p-6 text-sm text-coral">
        {error}
      </div>
    );
  }
  if (!data) return null;

  const headerInteractive = Boolean(onToggle);

  return (
    <div className="rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
      <div
        className={`flex flex-wrap items-center justify-between gap-3 px-5 py-4 ${
          headerInteractive
            ? "cursor-pointer rounded-t-2xl hover:bg-cream-soft/40"
            : ""
        }`}
        onClick={headerInteractive ? onToggle : undefined}
        role={headerInteractive ? "button" : undefined}
        aria-expanded={headerInteractive ? !collapsed : undefined}
      >
        <div className="flex items-start gap-2">
          {headerInteractive &&
            (collapsed ? (
              <ChevronRight
                size={20}
                aria-hidden
                className="mt-1.5 shrink-0 text-deep-green/55"
              />
            ) : (
              <ChevronDown
                size={20}
                aria-hidden
                className="mt-1.5 shrink-0 text-deep-green/55"
              />
            ))}
          <div>
            <h2 className="font-display text-3xl uppercase tracking-tight text-deep-green md:text-4xl">
              Monthly Cash Flow
            </h2>
            {isPastQuarter ? (
              <p className="text-xs text-deep-green/60">
                Realized · closed quarter
              </p>
            ) : effectiveMode === "mtd" ? (
              <p className="text-xs text-deep-green/60">
                Realized rows only · through today
              </p>
            ) : (
              <p className="mt-0.5 inline-flex items-center gap-1.5 rounded-md bg-gold-soft px-2 py-0.5 text-xs font-bold text-deep-green ring-1 ring-inset ring-gold/40">
                Projection mode · current month DPP extrapolated · future
                months use projections
              </p>
            )}
          </div>
        </div>
        {!isPastQuarter && (
          <div onClick={(e) => e.stopPropagation()}>
            <ModeToggle mode={mode} onChange={setMode} />
          </div>
        )}
      </div>

      {!collapsed && (
        <div className="overflow-x-auto">
          <table className="w-full font-mono text-sm">
            <thead>
              <tr className="border-y border-cream-line bg-cream-soft text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
                <th className="px-5 py-2.5 text-left">Item</th>
                {quarter.months.map((m, idx) => {
                  const projected = colIsProjected(idx);
                  const mixed = colIsMixed(idx);
                  return (
                    <th
                      key={m.key}
                      className={`px-3 py-2.5 text-right ${
                        projected
                          ? "bg-gold-soft/60 text-deep-green/75"
                          : ""
                      }`}
                    >
                      {m.shortName}
                      {mixed && (
                        <span className="ml-1 font-normal normal-case text-deep-green/50">
                          (mixed)
                        </span>
                      )}
                      {projected && (
                        <span className="ml-1 font-normal normal-case text-deep-green/55">
                          (proj)
                        </span>
                      )}
                    </th>
                  );
                })}
                <th className="px-3 py-2.5 text-right">{quarter.label} Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <PLRow
                  key={i}
                  row={row}
                  colIsProjected={colIsProjected}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ModeToggle({
  mode,
  onChange,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
}) {
  return (
    <div className="inline-flex rounded-full bg-cream-soft p-1 ring-1 ring-cream-line">
      <button
        type="button"
        onClick={() => onChange("mtd")}
        className={`rounded-full px-4 py-1 text-xs font-bold transition ${
          mode === "mtd"
            ? "bg-mint text-deep-green shadow-sm"
            : "text-deep-green/60 hover:text-deep-green"
        }`}
      >
        MTD
      </button>
      <button
        type="button"
        onClick={() => onChange("projection")}
        className={`rounded-full px-4 py-1 text-xs font-bold transition ${
          mode === "projection"
            ? "bg-mint text-deep-green shadow-sm"
            : "text-deep-green/60 hover:text-deep-green"
        }`}
      >
        Projection
      </button>
    </div>
  );
}

type CellMeta = { projected: boolean };
function ProjTag() {
  return (
    <span className="ml-1 text-[10px] font-normal text-deep-green/45">
      (proj)
    </span>
  );
}
function colTint(meta: CellMeta): string {
  return meta.projected ? "bg-gold-soft/40" : "";
}

function PLRow({
  row,
  colIsProjected,
}: {
  row: Row;
  colIsProjected: (colIdx: number) => boolean;
}) {
  if (row.kind === "section") {
    return (
      <tr className="border-t border-cream-line/60">
        <td
          colSpan={5}
          className="px-5 pb-1 pt-4 text-[10px] font-bold uppercase tracking-wider text-deep-green/55"
        >
          {row.label}
        </td>
      </tr>
    );
  }

  if (row.kind === "divider") {
    return (
      <tr>
        <td colSpan={5} className="h-3 border-t border-cream-line/60" />
      </tr>
    );
  }

  const values = row.values ?? [];
  const tone: Tone = row.tone ?? "neutral";

  if (row.kind === "memo") {
    return (
      <tr>
        <td className="px-5 py-1.5 pl-9 text-xs italic text-deep-green/65">
          {row.label}
        </td>
        {values.map((v, i) => {
          const meta: CellMeta = { projected: colIsProjected(i) };
          return (
            <td
              key={i}
              className={`px-3 py-1.5 text-right text-xs italic tabular-nums ${toneClass(v, tone)} ${colTint(meta)}`}
            >
              {fmt(v)}
              {meta.projected && Math.round(v) !== 0 && <ProjTag />}
            </td>
          );
        })}
      </tr>
    );
  }

  if (row.kind === "subtotal") {
    return (
      <tr className="border-t border-cream-line/40 bg-cream-soft/40">
        <td className="px-5 py-2 text-sm font-bold text-deep-green">
          {row.label}
        </td>
        {values.map((v, i) => {
          const meta: CellMeta = { projected: colIsProjected(i) };
          return (
            <td
              key={i}
              className={`px-3 py-2 text-right tabular-nums ${toneClass(v, tone, true)} ${colTint(meta)}`}
            >
              {fmt(v)}
              {meta.projected && Math.round(v) !== 0 && <ProjTag />}
            </td>
          );
        })}
      </tr>
    );
  }

  if (row.kind === "totalExpenses") {
    return (
      <tr className="border-t border-cream-line/40 bg-coral-soft/30">
        <td className="px-5 py-2 text-sm font-bold text-coral">{row.label}</td>
        {values.map((v, i) => {
          const meta: CellMeta = { projected: colIsProjected(i) };
          return (
            <td
              key={i}
              className={`px-3 py-2 text-right font-bold tabular-nums ${toneClass(v, tone, true)} ${colTint(meta)}`}
            >
              {fmt(v)}
              {meta.projected && Math.round(v) !== 0 && <ProjTag />}
            </td>
          );
        })}
      </tr>
    );
  }

  if (row.kind === "startingCash") {
    return (
      <tr>
        <td className="px-5 py-2 text-sm font-bold text-deep-green/70">
          {row.label}
        </td>
        {values.map((v, i) => {
          const meta: CellMeta = { projected: colIsProjected(i) };
          return (
            <td
              key={i}
              className={`px-3 py-2 text-right font-semibold tabular-nums text-deep-green/70 ${colTint(meta)}`}
            >
              {v === 0 ? "" : `$${fmt(v)}`}
            </td>
          );
        })}
      </tr>
    );
  }

  if (row.kind === "netPL") {
    return (
      <tr className="bg-cream-soft/40">
        <td className="px-5 py-2 text-sm font-bold text-deep-green">
          {row.label}
        </td>
        {values.map((v, i) => {
          const meta: CellMeta = { projected: colIsProjected(i) };
          return (
            <td
              key={i}
              className={`px-3 py-2 text-right tabular-nums ${toneClass(v, tone, true)} ${colTint(meta)}`}
            >
              {fmt(v)}
              {meta.projected && Math.round(v) !== 0 && <ProjTag />}
            </td>
          );
        })}
      </tr>
    );
  }

  if (row.kind === "endingCash") {
    return (
      <tr className="border-t-2 border-deep-green/30 bg-mint-soft/40">
        <td className="px-5 py-2.5 text-sm font-bold text-deep-green">
          {row.label}
        </td>
        {values.map((v, i) => {
          const meta: CellMeta = { projected: colIsProjected(i) };
          return (
            <td
              key={i}
              className={`px-3 py-2.5 text-right font-bold tabular-nums ${toneClass(v, tone, true)} ${colTint(meta)}`}
            >
              ${fmt(v)}
              {meta.projected && <ProjTag />}
            </td>
          );
        })}
      </tr>
    );
  }

  // data row
  return (
    <tr className="border-t border-cream-line/30">
      <td className="px-5 py-1.5 pl-9 text-sm text-deep-green/85">
        {row.label}
      </td>
      {values.map((v, i) => {
        const meta: CellMeta = { projected: colIsProjected(i) };
        return (
          <td
            key={i}
            className={`px-3 py-1.5 text-right tabular-nums ${toneClass(v, tone)} ${colTint(meta)}`}
          >
            {fmt(v)}
            {meta.projected && Math.round(v) !== 0 && <ProjTag />}
          </td>
        );
      })}
    </tr>
  );
}
