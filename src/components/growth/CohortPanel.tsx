"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./growth.module.css";
import { countLabel, downloadCsv, monthLabel } from "./format";
import {
  cohortMatrix,
  columnAverages,
  matureColumnAverages,
  heatClass,
  idxOf,
  MAX_AGE,
  type CohortCell,
  type CohortMatrixPayload,
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

// Drill-down endpoint shapes (lazy; fetched + cached on click).
type CohortPlayer = { u: number; city: string; field: string; last: string; matches: number };
type PlayersResponse = { cohort: string; age: number; count: number; players: CohortPlayer[] };
type CohortCitiesResponse = { cohort: string; nowMonth: string; rows: { age: number; city: string | null; players: number }[] };
type CityDetailRow = { city: string; size: number; cells: CohortCell[]; total: boolean };

// One cohort split by first-match city, reconstructed from the cohort-cities
// rows. city === null is the All-cities rollup; pct is per-city (against that
// city's own age-0 size); observable follows the cohort's own maturity window.
function buildCityDetail(res: CohortCitiesResponse, cohortKey: string): CityDetailRow[] {
  const maxObsAge = idxOf(res.nowMonth) - idxOf(cohortKey);
  const byCity = new Map<string, Map<number, number>>();
  const totalAges = new Map<number, number>();
  for (const r of res.rows) {
    if (r.city == null) {
      totalAges.set(r.age, r.players);
      continue;
    }
    let ages = byCity.get(r.city);
    if (!ages) byCity.set(r.city, (ages = new Map()));
    ages.set(r.age, r.players);
  }
  const mkCells = (ages: Map<number, number>): CohortCell[] => {
    const size = ages.get(0) ?? 0;
    const cells: CohortCell[] = [];
    for (let n = 0; n <= MAX_AGE; n++) {
      const observable = n <= maxObsAge;
      const count = ages.get(n) ?? 0;
      cells.push({ age: n, count, pct: size ? (100 * count) / size : 0, observable });
    }
    return cells;
  };
  const rows: CityDetailRow[] = [...byCity.entries()]
    .map(([city, ages]) => ({ city, size: ages.get(0) ?? 0, cells: mkCells(ages), total: false }))
    .sort((a, b) => b.size - a.size);
  rows.push({ city: "All cities", size: totalAges.get(0) ?? 0, cells: mkCells(totalAges), total: true });
  return rows;
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
      onClick={onClick}
      style={onClick ? { cursor: "pointer" } : undefined}
      title={
        cell.age === 0
          ? `${cell.count} players in the starting cohort`
          : `${cell.count} of the cohort active at Month ${cell.age}`
      }
    >
      <div className={styles.cohortPct}>{cell.pct.toFixed(0)}%</div>
      <div className={styles.cohortCount}>{cell.count.toLocaleString("en-US")}</div>
    </td>
  );
}

export default function CohortPanel({
  payload,
  authHeaders,
}: {
  payload: CohortMatrixPayload;
  authHeaders: Record<string, string>;
}) {
  const [year, setYear] = useState("all");
  const [month, setMonth] = useState("all");
  const [city, setCity] = useState("all"); // "all" or a display city name
  const [detail, setDetail] = useState<string | null>(null); // cohortKey of the city split
  const [drill, setDrill] = useState<{ cohortKey: string; age: number } | null>(null);
  const [roomCount, setRoomCount] = useState(0);
  useEffect(() => setRoomCount(readRoom().length), []);

  // Per-city matrix payloads (the all-cities rollup is the prop). Refetched, not
  // client-filtered — the server pre-aggregates each city's own matrix.
  const [cityPayloads, setCityPayloads] = useState<Record<string, CohortMatrixPayload>>({});
  const [matrixLoading, setMatrixLoading] = useState(false);
  useEffect(() => {
    if (city === "all" || city in cityPayloads) return;
    let alive = true;
    setMatrixLoading(true);
    fetch(`/api/growth/retention?city=${encodeURIComponent(city)}`, { headers: authHeaders })
      .then((r) => r.json())
      .then((p: CohortMatrixPayload) => {
        if (alive) setCityPayloads((prev) => ({ ...prev, [city]: p }));
      })
      .finally(() => {
        if (alive) setMatrixLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [city, authHeaders, cityPayloads]);

  const ready = city === "all" || city in cityPayloads;
  const activePayload = city === "all" ? payload : cityPayloads[city] ?? payload;

  // Drill-down caches survive open/close so reopening the same cell never refetches.
  const detailCache = useRef<Map<string, CityDetailRow[]>>(new Map());
  const playersCache = useRef<Map<string, CohortPlayer[]>>(new Map());

  const cityNames = payload.cities; // display names, already sorted server-side

  const rows = useMemo(() => cohortMatrix(activePayload), [activePayload]);
  const visible = useMemo(
    () =>
      rows.filter(
        (r) => (year === "all" || r.cohortKey.slice(0, 4) === year) && (month === "all" || r.cohortKey.slice(5, 7) === month),
      ),
    [rows, year, month],
  );
  const means = useMemo(() => columnAverages(visible), [visible]);
  const matureMeans = useMemo(() => matureColumnAverages(visible), [visible]);

  function exportCsv() {
    const header = ["Cohort", "Cohort size", ...AGES.map((a) => `Month ${a}`)];
    const body = visible.map((r) => [
      monthLabel(r.cohortKey) + (r.free ? " (free launch)" : ""),
      r.size,
      ...r.cells.map((c) => (c.observable ? `${c.pct.toFixed(0)}% (${c.count})` : "")),
    ]);
    const footAll = ["All visible cohorts (excl. free launch)", "", ...means.map((m) => (m == null ? "—" : `${m.toFixed(1)}%`))];
    const footMature = ["Mature cohorts only (12+ months observed)", "", ...matureMeans.map((m) => (m == null ? "—" : `${m.toFixed(1)}%`))];
    downloadCsv("player-retention-cohorts.csv", [header, ...body, footAll, footMature]);
  }

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
              {MONTHS.map((m) => (
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
          <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={exportCsv} disabled={!ready}>
            Export CSV
          </button>
        </div>
      </div>

      {!ready ? (
        <div className={styles.stateMsg}>Loading {city} cohorts…</div>
      ) : (
        <>
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
                      <Cell key={c.age} cell={c} mean={means[c.age]} onClick={() => setDrill({ cohortKey: r.cohortKey, age: c.age })} />
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className={`${styles.cohortCell} ${styles.cohortRowHead}`}>
                    All visible cohorts
                    <div className={styles.cohortSize}>excl. free launch</div>
                  </td>
                  {means.map((m, i) => (
                    <td key={i} className={styles.cohortCell}>{m == null ? "—" : `${m.toFixed(1)}%`}</td>
                  ))}
                </tr>
                <tr>
                  <td className={`${styles.cohortCell} ${styles.cohortRowHead}`}>
                    Mature cohorts only
                    <div className={styles.cohortSize}>12+ months observed</div>
                  </td>
                  {matureMeans.map((m, i) => (
                    <td key={i} className={styles.cohortCell}>{m == null ? "—" : `${m.toFixed(1)}%`}</td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>

          <div className={styles.footnote}>
            Apr and May 2023 matches were free. Those cohorts are shown but excluded from both averages. The{" "}
            <b>all visible cohorts</b> row mixes a different number of cohorts at each age — its tail is drawn only from the
            older cohorts — so it isn&rsquo;t a like-for-like curve; the <b>mature cohorts only</b> row is a fixed set (every
            cohort observed a full 12 months) and is the comparable curve. {CHURN_DEF}
          </div>
        </>
      )}

      {detail && (
        <CityDetailPanel
          cohortKey={detail}
          means={means}
          authHeaders={authHeaders}
          cache={detailCache}
          onClose={() => setDetail(null)}
        />
      )}

      {drill && (
        <CohortPlayersPanel
          cohortKey={drill.cohortKey}
          age={drill.age}
          city={city}
          authHeaders={authHeaders}
          cache={playersCache}
          roomCount={roomCount}
          onAddToRoom={(ids) => setRoomCount(addToRoom(ids))}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}

// City split for one cohort — self-fetching over /api/growth/retention/cohort-cities.
function CityDetailPanel({
  cohortKey,
  means,
  authHeaders,
  cache,
  onClose,
}: {
  cohortKey: string;
  means: (number | null)[];
  authHeaders: Record<string, string>;
  cache: { current: Map<string, CityDetailRow[]> };
  onClose: () => void;
}) {
  const [rows, setRows] = useState<CityDetailRow[] | null>(cache.current.get(cohortKey) ?? null);
  const [loading, setLoading] = useState(!rows);
  useEffect(() => {
    const cached = cache.current.get(cohortKey);
    if (cached) {
      setRows(cached);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    fetch(`/api/growth/retention/cohort-cities?cohort=${cohortKey}`, { headers: authHeaders })
      .then((r) => r.json())
      .then((res: CohortCitiesResponse) => {
        const built = buildCityDetail(res, cohortKey);
        cache.current.set(cohortKey, built);
        if (alive) setRows(built);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [cohortKey, authHeaders, cache]);

  // City Month-0 counts MUST sum to the cohort size — fail loudly otherwise.
  if (rows) {
    const total = rows.find((r) => r.total)!;
    const sum = rows.filter((r) => !r.total).reduce((s, r) => s + r.cells[0].count, 0);
    if (sum !== total.cells[0].count) {
      throw new Error(`Cohort ${cohortKey} city split Month-0 counts (${sum}) != cohort size (${total.cells[0].count})`);
    }
  }

  return (
    <div className={styles.detailPanel}>
      <div className={styles.detailHead}>
        <div className={styles.cardTitle}>{monthLabel(cohortKey)} cohort — by first-match city</div>
        <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={onClose}>
          Close
        </button>
      </div>
      {loading || !rows ? (
        <div className={styles.stateMsg}>Loading city split…</div>
      ) : (
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
      )}
    </div>
  );
}

// Age 0 lists the whole starting cohort; age >= 1 lists the set-subtraction
// churn. Self-fetching over /api/growth/retention/players, cached by cohort+age+city.
function CohortPlayersPanel({
  cohortKey,
  age,
  city,
  authHeaders,
  cache,
  roomCount,
  onAddToRoom,
  onClose,
}: {
  cohortKey: string;
  age: number;
  city: string;
  authHeaders: Record<string, string>;
  cache: { current: Map<string, CohortPlayer[]> };
  roomCount: number;
  onAddToRoom: (ids: number[]) => void;
  onClose: () => void;
}) {
  const key = `${cohortKey}:${age}:${city}`;
  const [players, setPlayers] = useState<CohortPlayer[] | null>(cache.current.get(key) ?? null);
  const [loading, setLoading] = useState(!players);
  useEffect(() => {
    const cached = cache.current.get(key);
    if (cached) {
      setPlayers(cached);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    fetch(
      `/api/growth/retention/players?cohort=${cohortKey}&age=${age}&city=${encodeURIComponent(city)}`,
      { headers: authHeaders },
    )
      .then((r) => r.json())
      .then((res: PlayersResponse) => {
        cache.current.set(key, res.players);
        if (alive) setPlayers(res.players);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [key, cohortKey, age, city, authHeaders, cache]);

  const list = players ?? [];
  return (
    <div className={styles.detailPanel}>
      <div className={styles.detailHead}>
        <div>
          <div className={styles.cardTitle}>
            {loading
              ? `Loading players — ${monthLabel(cohortKey)}${age === 0 ? "" : ` · Month ${age}`}…`
              : age === 0
                ? `Players in the starting cohort — ${monthLabel(cohortKey)} · ${list.length.toLocaleString("en-US")} players`
                : `${list.length.toLocaleString("en-US")} players churned at Month ${age} — ${monthLabel(cohortKey)} cohort`}
          </div>
          <div className={styles.cardSub}>
            {age === 0 ? "Every player whose first match was in this cohort month." : CHURN_DEF}
          </div>
        </div>
        <div className={styles.controlsRow}>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            onClick={() => onAddToRoom(list.map((p) => p.u))}
            disabled={loading || !list.length}
          >
            Add to Player Data Room
          </button>
          <span className={styles.roomPill}>{roomCount.toLocaleString("en-US")} in Data Room</span>
          <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      {loading ? (
        <div className={styles.stateMsg}>Loading players…</div>
      ) : (
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
              {list.map((p) => (
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
      )}
    </div>
  );
}
