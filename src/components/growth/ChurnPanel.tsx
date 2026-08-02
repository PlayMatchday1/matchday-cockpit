"use client";

import { useMemo, useState } from "react";
import type { GrowthData } from "@/lib/growthAnalytics";
import styles from "./growth.module.css";
import { countLabel, downloadCsv, fmtInt } from "./format";

// PART 6: potential churn. Filters by city, field and an inactivity threshold
// (30/60/90/120 days). Table: Player ID, City, Field, Days inactive, Matches
// played, Last played, plus CSV. The buckets are captioned: with data starting
// Jan 2026, "120 days" means "no play since ~April", and a player whose only
// match was in January reads as churned by construction — so 90/120 must not be
// over-read.
const BUCKETS = [30, 60, 90, 120] as const;
const MAX_ROWS = 500;

export default function ChurnPanel({ data }: { data: GrowthData }) {
  const cities = ["All cities", ...data.cities];
  const [city, setCity] = useState("All cities");
  const [threshold, setThreshold] = useState<number>(90); // matches the design default

  const fields = useMemo(() => {
    const set = new Set<string>();
    for (const p of data.players) if (city === "All cities" || p.city === city) set.add(p.field);
    return ["All fields", ...[...set].sort()];
  }, [data.players, city]);
  const [field, setField] = useState("All fields");

  const scoped = useMemo(
    () =>
      data.players.filter(
        (p) => (city === "All cities" || p.city === city) && (field === "All fields" || p.field === field),
      ),
    [data.players, city, field],
  );

  const bucketCounts = useMemo(() => {
    const m: Record<number, number> = {};
    for (const b of BUCKETS) m[b] = scoped.filter((p) => p.days >= b).length;
    return m;
  }, [scoped]);

  const filtered = useMemo(
    () => scoped.filter((p) => p.days >= threshold).sort((a, b) => b.days - a.days),
    [scoped, threshold],
  );

  function exportCsv() {
    const header = ["Player ID", "City", "Field", "Days inactive", "Matches played", "Last played"];
    const body = filtered.map((p) => [p.u, p.city, p.field, p.days, p.matches, p.last]);
    downloadCsv(`potential-churn-${threshold}d.csv`, [header, ...body]);
  }

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Potential churn players</div>
          <div className={styles.cardSub}>Players who previously held a spot but have not returned.</div>
        </div>
        <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={exportCsv}>
          Download CSV
        </button>
      </div>

      <div className={styles.controlsRow} style={{ marginBottom: 14 }}>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="churnCity">
            City
          </label>
          <select
            id="churnCity"
            className={styles.control}
            value={city}
            onChange={(e) => {
              setCity(e.target.value);
              setField("All fields");
            }}
          >
            {cities.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="churnField">
            Field
          </label>
          <select id="churnField" className={styles.control} value={field} onChange={(e) => setField(e.target.value)}>
            {fields.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className={styles.churnGrid}>
        {BUCKETS.map((b, i) => (
          <button
            key={b}
            type="button"
            className={`${styles.churnCell} ${threshold === b ? styles.churnCellActive : ""} ${
              i === 2 ? styles.churnCellWarn : i === 3 ? styles.churnCellCrit : ""
            }`}
            aria-pressed={threshold === b}
            onClick={() => setThreshold(b)}
          >
            <div className={styles.churnCellLabel}>Inactive ≥ {b} days</div>
            <div className={styles.churnCellValue}>{fmtInt(bucketCounts[b])}</div>
          </button>
        ))}
      </div>

      <div className={styles.summaryLine}>
        {countLabel(filtered.length, "player")} inactive ≥ {threshold} days
        {filtered.length > MAX_ROWS ? ` — showing the ${MAX_ROWS} most inactive; CSV has all` : ""}.
      </div>

      <div className={`${styles.tableWrap} ${styles.scrollBody}`}>
        <table className={styles.recordTable}>
          <thead>
            <tr>
              <th>Player ID</th>
              <th>City</th>
              <th>Field</th>
              <th className="num">Days inactive</th>
              <th className="num">Matches played</th>
              <th>Last played</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, MAX_ROWS).map((p) => (
              <tr key={p.u}>
                <td>{p.u}</td>
                <td>{p.city}</td>
                <td>{p.field}</td>
                <td className="num">{fmtInt(p.days)}</td>
                <td className="num">{fmtInt(p.matches)}</td>
                <td>{p.last}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={styles.footnote}>
        Play data starts January 2026, so &ldquo;inactive 120 days&rdquo; means no play since about April, and a player
        whose only match was in January necessarily reads as churned. Read the 90- and 120-day buckets with that in mind.
      </div>
    </div>
  );
}
