"use client";

import { useMemo, useState } from "react";
import type { BehaviorPoint, GrowthData } from "@/lib/growthAnalytics";
import { metricValue, type GridMetric } from "@/lib/growthMetricGrid";
import styles from "./growth.module.css";
import { downloadCsv, fmtInt, monthLabel } from "./format";

// PART 7: Player Data Room. Metric (registrations / new / total / spots), a month
// range (collapsed from the mockup's year range — play metrics have only one
// year; registrations may reach back to 2023), group by Matchday (network) /
// City / Field, a geography filter, and CSV. Total players is a distinct count,
// so it is read per-group from the server, never summed across columns.
type Metric = "registrations" | "newPlayers" | "totalPlayers" | "spots";
type Group = "matchday" | "city" | "field";

const METRIC_LABEL: Record<Metric, string> = {
  registrations: "Registrations",
  newPlayers: "New players",
  totalPlayers: "Total players",
  spots: "Spots booked",
};

export default function DataRoomPanel({ data }: { data: GrowthData }) {
  const [metric, setMetric] = useState<Metric>("spots");
  const [group, setGroup] = useState<Group>("city");
  const [geo, setGeo] = useState("All");

  const axis = data.behaviorOverall.map((p) => p.m);
  const regFloor = data.behaviorOverall.find((p) => (p.registrations ?? 0) > 0)?.m ?? axis[0];
  const minMonth = metric === "registrations" ? regFloor : data.floors.play;
  const rangeMonths = axis.filter((m) => m >= minMonth);
  const [start, setStart] = useState(rangeMonths[0] ?? data.floors.play);
  const [end, setEnd] = useState(axis[axis.length - 1] ?? data.floors.play);

  // registrations has no field dimension.
  const groupOptions: [Group, string][] = [
    ["matchday", "Matchday (network)"],
    ["city", "City"],
    ...(metric === "registrations" ? [] : ([["field", "Field"]] as [Group, string][])),
  ];
  const effectiveGroup: Group = metric === "registrations" && group === "field" ? "city" : group;

  const columns = useMemo(() => {
    // Shared with the Player behavior panel: the ONE metric-value computation,
    // so the two can't derive a metric differently (growthMetricGrid.metricValue).
    const pick = (pts: BehaviorPoint[], m: string) => {
      const p = pts.find((x) => x.m === m);
      return metricValue(p, metric as GridMetric);
    };
    if (effectiveGroup === "matchday") {
      const pts = geo === "All" ? data.behaviorOverall : data.behaviorByCity[geo] ?? [];
      return [{ key: geo === "All" ? "Network" : geo, pick: (m: string) => pick(pts, m) }];
    }
    if (effectiveGroup === "city") {
      const cs = geo === "All" ? data.cities : [geo];
      return cs.map((c) => ({ key: c, pick: (m: string) => pick(data.behaviorByCity[c] ?? [], m) }));
    }
    const entries = Object.entries(data.behaviorByField)
      .filter(([, v]) => geo === "All" || v.city === geo)
      .sort((a, b) => a[1].label.localeCompare(b[1].label));
    return entries.map(([, v]) => ({ key: `${v.label} · ${v.city}`, pick: (m: string) => pick(v.points, m) }));
  }, [effectiveGroup, geo, metric, data]);

  const lo = start <= end ? start : end;
  const hi = start <= end ? end : start;
  const shownMonths = axis.filter((m) => m >= lo && m <= hi && m >= minMonth);

  function exportCsv() {
    const header = ["Month", ...columns.map((c) => c.key)];
    const body = shownMonths.map((m) => [
      monthLabel(m),
      ...columns.map((c) => {
        const v = c.pick(m);
        return v == null ? "" : v;
      }),
    ]);
    downloadCsv(`data-room-${metric}-${effectiveGroup}-${lo}_${hi}.csv`, [header, ...body]);
  }

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Player data room</div>
          <div className={styles.cardSub}>
            Pick a metric, a month range, how to group it and a geography, then export.
          </div>
        </div>
        <button type="button" className={styles.btn} onClick={exportCsv}>
          Download CSV
        </button>
      </div>

      <div className={styles.controlsRow} style={{ marginBottom: 14 }}>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="drMetric">
            Metric
          </label>
          <select
            id="drMetric"
            className={styles.control}
            value={metric}
            onChange={(e) => setMetric(e.target.value as Metric)}
          >
            {(Object.keys(METRIC_LABEL) as Metric[]).map((m) => (
              <option key={m} value={m}>
                {METRIC_LABEL[m]}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="drGroup">
            Group by
          </label>
          <select
            id="drGroup"
            className={styles.control}
            value={effectiveGroup}
            onChange={(e) => setGroup(e.target.value as Group)}
          >
            {groupOptions.map(([g, txt]) => (
              <option key={g} value={g}>
                {txt}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="drGeo">
            Geography
          </label>
          <select id="drGeo" className={styles.control} value={geo} onChange={(e) => setGeo(e.target.value)}>
            <option value="All">All cities</option>
            {data.cities.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="drStart">
            From
          </label>
          <input
            id="drStart"
            className={styles.control}
            type="month"
            min={minMonth}
            max={axis[axis.length - 1]}
            value={start < minMonth ? minMonth : start}
            onChange={(e) => setStart(e.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="drEnd">
            To
          </label>
          <input
            id="drEnd"
            className={styles.control}
            type="month"
            min={minMonth}
            max={axis[axis.length - 1]}
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </div>
      </div>

      <div className={`${styles.tableWrap} ${styles.scrollBody}`}>
        <table className={styles.recordTable}>
          <thead>
            <tr>
              <th>Month</th>
              {columns.map((c) => (
                <th key={c.key} className="num">
                  {c.key}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shownMonths.map((m) => (
              <tr key={m}>
                <td>{monthLabel(m)}</td>
                {columns.map((c) => {
                  const v = c.pick(m);
                  return (
                    <td key={c.key} className="num">
                      {v == null ? <span className={styles.tableGap}>—</span> : fmtInt(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={styles.footnote}>
        {metric === "totalPlayers"
          ? "Total players is a distinct headcount, so city and field columns do not add up to the network total — a player active in two fields is counted once in each."
          : "Registrations can reach back to 2023; new players, total players and spots exist only from January 2026."}
      </div>
    </div>
  );
}
