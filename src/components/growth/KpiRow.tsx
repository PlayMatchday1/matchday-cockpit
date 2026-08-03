"use client";

import { useMemo } from "react";
import type { GrowthData } from "@/lib/growthAnalytics";
import type { Period } from "./GlobalPeriod";
import styles from "./growth.module.css";
import { fmtInt, fmtPct, monthLabel, plural } from "./format";

// KPI cascade scoped to the global TIME PERIOD (PART 3): the same sign-up cohort
// the funnel uses, so the two agree instead of one being all-time and the other
// in-window. Downloads has no source → explicit not-connected state, never 0.
// All-time totals are still shown, but LABELLED "all time".
export default function KpiRow({ data, period }: { data: GrowthData; period: Period }) {
  const scoped = useMemo(() => {
    let registrations = 0;
    let played1 = 0;
    let played5 = 0;
    for (const r of data.funnelByMonth) {
      if (r.m < period.start || r.m > period.end) continue;
      registrations += r.registrations;
      played1 += r.played1;
      played5 += r.played5;
    }
    return { registrations, played1, played5 };
  }, [data.funnelByMonth, period]);

  const k = data.kpis;
  const regOfPlayed1 = scoped.registrations ? scoped.played1 / scoped.registrations : 0;
  const played1OfPlayed5 = scoped.played1 ? scoped.played5 / scoped.played1 : 0;
  const rangeLabel =
    period.start === period.end ? monthLabel(period.start) : `${monthLabel(period.start)} – ${monthLabel(period.end)}`;

  return (
    <div className={styles.kpiRow}>
      <div className={`${styles.kpi} ${styles.kpiAccent}`}>
        <div className={styles.kpiLabel}>App downloads</div>
        <div className={`${styles.kpiValue} ${styles.kpiValueMuted}`}>—</div>
        <div className={styles.kpiFoot}>
          <span className={styles.notConnected}>
            <span className={styles.notConnectedDot} /> store sync not connected
          </span>
        </div>
      </div>

      <div className={styles.kpi}>
        <div className={styles.kpiLabel}>Registrations · {rangeLabel}</div>
        <div className={styles.kpiValue}>{fmtInt(scoped.registrations)}</div>
        <div className={styles.kpiFoot}>— of downloads (store sync not connected)</div>
        <div className={styles.kpiSecondary}>
          All time: {fmtInt(k.registrations)} completed · {fmtInt(k.accountsCreated)} accounts · {fmtInt(k.onboardingGap)}{" "}
          {plural(k.onboardingGap, "account", "accounts")} never finished onboarding
        </div>
      </div>

      <div className={styles.kpi}>
        <div className={styles.kpiLabel}>Played 1 match · {rangeLabel}</div>
        <div className={styles.kpiValue}>{fmtInt(scoped.played1)}</div>
        <div className={styles.kpiFoot}>{fmtPct(regOfPlayed1)} of registrations</div>
        <div className={styles.kpiSecondary}>All time (all players): {fmtInt(k.played1)}</div>
      </div>

      <div className={styles.kpi}>
        <div className={styles.kpiLabel}>Played 5 matches · {rangeLabel}</div>
        <div className={styles.kpiValue}>{fmtInt(scoped.played5)}</div>
        <div className={styles.kpiFoot}>{fmtPct(played1OfPlayed5)} of first-match players</div>
        <div className={styles.kpiSecondary}>All time (all players): {fmtInt(k.played5)}</div>
      </div>
    </div>
  );
}
