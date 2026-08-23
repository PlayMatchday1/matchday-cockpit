"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import styles from "./growth.module.css";
import { downloadCsv, monthLabel } from "./format";
import {
  cohortMatrix,
  columnAverages,
  idxOf,
  MAX_AGE,
  type CohortMatrixPayload,
  type CohortRow,
} from "./retentionModel";

const AGES = Array.from({ length: MAX_AGE + 1 }, (_, i) => i);
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_VALUES = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];
const CHURN_DEF =
  "Churn at Month N = players active at Month N−1 who did not play at Month N (set difference, not a drop in count).";

// "Apr 23" style, from a YYYY-MM cohort key.
function shortLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return `${MON[m - 1]} ${String(y).slice(2)}`;
}

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
type CohortCitiesResponse = {
  cohort: string;
  nowMonth: string;
  rows: { age: number; city: string | null; players: number }[];
};

// Per-column heat, three-step, ±2pp against the (free-excluded) column mean.
type Band = "above" | "at" | "below" | "none";
function band(v: number, mean: number | null): Band {
  if (mean == null) return "none";
  if (Math.abs(v - mean) <= 2) return "at";
  return v > mean ? "above" : "below";
}

// One cohort split by first-match city, reconstructed from the cohort-cities
// rows. city === null is the All-cities rollup. Per-city retention uses the
// spec rule (em-dash where the (city,age) cell is absent or beyond lived age);
// the All-cities row mirrors the main table (absent-within-window == real 0) so
// it equals the cohort's own row — asserted below.
type CityDetailBuilt = {
  cityRows: { city: string; size: number; pcts: (number | null)[] }[];
  allPcts: (number | null)[];
  sum: number;
  cohortSize: number;
};
function buildCityDetail(res: CohortCitiesResponse, cohortRow: CohortRow): CityDetailBuilt {
  const maxObs = idxOf(res.nowMonth) - idxOf(cohortRow.cohortKey);
  const byCity = new Map<string, Map<number, number>>();
  const total = new Map<number, number>();
  for (const r of res.rows) {
    if (r.city == null) {
      total.set(r.age, r.players);
      continue;
    }
    let ages = byCity.get(r.city);
    if (!ages) byCity.set(r.city, (ages = new Map()));
    ages.set(r.age, r.players);
  }
  const cohortSize = cohortRow.size;

  const cityRows = [...byCity.entries()]
    .map(([city, ages]) => {
      const size = ages.get(0) ?? 0;
      const pcts: (number | null)[] = [];
      for (let n = 0; n <= MAX_AGE; n++) {
        if (n === 0) {
          pcts.push(100);
        } else if (n > maxObs || !ages.has(n)) {
          pcts.push(null);
        } else {
          pcts.push(size ? Math.round((100 * (ages.get(n) as number)) / size) : null);
        }
      }
      return { city, size, pcts };
    })
    .sort((a, b) => a.city.localeCompare(b.city));

  const allPcts: (number | null)[] = [];
  for (let n = 0; n <= MAX_AGE; n++) {
    if (n > maxObs) {
      allPcts.push(null);
      continue;
    }
    const count = total.get(n) ?? 0;
    allPcts.push(cohortSize ? Math.round((100 * count) / cohortSize) : 0);
  }

  const sum = cityRows.reduce((s, c) => s + c.size, 0);

  // ASSERT (i): city first-match cities partition the cohort exactly.
  if (sum !== cohortSize) {
    throw new Error(
      `Cohort ${cohortRow.cohortKey}: city sizes sum to ${sum}, not the cohort size ${cohortSize}`,
    );
  }
  // ASSERT (ii): the All-cities rollup equals the cohort's own main-table row.
  for (let n = 0; n <= MAX_AGE; n++) {
    if (n > maxObs) continue;
    const expected = Math.round(cohortRow.cells[n].pct);
    if (allPcts[n] !== expected) {
      throw new Error(
        `Cohort ${cohortRow.cohortKey}: All-cities Month ${n} = ${allPcts[n]}% but main table = ${expected}%`,
      );
    }
  }

  return { cityRows, allPcts, sum, cohortSize };
}

export default function CohortPanel({
  payload,
  authHeaders,
  scopeChip,
}: {
  payload: CohortMatrixPayload;
  authHeaders: Record<string, string>;
  scopeChip?: ReactNode;
}) {
  const [year, setYear] = useState("all");
  const [month, setMonth] = useState("all");
  const [city, setCity] = useState("all"); // "all" or a display city name
  const [detail, setDetail] = useState<string | null>(null); // open cohortKey for the city split
  const [drill, setDrill] = useState<{ cohortKey: string; age: number } | null>(null);
  const [roomCount, setRoomCount] = useState(0);
  useEffect(() => setRoomCount(readRoom().length), []);

  // Per-city matrix payloads (the all-cities rollup is the prop). Refetched, not
  // client-filtered — the server pre-aggregates each city's own matrix.
  const [cityPayloads, setCityPayloads] = useState<Record<string, CohortMatrixPayload>>({});
  useEffect(() => {
    if (city === "all" || city in cityPayloads) return;
    let alive = true;
    fetch(`/api/lifecycle/retention?city=${encodeURIComponent(city)}`, { headers: authHeaders })
      .then((r) => r.json())
      .then((p: CohortMatrixPayload) => {
        if (alive) setCityPayloads((prev) => ({ ...prev, [city]: p }));
      });
    return () => {
      alive = false;
    };
  }, [city, authHeaders, cityPayloads]);

  const ready = city === "all" || city in cityPayloads;
  const activePayload = city === "all" ? payload : cityPayloads[city] ?? payload;

  // Drill-down caches survive open/close so reopening never refetches.
  const detailCache = useRef<Map<string, CohortCitiesResponse>>(new Map());
  const playersCache = useRef<Map<string, CohortPlayer[]>>(new Map());

  // City filter list: "All Matchday" + payload cities minus New York.
  const cityOptions = useMemo(
    () => payload.cities.filter((c) => c !== "New York City" && c !== "NYC"),
    [payload.cities],
  );

  // OLDEST-first (defect 1): cohortMatrix returns newest-first, so re-sort ASC.
  const rows = useMemo(
    () => [...cohortMatrix(activePayload)].sort((a, b) => a.cohortIdx - b.cohortIdx),
    [activePayload],
  );
  const yearsPresent = useMemo(
    () => [...new Set(rows.map((r) => r.cohortKey.slice(0, 4)))].sort(),
    [rows],
  );
  const visible = useMemo(
    () =>
      rows.filter(
        (r) =>
          (year === "all" || r.cohortKey.slice(0, 4) === year) &&
          (month === "all" || r.cohortKey.slice(5, 7) === month),
      ),
    [rows, year, month],
  );
  const means = useMemo(() => columnAverages(visible), [visible]);

  const nonFree = visible.filter((r) => !r.free);
  const nAtM1 = nonFree.length;
  const mAtM12 = nonFree.filter((r) => r.cells[MAX_AGE].observable).length;

  function exportCsv() {
    const header = ["Cohort", "Players", ...AGES.map((a) => `Month ${a}`)];
    const body = visible.map((r) => [
      shortLabel(r.cohortKey) + (r.free ? " (free launch)" : ""),
      r.size,
      ...r.cells.map((c) => (c.observable ? `${Math.round(c.pct)}%` : "")),
    ]);
    const foot = [
      "Average retention · All Matchday",
      "",
      ...means.map((m) => (m == null ? "—" : `${m.toFixed(1)}%`)),
    ];
    downloadCsv("player-retention-cohorts.csv", [header, ...body, foot]);
  }

  return (
    <div className={ROOT}>
      <style>{CSS}</style>

      <div className="head">
        <div>
          <div className="title">Player retention cohorts</div>
          <div className="sub">
            Filter by year, month and city. Click a cohort name for city detail; click a retention cell to
            see the Player IDs that churned from the prior month.
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
          {scopeChip}
        <div className="controls">
          <div className="fld">
            <label htmlFor="cohortYear">Cohort year</label>
            <select id="cohortYear" value={year} onChange={(e) => setYear(e.target.value)}>
              <option value="all">All years</option>
              {yearsPresent.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="cohortMonth">Cohort month</label>
            <select id="cohortMonth" value={month} onChange={(e) => setMonth(e.target.value)}>
              <option value="all">All months</option>
              {MONTH_VALUES.map((mv, i) => (
                <option key={mv} value={mv}>
                  {MON[i]}
                </option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="cohortCity">City</label>
            <select id="cohortCity" value={city} onChange={(e) => setCity(e.target.value)}>
              <option value="all">All Matchday</option>
              {cityOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <button type="button" className="btn" id="cohortExport" onClick={exportCsv} disabled={!ready}>
            Export
          </button>
        </div>
        </div>
      </div>

      <div className="key">
        <span>
          <i style={{ background: "#d9f8ea" }} />
          Above column average
        </span>
        <span>
          <i style={{ background: "#fff1bd" }} />
          At column average (±2pp)
        </span>
        <span>
          <i style={{ background: "#fde4e1" }} />
          Below column average
        </span>
      </div>

      {!ready ? (
        <div className="loading">Loading {city} cohorts…</div>
      ) : (
        <>
          <div className="scroll">
            <table id="grid">
              <thead>
                <tr>
                  <th className="cohort-h">Cohort</th>
                  {AGES.map((a) => (
                    <th key={a}>Month {a}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const open = detail === r.cohortKey;
                  return (
                    <Fragment key={r.cohortKey}>
                      <tr className={open ? "open" : undefined}>
                        <td className="cohort-c">
                          <button
                            type="button"
                            className="cname"
                            onClick={() => setDetail(open ? null : r.cohortKey)}
                          >
                            {shortLabel(r.cohortKey)}
                          </button>
                          {r.free && <span className="freebadge">free launch</span>}
                          <div className="cmeta">
                            {r.size.toLocaleString("en-US")} players · click for city detail
                          </div>
                        </td>
                        {r.cells.map((c) => {
                          if (!c.observable) return <td key={c.age} className="cell none">—</td>;
                          const b = band(c.pct, means[c.age]);
                          const clickable = c.age >= 1;
                          return (
                            <td
                              key={c.age}
                              className={`cell ${b}`}
                              title={`${c.count} of ${r.size} players`}
                              onClick={clickable ? () => setDrill({ cohortKey: r.cohortKey, age: c.age }) : undefined}
                              style={clickable ? { cursor: "pointer" } : undefined}
                            >
                              {Math.round(c.pct)}%
                            </td>
                          );
                        })}
                      </tr>
                      {open && (
                        <tr className="detail">
                          <td colSpan={MAX_AGE + 2}>
                            <CityDetail
                              cohortRow={r}
                              authHeaders={authHeaders}
                              cache={detailCache}
                              onClose={() => setDetail(null)}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td className="cohort-c">
                    <span className="flabel">Average retention · All Matchday</span>
                    <div className="fsub">{nonFree.length} cohorts, free launch excluded</div>
                  </td>
                  {means.map((m, i) => (
                    <td key={i}>{m == null ? "—" : `${m.toFixed(1)}%`}</td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="foot">
            <b>Shading compares each cell to its own column</b>, not to the rest of its row — so a green
            Month 6 means that cohort held better at six months than other cohorts did at six months. Within
            two percentage points of the column average counts as at average.
          </div>
          <div className="foot">
            <b>Apr and May 2023 matches were free.</b> Those cohorts are shown but excluded from the average
            row, because pooling free trials with paid play overstates retention. Every other cohort counts
            at every age it has reached — {nAtM1} at Month 1, {mAtM12} at Month 12.
          </div>
        </>
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

// City split for one cohort — self-fetching over /api/lifecycle/retention/cohort-cities.
// Renders as a proper JSX <table> (NEVER innerHTML) so the nested thead/tfoot survive.
function CityDetail({
  cohortRow,
  authHeaders,
  cache,
  onClose,
}: {
  cohortRow: CohortRow;
  authHeaders: Record<string, string>;
  cache: { current: Map<string, CohortCitiesResponse> };
  onClose: () => void;
}) {
  const key = cohortRow.cohortKey;
  const [res, setRes] = useState<CohortCitiesResponse | null>(cache.current.get(key) ?? null);
  const [loading, setLoading] = useState(!res);
  useEffect(() => {
    const cached = cache.current.get(key);
    if (cached) {
      setRes(cached);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    fetch(`/api/lifecycle/retention/cohort-cities?cohort=${key}`, { headers: authHeaders })
      .then((r) => r.json())
      .then((data: CohortCitiesResponse) => {
        cache.current.set(key, data);
        if (alive) setRes(data);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [key, authHeaders, cache]);

  const built = res ? buildCityDetail(res, cohortRow) : null; // assertions run here

  return (
    <div className="detail-inner">
      <div className="detail-head">
        <div>
          <strong>{shortLabel(key)} cohort by city</strong>
          <div className="detail-sub">
            City-level retention for the selected cohort. Click any cell in the main table to inspect Player
            ID churn.
          </div>
        </div>
        <button type="button" className="close" onClick={onClose}>
          Close
        </button>
      </div>

      {!built ? (
        <div className="loading">{loading ? "Loading city split…" : "No city detail."}</div>
      ) : (
        <>
          <div className="dwrap">
            <table className="dt">
              <thead>
                <tr>
                  <th className="dcity">City</th>
                  <th className="dsize">Cohort size</th>
                  {AGES.map((a) => (
                    <th key={a}>M{a}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {built.cityRows.map((ct) => (
                  <tr key={ct.city}>
                    <td className="dcity">{ct.city}</td>
                    <td className="dsize">{ct.size.toLocaleString("en-US")}</td>
                    {ct.pcts.map((v, a) =>
                      v == null ? (
                        <td key={a} className="dnone">—</td>
                      ) : (
                        <td key={a}>{v}%</td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className="dcity">All cities</td>
                  <td className="dsize">{built.cohortSize.toLocaleString("en-US")}</td>
                  {built.allPcts.map((v, a) =>
                    v == null ? (
                      <td key={a} className="dnone">—</td>
                    ) : (
                      <td key={a}>{v}%</td>
                    ),
                  )}
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="dnote">
            Every player has one first-match city, so the city sizes are a partition of the cohort —{" "}
            {built.sum.toLocaleString("en-US")} across {built.cityRows.length} markets, equal to the cohort&rsquo;s{" "}
            {built.cohortSize.toLocaleString("en-US")}. <b>All cities</b> is the cohort&rsquo;s own curve, for
            comparison.
          </div>
        </>
      )}
    </div>
  );
}

// Age >= 1 lists the set-subtraction churn for (cohort, age). Self-fetching over
// /api/lifecycle/retention/players, cached by cohort+age+city. Reused verbatim.
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
    fetch(`/api/lifecycle/retention/players?cohort=${cohortKey}&age=${age}&city=${encodeURIComponent(city)}`, {
      headers: authHeaders,
    })
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
              ? `Loading players — ${monthLabel(cohortKey)} · Month ${age}…`
              : `${list.length.toLocaleString("en-US")} players churned at Month ${age} — ${monthLabel(
                  cohortKey,
                )} cohort`}
          </div>
          <div className={styles.cardSub}>{CHURN_DEF}</div>
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

// ── scoped styling ─────────────────────────────────────────────────────────
// Ported from mockups/cohorts-v1.html; every selector is prefixed with the root
// class so nothing collides with the rest of the Growth tab.
const ROOT = "mcCohorts";
const CSS = `
.${ROOT}{
  --forest:#003326;--ink:#0d1f18;--muted:#5C6B62;--paper:#fff;
  --line:#dfe4da;--slot:#EFF4EF;
  --above:#d9f8ea;--aboveInk:#0A5C3E;
  --at:#fff1bd;--atInk:#7A5200;
  --below:#fde4e1;--belowInk:#A02F22;
  background:var(--paper);border:1px solid var(--line);border-radius:16px;
  box-shadow:0 9px 26px rgba(0,51,38,.075);overflow:hidden;color:var(--ink);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif;
}
.${ROOT} *{box-sizing:border-box}
.${ROOT} .head{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;padding:18px 22px;flex-wrap:wrap}
.${ROOT} .title{font-size:16px;font-weight:900;letter-spacing:-.2px;color:var(--forest)}
.${ROOT} .sub{font-size:12px;color:var(--muted);margin-top:5px;max-width:820px;line-height:1.45}
.${ROOT} .controls{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap}
.${ROOT} .fld label{display:block;font-size:9px;font-weight:900;letter-spacing:.8px;text-transform:uppercase;color:var(--muted);margin-bottom:5px}
.${ROOT} select{font-family:inherit;font-size:12px;font-weight:750;color:var(--ink);background:#fff;border:1px solid var(--line);border-radius:10px;padding:9px 12px;cursor:pointer;min-width:132px}
.${ROOT} .btn{border:0;background:var(--forest);color:#fff;font-size:12px;font-weight:850;padding:11px 20px;border-radius:10px;cursor:pointer;font-family:inherit}
.${ROOT} .btn:hover{background:#00281e}
.${ROOT} .btn:disabled{opacity:.5;cursor:default}
.${ROOT} .key{display:flex;gap:22px;padding:11px 22px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:#fff;flex-wrap:wrap}
.${ROOT} .key span{font-size:10.5px;font-weight:800;color:var(--ink);display:inline-flex;align-items:center}
.${ROOT} .key i{display:inline-block;width:13px;height:13px;border-radius:4px;margin-right:8px}
.${ROOT} .loading{padding:40px;text-align:center;color:var(--muted);font-size:13px}

.${ROOT} .scroll{overflow:auto;max-height:min(68vh,640px)}
.${ROOT} table#grid{width:100%;border-collapse:collapse;table-layout:fixed}
.${ROOT} #grid th,.${ROOT} #grid td{padding:0;text-align:center;font-variant-numeric:tabular-nums}
.${ROOT} thead th{font-size:9.5px;font-weight:900;letter-spacing:.7px;text-transform:uppercase;color:var(--muted);padding:12px 6px;background:#fff;border-bottom:1px solid var(--line);white-space:nowrap;position:sticky;top:0;z-index:3}
.${ROOT} th.cohort-h,.${ROOT} td.cohort-c{text-align:left;width:190px;padding-left:22px;padding-right:12px}
.${ROOT} .cell{padding:14px 6px;font-size:12.5px;font-weight:850;border-bottom:1px solid rgba(255,255,255,.85)}
.${ROOT} .cell.above{background:var(--above);color:var(--aboveInk)}
.${ROOT} .cell.at{background:var(--at);color:var(--atInk)}
.${ROOT} .cell.below{background:var(--below);color:var(--belowInk)}
.${ROOT} .cell.none{background:#fafbf9;color:#67736C;font-weight:700}
.${ROOT} td.cohort-c{padding-top:11px;padding-bottom:11px;border-bottom:1px solid var(--line);background:#fff}
.${ROOT} .cname{font-size:12.5px;font-weight:900;color:var(--forest);background:none;border:0;padding:0;cursor:pointer;font-family:inherit}
.${ROOT} .cname:hover{text-decoration:underline}
.${ROOT} .cmeta{font-size:10.5px;color:var(--muted);font-weight:650;margin-top:3px}
.${ROOT} .freebadge{display:inline-block;margin-left:7px;font-size:8.5px;font-weight:900;letter-spacing:.4px;text-transform:uppercase;background:var(--slot);border:1px solid var(--line);color:var(--muted);border-radius:5px;padding:1px 6px;vertical-align:1px}
.${ROOT} tbody tr.open td.cohort-c{background:var(--slot)}

.${ROOT} tfoot td{background:var(--forest);color:#fff;font-size:12.5px;font-weight:900;border:0;position:sticky;bottom:0;z-index:3;height:50px;padding:0 6px}
.${ROOT} tfoot td.cohort-c{background:var(--forest);color:#fff;text-align:left;font-weight:900}
.${ROOT} tfoot .flabel{font-size:12.5px;font-weight:900;display:block}
.${ROOT} tfoot .fsub{font-size:10.5px;font-weight:700;opacity:.85}

.${ROOT} .detail > td{background:var(--slot);border-bottom:1px solid var(--line);padding:0}
.${ROOT} .detail-inner{padding:16px 22px 20px;text-align:left}
.${ROOT} .detail-head{display:flex;justify-content:flex-start;align-items:flex-start;gap:20px;margin-bottom:12px}
.${ROOT} .detail-head > div:first-child{flex:1}
.${ROOT} .detail-head strong{font-size:15px;font-weight:900;color:var(--forest)}
.${ROOT} .detail-sub{font-size:11.5px;color:var(--muted);font-weight:650;margin-top:4px}
.${ROOT} .close{border:1px solid var(--line);background:#fff;color:var(--ink);font-size:12px;font-weight:850;border-radius:10px;padding:9px 20px;cursor:pointer;font-family:inherit;white-space:nowrap}
.${ROOT} .close:hover{background:var(--slot)}
.${ROOT} .dwrap{background:#fff;border:1px solid var(--line);border-radius:12px;overflow:auto}
.${ROOT} table.dt{width:100%;border-collapse:collapse;table-layout:fixed}
.${ROOT} table.dt th{font-size:9px;font-weight:900;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);padding:11px 5px;background:#fff;border-bottom:1px solid var(--line);text-align:right;position:static}
.${ROOT} table.dt td{font-size:12px;font-weight:750;color:var(--ink);padding:12px 5px;text-align:right;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
.${ROOT} table.dt th.dcity,.${ROOT} table.dt td.dcity{text-align:left;width:170px;padding-left:18px;font-weight:900}
.${ROOT} table.dt th.dsize,.${ROOT} table.dt td.dsize{width:110px;padding-right:18px}
.${ROOT} table.dt tfoot td{background:#eef3ef;color:var(--forest);font-weight:900;border-bottom:0}
.${ROOT} table.dt .dnone{color:#67736C;font-weight:700}
.${ROOT} .dnote{font-size:11px;color:var(--muted);line-height:1.55;margin-top:11px;max-width:1000px}
.${ROOT} .dnote b{color:var(--ink);font-weight:800}

.${ROOT} .foot{padding:14px 22px 18px;font-size:11px;color:var(--muted);line-height:1.6;max-width:1100px}
.${ROOT} .foot b{color:var(--ink);font-weight:800}
.${ROOT} .foot + .foot{padding-top:0}
`;
