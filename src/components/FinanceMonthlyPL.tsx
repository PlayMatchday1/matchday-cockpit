"use client";

import { useMemo, useState } from "react";
import { useFinanceData } from "@/lib/useFinanceData";
import {
  Q2_MONTHS,
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

function fmt(n: number): string {
  const r = Math.round(n);
  if (r === 0) return "—";
  return r.toLocaleString("en-US");
}

function moneyClass(n: number, bold = false): string {
  const base = bold ? "font-bold" : "";
  if (Math.round(n) < 0) return `${base} text-coral`;
  return `${base} text-deep-green`;
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
};

export default function FinanceMonthlyPL() {
  const { data, loading, error } = useFinanceData();
  const [mode, setMode] = useState<Mode>("mtd");

  const rows = useMemo<Row[]>(() => {
    if (!data) return [];

    const cities = distinctCitiesFromRevenue(data);
    const otherCats = distinctExpenseCategories(data, mode);
    const start = startingCash(data);

    const sumAcross = (perMonth: number[]) =>
      perMonth.reduce((s, n) => s + n, 0);

    const cityRows: Row[] = cities.map((city) => {
      const perMonth = Q2_MONTHS.map(
        (m) => netRevenueByCityFor(data, m, mode).get(city) ?? 0,
      );
      return {
        kind: "data",
        label: city,
        values: [...perMonth, sumAcross(perMonth)],
      };
    });

    const grossPerMonth = Q2_MONTHS.map((m) => grossRevenueFor(data, m, mode));
    const feesPerMonth = Q2_MONTHS.map((m) => feesFor(data, m, mode));
    const netRevPerMonth = Q2_MONTHS.map((m) => netRevenueFor(data, m, mode));

    const matchPayPerMonth = Q2_MONTHS.map((m) => managerPayFor(data, m));
    const cityMgrPerMonth = Q2_MONTHS.map((m) =>
      monthlyExpenseCategoryFor(data, m, "city_manager"),
    );
    const marketingPerMonth = Q2_MONTHS.map((m) =>
      monthlyExpenseCategoryFor(data, m, "marketing"),
    );
    const equipmentPerMonth = Q2_MONTHS.map((m) =>
      monthlyExpenseCategoryFor(data, m, "equipment"),
    );

    const otherCatRows: Row[] = otherCats.map((cat) => {
      const perMonth = Q2_MONTHS.map(
        (m) => otherExpensesByCategoryFor(data, m, mode).get(cat) ?? 0,
      );
      return {
        kind: "data",
        label: cat,
        values: [...perMonth, sumAcross(perMonth)],
      };
    });

    const totalExpPerMonth = Q2_MONTHS.map((m) =>
      totalExpensesFor(data, m, mode),
    );
    const netPLPerMonth = Q2_MONTHS.map((m) => netPLFor(data, m, mode));

    const endingCash: number[] = [];
    let runningCash = start;
    for (let i = 0; i < Q2_MONTHS.length; i++) {
      runningCash += netPLPerMonth[i];
      endingCash.push(runningCash);
    }

    return [
      { kind: "section", label: "Revenue by city" },
      ...cityRows,
      {
        kind: "memo",
        label: "Gross Revenue",
        values: [...grossPerMonth, sumAcross(grossPerMonth)],
      },
      {
        kind: "memo",
        label: "Stripe Fees",
        values: [...feesPerMonth, sumAcross(feesPerMonth)],
      },
      {
        kind: "subtotal",
        label: "Net Revenue",
        values: [...netRevPerMonth, sumAcross(netRevPerMonth)],
      },
      { kind: "divider" },
      { kind: "section", label: "Expenses" },
      {
        kind: "data",
        label: "Match Manager Pay",
        values: [...matchPayPerMonth, sumAcross(matchPayPerMonth)],
      },
      {
        kind: "data",
        label: "City Manager",
        values: [...cityMgrPerMonth, sumAcross(cityMgrPerMonth)],
      },
      {
        kind: "data",
        label: "Marketing",
        values: [...marketingPerMonth, sumAcross(marketingPerMonth)],
      },
      {
        kind: "data",
        label: "Equipment",
        values: [...equipmentPerMonth, sumAcross(equipmentPerMonth)],
      },
      ...otherCatRows,
      {
        kind: "totalExpenses",
        label: "Total Expenses",
        values: [...totalExpPerMonth, sumAcross(totalExpPerMonth)],
      },
      { kind: "divider" },
      {
        kind: "startingCash",
        label: "Starting Cash",
        values: [start, 0, 0, start],
      },
      {
        kind: "netPL",
        label: "Net P&L",
        values: [...netPLPerMonth, sumAcross(netPLPerMonth)],
      },
      {
        kind: "endingCash",
        label: "Ending Cash",
        values: [...endingCash, endingCash[endingCash.length - 1]],
      },
    ];
  }, [data, mode]);

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

  return (
    <div className="rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div>
          <h2 className="font-display text-3xl uppercase tracking-tight text-deep-green md:text-4xl">
            Monthly Cash Flow
          </h2>
          <p className="text-xs text-deep-green/60">
            {mode === "mtd"
              ? "Realized rows only · through today"
              : "Current month DPP extrapolated · future months use projections"}
          </p>
        </div>
        <ModeToggle mode={mode} onChange={setMode} />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full font-mono text-sm">
          <thead>
            <tr className="border-y border-cream-line bg-cream-soft text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
              <th className="px-5 py-2.5 text-left">Item</th>
              <th className="px-3 py-2.5 text-right">Apr</th>
              <th className="px-3 py-2.5 text-right">May</th>
              <th className="px-3 py-2.5 text-right">Jun</th>
              <th className="px-3 py-2.5 text-right">Q2 Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <PLRow key={i} row={row} />
            ))}
          </tbody>
        </table>
      </div>
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

function PLRow({ row }: { row: Row }) {
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

  if (row.kind === "memo") {
    return (
      <tr>
        <td className="px-5 py-1.5 pl-9 text-xs italic text-deep-green/55">
          {row.label}
        </td>
        {values.map((v, i) => (
          <td
            key={i}
            className="px-3 py-1.5 text-right text-xs italic tabular-nums text-deep-green/55"
          >
            {fmt(v)}
          </td>
        ))}
      </tr>
    );
  }

  if (row.kind === "subtotal") {
    return (
      <tr className="border-t border-cream-line/40 bg-cream-soft/40">
        <td className="px-5 py-2 text-sm font-bold text-deep-green">
          {row.label}
        </td>
        {values.map((v, i) => (
          <td
            key={i}
            className={`px-3 py-2 text-right tabular-nums ${moneyClass(v, true)}`}
          >
            {fmt(v)}
          </td>
        ))}
      </tr>
    );
  }

  if (row.kind === "totalExpenses") {
    return (
      <tr className="border-t border-cream-line/40 bg-coral-soft/30">
        <td className="px-5 py-2 text-sm font-bold text-coral">{row.label}</td>
        {values.map((v, i) => (
          <td
            key={i}
            className="px-3 py-2 text-right font-bold tabular-nums text-coral"
          >
            {fmt(v)}
          </td>
        ))}
      </tr>
    );
  }

  if (row.kind === "startingCash") {
    return (
      <tr>
        <td className="px-5 py-2 text-sm font-bold text-deep-green/70">
          {row.label}
        </td>
        {values.map((v, i) => (
          <td
            key={i}
            className="px-3 py-2 text-right font-semibold tabular-nums text-deep-green/70"
          >
            {v === 0 ? "" : `$${fmt(v)}`}
          </td>
        ))}
      </tr>
    );
  }

  if (row.kind === "netPL") {
    return (
      <tr className="bg-cream-soft/40">
        <td className="px-5 py-2 text-sm font-bold text-deep-green">
          {row.label}
        </td>
        {values.map((v, i) => (
          <td
            key={i}
            className={`px-3 py-2 text-right tabular-nums ${moneyClass(v, true)}`}
          >
            {fmt(v)}
          </td>
        ))}
      </tr>
    );
  }

  if (row.kind === "endingCash") {
    return (
      <tr className="border-t-2 border-deep-green/30 bg-mint-soft/40">
        <td className="px-5 py-2.5 text-sm font-bold text-deep-green">
          {row.label}
        </td>
        {values.map((v, i) => (
          <td
            key={i}
            className="px-3 py-2.5 text-right font-bold tabular-nums text-deep-green"
          >
            ${fmt(v)}
          </td>
        ))}
      </tr>
    );
  }

  // data row
  return (
    <tr className="border-t border-cream-line/30">
      <td className="px-5 py-1.5 pl-9 text-sm text-deep-green/85">
        {row.label}
      </td>
      {values.map((v, i) => (
        <td
          key={i}
          className={`px-3 py-1.5 text-right tabular-nums ${moneyClass(v)}`}
        >
          {fmt(v)}
        </td>
      ))}
    </tr>
  );
}
