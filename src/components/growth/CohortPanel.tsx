"use client";

import { useEffect, useMemo, useState } from "react";
import type { RetentionAggregate } from "@/lib/retentionEngine";
import styles from "./growth.module.css";
import { countLabel, downloadCsv, monthLabel } from "./format";
import {
  cohortMatrix,
  columnAverages,
  heatClass,
  churnedAt,
  cohortCityDetail,
  MAX_AGE,
  type CohortCell,
} from "./retentionModel";

const AGES = Array.from({ length: MAX_AGE + 1 }, (_, i) => i);
const YEARS = ["2023", "2024", "2025", "2026"];
const MONTHS = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];
const CHURN_DEF = "Churn at Month N = players active at Month N−1 who did not play at Month N (set difference, not a drop in count).";
// The Player Data Room (a later pass) reads this key; here we only write it.
const DATA_ROOM_KEY = "growth.dataRoom.playerIds";
function readRoom(): number[] {
  try {
    const v = JSON.parse(localStorage.getItem(DATA_ROOM_KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function addToRoom(ids: number[]): number {
  const set = new Set<number>(readRoom());
  for (const i of ids) set.add(i);
  const arr = [...set];
  localStorage.setItem(DATA_ROOM_KEY, JSON.stringify(arr));
  return arr.length;
}

const heatStyle: Record<string, string> = {
  above: styles.heatAbove,
  average: styles.heatAverage,
  below: styles.heatBelow,
  na: styles.heatNa,
};

function Cell({ cell, mean, onClick }: { cell: CohortCell; mean: number | null; onClick?: () => void }) {
  const cls = heatClass(cell, mean);
  if (!cell.observable) return <td className={`${styles.cohortCell} ${styles.heatNa}`}>—</td>;
  return (
    <td
      className={`${styles.cohortCell} ${heatStyle[cls]}`}
      onClick={cell.age >= 1 ? onClick : undefined}
      style={cell.age >= 1 && onClick ? { cursor: "pointer" } : undefined}
      title={`${cell.count} of the cohort active at Month ${cell.age}`}
    >
      <div className={styles.cohortPct}>{cell.pct.toFixed(0)}%</div>
      <div className={styles.cohortCount}>{cell.count.toLocaleString("en-US")}</div>
    </td>
  );
}

export default function CohortPanel({ agg }: { agg: RetentionAggregate }) {
  const [year, setYear] = useState("all");
  const [month, setMonth] = useState("all");
  const [city, setCity] = useState("all");
  const [detail, setDetail] = useState<string | null>(null);
  const [churn, setChurn] = useState<{ cohortKey: string; age: number } | null>(null);
  const [roomCount, setRoomCount] = useState(0);
  useEffect(() => setRoomCount(readRoom().length), []);

  const cityNames = useMemo(() => [...agg.cities].sort((a, b) => a.localeCompare(b)), [agg.cities]);
  const cityIdx = city === "all" ? undefined : agg.cities.indexOf(city);

  const rows = useMemo(() => cohortMatrix(agg, { cityIdx }), [agg, cityIdx]);
  const visible = useMemo(
    () =>
      rows.filter(
        (r) => (year === "all" || r.cohortKey.slice(0, 4) === year) && (month === "all" || r.cohortKey.slice(5, 7) === month),
      ),
    [rows, year, month],
  );
  const means = useMemo(() => columnAverages(visible), [visible]);

  function exportCsv() {
    const header = ["Cohort", "Cohort size", ...AGES.map((a) => `Month ${a}`)];
    const body = visible.map((r) => [
      monthLabel(r.cohortKey) + (r.free ? " (free launch)" : ""),
      r.size,
      ...r.cells.map((c) => (c.observable ? `${c.pct.toFixed(0)}% (${c.count})` : "")),
    ]);
    const footer = ["Average retention (excl. free launch)", "", ...means.map((m) => (m == null ? "—" : `${m.toFixed(1)}%`))];
    downloadCsv("player-retention-cohorts.csv", [header, ...body, footer]);
  }

  const detailRows = detail ? cohortCityDetail(agg, detail) : null;
  if (detailRows) {
    // City Month-0 counts MUST sum to the cohort size — fail loudly otherwise.
    const total = detailRows.find((r) => r.total)!;
    const sum = detailRows.filter((r) => !r.total).reduce((s, r) => s + r.cells[0].count, 0);
    if (sum !== total.cells[0].count) {
      throw new Error(`Cohort ${detail} city split Month-0 counts (${sum}) != cohort size (${total.cells[0].count})`);
    }
  }

  const churnPlayers = churn ? churnedAt(agg, churn.cohortKey, churn.age, { cityIdx }) : [];

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Player retention cohorts</div>
          <div className={styles.cardSub}>
            Every first-match cohort from launch through the latest month, with average retention by month at the
            bottom. Click a cohort to split it by city; click any cell to see who churned there.
          </div>
        </div>
        <div className={styles.controlsRow}>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="cohortYear">Cohort year</label>
            <select id="cohortYear" className={styles.control} value={year} onChange={(e) => setYear(e.target.value)}>
              <option value="all">All years</option>
              {YEARS.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="cohortMonth">Cohort month</label>
            <select id="cohortMonth" className={styles.control} value={month} onChange={(e) => setMonth(e.target.value)}>
              <option value="all">All months</option>
              {MONTHS.map((m, i) => (
                <option key={m} value={m}>{monthLabel(`2000-${m}`).split(" ")[0]}</option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="cohortCity">City</label>
            <select id="cohortCity" className={styles.control} value={city} onChange={(e) => setCity(e.target.value)}>
              <option value="all">All cities</option>
              {cityNames.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={exportCsv}>
            Export CSV
          </button>
        </div>
      </div>

      <div className={styles.cohortKey}>
        <span><i style={{ background: "#d9f8ea" }} />Above column average</span>
        <span><i style={{ background: "#fff1bd" }} />At column average (±2pp)</span>
        <span><i style={{ background: "#fde4e1" }} />Below column average</span>
      </div>

      <div className={styles.cohortWrap}>
        <table className={styles.cohortTable}>
          <thead>
            <tr>
              <th className={styles.cohortRowHead}>Cohort</th>
              {AGES.map((a) => (
                <th key={a}>Month {a}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.cohortKey}>
                <td className={`${styles.cohortCell} ${styles.cohortRowHead}`}>
                  <button type="button" className={styles.cohortName} onClick={() => setDetail(r.cohortKey)}>
                    {monthLabel(r.cohortKey)}
                  </button>
                  {r.free && <span className={styles.freeBadge}>free launch</span>}
                  <div className={styles.cohortSize}>{countLabel(r.size, "player")}</div>
                </td>
                {r.cells.map((c) => (
                  <Cell key={c.age} cell={c} mean={means[c.age]} onClick={() => setChurn({ cohortKey: r.cohortKey, age: c.age })} />
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className={`${styles.cohortCell} ${styles.cohortRowHead}`}>
                Average retention
                <div className={styles.cohortSize}>excl. free launch</div>
              </td>
              {means.map((m, i) => (
                <td key={i} className={styles.cohortCell}>{m == null ? "—" : `${m.toFixed(1)}%`}</td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>

      <div className={styles.footnote}>
        Apr and May 2023 matches were free. Those cohorts are shown but excluded from the average. {CHURN_DEF}
      </div>

      {detailRows && detail && (
        <DetailPanel cohortKey={detail} rows={detailRows} means={means} onClose={() => setDetail(null)} />
      )}

      {churn && (
        <ChurnPanel
          cohortKey={churn.cohortKey}
          age={churn.age}
          players={churnPlayers.map((p) => ({
            u: p.u,
            city: agg.cities[p.ct],
            field: agg.fields[p.f],
            last: p.l,
            matches: p.m,
          }))}
          roomCount={roomCount}
          onAddToRoom={(ids) => setRoomCount(addToRoom(ids))}
          onClose={() => setChurn(null)}
        />
      )}
    </div>
  );
}

function DetailPanel({
  cohortKey,
  rows,
  means,
  onClose,
}: {
  cohortKey: string;
  rows: ReturnType<typeof cohortCityDetail>;
  means: (number | null)[];
  onClose: () => void;
}) {
  return (
    <div className={styles.detailPanel}>
      <div className={styles.detailHead}>
        <div className={styles.cardTitle}>{monthLabel(cohortKey)} cohort — by first-match city</div>
        <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={onClose}>
          Close
        </button>
      </div>
      <div className={styles.cohortWrap}>
        <table className={styles.cohortTable}>
          <thead>
            <tr>
              <th className={styles.cohortRowHead}>City</th>
              {AGES.map((a) => (
                <th key={a}>Month {a}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.city} style={r.total ? { fontWeight: 800, borderTop: "2px solid var(--line)" } : undefined}>
                <td className={`${styles.cohortCell} ${styles.cohortRowHead}`}>
                  {r.city}
                  <div className={styles.cohortSize}>{countLabel(r.size, "player")}</div>
                </td>
                {r.cells.map((c) => (
                  <Cell key={c.age} cell={c} mean={r.total ? means[c.age] : null} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ChurnPanel({
  cohortKey,
  age,
  players,
  roomCount,
  onAddToRoom,
  onClose,
}: {
  cohortKey: string;
  age: number;
  players: { u: number; city: string; field: string; last: string; matches: number }[];
  roomCount: number;
  onAddToRoom: (ids: number[]) => void;
  onClose: () => void;
}) {
  return (
    <div className={styles.detailPanel}>
      <div className={styles.detailHead}>
        <div>
          <div className={styles.cardTitle}>
            {players.length.toLocaleString("en-US")} players churned at Month {age} — {monthLabel(cohortKey)} cohort
          </div>
          <div className={styles.cardSub}>{CHURN_DEF}</div>
        </div>
        <div className={styles.controlsRow}>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            onClick={() => onAddToRoom(players.map((p) => p.u))}
          >
            Add to Player Data Room
          </button>
          <span className={styles.roomPill}>{roomCount.toLocaleString("en-US")} in Data Room</span>
          <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <div className={styles.tableWrap} style={{ maxHeight: 360 }}>
        <table className={styles.dataTable}>
          <thead>
            <tr>
              <th>Player ID</th>
              <th>First-match city</th>
              <th>First-match field</th>
              <th>Last match date</th>
              <th>Matches played</th>
            </tr>
          </thead>
          <tbody>
            {players.map((p) => (
              <tr key={p.u}>
                <td>{p.u}</td>
                <td>{p.city}</td>
                <td>{p.field}</td>
                <td>{p.last}</td>
                <td>{p.matches}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
