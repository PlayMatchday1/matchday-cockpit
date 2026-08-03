"use client";

import styles from "./growth.module.css";
import { monthLabel } from "./format";

// PART 3: one page-level TIME PERIOD control (Start Month/Year · End Month/Year).
// The KPI row and funnel read from it, so there is a single shared window instead
// of every panel carrying its own. `months` is the full available axis
// ("YYYY-MM"); the control clamps any picked combination into that range.
export type Period = { start: string; end: string };

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default function GlobalPeriod({
  months,
  period,
  setPeriod,
}: {
  months: string[];
  period: Period;
  setPeriod: (p: Period) => void;
}) {
  const min = months[0];
  const max = months[months.length - 1];
  const years = [...new Set(months.map((m) => m.slice(0, 4)))];

  const clamp = (k: string) => (k < min ? min : k > max ? max : k);
  const setEdge = (edge: "start" | "end", y: string, mIdx: number) => {
    const key = clamp(`${y}-${String(mIdx + 1).padStart(2, "0")}`);
    const next: Period = { ...period, [edge]: key };
    // keep start ≤ end
    if (next.start > next.end) {
      if (edge === "start") next.end = next.start;
      else next.start = next.end;
    }
    setPeriod(next);
  };

  const edge = (which: "start" | "end") => {
    const [y, m] = period[which].split("-");
    const mIdx = Number(m) - 1;
    return (
      <>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={`period-${which}-month`}>
            {which === "start" ? "Start month" : "End month"}
          </label>
          <select
            id={`period-${which}-month`}
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
          <label className={styles.fieldLabel} htmlFor={`period-${which}-year`}>
            {which === "start" ? "Start year" : "End year"}
          </label>
          <select
            id={`period-${which}-year`}
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
    <div className={styles.periodCard}>
      <div className={styles.periodTop}>
        <span className={styles.periodTitle}>Time period</span>
        <span className={styles.periodValue}>
          {monthLabel(period.start)} – {monthLabel(period.end)}
        </span>
      </div>
      <div className={styles.dateGrid}>
        {edge("start")}
        {edge("end")}
      </div>
    </div>
  );
}
