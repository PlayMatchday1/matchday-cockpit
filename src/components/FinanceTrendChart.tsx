"use client";

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useFinanceData } from "@/lib/useFinanceData";
import { useFinanceQuarter } from "@/lib/financeQuarter";
import {
  netPLFor,
  netRevenueFor,
  totalExpensesFor,
} from "@/lib/financeStats";

function fmtAxis(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1000) return `$${Math.round(v / 1000)}K`;
  return `$${Math.round(v)}`;
}

function fmtTooltip(v: number): string {
  const abs = Math.abs(v);
  return `${v < 0 ? "-" : ""}$${Math.round(abs).toLocaleString("en-US")}`;
}

export default function FinanceTrendChart() {
  const { data, loading, error } = useFinanceData();
  const quarter = useFinanceQuarter();

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

  const chartData = quarter.months.map((m) => ({
    month: m.shortName,
    revenue: Math.round(netRevenueFor(data, m.key, "projection")),
    expenses: Math.round(totalExpensesFor(data, m.key, "projection")),
    netPL: Math.round(netPLFor(data, m.key, "projection")),
  }));

  return (
    <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="font-display text-3xl uppercase tracking-tight text-deep-green md:text-4xl">
            {quarter.label} Trend
          </h2>
          <p className="text-xs text-deep-green/60">
            Revenue + expenses by month · Net P&L line overlay · projected
          </p>
        </div>
      </div>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={chartData}
            margin={{ top: 8, right: 16, bottom: 0, left: 8 }}
          >
            <CartesianGrid stroke="#E6DEC9" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="month"
              tick={{ fill: "#003326", fontSize: 12, fontWeight: 600 }}
              axisLine={{ stroke: "#C2D1C9" }}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: "#003326", fontSize: 11, opacity: 0.7 }}
              tickFormatter={fmtAxis}
              axisLine={false}
              tickLine={false}
              width={56}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "#FFFFFF",
                border: "1.5px solid #E6DEC9",
                borderRadius: 12,
                fontFamily: "var(--font-geist-sans)",
                fontSize: 12,
              }}
              labelStyle={{ color: "#003326", fontWeight: 700 }}
              formatter={(value, name) => {
                const n =
                  typeof value === "number"
                    ? value
                    : Number(Array.isArray(value) ? value[0] : value);
                return [fmtTooltip(n), name];
              }}
            />
            <Legend
              verticalAlign="top"
              align="right"
              iconType="circle"
              wrapperStyle={{
                fontFamily: "var(--font-geist-sans)",
                fontSize: 12,
                paddingBottom: 12,
              }}
            />
            <Bar
              dataKey="revenue"
              name="Revenue"
              fill="#2CDB87"
              radius={[6, 6, 0, 0]}
            />
            <Bar
              dataKey="expenses"
              name="Expenses"
              fill="#FF6955"
              radius={[6, 6, 0, 0]}
            />
            <Line
              type="monotone"
              dataKey="netPL"
              name="Net P&L"
              stroke="#FFD700"
              strokeWidth={3}
              dot={{ fill: "#FFD700", stroke: "#003326", strokeWidth: 1.5, r: 5 }}
              activeDot={{ r: 7 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
