"use client";

import { useState } from "react";
import type { ArppPoint, GrowthData } from "@/lib/growthAnalytics";
import styles from "./growth.module.css";
import { fmtInt, fmtMoney, fmtPct, monthLabel } from "./format";

// PART 4 + PART 5 form fix: ARPP is a TABLE (the design's arppSummary + detail),
// not a chart. Monthly only (DECISION 2): numerator = fin_revenue net that month;
// denominator = players who PLAYED that month ∪ members ACTIVE that month —
// members are billed on the 1st regardless of play. No YoY / per-year cells: no
// 2025 revenue exists. Field-level ARPP is not offered — the revenue ledger is
// not keyed to fields, only cities.
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
  const periodNet = withData.reduce((a, p) => a + p.net, 0);

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Average revenue per player</div>
          <div className={styles.cardSub}>
            Monthly. Numerator = net revenue that month; denominator = players who played that month plus members active
            that month. Selected month compared with the previous month.
          </div>
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="arppView">
            View
          </label>
          <select id="arppView" className={styles.control} value={view} onChange={(e) => setView(e.target.value)}>
            <option value="General">General (Matchday)</option>
            {cityKeys.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* summary table: current vs previous month + MoM */}
      <div className={styles.tableWrap}>
        <table className={styles.dataTable}>
          <thead>
            <tr>
              <th>View</th>
              <th>{cur ? monthLabel(cur.m) : "Current"}</th>
              <th>{prev ? monthLabel(prev.m) : "Previous"}</th>
              <th>MoM</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{view}</td>
              <td>
                {cur ? fmtMoney(cur.arpp, 2) : "—"}
                {cur?.m === currentMonth ? " °" : ""}
              </td>
              <td>{prev ? fmtMoney(prev.arpp, 2) : "—"}</td>
              <td>
                {mom == null ? (
                  "—"
                ) : (
                  <span className={mom >= 0 ? styles.statusPos : styles.statusNeg}>
                    {mom >= 0 ? "▲" : "▼"} {fmtPct(Math.abs(mom))}
                  </span>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* monthly detail: numerator, denominator and its split */}
      <div className={styles.tableWrap} style={{ marginTop: 14 }}>
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
        ° current month in progress — its denominator already includes every active member while play is only part-way
        through, so ARPP will settle upward. Net revenue for this view totals {fmtMoney(periodNet)} across the shown
        months. Same-month-last-year is not shown: no 2025 revenue exists.
      </div>
    </div>
  );
}
