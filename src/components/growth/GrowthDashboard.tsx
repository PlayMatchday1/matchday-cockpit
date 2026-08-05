"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { GrowthData } from "@/lib/growthAnalytics";
import type { CohortMatrixPayload } from "./retentionModel";
import styles from "./growth.module.css";
import { fmtInt, fmtPct, monthLabel } from "./format";
import { type Period } from "./GlobalPeriod";
import { axisMaxAge } from "./retentionModel";
import PeriodBar from "./PeriodBar";
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
  const [retention, setRetention] = useState<CohortMatrixPayload | null>(null);
  const [authHeaders, setAuthHeaders] = useState<Record<string, string> | null>(null);
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
        if (alive) setAuthHeaders(headers); // children (churn, drill-downs) fetch with these
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
        if (retRes.ok && alive) setRetention((await retRes.json()) as CohortMatrixPayload);
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

  // DEFECT 2: one scope map drives both the per-card chips and the bar's "N of 7"
  // count — change a card's scope here and the count moves with it. GREEN chips
  // print the literal range (they follow the period); BLUE/GREY are period-free.
  const rangeText = `${monthLabel(activePeriod.start)} – ${monthLabel(activePeriod.end)}`;
  const followsChip = (
    <span className={`${styles.scope} ${styles.scopeFollows}`}>
      <i />
      {rangeText}
    </span>
  );
  const ownChip = (note: string) => (
    <span className={`${styles.scope} ${styles.scopeOwn}`}>
      <i />
      Own filters · {note}
    </span>
  );
  const maxAge = retention ? axisMaxAge(retention) : 40;
  const alltimeChip = (
    <span className={`${styles.scope} ${styles.scopeAlltime}`}>
      <i />
      All time · Months 0–{maxAge}, every cohort
    </span>
  );
  const cardScopes = ["follows", "follows", "follows", "alltime", "own", "own", "follows"] as const;
  const followN = cardScopes.filter((s) => s === "follows").length;

  return (
    <div className={styles.dash}>
      <Header />

      <PeriodBar
        months={months}
        period={activePeriod}
        setPeriod={setPeriod}
        generatedAt={data.generatedAt}
        followCount={followN}
        cardCount={cardScopes.length}
      />

      <div className={styles.scopeLegend}>
        <span>
          <i style={{ background: "#2CDB87" }} />
          Follows the time period above
        </span>
        <span>
          <i style={{ background: "#2E79FF" }} />
          Has its own filters
        </span>
        <span>
          <i style={{ background: "#9AA79F" }} />
          All time, ignores the period
        </span>
      </div>

      <div className={styles.calloutBanner}>
        This data has <b>three start dates</b>, not one. Registrations reach back to{" "}
        <b>{monthLabel(data.floors.registrations)}</b> and memberships to <b>{monthLabel(data.floors.memberships)}</b>,
        but every play-derived number — matches, spots, revenue, cohorts, retention, ARPP — begins{" "}
        <b>{monthLabel(data.floors.play)}</b>, the first month any matches exist. Empty regions before a series&rsquo;
        start mean &ldquo;no data yet&rdquo;, never zero.
      </div>

      <KpiRow data={data} period={activePeriod} />
      <PlayerFunnel data={data} period={activePeriod} scopeChip={followsChip} />
      <BehaviorPanel data={data} period={activePeriod} scopeChip={followsChip} />
      <ArppPanel data={data} scopeChip={followsChip} />
      {/* Retention curve sits directly below ARPP and before the cohort table, full-width. */}
      {retention ? (
        <RetentionCurvePanel payload={retention} authHeaders={authHeaders ?? {}} scopeChip={alltimeChip} />
      ) : (
        <div className={styles.stateMsg}>Loading retention curve…</div>
      )}
      {retention ? (
        <CohortPanel
          payload={retention}
          authHeaders={authHeaders ?? {}}
          scopeChip={ownChip("Cohort year · Cohort month · City")}
        />
      ) : (
        <div className={styles.stateMsg}>Loading retention cohorts…</div>
      )}
      <ChurnPanel
        cities={data.cities}
        authHeaders={authHeaders ?? {}}
        scopeChip={ownChip("Inactive for · Last played after")}
      />
      <DataRoomPanel authHeaders={authHeaders ?? {}} scopeChip={followsChip} />

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
