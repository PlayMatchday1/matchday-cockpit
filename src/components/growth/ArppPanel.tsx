"use client";

import { useMemo, useState } from "react";
import type { ArppPoint, GrowthData } from "@/lib/growthAnalytics";
import styles from "./growth.module.css";
import { LineChart } from "./charts";
import { fmtInt, fmtMoney, fmtPct, monthLabel, monthShort } from "./format";

// PART 4 + DECISION 2. Monthly ARPP only (a whole-period ARPP has a cumulative
// denominator and is meaningless — never rendered). numerator = fin_revenue net
// that month; denominator = players who PLAYED that month ∪ members ACTIVE that
// month, because members are billed on the 1st whether or not they play — so the
// denominator must cover them or ARPP spikes in months members sit out. YoY and
// per-year cells are GONE: no 2025 revenue exists, so there is nothing to compare
// to and no element is rendered where one would have been.
export default function ArppPanel({ data }: { data: GrowthData }) {
  const cityKeys = Object.keys(data.arppByCity)
    .filter((c) => data.arppByCity[c].some((p) => p.net > 0 || p.denom > 0))
    .sort();
  const [view, setView] = useState("General");
  const series: ArppPoint[] = view === "General" ? data.arppOverall : data.arppByCity[view] ?? [];
  const withData = series.filter((p) => p.denom > 0 || p.net > 0);
  const currentMonth = data.generatedAt.slice(0, 7);

  const cur = withData[withData.length - 1];
  const prev = withData[withData.length - 2];
  const mom = cur && prev && prev.arpp ? (cur.arpp - prev.arpp) / prev.arpp : null;
  const curPartial = cur?.m === currentMonth;

  const periodNet = useMemo(() => withData.reduce((a, p) => a + p.net, 0), [withData]);

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Average revenue per player</div>
          <div className={styles.cardSub}>
            Monthly. Numerator = net revenue that month; denominator = players who played that month plus members active
            that month.
          </div>
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="arppView">
            View
          </label>
          <select id="arppView" className={styles.control} value={view} onChange={(e) => setView(e.target.value)}>
            <option value="General">General (network)</option>
            {cityKeys.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      {cur && prev ? (
        <div className={styles.arppCompare}>
          <div className={styles.arppBox}>
            <div className={styles.arppBoxLabel}>
              {monthLabel(cur.m)}
              {curPartial ? " — month in progress" : ""}
            </div>
            <div className={styles.arppBoxValue}>{fmtMoney(cur.arpp, 2)}</div>
            {mom != null && (
              <span className={mom >= 0 ? styles.statusPos : styles.statusNeg}>
                {mom >= 0 ? "▲" : "▼"} {fmtPct(Math.abs(mom))} MoM
              </span>
            )}
          </div>
          <div className={styles.arppVs}>VS</div>
          <div className={styles.arppBox}>
            <div className={styles.arppBoxLabel}>{monthLabel(prev.m)}</div>
            <div className={styles.arppBoxValue}>{fmtMoney(prev.arpp, 2)}</div>
            <span className={styles.arppBoxLabel}>Previous month</span>
          </div>
        </div>
      ) : (
        <div className={styles.stateMsg}>No revenue for this view yet.</div>
      )}

      {curPartial && (
        <div className={styles.footnote}>
          The current month is still running, so its denominator already includes every active member (billed on the 1st)
          while play is only part-way through — the MoM figure will settle upward as the month completes.
        </div>
      )}

      <LineChart
        axis={withData.map((p) => p.m)}
        series={[{ label: "ARPP", color: "var(--accent)", values: withData.map((p) => p.arpp) }]}
        height={200}
        formatAxis={monthShort}
        formatValue={(v) => fmtMoney(v, 2)}
      />

      <div className={styles.tableWrap} style={{ marginTop: 12 }}>
        <table className={styles.dataTable}>
          <thead>
            <tr>
              <th>Month</th>
              <th>Net revenue</th>
              <th>Denominator</th>
              <th>Played only</th>
              <th>Subscribed only</th>
              <th>Both</th>
              <th>ARPP</th>
            </tr>
          </thead>
          <tbody>
            {withData.map((p) => (
              <tr key={p.m}>
                <td>
                  {monthLabel(p.m)}
                  {p.m === currentMonth ? " °" : ""}
                </td>
                <td>{fmtMoney(p.net)}</td>
                <td>{fmtInt(p.denom)}</td>
                <td>{fmtInt(p.playedOnly)}</td>
                <td>{fmtInt(p.subOnly)}</td>
                <td>{fmtInt(p.both)}</td>
                <td>{fmtMoney(p.arpp, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={styles.footnote}>
        ° current month in progress. Net revenue for this view totals {fmtMoney(periodNet)} across the shown months.
        Same-month-last-year is not shown: no 2025 revenue exists.
      </div>
    </div>
  );
}
