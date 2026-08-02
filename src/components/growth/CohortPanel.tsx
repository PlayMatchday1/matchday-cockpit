"use client";

import { useMemo, useState } from "react";
import type { GrowthData } from "@/lib/growthAnalytics";
import styles from "./growth.module.css";
import { countLabel, downloadCsv, fmtPct, monthLabel } from "./format";

// PART 5: first-match cohort retention. The grid is TRIANGULAR — each cohort can
// only be observed as far as the calendar has run, so cells past that are an
// explicit hatched "no data yet" state, never a 0% that would read as 100%
// churn. Visible columns are capped at the furthest observable offset (Month 0–7
// today) and grow one per month. The current calendar month is marked partial
// (°) because its % is still climbing. Shading is DIVERGING (above / at / below
// that column's mean) — two hues plus a neutral midpoint, and every cell prints
// its value so colour is never the sole encoding. 2023–2025 cohort years are
// gone (zero play data); 2026 only.
export default function CohortPanel({ data }: { data: GrowthData }) {
  const cohorts = data.cohorts;
  const [monthFilter, setMonthFilter] = useState("all");

  const maxOffset = useMemo(() => {
    let mx = 0;
    for (const c of cohorts) for (const cell of c.cells) if (cell.observable) mx = Math.max(mx, cell.offset);
    return Math.min(7, mx); // design cap
  }, [cohorts]);
  const offsets = Array.from({ length: maxOffset + 1 }, (_, i) => i);

  // per-column mean over observable, non-partial cells (partial understates).
  const colMean = useMemo(() => {
    const m: Record<number, number> = {};
    for (const o of offsets) {
      const vals = cohorts
        .map((c) => c.cells[o])
        .filter((cell) => cell && cell.observable && !cell.partial)
        .map((cell) => cell!.pct);
      m[o] = vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : 0;
    }
    return m;
  }, [cohorts, offsets]);

  const rows = cohorts.filter((c) => monthFilter === "all" || c.cohort === monthFilter);

  function cellClass(o: number, pct: number, observable: boolean, partial: boolean): string {
    if (!observable) return styles.cohortFuture;
    if (o === 0) return styles.cohortBase; // month 0 is 100% by definition
    if (partial) return styles.divMid;
    const mean = colMean[o] || 0;
    if (mean <= 0) return styles.divMid;
    const r = pct / mean;
    if (r >= 1.2) return styles.divAbove2;
    if (r >= 1.05) return styles.divAbove1;
    if (r <= 0.8) return styles.divBelow2;
    if (r <= 0.95) return styles.divBelow1;
    return styles.divMid;
  }

  function exportCsv() {
    const header = ["Cohort", "Players", ...offsets.map((o) => `Month ${o}`)];
    const body = rows.map((c) => [
      monthLabel(c.cohort),
      c.size,
      ...offsets.map((o) => {
        const cell = c.cells[o];
        if (!cell || !cell.observable) return "no data yet";
        return (cell.pct * 100).toFixed(1) + "%" + (cell.partial ? " (in progress)" : "");
      }),
    ]);
    downloadCsv("player-retention-cohorts-2026.csv", [header, ...body]);
  }

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Player retention cohorts</div>
          <div className={styles.cardSub}>
            Share of each first-match cohort that played again in later calendar months. 2026 cohorts.
          </div>
        </div>
        <div className={styles.controlsRow}>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="cohortMonth">
              Cohort month
            </label>
            <select
              id="cohortMonth"
              className={styles.control}
              value={monthFilter}
              onChange={(e) => setMonthFilter(e.target.value)}
            >
              <option value="all">All 2026 cohorts</option>
              {cohorts.map((c) => (
                <option key={c.cohort} value={c.cohort}>
                  {monthLabel(c.cohort)}
                </option>
              ))}
            </select>
          </div>
          <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={exportCsv}>
            Export CSV
          </button>
        </div>
      </div>

      <div className={styles.cohortWrap}>
        <table className={styles.cohortTable}>
          <thead>
            <tr>
              <th className={styles.cohortRowHead}>Cohort</th>
              {offsets.map((o) => (
                <th key={o}>Month {o}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.cohort}>
                <td className={`${styles.cohortCell} ${styles.cohortRowHead}`}>
                  {monthLabel(c.cohort)}
                  <div className={styles.cohortSize}>{countLabel(c.size, "player")}</div>
                </td>
                {offsets.map((o) => {
                  const cell = c.cells[o];
                  const observable = !!cell?.observable;
                  const partial = !!cell?.partial;
                  return (
                    <td
                      key={o}
                      className={`${styles.cohortCell} ${cellClass(o, cell?.pct ?? 0, observable, partial)} ${
                        partial ? styles.cohortPartial : ""
                      }`}
                      title={
                        !observable
                          ? "No data yet — this month hasn't happened"
                          : partial
                            ? "Current month — still in progress, will climb"
                            : `${cell!.active} of ${c.size} active`
                      }
                    >
                      {observable ? fmtPct(cell!.pct, 0) : "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className={`${styles.cohortCell} ${styles.cohortRowHead}`}>
                Average
                <div className={styles.cohortSize}>observed cohorts</div>
              </td>
              {offsets.map((o) => (
                <td key={o} className={`${styles.cohortCell} ${styles.divMid}`} style={{ fontWeight: 800 }}>
                  {o === 0 ? "100%" : fmtPct(colMean[o] ?? 0, 0)}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>

      <div className={styles.divergingLegend}>
        <span>
          <span className={styles.divergingSwatch} style={{ background: "var(--div-below-2)" }} />below column avg
        </span>
        <span>
          <span className={styles.divergingSwatch} style={{ background: "var(--div-mid)" }} />at avg
        </span>
        <span>
          <span className={styles.divergingSwatch} style={{ background: "var(--div-above-2)" }} />above avg
        </span>
        <span>
          <span
            className={styles.divergingSwatch}
            style={{
              background:
                "repeating-linear-gradient(45deg,var(--hair),var(--hair) 5px,var(--surface) 5px,var(--surface) 10px)",
            }}
          />
          no data yet
        </span>
        <span>° current month (in progress)</span>
      </div>
      <div className={styles.footnote}>
        Months {maxOffset + 1}–12 are hidden until they exist: the January cohort first reaches Month{" "}
        {maxOffset + 1} in {monthLabel(nextMonth(data.floors.play, maxOffset + 1))}, and Month 12 in{" "}
        {monthLabel(nextMonth(data.floors.play, 12))}. A hidden month is never shown as 0%.
      </div>
    </div>
  );
}

function nextMonth(base: string, add: number): string {
  const [y, m] = base.split("-").map(Number);
  const t = y * 12 + (m - 1) + add;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}
