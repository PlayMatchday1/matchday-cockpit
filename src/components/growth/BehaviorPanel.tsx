"use client";

import { useMemo, useState } from "react";
import type { BehaviorPoint, GrowthData } from "@/lib/growthAnalytics";
import styles from "./growth.module.css";
import { LineChart, type Series } from "./charts";
import { fmtInt, monthLabel, monthShort } from "./format";

type Metric = "general" | "registrations" | "newPlayers" | "totalPlayers" | "spots";
type Scope = "network" | "city" | "field";

const SERIES_META: { key: Exclude<Metric, "general">; label: string; color: string }[] = [
  { key: "registrations", label: "Registrations", color: "var(--forest)" },
  { key: "newPlayers", label: "New players", color: "var(--accent)" },
  { key: "totalPlayers", label: "Total players", color: "var(--gold-dot)" },
  { key: "spots", label: "Spots booked", color: "var(--ns-ink)" },
];

// PART 3: registrations / new / total / spots over time, with a Network / City /
// Field scope. Registrations run from 2023-03; every play-derived series starts
// 2026-01 and is simply NOT DRAWN before then (never plotted at zero) with a gold
// "play data starts" marker — so nobody reads the empty region as "we had no
// players" (PART 1). Total players is a distinct count (non-additive), so it is
// read from the server's per-scope precompute, never summed.
export default function BehaviorPanel({ data }: { data: GrowthData }) {
  const [metric, setMetric] = useState<Metric>("general");
  const [scope, setScope] = useState<Scope>("network");
  const cityOptions = data.cities;
  const fieldEntries = Object.entries(data.behaviorByField).sort((a, b) => a[1].label.localeCompare(b[1].label));
  const [city, setCity] = useState(cityOptions[0] ?? "");
  const [field, setField] = useState(fieldEntries[0]?.[0] ?? "");

  const points: BehaviorPoint[] =
    scope === "network"
      ? data.behaviorOverall
      : scope === "city"
        ? data.behaviorByCity[city] ?? []
        : data.behaviorByField[field]?.points ?? [];

  const axis = points.map((p) => p.m);
  const playFloorIdx = axis.indexOf(data.floors.play);
  const regDisabled = scope === "field"; // fields carry no registrations

  const visible = useMemo(() => {
    const keys: Exclude<Metric, "general">[] =
      metric === "general"
        ? SERIES_META.filter((s) => !(regDisabled && s.key === "registrations")).map((s) => s.key)
        : [metric];
    return SERIES_META.filter((s) => keys.includes(s.key));
  }, [metric, regDisabled]);

  const series: Series[] = visible.map((s) => ({
    label: s.label,
    color: s.color,
    values: points.map((p) => p[s.key]),
  }));

  const startMarkers =
    playFloorIdx > 0 && visible.some((s) => s.key !== "registrations")
      ? [{ index: playFloorIdx, label: "play data starts" }]
      : [];

  // values table: months as rows; blanks before a series exists (not zero).
  const tableMonths = axis.filter((_, i) => points[i] && series.some((s) => s.values[i] != null));

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Player behavior evolution</div>
          <div className={styles.cardSub}>
            Registrations, new players, active players and spots booked over time
          </div>
        </div>
        <div className={styles.segmented} aria-label="Metric">
          {(
            [
              ["general", "General"],
              ["registrations", "Registrations"],
              ["newPlayers", "New players"],
              ["totalPlayers", "Total players"],
              ["spots", "Spots"],
            ] as [Metric, string][]
          ).map(([m, txt]) => (
            <button
              key={m}
              type="button"
              disabled={regDisabled && m === "registrations"}
              className={`${styles.segBtn} ${metric === m ? styles.segBtnActive : ""}`}
              aria-pressed={metric === m}
              onClick={() => setMetric(m)}
              style={regDisabled && m === "registrations" ? { opacity: 0.4, cursor: "not-allowed" } : undefined}
            >
              {txt}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.controlsRow} style={{ marginBottom: 12 }}>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>View</span>
          <div className={styles.segmented}>
            {(
              [
                ["network", "Network"],
                ["city", "By city"],
                ["field", "By field"],
              ] as [Scope, string][]
            ).map(([s, txt]) => (
              <button
                key={s}
                type="button"
                className={`${styles.segBtn} ${scope === s ? styles.segBtnActive : ""}`}
                aria-pressed={scope === s}
                onClick={() => setScope(s)}
              >
                {txt}
              </button>
            ))}
          </div>
        </div>
        {scope === "city" && (
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="behaviorCity">
              City
            </label>
            <select id="behaviorCity" className={styles.control} value={city} onChange={(e) => setCity(e.target.value)}>
              {cityOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        )}
        {scope === "field" && (
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="behaviorField">
              Field
            </label>
            <select id="behaviorField" className={styles.control} value={field} onChange={(e) => setField(e.target.value)}>
              {fieldEntries.map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label} · {v.city}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <LineChart axis={axis} series={series} startMarkers={startMarkers} formatAxis={monthShort} formatValue={fmtInt} />

      <div className={styles.legend}>
        {series.map((s) => (
          <span key={s.label} className={styles.legendItem}>
            <i className={styles.legendDot} style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
        {startMarkers.length > 0 && (
          <span className={styles.seriesStartFlag}>▎play-derived series begin {monthLabel(data.floors.play)}</span>
        )}
      </div>

      <details style={{ marginTop: 12 }}>
        <summary className={styles.fieldLabel} style={{ cursor: "pointer" }}>
          Show values
        </summary>
        <div className={styles.tableWrap} style={{ marginTop: 8, maxHeight: 320, overflowY: "auto" }}>
          <table className={styles.dataTable}>
            <thead>
              <tr>
                <th>Month</th>
                {series.map((s) => (
                  <th key={s.label}>{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableMonths.map((m) => {
                const i = axis.indexOf(m);
                return (
                  <tr key={m}>
                    <td>{monthLabel(m)}</td>
                    {series.map((s) => (
                      <td key={s.label}>
                        {s.values[i] == null ? <span className={styles.tableGap}>—</span> : fmtInt(s.values[i]!)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
