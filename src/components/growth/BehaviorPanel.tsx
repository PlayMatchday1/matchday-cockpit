"use client";

import { useMemo, useState } from "react";
import type { BehaviorPoint, GrowthData } from "@/lib/growthAnalytics";
import type { Period } from "./GlobalPeriod";
import styles from "./growth.module.css";
import { downloadCsv, fmtInt, monthLabel } from "./format";

// PART 4: Player behavior is a TABLE (the design's growthSummary), not a chart —
// metrics as rows, months as columns, with Export and a City/Field breakdown.
// Registrations run from 2023; play-derived metrics only from 2026, shown as an
// em-dash before they exist (never zero). Total players is a distinct headcount
// (non-additive), so the breakdown shows it at the end of the range, not summed.
const METRICS: { key: keyof Omit<BehaviorPoint, "m">; label: string }[] = [
  { key: "registrations", label: "Registrations" },
  { key: "newPlayers", label: "New players" },
  { key: "totalPlayers", label: "Total players" },
  { key: "spots", label: "Spots booked" },
];

export default function BehaviorPanel({ data, period }: { data: GrowthData; period: Period }) {
  const [view, setView] = useState<"city" | "field">("city");
  const months = data.behaviorOverall.map((p) => p.m).filter((m) => m >= period.start && m <= period.end);
  const byMonth = useMemo(() => new Map(data.behaviorOverall.map((p) => [p.m, p])), [data.behaviorOverall]);

  const cell = (m: string, key: keyof Omit<BehaviorPoint, "m">) => {
    const p = byMonth.get(m);
    const v = p ? p[key] : null;
    return v == null ? <span className={styles.tableGap}>—</span> : fmtInt(v);
  };

  // detail: entities × metrics over the window (additive summed; total = end-of-range).
  const endMonth = months[months.length - 1] ?? period.end;
  const detail = useMemo(() => {
    const sumOver = (pts: BehaviorPoint[], key: keyof Omit<BehaviorPoint, "m">) =>
      pts.filter((p) => p.m >= period.start && p.m <= period.end).reduce((a, p) => a + (p[key] ?? 0), 0);
    const endVal = (pts: BehaviorPoint[], key: keyof Omit<BehaviorPoint, "m">) =>
      pts.find((p) => p.m === endMonth)?.[key] ?? 0;
    if (view === "city") {
      return data.cities.map((c) => {
        const pts = data.behaviorByCity[c] ?? [];
        return {
          name: c,
          registrations: sumOver(pts, "registrations"),
          newPlayers: sumOver(pts, "newPlayers"),
          totalPlayers: endVal(pts, "totalPlayers"),
          spots: sumOver(pts, "spots"),
        };
      });
    }
    return Object.entries(data.behaviorByField)
      .sort((a, b) => a[1].label.localeCompare(b[1].label))
      .map(([, v]) => ({
        name: `${v.label} · ${v.city}`,
        registrations: null as number | null,
        newPlayers: sumOver(v.points, "newPlayers"),
        totalPlayers: endVal(v.points, "totalPlayers"),
        spots: sumOver(v.points, "spots"),
      }));
  }, [view, data, period, endMonth]);

  function exportCsv() {
    const header = ["Metric", ...months.map((m) => monthLabel(m))];
    const body = METRICS.map((mt) => [
      mt.label,
      ...months.map((m) => {
        const p = byMonth.get(m);
        const v = p ? p[mt.key] : null;
        return v == null ? "" : v;
      }),
    ]);
    downloadCsv(`player-behavior-${period.start}_${period.end}.csv`, [header, ...body]);
  }

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Player behavior</div>
          <div className={styles.cardSub}>
            Registrations, new players, total players and spots booked · oldest to newest, over the selected period.
          </div>
        </div>
        <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={exportCsv}>
          Export
        </button>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.dataTable}>
          <thead>
            <tr>
              <th>Metric</th>
              {months.map((m) => (
                <th key={m}>{monthLabel(m)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {METRICS.map((mt) => (
              <tr key={mt.key}>
                <td>{mt.label}</td>
                {months.map((m) => (
                  <td key={m}>{cell(m, mt.key)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={styles.controlsRow} style={{ margin: "16px 0 10px" }}>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>Breakdown</span>
          <div className={styles.segmented}>
            {(
              [
                ["city", "City View"],
                ["field", "Field View"],
              ] as ["city" | "field", string][]
            ).map(([v, txt]) => (
              <button
                key={v}
                type="button"
                className={`${styles.segBtn} ${view === v ? styles.segBtnActive : ""}`}
                aria-pressed={view === v}
                onClick={() => setView(v)}
              >
                {txt}
              </button>
            ))}
          </div>
        </div>
        <span className={styles.summaryLine}>
          {view === "city" ? "By city" : "By field"} · additive metrics summed over the range; total players at{" "}
          {monthLabel(endMonth)}
        </span>
      </div>

      <div className={`${styles.tableWrap} ${styles.scrollBody}`}>
        <table className={styles.recordTable}>
          <thead>
            <tr>
              <th>{view === "city" ? "City" : "Field"}</th>
              <th className="num">Registrations</th>
              <th className="num">New players</th>
              <th className="num">Total players</th>
              <th className="num">Spots booked</th>
            </tr>
          </thead>
          <tbody>
            {detail.map((r) => (
              <tr key={r.name}>
                <td>{r.name}</td>
                <td className="num">{r.registrations == null ? <span className={styles.tableGap}>—</span> : fmtInt(r.registrations)}</td>
                <td className="num">{fmtInt(r.newPlayers)}</td>
                <td className="num">{fmtInt(r.totalPlayers)}</td>
                <td className="num">{fmtInt(r.spots)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
