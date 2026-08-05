"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "./growth.module.css";
import { LineChart, type Series } from "./charts";
import { monthLabel } from "./format";
import { retentionCurve, MAX_AGE, type CohortMatrixPayload } from "./retentionModel";

// Retention curve — the unweighted average of each first-match cohort's
// retention by month since first match. A cohort contributes to age N only when
// it is old enough to have been observed at N; ages with zero observations break
// the line (never plotted as 0%). Computed from match participation, never Stripe.
// The all-cities rollup is the incoming payload; a city selection refetches
// /api/growth/retention?city=<display>.
const NETWORK = "Network (all cities)";

export default function RetentionCurvePanel({
  payload,
  authHeaders,
}: {
  payload: CohortMatrixPayload;
  authHeaders: Record<string, string>;
}) {
  const cityNames = payload.cities; // display names, already sorted server-side
  const [primary, setPrimary] = useState(NETWORK);
  const [compareOn, setCompareOn] = useState(false);
  const [secondary, setSecondary] = useState(cityNames[0] ?? NETWORK);
  // Per-city payloads fetched on demand (the all-cities rollup is the prop).
  const [cityPayloads, setCityPayloads] = useState<Record<string, CohortMatrixPayload>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const wanted = [primary, compareOn ? secondary : null].filter(
      (n): n is string => !!n && n !== NETWORK && !(n in cityPayloads),
    );
    if (!wanted.length) return;
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const fetched = await Promise.all(
          wanted.map(async (name) => {
            const res = await fetch(`/api/growth/retention?city=${encodeURIComponent(name)}`, { headers: authHeaders });
            return [name, (await res.json()) as CohortMatrixPayload] as const;
          }),
        );
        if (alive) setCityPayloads((prev) => ({ ...prev, ...Object.fromEntries(fetched) }));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [primary, secondary, compareOn, authHeaders, cityPayloads]);

  const payloadFor = (name: string): CohortMatrixPayload | null =>
    name === NETWORK ? payload : cityPayloads[name] ?? null;

  const primaryPayload = payloadFor(primary);
  const secondaryPayload = compareOn && secondary !== primary ? payloadFor(secondary) : null;
  const primaryCurve = useMemo(
    () => (primaryPayload ? retentionCurve(primaryPayload) : null),
    [primaryPayload],
  );
  const secondaryCurve = useMemo(
    () => (secondaryPayload ? retentionCurve(secondaryPayload) : null),
    [secondaryPayload],
  );

  const axis = Array.from({ length: MAX_AGE + 1 }, (_, i) => `M${i}`);
  const series: Series[] = [];
  if (primaryCurve) series.push({ label: primary, color: "var(--forest)", values: primaryCurve.points.map((p) => p.pct) });
  if (secondaryCurve) series.push({ label: secondary, color: "var(--gold-dot)", values: secondaryCurve.points.map((p) => p.pct) });

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
              — {endLabel(s.label === primary ? primaryCurve! : secondaryCurve ?? primaryCurve!)}
            </span>
          </span>
        ))}
      </div>

      <div className={styles.footnote}>
        {loading && <>Loading city curve… · </>}
        {primaryCurve ? `${primary}: ${spanText(primaryCurve)}` : `${primary}: loading…`}
        {secondaryCurve ? ` · ${secondary}: ${spanText(secondaryCurve)}` : ""}.
      </div>
    </div>
  );
}
