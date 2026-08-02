"use client";

import { useMemo, useState } from "react";
import type { GrowthData } from "@/lib/growthAnalytics";
import styles from "./growth.module.css";
import { fmtInt, fmtPct, monthLabel } from "./format";

type Period = "current" | "previous" | "year" | "custom";

// Funnel: Downloads → Registrations → Played ≥1 → Played ≥5, over a chosen
// window. The funnel mixes two clocks (PART 2): registrations count users
// CREATED in the window; play steps count players who PLAYED in the window. That
// is stated on the card. Downloads→Registrations is an aggregate ratio of two
// unlinked totals (store accounts can't be joined to a person) — and it can't
// even be computed because downloads have no source. The Played1→Played5 step is
// a genuine per-person conversion (played5 ⊆ played1, same window).
export default function PlayerFunnel({ data }: { data: GrowthData }) {
  const months = data.playMonths;
  const [period, setPeriod] = useState<Period>("current");
  const [customStart, setCustomStart] = useState(months[0] ?? "2026-01");
  const [customEnd, setCustomEnd] = useState(months[months.length - 1] ?? "2026-08");

  const window = useMemo(() => {
    if (period === "current") return [months[months.length - 1]];
    if (period === "previous") return months.length >= 2 ? [months[months.length - 2]] : [months[months.length - 1]];
    if (period === "year") {
      const yr = (months[months.length - 1] ?? "2026").slice(0, 4);
      return months.filter((m) => m.startsWith(yr));
    }
    const lo = customStart <= customEnd ? customStart : customEnd;
    const hi = customStart <= customEnd ? customEnd : customStart;
    return months.filter((m) => m >= lo && m <= hi);
  }, [period, months, customStart, customEnd]);

  const windowSet = useMemo(() => new Set(window), [window]);
  const windowIdx = useMemo(
    () => new Set(window.map((m) => months.indexOf(m))),
    [window, months],
  );

  const registrations = data.registrationsByMonth
    .filter((r) => windowSet.has(r.m))
    .reduce((a, r) => a + r.count, 0);

  const { played1, played5 } = useMemo(() => {
    let p1 = 0;
    let p5 = 0;
    for (const pl of data.players) {
      let inWin = 0;
      for (const idx of pl.plays) if (windowIdx.has(idx)) inWin++;
      if (inWin >= 1) p1++;
      if (inWin >= 5) p5++;
    }
    return { played1: p1, played5: p5 };
  }, [data.players, windowIdx]);

  const label =
    period === "custom" && window.length
      ? `${monthLabel(window[0])} – ${monthLabel(window[window.length - 1])}`
      : period === "year"
        ? `${(months[months.length - 1] ?? "2026").slice(0, 4)} year to date`
        : monthLabel(window[0] ?? months[months.length - 1]);

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Player funnel</div>
          <div className={styles.cardSub}>{label}</div>
        </div>
        <div className={styles.segmented} role="tablist" aria-label="Funnel period">
          {(
            [
              ["current", "Current month"],
              ["previous", "Previous month"],
              ["year", "Current year"],
              ["custom", "Custom period"],
            ] as [Period, string][]
          ).map(([p, txt]) => (
            <button
              key={p}
              type="button"
              className={`${styles.segBtn} ${period === p ? styles.segBtnActive : ""}`}
              aria-pressed={period === p}
              onClick={() => setPeriod(p)}
            >
              {txt}
            </button>
          ))}
        </div>
      </div>

      {period === "custom" && (
        <div className={styles.customDates}>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="funnelStart">
              Start month
            </label>
            <input
              id="funnelStart"
              className={styles.control}
              type="month"
              min={months[0]}
              max={months[months.length - 1]}
              value={customStart}
              onChange={(e) => setCustomStart(e.target.value)}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="funnelEnd">
              End month
            </label>
            <input
              id="funnelEnd"
              className={styles.control}
              type="month"
              min={months[0]}
              max={months[months.length - 1]}
              value={customEnd}
              onChange={(e) => setCustomEnd(e.target.value)}
            />
          </div>
        </div>
      )}

      <div className={styles.funnel}>
        <FunnelStep bg="var(--gold-dot)" ink="var(--ink)" label="App downloads" value={null} />
        <div className={`${styles.funnelConv} ${styles.funnelConvAggregate}`}>
          Downloads → Registrations: aggregate ratio, not per-user conversion (store sync not connected)
        </div>
        <FunnelStep bg="var(--forest)" ink="var(--surface)" label="Registrations (created in window)" value={registrations} />
        <div className={styles.funnelConv}>
          Registrations → Played ≥1: {fmtPct(registrations ? played1 / registrations : 0)} — two clocks (created vs played)
        </div>
        <FunnelStep bg="#1f6d4e" ink="var(--surface)" label="Played ≥1 match" value={played1} />
        <div className={styles.funnelConv}>
          Played ≥1 → Played ≥5: {fmtPct(played1 ? played5 / played1 : 0)} — per-person conversion
        </div>
        <FunnelStep bg="var(--accent)" ink="var(--ink)" label="Played ≥5 matches" value={played5} />
      </div>

      <div className={styles.funnelNote}>
        Registrations count users <b>created</b> in the window; the two play steps count players who <b>played</b> in
        it — the funnel deliberately mixes those two clocks. The first step (downloads → registrations) is an aggregate
        ratio of two totals that cannot be linked to a person; every later step is a real per-person conversion.
      </div>
    </div>
  );
}

function FunnelStep({
  bg,
  ink,
  label,
  value,
}: {
  bg: string;
  ink: string;
  label: string;
  value: number | null;
}) {
  return (
    <div className={styles.funnelStep} style={{ background: bg, color: ink }}>
      <span className={styles.funnelStepLabel}>{label}</span>
      <span className={styles.funnelStepValue}>
        {value == null ? "—" : fmtInt(value)}
      </span>
    </div>
  );
}
