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
  const statusLabel = (s: typeof ps, store: string) =>
    s.state === "not_configured"
      ? `${store} not configured — credentials missing`
      : s.state === "never_run"
        ? `${store} configured · not yet run`
        : s.state === "failed"
          ? `Last ran ${s.lastRunAt ? fmtInstant(s.lastRunAt) : "?"} · failed: ${s.error ?? "unknown error"}`
          : `Last ran ${s.lastRunAt ? fmtInstant(s.lastRunAt) : "?"} · returned no data`;
  const playStatus = statusLabel(ps, "Play sync");

  // iOS App Units summed over the period — a SEPARATE metric from Android, never
  // folded into one series. (Apple "App Units" = new downloads; Google "Daily User
  // Installs" = user-deduped installs. The combined figure below is shown only as a
  // convenience and the card says the two are counted differently.)
  const as = data.appleSync;
  const appleStatus = statusLabel(as, "App Store sync");
  const ios = useMemo(() => {
    const months = data.downloads.iosByMonth.filter((d) => d.m >= period.start && d.m <= period.end);
    return { has: data.downloads.ios != null && months.length > 0, total: months.reduce((a, d) => a + d.count, 0) };
  }, [data.downloads, period]);
  const iosRange = data.downloads.ios
    ? `${monthLabel(data.downloads.ios.earliest.slice(0, 7))} – ${monthLabel(data.downloads.ios.latest.slice(0, 7))}`
    : null;
  // Combined total across whichever platforms have data — explicitly labelled as a
  // mixed-definition sum, never presented as a single clean install count.
  const combinedHas = android.has || ios.has;
  const combinedTotal = (android.has ? android.total : 0) + (ios.has ? ios.total : 0);
  const bothHave = android.has && ios.has;

  const k = data.kpis;
  const regOfPlayed1 = scoped.registrations ? scoped.played1 / scoped.registrations : 0;
  const played1OfPlayed5 = scoped.played1 ? scoped.played5 / scoped.played1 : 0;
  const rangeLabel =
    period.start === period.end ? monthLabel(period.start) : `${monthLabel(period.start)} – ${monthLabel(period.end)}`;

  return (
    <div className={styles.kpiRow}>
      <div className={`${styles.kpi} ${styles.kpiAccent}`}>
        <div className={styles.kpiLabel}>App downloads · iOS + Android</div>
        <div className={`${styles.kpiValue} ${combinedHas ? "" : styles.kpiValueMuted}`}>
          {combinedHas ? fmtInt(combinedTotal) : "—"}
        </div>
        <div className={styles.kpiFoot}>
          {/* State exactly what the total includes. The two stores count differently
              (Apple App Units vs Google user-installs), so the sum is approximate. */}
          {bothHave
            ? `iOS App Units + Android user-installs · ${rangeLabel} — counted differently, not like-for-like`
            : android.has
              ? `Android only · ${rangeLabel} — iOS pending`
              : ios.has
                ? `iOS only · ${rangeLabel} — Android pending`
                : "iOS + Android — no store data yet"}
        </div>
        <div className={styles.kpiSecondary}>
          <div>
            <b>iOS</b> {ios.has ? fmtInt(ios.total) : "—"}
            {ios.has ? ` · App Store Units${iosRange ? ` · ${iosRange}` : ""}` : ""}
            {!ios.has && (
              <span className={styles.notConnected} title={as.error ?? undefined}>
                {" "}
                <span className={styles.notConnectedDot} /> {appleStatus}
              </span>
            )}
          </div>
          <div>
            <b>Android</b> {android.has ? fmtInt(android.total) : "—"}
            {android.has ? ` · Play user-installs${androidRange ? ` · ${androidRange}` : ""}` : ""}
            {!android.has && (
              <span className={styles.notConnected} title={ps.error ?? undefined}>
                {" "}
                <span className={styles.notConnectedDot} /> {playStatus}
              </span>
            )}
          </div>
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
