"use client";

import { useState } from "react";
import type { GrowthData } from "@/lib/growthAnalytics";
import styles from "./growth.module.css";
import { LineChart, type Series } from "./charts";
import { fmtPct } from "./format";

// PART 5: retention curve, primary city plus an optional comparison city, using
// the DECISION-3 attribution. Only observable offsets are plotted; the tail is
// short by construction (≤7 months of play history) and that is stated.
const NETWORK = "Network (all cities)";

export default function RetentionCurvePanel({ data }: { data: GrowthData }) {
  const cityKeys = data.cities.filter((c) => (data.retentionCurveByCity[c] ?? []).some((p) => p.observable));
  const [primary, setPrimary] = useState(NETWORK);
  const [compare, setCompare] = useState("none");

  const curveFor = (k: string) => (k === NETWORK ? data.retentionCurveOverall : data.retentionCurveByCity[k] ?? []);
  const primaryCurve = curveFor(primary).filter((p) => p.observable);
  const maxOffset = primaryCurve.length ? primaryCurve[primaryCurve.length - 1].offset : 0;
  const axis = Array.from({ length: maxOffset + 1 }, (_, i) => `M${i}`);

  const series: Series[] = [
    {
      label: primary,
      color: "var(--forest)",
      values: axis.map((_, o) => {
        const c = curveFor(primary).find((p) => p.offset === o);
        return c && c.observable ? c.pct * 100 : null;
      }),
    },
  ];
  if (compare !== "none") {
    series.push({
      label: compare,
      color: "var(--gold-dot)",
      values: axis.map((_, o) => {
        const c = curveFor(compare).find((p) => p.offset === o);
        return c && c.observable ? c.pct * 100 : null;
      }),
    });
  }

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Retention curve</div>
          <div className={styles.cardSub}>
            Share of a cohort still active this many months after their first match, pooled across 2026 cohorts.
          </div>
        </div>
        <div className={styles.controlsRow}>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="retPrimary">
              Primary
            </label>
            <select id="retPrimary" className={styles.control} value={primary} onChange={(e) => setPrimary(e.target.value)}>
              <option value={NETWORK}>{NETWORK}</option>
              {cityKeys.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="retCompare">
              Compare
            </label>
            <select id="retCompare" className={styles.control} value={compare} onChange={(e) => setCompare(e.target.value)}>
              <option value="none">None</option>
              <option value={NETWORK}>{NETWORK}</option>
              {cityKeys.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <LineChart axis={axis} series={series} height={220} step={64} formatValue={(v) => v.toFixed(1)} yUnit="%" />
      <div className={styles.legend}>
        {series.map((s) => (
          <span key={s.label} className={styles.legendItem}>
            <i className={styles.legendDot} style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>

      <div className={styles.tableWrap} style={{ marginTop: 10 }}>
        <table className={styles.dataTable}>
          <thead>
            <tr>
              <th>Series</th>
              {axis.map((a) => (
                <th key={a}>{a}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {series.map((s) => (
              <tr key={s.label}>
                <td>{s.label}</td>
                {s.values.map((v, i) => (
                  <td key={i}>{v == null ? <span className={styles.tableGap}>—</span> : fmtPct(v / 100, 1)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={styles.footnote}>
        With play data starting January 2026, the curve only extends to Month {maxOffset} today and lengthens one month
        per month.
      </div>
    </div>
  );
}
