"use client";

import { useMemo, useState } from "react";
import type { RetentionAggregate } from "@/lib/retentionEngine";
import styles from "./growth.module.css";
import { LineChart, type Series } from "./charts";
import { monthLabel } from "./format";
import { retentionCurve, MAX_AGE } from "./retentionModel";

// Retention curve — the unweighted average of each first-match cohort's
// retention by month since first match. A cohort contributes to age N only when
// it is old enough to have been observed at N; ages with zero observations break
// the line (never plotted as 0%). Computed from match participation, never Stripe.
const NETWORK = "Network (all cities)";

export default function RetentionCurvePanel({ agg }: { agg: RetentionAggregate }) {
  const cityNames = useMemo(() => [...agg.cities].sort((a, b) => a.localeCompare(b)), [agg.cities]);
  const [primary, setPrimary] = useState(NETWORK);
  const [compareOn, setCompareOn] = useState(false);
  const [secondary, setSecondary] = useState(cityNames[0] ?? NETWORK);

  const cityIdxOf = (name: string) => (name === NETWORK ? undefined : agg.cities.indexOf(name));
  const primaryCurve = useMemo(() => retentionCurve(agg, { cityIdx: cityIdxOf(primary) }), [agg, primary]);
  const secondaryCurve = useMemo(
    () => (compareOn && secondary !== primary ? retentionCurve(agg, { cityIdx: cityIdxOf(secondary) }) : null),
    [agg, compareOn, secondary, primary],
  );

  const axis = Array.from({ length: MAX_AGE + 1 }, (_, i) => `M${i}`);
  const series: Series[] = [{ label: primary, color: "var(--forest)", values: primaryCurve.points.map((p) => p.pct) }];
  if (secondaryCurve) {
    series.push({ label: secondary, color: "var(--gold-dot)", values: secondaryCurve.points.map((p) => p.pct) });
  }

  const endLabel = (c: ReturnType<typeof retentionCurve>) => {
    for (let n = MAX_AGE; n >= 0; n--) if (c.points[n].pct != null) return `${c.points[n].pct!.toFixed(0)}% at M${n}`;
    return "no data";
  };
  const spanText = (c: ReturnType<typeof retentionCurve>) =>
    c.span ? `${c.cohortCount} cohorts, ${monthLabel(c.span[0])} – ${monthLabel(c.span[1])}` : "no cohorts";

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Retention curve</div>
          <div className={styles.cardSub}>
            Average share of each first-match cohort still playing by month since first match. Ages with no observed
            cohort break the line.
          </div>
        </div>
        <div className={styles.controlsRow}>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="retPrimary">
              Primary city
            </label>
            <select id="retPrimary" className={styles.control} value={primary} onChange={(e) => setPrimary(e.target.value)}>
              <option value={NETWORK}>{NETWORK}</option>
              {cityNames.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className={`${styles.segBtn} ${compareOn ? styles.segBtnActive : ""}`}
            aria-pressed={compareOn}
            onClick={() => setCompareOn((v) => !v)}
          >
            Compare
          </button>
          {compareOn && (
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="retCompare">
                Comparison city
              </label>
              <select id="retCompare" className={styles.control} value={secondary} onChange={(e) => setSecondary(e.target.value)}>
                <option value={NETWORK}>{NETWORK}</option>
                {cityNames.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>

      <LineChart axis={axis} series={series} height={300} step={52} formatValue={(v) => v.toFixed(0)} yUnit="%" />

      <div className={styles.legend}>
        {series.map((s) => (
          <span key={s.label} className={styles.legendItem}>
            <i className={styles.legendDot} style={{ background: s.color }} />
            <b>{s.label}</b>
            <span style={{ color: "var(--muted)", marginLeft: 4 }}>
              — {endLabel(s.label === primary ? primaryCurve : secondaryCurve ?? primaryCurve)}
            </span>
          </span>
        ))}
      </div>

      <div className={styles.footnote}>
        {primary}: {spanText(primaryCurve)}
        {secondaryCurve ? ` · ${secondary}: ${spanText(secondaryCurve)}` : ""}.
      </div>
    </div>
  );
}
