"use client";

// RETENTION — the curve and the cohort matrix, together on one page, both moved verbatim.
//
// NO PERIOD BAR, and that is the point of the split. The curve is ALL TIME (every cohort, months
// 0–N) and the cohort table has its OWN filters (cohort year, cohort month, city). Neither ever
// followed the global period; on the single-scroll page they were labelled with grey and blue dots
// to say so. The subtitle says it in words instead.
//
// No start-dates note: both are anchored to a cohort's own month zero, so there is no pre-play
// region on screen to mistake for zero.

import CohortPanel from "@/components/growth/CohortPanel";
import RetentionCurvePanel from "@/components/growth/RetentionCurvePanel";
import SectionFrame from "@/components/growth/SectionFrame";
import styles from "@/components/growth/growth.module.css";
import { useGrowth } from "@/components/growth/GrowthDataProvider";

export default function LifecycleRetentionPage() {
  const g = useGrowth();
  return (
    <SectionFrame
      title="Retention"
      subtitle="All time, every cohort — the curve ignores the time period, and the matrix has its own cohort and city filters."
      period={false}
      /* IT READS g.retention, NOT g.data — a DIFFERENT fetch, and the faster of the two (408 ms
       * against 1,443 ms). Gating it on g.data made it wait for the slower one for no reason. It
       * already renders its own empty state while g.retention is null. */
      needsGrowthData={false}
    >
      {g.retention ? (
        <>
          <RetentionCurvePanel payload={g.retention} authHeaders={g.authHeaders} />
          <CohortPanel payload={g.retention} authHeaders={g.authHeaders} />
        </>
      ) : (
        <div className={styles.stateMsg}>Loading retention…</div>
      )}
    </SectionFrame>
  );
}
