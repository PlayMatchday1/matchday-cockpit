"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { GrowthData } from "@/lib/growthAnalytics";
import type { Period } from "./GlobalPeriod";
import styles from "./growth.module.css";
import { fmtInt, monthLabel } from "./format";

// PART 1 (c0d3853, unchanged): a nested COHORT funnel. For the users who completed
// sign-up in a window, how many went on to play ≥1/≥3/≥5/≥10 non-cancelled
// matches EVER. Each stage a strict subset → no conversion > 100%.
//
// v1_2 restyle (presentation only): bars carry the funnel shape (each stage as a
// share of the row's registrations); numbers carry the values. No per-cell colour
// tiers, no repeated stage/"conversion" labels, no per-row arrows. The conversion
// between two cells is still b/a — placement unchanged from c0d3853.

// One-hue light→dark ramp in stage order (colour is redundant with position; the
// number is always printed). Downloads has no source → no bar.
const STAGES: { label: string; hue: string | null }[] = [
  { label: "Downloads", hue: "#c3ecd6" },
  { label: "Registrations", hue: "#93dcb9" },
  { label: "1 match", hue: "#5ecb97" },
  { label: "3 matches", hue: "#2fa774" },
  { label: "5 matches", hue: "#186b4c" },
  { label: "10 matches", hue: "var(--forest)" },
];

type Cohort = { registrations: number; played1: number; played3: number; played5: number; played10: number };

function sumCohort(rows: GrowthData["funnelByMonth"], monthSet: Set<string>): Cohort {
  const acc: Cohort = { registrations: 0, played1: 0, played3: 0, played5: 0, played10: 0 };
  for (const r of rows) {
    if (!monthSet.has(r.m)) continue;
    acc.registrations += r.registrations;
    acc.played1 += r.played1;
    acc.played3 += r.played3;
    acc.played5 += r.played5;
    acc.played10 += r.played10;
  }
  return acc;
}

export default function PlayerFunnel({
  data,
  period,
  scopeChip,
}: {
  data: GrowthData;
  period: Period;
  scopeChip?: ReactNode;
}) {
  const months = data.behaviorOverall.map((p) => p.m);
  const [customStart, setCustomStart] = useState(period.start);
  const [customEnd, setCustomEnd] = useState(period.end);

  const rows = useMemo(() => {
    // "Current" is the latest data month (independent of the global period);
    // "Custom" is driven by the Custom start/end inputs.
    const end = months[months.length - 1];
    const endIdx = months.indexOf(end);
    const prev = endIdx > 0 ? months[endIdx - 1] : end;
    const year = end.slice(0, 4);
    const ytd = months.filter((m) => m.startsWith(year) && m <= end);
    const lo = customStart <= customEnd ? customStart : customEnd;
    const hi = customStart <= customEnd ? customEnd : customStart;
    const custom = months.filter((m) => m >= lo && m <= hi);
    return [
      { name: monthLabel(end), meta: "current month", months: [end] },
      { name: monthLabel(prev), meta: "previous month", months: [prev] },
      { name: `${year} YTD`, meta: "year to date", months: ytd },
      {
        name: custom.length ? `${monthLabel(custom[0])} – ${monthLabel(custom[custom.length - 1])}` : "—",
        meta: "custom range",
        months: custom,
      },
    ].map((r) => {
      const c = sumCohort(data.funnelByMonth, new Set(r.months));
      // Downloads = iOS App Units + Android user-installs summed over the row's months; null
      // (dash) when we have NO install data for that period — never 0.
      //
      // THIS READ BOTH STORES ONLY AFTER APPLE LANDED. It summed androidByMonth alone while the
      // KPI card above already summed both, so the same metric over the same period appeared twice
      // on one page as 2,241 and 11,307. The visible symptom was a download → registration
      // conversion of 2551.3% in the Aug 2026 row (995 registrations from 39 downloads) — a funnel
      // stage that grew 25× at its first step, on screen the whole time.
      //
      // The two stores count differently (Apple App Units = new downloads, Google user-installs =
      // user-deduped), which is why the card calls the sum not-like-for-like. That caveat now lives
      // in the page banner; it is a reason to label the number, not a reason to show a different
      // one here than the card shows.
      // THE TWO STORES DO NOT COVER THE SAME HISTORY, AND THEY NEVER WILL. Apple's monthly Sales
      // and Trends reports are retained for ONE YEAR and are not regenerated once that window
      // passes, so iOS monthly data before Aug 2025 is PERMANENTLY GONE — not unsynced, not
      // pending, not fillable. (Apple keeps YEARLY reports for ten years, so annual iOS totals for
      // 2023 and 2024 are recoverable, but with no monthly granularity, which is the granularity
      // this table is built on.) Google's begin Mar 2023.
      //
      // So the boundary below is a PERMANENT PROPERTY OF THE DATA. There is deliberately no TODO
      // here: nothing later can remove this label, and writing it as a temporary gap would invite
      // someone to try. A naive sum is genuinely both stores only from Apple's floor onward, and
      // the step up when iOS appears would otherwise read as growth when it is a second source
      // arriving.
      //
      // NOT BACKFILLED, NOT ESTIMATED, AND ROWS ARE NOT RESTRICTED to the covered window. The row
      // still shows what we have; it is LABELLED with what that number is made of. Computed per
      // row from the months it actually spans, because two of the four rows (YTD and the custom
      // range) are driven by data or by the operator and can straddle the floor at any time.
      const monthSet = new Set(r.months);
      const iosFloor = data.downloads.ios?.earliest.slice(0, 7) ?? null;
      const withIos = iosFloor ? r.months.filter((m) => m >= iosFloor) : [];
      const coverage: "both" | "partial" | "android" =
        !iosFloor || withIos.length === 0 ? "android"
        : withIos.length === r.months.length ? "both"
        : "partial";
      const dlMonths = [...data.downloads.androidByMonth, ...data.downloads.iosByMonth]
        .filter((d) => monthSet.has(d.m));
      const downloads = dlMonths.length ? dlMonths.reduce((a, d) => a + d.count, 0) : null;
      const dlNote =
        downloads == null ? null
        : coverage === "both" ? null
        : coverage === "android" ? "Android only · no iOS data exists"
        : `Android only before ${monthLabel(iosFloor!)}`;
      const vals = [downloads, c.registrations, c.played1, c.played3, c.played5, c.played10] as (number | null)[];
      // Assert nested — a violation is a bug, not a number to render.
      for (let i = 2; i < vals.length; i++) {
        if ((vals[i] as number) > (vals[i - 1] as number)) {
          // eslint-disable-next-line no-console
          console.error(`Funnel not nested in "${r.name}" at stage ${i}`, vals);
        }
      }
      return { ...r, vals, dlNote };
    });
  }, [data.funnelByMonth, customStart, customEnd, months]);

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Player funnel comparison</div>
          <div className={styles.cardSub}>
            Of each period&rsquo;s sign-up cohort, how many went on to play that many non-cancelled matches <b>ever</b> —
            so every stage is a subset of the one before it.
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
          {scopeChip}
          <div className={styles.controlsRow}>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="funnelCustomStart">
              Custom start
            </label>
            <input
              id="funnelCustomStart"
              className={styles.control}
              type="month"
              min={months[0]}
              max={months[months.length - 1]}
              value={customStart}
              onChange={(e) => setCustomStart(e.target.value)}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="funnelCustomEnd">
              Custom end
            </label>
            <input
              id="funnelCustomEnd"
              className={styles.control}
              type="month"
              min={months[0]}
              max={months[months.length - 1]}
              value={customEnd}
              onChange={(e) => setCustomEnd(e.target.value)}
            />
          </div>
          </div>
        </div>
      </div>

      <div className={styles.funnelScroll}>
        <div className={styles.funnelMatrix}>
          {/* header: the only place a stage is named + one arrow per gap */}
          <div className={`${styles.funnelRow} ${styles.funnelHeaderRow}`}>
            <div />
            {STAGES.flatMap((s, i) => {
              const cells: ReactNode[] = [
                <div key={`h${i}`} className={styles.funnelHstage}>
                  {s.label}
                </div>,
              ];
              if (i < STAGES.length - 1) cells.push(<div key={`ha${i}`} className={styles.funnelHarrow}>→</div>);
              return cells;
            })}
          </div>

          {rows.map((r) => (
            <div key={r.meta} className={styles.funnelRow}>
              <div className={styles.funnelPeriod}>
                <span className={styles.funnelPeriodName}>{r.name}</span>
                <span className={styles.funnelPeriodMeta}>{r.meta}</span>
              </div>
              {renderRowCells(r.vals, r.dlNote)}
            </div>
          ))}
        </div>
      </div>

      <div className={styles.funnelNote}>
        The bar in each cell is that stage as a share of the row&rsquo;s largest stage, so the funnel narrows left to
        right; the figure between two cells is the conversion from the left one to the right one, dashed whenever either
        side is unknown. <b>Downloads → Registrations is an aggregate ratio, not a per-user conversion</b> — store
        installs can&rsquo;t be linked to a player (Apple and Google never reveal who installed), unlike every later step,
        which is a true cohort subset. Downloads is Android only until Apple lands, and is a dash wherever we have no
        install data — never 0.
      </div>
    </div>
  );
}

// Builds a row's stage + conversion cells. The conversion between stage i and i+1
// is b/a (b = vals[i+1], a = vals[i]); a dash when either is null or a is 0.
function renderRowCells(vals: (number | null)[], dlNote?: string | null): ReactNode[] {
  // Bars are a share of the LARGEST stage in the row (Downloads when known, else
  // Registrations) so the funnel narrows left → right even now that Downloads is
  // a real, larger-than-registrations value.
  const base = Math.max(0, ...vals.filter((v): v is number => v != null));
  const out: ReactNode[] = [];
  vals.forEach((v, i) => {
    const isNull = v == null;
    const share = isNull || !base ? 0 : Math.min(100, (v / base) * 100);
    // ASSERT 1: a null stage renders its dashed treatment wherever it falls in
    // the row (not only column 0). isNull ⟺ funnelStageNull is applied below.
    const stageDashed = isNull;
    if (isNull && !stageDashed) throw new Error(`funnel: null stage at ${i} not dashed`);
    out.push(
      <div key={`s${i}`} className={`${styles.funnelStage} ${stageDashed ? styles.funnelStageNull : ""}`}>
        <span className={styles.funnelSnum}>{isNull ? "—" : fmtInt(v)}</span>
        {/* STORE COVERAGE, on the Downloads cell only. A bare combined number on a row the two
            stores do not both cover would read as one metric when it is two spliced together. */}
        {i === 0 && dlNote && (
          <span className={styles.funnelDlNote} data-testid="funnel-dl-coverage">{dlNote}</span>
        )}
        {isNull ? (
          <span className={styles.funnelSbar} style={{ background: "transparent" }} />
        ) : (
          <span className={styles.funnelSbar}>
            <span className={styles.funnelSfill} style={{ width: `${share}%`, background: STAGES[i].hue ?? "var(--forest)" }} />
          </span>
        )}
      </div>,
    );
    if (i < vals.length - 1) {
      const a = vals[i];
      const b = vals[i + 1];
      // ASSERT 2: a conversion is a dash whenever EITHER side is null OR the left
      // side is 0 — regardless of position in the row.
      const mustDash = a == null || b == null || a <= 0;
      const known = !mustDash;
      if (mustDash && known) throw new Error(`funnel: conversion at ${i} should be dashed`);
      out.push(
        <div key={`c${i}`} className={styles.funnelConv}>
          <span className={`${styles.funnelCpill} ${known ? "" : styles.funnelCpillNone}`}>
            {known ? `${((b! / a!) * 100).toFixed(1)}%` : "—"}
          </span>
        </div>,
      );
    }
  });
  return out;
}
