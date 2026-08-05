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

  // Android installs summed over the period; iOS is not wired (dash, never 0).
  const android = useMemo(() => {
    const months = data.downloads.androidByMonth.filter((d) => d.m >= period.start && d.m <= period.end);
    return { has: data.downloads.android != null && months.length > 0, total: months.reduce((a, d) => a + d.count, 0) };
  }, [data.downloads, period]);
  const androidRange = data.downloads.android
    ? `${monthLabel(data.downloads.android.earliest.slice(0, 7))} – ${monthLabel(data.downloads.android.latest.slice(0, 7))}`
    : null;

  // Play-ingest status label. Replaces the static "awaiting Play sync" — which
  // could not fail and so could not be debugged — with one line per real state:
  // not configured / configured-never-run / last ran <t> and failed with <err> /
  // last ran <t> and returned no data. The synced case shows the install range
  // above instead. Sync health comes from the server (env + fin_sync_log).
  const ps = data.playSync;
  const fmtInstant = (iso: string) =>
    new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  const playStatus =
    ps.state === "not_configured"
      ? "Play sync not configured — Play key missing"
      : ps.state === "never_run"
        ? "Play sync configured · not yet run"
        : ps.state === "failed"
          ? `Last ran ${ps.lastRunAt ? fmtInstant(ps.lastRunAt) : "?"} · failed: ${ps.error ?? "unknown error"}`
          : `Last ran ${ps.lastRunAt ? fmtInstant(ps.lastRunAt) : "?"} · returned no data`;

  const k = data.kpis;
  const regOfPlayed1 = scoped.registrations ? scoped.played1 / scoped.registrations : 0;
  const played1OfPlayed5 = scoped.played1 ? scoped.played5 / scoped.played1 : 0;
  const rangeLabel =
    period.start === period.end ? monthLabel(period.start) : `${monthLabel(period.start)} – ${monthLabel(period.end)}`;

  return (
    <div className={styles.kpiRow}>
      <div className={`${styles.kpi} ${styles.kpiAccent}`}>
        <div className={styles.kpiLabel}>App downloads · Android</div>
        <div className={`${styles.kpiValue} ${android.has ? "" : styles.kpiValueMuted}`}>
          {android.has ? fmtInt(android.total) : "—"}
        </div>
        <div className={styles.kpiFoot}>
          {androidRange ? (
            `Play installs · ${androidRange}`
          ) : (
            <span className={styles.notConnected} title={ps.error ?? undefined}>
              <span className={styles.notConnectedDot} /> {playStatus}
            </span>
          )}
        </div>
        <div className={styles.kpiSecondary}>
          iOS — · Apple not connected (App Store Connect key pending)
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
