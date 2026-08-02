"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { GrowthData } from "@/lib/growthAnalytics";
import styles from "./growth.module.css";
import { fmtInt, fmtPct, monthLabel } from "./format";
import KpiRow from "./KpiRow";
import PlayerFunnel from "./PlayerFunnel";
import BehaviorPanel from "./BehaviorPanel";
import ArppPanel from "./ArppPanel";
import CohortPanel from "./CohortPanel";
import RetentionCurvePanel from "./RetentionCurvePanel";
import ChurnPanel from "./ChurnPanel";
import DataRoomPanel from "./DataRoomPanel";

// The Growth tab. One fetch to /api/growth (server-computed, service-role,
// read-only), then every panel renders from that single payload. The old
// Overview / Users / Cancellations lenses were removed on request.
export default function GrowthDashboard() {
  const [data, setData] = useState<GrowthData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) throw new Error("Not signed in");
        const res = await fetch("/api/growth", { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Request failed (${res.status})`);
        }
        const json = (await res.json()) as GrowthData;
        if (alive) setData(json);
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

  const rc = data.rowCounts;
  return (
    <div className={styles.dash}>
      <Header />

      <div className={styles.calloutBanner}>
        This data has <b>three start dates</b>, not one. Registrations reach back to{" "}
        <b>{monthLabel(data.floors.registrations)}</b> and memberships to <b>{monthLabel(data.floors.memberships)}</b>,
        but every play-derived number — matches, spots, revenue, cohorts, retention, ARPP — begins{" "}
        <b>{monthLabel(data.floors.play)}</b>, the first month any matches exist. Empty regions before a series&rsquo;
        start mean &ldquo;no data yet&rdquo;, never zero.
      </div>

      <KpiRow data={data} />
      <PlayerFunnel data={data} />
      <BehaviorPanel data={data} />
      <ArppPanel data={data} />
      <CohortPanel data={data} />
      <div className={styles.grid2}>
        <RetentionCurvePanel data={data} />
        <ChurnPanel data={data} />
      </div>
      <DataRoomPanel data={data} />

      <div className={styles.footnote}>
        Source: live mdapi_* mirror + fin_revenue, read-only. {fmtInt(rc.matchesLive)} live matches,{" "}
        {fmtInt(rc.playersLive)} live participation rows. Every figure excludes fake players —{" "}
        {fmtInt(rc.usersFake)} fake users and {fmtInt(rc.fakeLiveRows)} live fake rows ({fmtPct(rc.fakeLivePct)} of live
        rows) are removed everywhere. Computed {new Date(data.generatedAt).toLocaleString("en-US")}.
      </div>
    </div>
  );
}

function Header() {
  return (
    <div className={styles.header}>
      <h1 className={styles.title}>Growth</h1>
      <p className={styles.subtitle}>Downloads, registrations, play, revenue and retention across the network.</p>
    </div>
  );
}
