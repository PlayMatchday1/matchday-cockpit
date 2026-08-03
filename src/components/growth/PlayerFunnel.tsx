"use client";

import { useMemo, useState } from "react";
import type { GrowthData } from "@/lib/growthAnalytics";
import type { Period } from "./GlobalPeriod";
import styles from "./growth.module.css";
import { fmtInt, monthLabel } from "./format";

// PART 1 + 2: a nested COHORT funnel rendered as a matrix — six stages left to
// right (Downloads · Registrations · 1 · 3 · 5 · 10 matches), four period rows at
// once (current month, previous month, year-to-date, custom range). Each play
// stage counts, of the users who completed sign-up in that window, how many went
// on to play ≥N non-cancelled non-fake matches EVER (lifetime). Every stage is a
// strict subset of the prior, so no conversion can exceed 100% — asserted below.
// Downloads is the one non-nested step (no per-person link).

const STAGES = ["Downloads", "Registrations", "1 match", "3 matches", "5 matches", "10 matches"];

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

export default function PlayerFunnel({ data, period }: { data: GrowthData; period: Period }) {
  const months = data.behaviorOverall.map((p) => p.m);
  const [customStart, setCustomStart] = useState(period.start);
  const [customEnd, setCustomEnd] = useState(period.end);

  const rows = useMemo(() => {
    // "Current" is always the latest data month (independent of the global period,
    // which may end earlier). Custom is driven by the Custom start/end inputs.
    const end = months[months.length - 1];
    const endIdx = months.indexOf(end);
    const prev = endIdx > 0 ? months[endIdx - 1] : end;
    const year = end.slice(0, 4);
    const ytd = months.filter((m) => m.startsWith(year) && m <= end);
    const lo = customStart <= customEnd ? customStart : customEnd;
    const hi = customStart <= customEnd ? customEnd : customStart;
    const custom = months.filter((m) => m >= lo && m <= hi);
    return [
      { key: "current", cls: styles.rowCurrent, label: monthLabel(end), months: [end] },
      { key: "previous", cls: styles.rowPrevious, label: monthLabel(prev), months: [prev] },
      { key: "year", cls: styles.rowYear, label: `${year} YTD`, months: ytd },
      {
        key: "custom",
        cls: styles.rowCustom,
        label: custom.length ? `${monthLabel(custom[0])} – ${monthLabel(custom[custom.length - 1])}` : "—",
        months: custom,
      },
    ].map((r) => {
      const c = sumCohort(data.funnelByMonth, new Set(r.months));
      // Assert nested — a violation is a bug, not a number to render.
      const vals = [null, c.registrations, c.played1, c.played3, c.played5, c.played10] as (number | null)[];
      for (let i = 2; i < vals.length; i++) {
        if ((vals[i] as number) > (vals[i - 1] as number)) {
          // eslint-disable-next-line no-console
          console.error(`Funnel not nested in ${r.key} row at stage ${i}`, vals);
        }
      }
      return { ...r, vals };
    });
  }, [data.funnelByMonth, customStart, customEnd, months]);

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Player funnel comparison</div>
          <div className={styles.cardSub}>
            Counts and step-to-step conversion, shown left to right. Each play stage is the share of that period&rsquo;s
            sign-up cohort who went on to play that many non-cancelled matches <b>ever</b> — so every stage is a subset of
            the one before it.
          </div>
        </div>
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

      <div className={styles.funnelScroll}>
        <div className={styles.funnelMatrix}>
          {/* header row */}
          <div className={`${styles.funnelRow} ${styles.funnelHeader}`}>
            <div className={styles.funnelPeriod}>Period</div>
            {STAGES.map((s, i) => (
              <FragmentCell key={s} stage={s} isLast={i === STAGES.length - 1} header />
            ))}
          </div>
          {/* period rows */}
          {rows.map((r) => (
            <div key={r.key} className={`${styles.funnelRow} ${r.cls}`}>
              <div className={styles.funnelPeriod}>{r.label}</div>
              {r.vals.map((v, i) => (
                <FragmentCell
                  key={i}
                  stage={STAGES[i]}
                  value={v}
                  prev={i > 0 ? r.vals[i - 1] : null}
                  isLast={i === r.vals.length - 1}
                  firstArrow={i === 0}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className={styles.funnelNote}>
        &ldquo;Went on to play&rdquo; means <b>ever</b> (lifetime matches), counted for the users who completed sign-up in
        each period. Downloads has no per-person source, so its column is an em-dash and the Downloads → Registrations
        step is an <b>aggregate ratio, not a per-user conversion</b>; every later step is a real per-person conversion.
      </div>
    </div>
  );
}

// One stage cell plus (unless last) the conversion cell that follows it.
function FragmentCell({
  stage,
  value,
  prev,
  isLast,
  header,
  firstArrow,
}: {
  stage: string;
  value?: number | null;
  prev?: number | null;
  isLast: boolean;
  header?: boolean;
  firstArrow?: boolean;
}) {
  const stageEl = header ? (
    <div className={`${styles.funnelStage} ${styles.funnelStageHeader}`}>
      <span>{stage}</span>
    </div>
  ) : (
    <div className={styles.funnelStage}>
      <b>{value == null ? "—" : fmtInt(value)}</b>
      <span>{stage}</span>
    </div>
  );

  if (isLast) return stageEl;

  let convEl;
  if (header) {
    convEl = <div className={styles.funnelConvHeader}>→</div>;
  } else if (firstArrow) {
    convEl = <div className={styles.funnelAggNote}>aggregate ratio (no per-user link)</div>;
  } else {
    const pct = prev ? ((value as number) / (prev as number)) * 100 : 0;
    convEl = (
      <div className={styles.funnelConversion}>
        {Math.min(pct, 100).toFixed(1)}%<small>conversion</small>
      </div>
    );
  }
  return (
    <>
      {stageEl}
      {convEl}
    </>
  );
}
