"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { GrowthData } from "@/lib/growthAnalytics";
import type { RetentionAggregate } from "@/lib/retentionEngine";
import styles from "./growth.module.css";
import { fmtInt, fmtPct, monthLabel } from "./format";
import GlobalPeriod, { type Period } from "./GlobalPeriod";
import KpiRow from "./KpiRow";
import PlayerFunnel from "./PlayerFunnel";
import BehaviorPanel from "./BehaviorPanel";
import ArppPanel from "./ArppPanel";
import CohortPanel from "./CohortPanel";
import RetentionCurvePanel from "./RetentionCurvePanel";
import ChurnPanel from "./ChurnPanel";
import DataRoomPanel from "./DataRoomPanel";

// The Growth tab. Two concurrent reads of one cached server aggregate
// (getGrowthCache): /api/growth backs funnel/behavior/ARPP/churn,
// /api/growth/retention backs the curve + cohort table. Read-only, service-role.
export default function GrowthDashboard() {
  const [data, setData] = useState<GrowthData | null>(null);
  const [retention, setRetention] = useState<RetentionAggregate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) throw new Error("Not signed in");
        const headers = { Authorization: `Bearer ${token}` };
        const [res, retRes] = await Promise.all([
          fetch("/api/growth", { headers }),
          fetch("/api/growth/retention", { headers }),
        ]);
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Request failed (${res.status})`);
        }
        const json = (await res.json()) as GrowthData;
        if (alive) {
          setData(json);
          const ms = json.behaviorOverall.map((p) => p.m);
          if (ms.length) setPeriod(defaultPeriod(ms, json.generatedAt.slice(0, 7)));
        }
        if (retRes.ok && alive) setRetention((await retRes.json()) as RetentionAggregate);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "Failed to load");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return (
      <div className={styles.dash}>
        <Header />
        <div className={`${styles.stateMsg} ${styles.errorMsg}`}>Could not load growth data: {error}</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className={styles.dash}>
        <Header />
        <div className={styles.stateMsg}>Loading growth analytics…</div>
      </div>
    );
  }

  const months = data.behaviorOverall.map((p) => p.m);
  const activePeriod: Period = period ?? defaultPeriod(months, data.generatedAt.slice(0, 7));
  return (
    <div className={styles.dash}>
      <Header />

      <GlobalPeriod months={months} period={activePeriod} setPeriod={setPeriod} />

      <div className={styles.calloutBanner}>
        This data has <b>three start dates</b>, not one. Registrations reach back to{" "}
        <b>{monthLabel(data.floors.registrations)}</b> and memberships to <b>{monthLabel(data.floors.memberships)}</b>,
        but every play-derived number — matches, spots, revenue, cohorts, retention, ARPP — begins{" "}
        <b>{monthLabel(data.floors.play)}</b>, the first month any matches exist. Empty regions before a series&rsquo;
        start mean &ldquo;no data yet&rdquo;, never zero.
      </div>

      <KpiRow data={data} period={activePeriod} />
      <PlayerFunnel data={data} period={activePeriod} />
      <BehaviorPanel data={data} period={activePeriod} />
      <ArppPanel data={data} />
      {retention ? <CohortPanel agg={retention} /> : <div className={styles.stateMsg}>Loading retention cohorts…</div>}
      <div className={styles.grid2}>
        {retention ? (
          <RetentionCurvePanel agg={retention} />
        ) : (
          <div className={styles.stateMsg}>Loading retention curve…</div>
        )}
        <ChurnPanel data={data} />
      </div>
      <DataRoomPanel data={data} />

      <div className={styles.footnote}>
        Source: live mdapi_* mirror + fin_revenue, read-only. {fmtInt(data.rowCounts.matchesLive)} live matches,{" "}
        {fmtInt(data.rowCounts.playersLive)} live participation rows. Every figure excludes fake players —{" "}
        {fmtInt(data.rowCounts.usersFake)} fake users and {fmtInt(data.rowCounts.fakeLiveRows)} live fake rows (
        {fmtPct(data.rowCounts.fakeLivePct)} of live rows) are removed everywhere. Computed{" "}
        {new Date(data.generatedAt).toLocaleString("en-US")}.
      </div>
    </div>
  );
}

// PART 2a: open on the last 6 COMPLETED months (excludes the current partial
// month) so the panel doesn't default to a 34-column wall of correct-but-empty
// pre-2026 dashes. The user can still widen it.
function defaultPeriod(months: string[], nowMonth: string): Period {
  const completed = months.filter((m) => m < nowMonth);
  const last6 = completed.slice(-6);
  return { start: last6[0] ?? months[0], end: last6[last6.length - 1] ?? months[months.length - 1] };
}

function Header() {
  return (
    <div className={styles.header}>
      <h1 className={styles.title}>Growth</h1>
      <p className={styles.subtitle}>
        Follow the player journey from app download to repeat play, then measure retention and identify churn risk.
      </p>
    </div>
  );
}
