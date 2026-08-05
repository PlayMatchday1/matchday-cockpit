"use client";

import { useEffect, useRef, useState } from "react";
import type { Period } from "./GlobalPeriod";
import { monthLabel } from "./format";
import styles from "./growth.module.css";

// DEFECT 2: the sticky period bar. Replaces GlobalPeriod. At rest it is one line
// (label · range · "applies to N of 7"); a Change button reveals the four custom
// Start/End selects (ported from GlobalPeriod). Quick ranges each END on the LAST
// COMPLETE month — never the current partial month — computed from generatedAt.
// The chosen range is written to the shared `period` state the cards consume.
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
type Quick = "3" | "6" | "12" | "ytd" | "";

// Month arithmetic on a "YYYY-MM" key (no Date(), no timezone drift).
function addMonths(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

const QUICKS: { q: Exclude<Quick, "">; label: string }[] = [
  { q: "3", label: "Last 3 months" },
  { q: "6", label: "Last 6 months" },
  { q: "12", label: "Last 12 months" },
  { q: "ytd", label: "YTD" },
];

export default function PeriodBar({
  months,
  period,
  setPeriod,
  generatedAt,
  followCount,
  cardCount,
}: {
  months: string[];
  period: Period;
  setPeriod: (p: Period) => void;
  generatedAt: string;
  followCount: number;
  cardCount: number;
}) {
  // Default selection = Last 6 months (matches the dashboard's initial period).
  const [quick, setQuick] = useState<Quick>("6");
  const [open, setOpen] = useState(false);
  const [stuck, setStuck] = useState(false);
  const sentinel = useRef<HTMLDivElement | null>(null);

  // The pin comes from position:sticky; this observer only toggles the shadow.
  // The sentinel sits 1px above the bar, so it leaves the viewport exactly when
  // the bar pins to top:0 → stuck = not intersecting.
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setStuck(!e.isIntersecting), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const min = months[0];
  const max = months[months.length - 1];
  const years = [...new Set(months.map((m) => m.slice(0, 4)))];
  const clamp = (k: string) => (k < min ? min : k > max ? max : k);

  // Current month from the aggregate's stamp; last COMPLETE month is the one before.
  const lastComplete = addMonths(generatedAt.slice(0, 7), -1);

  const applyQuick = (q: Exclude<Quick, "">) => {
    const end = clamp(lastComplete);
    const start =
      q === "ytd"
        ? clamp(`${end.slice(0, 4)}-01`) // Jan of the end month's year
        : clamp(addMonths(lastComplete, -(Number(q) - 1))); // end − (N−1) months
    setQuick(q);
    setPeriod({ start, end });
  };

  // Custom-range selects — logic ported verbatim from GlobalPeriod, plus clearing
  // the quick-pill highlight on any manual change.
  const setEdge = (which: "start" | "end", y: string, mIdx: number) => {
    const key = clamp(`${y}-${String(mIdx + 1).padStart(2, "0")}`);
    const next: Period = { ...period, [which]: key };
    if (next.start > next.end) {
      if (which === "start") next.end = next.start;
      else next.start = next.end;
    }
    setQuick("");
    setPeriod(next);
  };

  const edge = (which: "start" | "end") => {
    const [y, m] = period[which].split("-");
    const mIdx = Number(m) - 1;
    return (
      <>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={`pb-${which}-month`}>
            {which === "start" ? "Start month" : "End month"}
          </label>
          <select
            id={`pb-${which}-month`}
            className={styles.control}
            value={mIdx}
            onChange={(e) => setEdge(which, y, Number(e.target.value))}
          >
            {MON.map((mm, i) => (
              <option key={i} value={i}>
                {mm}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={`pb-${which}-year`}>
            {which === "start" ? "Start year" : "End year"}
          </label>
          <select
            id={`pb-${which}-year`}
            className={styles.control}
            value={y}
            onChange={(e) => setEdge(which, e.target.value, mIdx)}
          >
            {years.map((yy) => (
              <option key={yy} value={yy}>
                {yy}
              </option>
            ))}
          </select>
        </div>
      </>
    );
  };

  return (
    <div className={`${styles.periodbar}${stuck ? ` ${styles.pbStuck}` : ""}`}>
      <div ref={sentinel} className={styles.pbSentinel} aria-hidden="true" />
      <div className={styles.pbInner}>
        <div className={styles.pbTop}>
          <div className={styles.pbLeft}>
            <span className={styles.pbLabel}>Time period</span>
            <span className={styles.pbVal}>
              {monthLabel(period.start)} – {monthLabel(period.end)}
            </span>
            <span className={styles.pbScope}>
              applies to {followCount} of {cardCount} cards
            </span>
          </div>
          <div className={styles.pbActions}>
            {QUICKS.map(({ q, label }) => (
              <button
                key={q}
                type="button"
                className={`${styles.qbtn}${quick === q ? ` ${styles.qbtnOn}` : ""}`}
                aria-pressed={quick === q}
                onClick={() => applyQuick(q)}
              >
                {label}
              </button>
            ))}
            <button type="button" className={styles.pbToggle} onClick={() => setOpen((v) => !v)}>
              {open ? "Done" : "Change"}
            </button>
          </div>
        </div>
        <div className={`${styles.pbBody}${open ? "" : ` ${styles.pbBodyHidden}`}`}>
          {edge("start")}
          {edge("end")}
        </div>
      </div>
    </div>
  );
}
