"use client";

import type { GrowthData } from "@/lib/growthAnalytics";
import styles from "./growth.module.css";
import { fmtInt, fmtPct, plural } from "./format";

// KPI cascade: App downloads · Registrations · Played 1 · Played 5.
// Downloads has NO source — it renders an explicit not-connected state, never 0
// or blank (PART 2). Registrations shows completed sign-ups with accounts-created
// and the onboarding gap beneath it (DECISION 1).
export default function KpiRow({ data }: { data: GrowthData }) {
  const k = data.kpis;
  const regOfPlayed1 = k.registrations ? k.played1 / k.registrations : 0;
  const played1OfPlayed5 = k.played1 ? k.played5 / k.played1 : 0;
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
        <div className={styles.kpiLabel}>Registrations</div>
        <div className={styles.kpiValue}>{fmtInt(k.registrations)}</div>
        <div className={styles.kpiFoot}>completed sign-up (non-fake)</div>
        <div className={styles.kpiSecondary}>
          {fmtInt(k.accountsCreated)} accounts created · {fmtInt(k.onboardingGap)}{" "}
          {plural(k.onboardingGap, "account", "accounts")} started but never finished onboarding
        </div>
      </div>

      <div className={styles.kpi}>
        <div className={styles.kpiLabel}>Played 1 match</div>
        <div className={styles.kpiValue}>{fmtInt(k.played1)}</div>
        <div className={styles.kpiFoot}>{fmtPct(regOfPlayed1)} of registrations</div>
      </div>

      <div className={styles.kpi}>
        <div className={styles.kpiLabel}>Played 5 matches</div>
        <div className={styles.kpiValue}>{fmtInt(k.played5)}</div>
        <div className={styles.kpiFoot}>{fmtPct(played1OfPlayed5)} of first-match players</div>
      </div>
    </div>
  );
}
