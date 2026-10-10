"use client";

import { useMemo, type ReactNode } from "react";
import type { GrowthData } from "@/lib/growthAnalytics";
import type { Period } from "./GlobalPeriod";
import styles from "./growth.module.css";
import { fmtInt, monthLabel } from "./format";
import { canonCity } from "@/lib/reviewsDerive";
import { clampMonthsToNow } from "@/lib/funnelMonth";

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
export const STAGES: { label: string; hue: string | null }[] = [
  { label: "Downloads", hue: "#c3ecd6" },
  { label: "Registrations", hue: "#93dcb9" },
  { label: "1 match", hue: "#5ecb97" },
  { label: "3 matches", hue: "#2fa774" },
  { label: "5 matches", hue: "#186b4c" },
  { label: "10 matches", hue: "var(--forest)" },
];

const ALL_CITIES = "All cities";

export type Cohort = { registrations: number; played1: number; played3: number; played5: number; played10: number };

// The city-dimensioned cohort for one city. canonCity on BOTH sides — see the comment at the
// city state above for why that is not optional.
export function sumCohortCity(
  rows: { m: string; city: string; registrations: number; played1: number; played3: number; played5: number; played10: number }[],
  monthSet: Set<string>,
  city: string,
): Cohort {
  const want = canonCity(city);
  const acc: Cohort = { registrations: 0, played1: 0, played3: 0, played5: 0, played10: 0 };
  for (const r of rows) {
    if (!monthSet.has(r.m) || canonCity(r.city) !== want) continue;
    acc.registrations += r.registrations;
    acc.played1 += r.played1;
    acc.played3 += r.played3;
    acc.played5 += r.played5;
    acc.played10 += r.played10;
  }
  return acc;
}

export function sumCohort(rows: GrowthData["funnelByMonth"], monthSet: Set<string>): Cohort {
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
  /* ── THE AXIS, CLAMPED TO THE MONTH CHICAGO IS ACTUALLY IN ────────────────────────────────
   * behaviorOverall runs off behaviorAxis, whose ceiling is max(nowMonth, last booked match month)
   * - and growth_play_dims carries BOOKED matches, so the axis runs into the future. This page then
   * called its last entry the current month. Measured on prod 2026-09-27: the axis ended 2026-10
   * while Chicago was in 2026-09.
   *
   * CLAMPED HERE AND NOT IN THE AXIS, because behaviorAxis has other readers (BehaviorPanel among
   * them) that may legitimately want a future month. See lib/funnelMonth for why the clamp is to the
   * calendar rather than to the data, and why it reads the business timezone.
   *
   * EVERYTHING DOWNSTREAM INHERITS IT, including the range pickers' own max: an end month there can
   * no longer be a month that has no data by definition. One clamp, not four. */
  const months = useMemo(() => clampMonthsToNow(data.behaviorOverall.map((p) => p.m)), [data.behaviorOverall]);
  /* THE RANGE COMES FROM THE PAGE AND IS NOT DUPLICATED HERE. These were local state with their own
   * two month inputs in this card's header, which meant the page had two range controls: one driving
   * the cards and one driving the bottom row of this table. Ryan: "there's already a custom range for
   * the last row" - so that one moved up and now drives both. */
  const customStart = period.start;
  const customEnd = period.end;
  /* ALWAYS ALL CITIES (Ryan, 2026-10-10, from Miguel's feedback). The city chips came off this block;
   * city by city now lives in the Funnel by city block below it (FunnelByCity), one month at a time. */
  const city: string = ALL_CITIES;

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
      // THE CURRENT MONTH IS AN OPEN PERIOD. Its registrations are current while its downloads
      // are short — the month is part-elapsed AND Apple's daily feed lags — so its conversion is
      // computed on a denominator that has not finished arriving. The NUMBER is fine; the
      // COMPARISON to the closed rows beneath it is not. Marked, exactly as the partner page marks
      // a month that has not closed; neither excluded nor annualised.
      { name: monthLabel(end), meta: "current month", months: [end], partial: true },
      { name: monthLabel(prev), meta: "previous month", months: [prev] },
      { name: `${year} YTD`, meta: "year to date", months: ytd },
      {
        name: custom.length ? `${monthLabel(custom[0])} – ${monthLabel(custom[custom.length - 1])}` : "—",
        meta: "custom range",
        months: custom,
      },
    ].map((r) => {
      const monthsOf = new Set(r.months);
      // ALL CITIES uses the national cohort; a single city uses the city-dimensioned one. They are
      // built from the same users in the same pass on the server, so the only difference is which
      // rows are summed.
      const c = city === ALL_CITIES
        ? sumCohort(data.funnelByMonth, monthsOf)
        : sumCohortCity(data.funnelByMonthCity, monthsOf, city);
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
      // DOWNLOADS CANNOT BE ATTRIBUTED TO A CITY. Apple and Google report country and region,
      // never city. With a single city selected the cell is a DASH and its conversion is a dash —
      // NOT the national figure, and never a city's registrations divided by a national
      // denominator, which would invent a conversion rate that does not exist.
      const dlMonths = city === ALL_CITIES
        ? [...data.downloads.androidByMonth, ...data.downloads.iosByMonth].filter((d) => monthSet.has(d.m))
        : [];
      const downloads = dlMonths.length ? dlMonths.reduce((a, d) => a + d.count, 0) : null;
      const dlNote =
        city !== ALL_CITIES ? null
        : downloads == null ? null
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
      return { ...r, vals, dlNote, partial: "partial" in r ? Boolean(r.partial) : false,
               isCity: false, isTotal: false };
    });
  }, [data.funnelByMonth, data.funnelByMonthCity, data.downloads, city, customStart, customEnd, months]);

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          {/* TITLE ONLY. The cohort definition, the bar's meaning, the aggregate-ratio caveat and
              the store-coverage explanation all moved to the Player Data Room, which is the page
              for how a number is made. Nothing methodological is stated twice. */}
          <div className={styles.cardTitle}>Player funnel comparison</div>
        </div>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
          {scopeChip}
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

          {/* KEYED ON name, NOT meta. In compare mode every city row shares the same meta (the
              range), so keying on meta collapsed them to one row. */}
          {rows.map((r) => (
            <div key={r.name} className={styles.funnelRow} data-testid="funnel-row"
              data-city-row={r.isCity ? "1" : "0"} data-total-row={r.isTotal ? "1" : "0"}>
              <div className={styles.funnelPeriod}>
                <span className={styles.funnelPeriodName}>
                  {r.name}
                  {/* ONCE, ON THE ROW IT DESCRIBES. Clamping the current month to the real one is
                      not the same as pretending it closed, so the marker stays - it just stopped
                      being repeated across every conversion in the row. */}
                  {r.partial && (
                    <i data-testid="funnel-in-progress" className={styles.funnelInProgress}> · in progress</i>
                  )}
                </span>
                <span className={styles.funnelPeriodMeta}>{r.meta}</span>
              </div>
              {renderRowCells(r.vals, r.dlNote, r.partial, r.isCity)}
            </div>
          ))}
        </div>
      </div>

      {/* The note on signup city moved under the Funnel by city block (FunnelByCity), with the city rows it explains. */}
    </div>
  );
}

// Builds a row's stage + conversion cells. The conversion between stage i and i+1
// is b/a (b = vals[i+1], a = vals[i]); a dash when either is null or a is 0.
/* `opts.offset` names the first value's stage (1 = Registrations, for the Funnel by city block, which
 * has no Downloads column); `opts.deltas` is the change of each conversion against the previous month,
 * in points, printed under it (null = blank). Both default to the comparison table's behaviour. */
export function renderRowCells(vals: (number | null)[], dlNote?: string | null, partial = false, isCity = false,
  opts: { offset?: number; deltas?: (number | null)[] } = {}): ReactNode[] {
  const offset = opts.offset ?? 0;
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
      <div key={`s${i}`} data-testid="funnel-cell" data-stage={i + offset === 0 ? "downloads" : STAGES[i + offset].label.toLowerCase().replace(/\s+/g, "-")}
        className={`${styles.funnelStage} ${stageDashed ? styles.funnelStageNull : ""}`}>
        <span className={styles.funnelSnum}>{isNull ? "—" : fmtInt(v)}</span>
        {/* STORE COVERAGE, on the Downloads cell only. A bare combined number on a row the two
            stores do not both cover would read as one metric when it is two spliced together. */}
        {i + offset === 0 && dlNote && (
          <span className={styles.funnelDlNote} data-testid="funnel-dl-coverage">{dlNote}</span>
        )}
        {/* ── THE DASH CARRIES ITS REASON, ON THE CELL ─────────────────────────────────────────
            The footnote says it once for the table; this says it where the dash is. A dash with no
            reason beside it reads as missing data that somebody could go and fetch, and this one
            cannot be fetched: the stores report country and region and there is no city dimension to
            split. A number here would be invented. */}
        {i + offset === 0 && isCity && (
          <span className={styles.funnelDlNote} data-testid="funnel-why-dash">Installs carry no city</span>
        )}
        {isNull ? (
          <span className={styles.funnelSbar} style={{ background: "transparent" }} />
        ) : (
          <span className={styles.funnelSbar}>
            <span className={styles.funnelSfill} style={{ width: `${share}%`, background: STAGES[i + offset].hue ?? "var(--forest)" }} />
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
          {/* ── NO "SO FAR" ON THE CONVERSIONS ────────────────────────────────────────────────
              It said the same thing five times in one row, and five copies of a caveat read as five
              separate caveats. The row says it ONCE instead, in its own label. The pill keeps its
              open-period styling and its title, so the reason is still one hover away on the number
              it applies to. */}
          <span
            className={`${styles.funnelCpill} ${known ? "" : styles.funnelCpillNone} ${partial && known ? styles.funnelCpillPartial : ""}`}
            title={partial && known ? "This month is still open and Apple's daily feed lags, so the denominator is incomplete. Not comparable to the closed rows below." : undefined}
          >
            {known ? `${((b! / a!) * 100).toFixed(1)}%` : "—"}
          </span>
          {opts.deltas && <Delta pts={known ? opts.deltas[i] ?? null : null} />}
        </div>,
      );
    }
  });
  return out;
}

/* THE CHANGE AGAINST THE PREVIOUS MONTH, in percentage points: green up, red down. Blank when the
 * previous month has nothing to compare (the slot keeps its height so rows stay aligned). */
function Delta({ pts }: { pts: number | null }) {
  if (pts == null || !Number.isFinite(pts)) return <span className={styles.funnelDelta} data-testid="funnel-delta" data-empty="1">&nbsp;</span>;
  const r = Math.round(pts * 10) / 10;
  const cls = r > 0 ? styles.funnelDeltaUp : r < 0 ? styles.funnelDeltaDown : "";
  return (
    <span className={`${styles.funnelDelta} ${cls}`} data-testid="funnel-delta" data-pts={r.toFixed(1)} title="Change against the previous month">
      {r > 0 ? "▲ " : r < 0 ? "▼ " : ""}{Math.abs(r).toFixed(1)} pts
    </span>
  );
}
