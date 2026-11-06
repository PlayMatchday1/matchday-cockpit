"use client";

/* REVENUE PER PLAYER — the redesign (Ryan, 2026-11-05; Figma "Revenue per Player" page, frames 15:3
 * Monthly and 16:2 Annual). Miguel's three complaints are the shape of this file:
 *
 *   Sep 17  the preset bubbles are gone; a From / To month range drives the chart and the city
 *           table's month columns.
 *   Oct 14  the page compared two months and the picker changed nothing: the old panel read three
 *           fixed months off data.arppCard and ignored the period entirely. Now every settled month
 *           is in data.arppCard.series and the range selects from it on the client.
 *   Oct 14  "previous year" was unclear: the cards say "vs September" and "vs October 2025".
 *
 * THE ARITHMETIC DID NOT MOVE. Revenue per player for a month is the card's own resolver: clean
 * revenue (deleted accounts' revenue out) over the players who played or held a paying membership
 * that month, counted once at network grain and once per city. October 2026 reads what it read
 * before. The caveat paragraphs became the "How this is counted" panel at the bottom, closed.
 *
 * Tables of numbers, not sparklines: Miguel prefers real numbers over small line graphs, so the one
 * chart on the page is the network line with last year dashed, and the city table is money. */

import { useMemo, useState } from "react";
import type { ArppMonthPoint, ArppSeries, GrowthData } from "@/lib/growthAnalytics";
import styles from "./growth.module.css";
import MonthRangeBar, { orderRange } from "./MonthRangeBar";
import { LineChart, type Series } from "./charts";
import { fmtInt, monthLabel } from "./format";

type Mode = "monthly" | "annual";
type View = "city" | "field";

const MON_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const longMonth = (key: string) => `${MON_LONG[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
const shortMonth = (key: string) => MON[Number(key.slice(5, 7)) - 1];
const money = (v: number | null | undefined, digits = 2) => (v == null ? "—" : "$" + v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
const signedMoney = (d: number) => `${d < 0 ? "−" : "+"}$${Math.abs(d).toFixed(2)}`;
const addMonths = (key: string, delta: number): string => {
  const [y, m] = key.split("-").map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
};

/** A change chip. Null on either side is a dash; a missing prior year is "new" (the city did not
 *  exist then) rather than a percentage against nothing. */
function Chip({ cur, prev, newWhenMissing = false }: { cur: number | null; prev: number | null; newWhenMissing?: boolean }) {
  if (cur == null || prev == null || prev === 0) {
    return newWhenMissing && cur != null && prev == null
      ? <span className={styles.pill} data-testid="rpp-chip-new">new</span>
      : <span className={styles.nd}>—</span>;
  }
  const d = ((cur - prev) / prev) * 100;
  return (
    <span className={`${styles.status} ${d >= 0 ? styles.statusGreen : styles.statusRed}`} data-testid="rpp-chip">
      {d >= 0 ? "▲" : "▼"} {Math.abs(d).toFixed(1)}%
    </span>
  );
}

export default function RevenuePerPlayerPanel({ data }: { data: GrowthData }) {
  const series: ArppSeries | undefined = data.arppCard?.series;
  const [mode, setMode] = useState<Mode>("monthly");
  const [view, setView] = useState<View>("city");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");

  const months = series?.months ?? [];
  const last = months[months.length - 1] ?? "";
  const first = months[0] ?? "";
  /* THE DEFAULT IS THE SIX MOST RECENT FULL MONTHS, ending on the latest settled month. */
  const defaultStart = months[Math.max(0, months.length - 6)] ?? first;
  const range = useMemo(() => orderRange(start || defaultStart, end || last), [start, end, defaultStart, last]);
  const axis = useMemo(() => months.filter((m) => m >= range.start && m <= range.end), [months, range]);
  const to = axis[axis.length - 1] ?? last;
  const prevM = addMonths(to, -1);
  const pyM = addMonths(to, -12);

  const rows = useMemo(() => {
    if (!series) return [];
    const list = view === "city" ? series.cities.map((c) => ({ name: c.name, city: null as string | null, points: c.points }))
      : series.fields.map((f) => ({ name: f.name, city: f.city, points: f.points }));
    const at = (p: Record<string, ArppMonthPoint>, m: string) => p[m]?.arpp ?? null;
    return list
      .map((r) => ({ ...r, cur: at(r.points, to), prev: at(r.points, prevM), py: at(r.points, pyM), players: r.points[to]?.players ?? 0 }))
      .filter((r) => axis.some((m) => at(r.points, m) != null))
      .sort((a, b) => (b.cur ?? -Infinity) - (a.cur ?? -Infinity));
  }, [series, view, axis, to, prevM, pyM]);

  if (!series || months.length === 0) return <div className={styles.stateMsg}>No settled months yet.</div>;

  const net = series.network;
  const cur = net[to], prev = net[prevM], py = net[pyM];
  const delta = (a: ArppMonthPoint | undefined, b: ArppMonthPoint | undefined) =>
    a?.arpp != null && b?.arpp != null ? { d: a.arpp - b.arpp, pct: b.arpp ? ((a.arpp - b.arpp) / b.arpp) * 100 : null } : null;
  const vsPrev = delta(cur, prev), vsPy = delta(cur, py);

  const seg = (on: boolean, label: string, fn: () => void, testId: string) => (
    <button type="button" className={`${styles.segBtn} ${on ? styles.segBtnActive : ""}`} aria-pressed={on} onClick={fn} data-testid={testId}>{label}</button>
  );

  const chart: Series[] = [
    { label: axis.length ? `${axis[0].slice(0, 4) === to.slice(0, 4) ? to.slice(0, 4) : `${axis[0].slice(0, 4)}–${to.slice(0, 4)}`}` : "This range", color: "var(--forest)", values: axis.map((m) => net[m]?.arpp ?? null) },
    { label: "Same month a year earlier", color: "#9AA8A1", dash: true, values: axis.map((m) => net[addMonths(m, -12)]?.arpp ?? null) },
  ];
  const step = Math.max(46, Math.min(180, Math.floor(960 / Math.max(1, axis.length - 1))));

  const kpi = (label: string, value: string, foot: string, chip?: React.ReactNode, testId?: string) => (
    <div className={styles.kpi} data-testid={testId}>
      <div className={styles.kpiLabel}>{label}</div>
      <div className={styles.kpiValue} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>{value}{chip}</div>
      <div className={styles.kpiFoot}>{foot}</div>
    </div>
  );
  const pctChip = (c: { d: number; pct: number | null } | null) =>
    c && c.pct != null ? <span className={`${styles.status} ${c.d >= 0 ? styles.statusGreen : styles.statusRed}`}>{c.d >= 0 ? "▲" : "▼"} {Math.abs(c.pct).toFixed(1)}%</span> : null;

  /* 2024 ON. fin_revenue begins in May 2023, so 2023 is eight months beside three full years and
   * would read as a collapse; the mock lists 2024, 2025 and the year to date. */
  const annual = series.annual.filter((y) => y.year >= 2024);

  return (
    <>
      {/* ── CONTROLS: the mode, and the From / To range (hidden in Annual) ─────────────────── */}
      <div className={styles.controlsRow} style={{ justifyContent: "space-between", alignItems: "center" }} data-testid="rpp-controls">
        <div className={styles.segmented} data-testid="rpp-mode">
          {seg(mode === "monthly", "Monthly", () => setMode("monthly"), "rpp-mode-monthly")}
          {seg(mode === "annual", "Annual", () => setMode("annual"), "rpp-mode-annual")}
        </div>
        {mode === "monthly" && (
          <MonthRangeBar range={range} min={first} max={last} onStart={setStart} onEnd={setEnd} label="From"
            testId="rpp-range" startTestId="rpp-range-start" endTestId="rpp-range-end" echoTestId="rpp-range-echo" />
        )}
      </div>

      {mode === "monthly" ? (
        <>
          <div className={styles.kpiRow} data-testid="rpp-kpis">
            {kpi(longMonth(to), money(cur?.arpp), "per paying player", undefined, "rpp-kpi-cur")}
            {kpi(`vs ${MON_LONG[Number(prevM.slice(5, 7)) - 1]}`, vsPrev ? signedMoney(vsPrev.d) : "—", `was ${money(prev?.arpp)}`, pctChip(vsPrev), "rpp-kpi-prev")}
            {kpi(`vs ${longMonth(pyM)}`, vsPy ? signedMoney(vsPy.d) : "—", `was ${money(py?.arpp)}`, pctChip(vsPy), "rpp-kpi-py")}
            {kpi("Paying players", fmtInt(cur?.players ?? 0), "counted once across cities", undefined, "rpp-kpi-players")}
          </div>

          <section className={styles.card} data-testid="rpp-chart">
            <div className={styles.cardHead}>
              <div className={styles.cardTitle}>Revenue per player by month</div>
              <div className={styles.legend}>
                {chart.map((s) => (
                  <span key={s.label} className={styles.legendItem}>
                    <span className={styles.legendDot} style={{ background: s.color, height: 3, width: 14, borderRadius: 2, ...(s.dash ? { backgroundImage: `repeating-linear-gradient(90deg, ${s.color} 0 4px, transparent 4px 7px)`, background: "none" } : {}) }} />
                    {s.label}
                  </span>
                ))}
              </div>
            </div>
            <LineChart axis={axis} series={chart} height={260} step={step} formatAxis={shortMonth}
              formatValue={(v) => money(v)} formatTick={(v) => `$${Math.round(v)}`} />
          </section>

          <section className={styles.card} data-testid="rpp-table">
            <div className={styles.cardHead}>
              <div className={styles.cardTitle}>{view === "city" ? "By city" : "By field"}</div>
              <div className={styles.segmented} data-testid="rpp-view">
                {seg(view === "city", "Cities", () => setView("city"), "rpp-view-city")}
                {seg(view === "field", "Fields", () => setView("field"), "rpp-view-field")}
              </div>
            </div>
            <div className={styles.rppWrap}>
              <table className={`${styles.dataTable} ${styles.rppTable}`}>
                <thead>
                  <tr>
                    <th className={styles.rppLeft}>{view === "city" ? "City" : "Field"}</th>
                    {axis.map((m) => <th key={m} className={m === to ? styles.rppLatest : undefined}>{shortMonth(m)}{m.slice(0, 4) !== to.slice(0, 4) ? ` ${m.slice(2, 4)}` : ""}</th>)}
                    <th className={`${styles.rppRight} ${styles.rppRight3}`}>vs {shortMonth(prevM)}</th>
                    <th className={`${styles.rppRight} ${styles.rppRight2}`}>vs {shortMonth(pyM)} {pyM.slice(0, 4)}</th>
                    <th className={`${styles.rppRight} ${styles.rppRight1}`}>Players</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.name}|${r.city ?? ""}`} data-testid="rpp-row">
                      <td className={`${styles.rppLeft} ${styles.nameCell}`}>{r.name}{view === "field" && r.city ? <span className={styles.nd}> · {r.city}</span> : null}</td>
                      {axis.map((m) => <td key={m} className={m === to ? styles.rppLatest : undefined}>{money(r.points[m]?.arpp)}</td>)}
                      <td className={`${styles.rppRight} ${styles.rppRight3}`}><Chip cur={r.cur} prev={r.prev} /></td>
                      <td className={`${styles.rppRight} ${styles.rppRight2}`}><Chip cur={r.cur} prev={r.py} newWhenMissing /></td>
                      <td className={`${styles.rppRight} ${styles.rppRight1}`}>{r.players ? fmtInt(r.players) : <span className={styles.nd}>—</span>}</td>
                    </tr>
                  ))}
                  <tr className={styles.summaryRow} data-testid="rpp-total">
                    <td className={styles.rppLeft}>All MatchDay</td>
                    {axis.map((m) => <td key={m} className={m === to ? styles.rppLatest : undefined}>{money(net[m]?.arpp)}</td>)}
                    <td className={`${styles.rppRight} ${styles.rppRight3}`}><Chip cur={cur?.arpp ?? null} prev={prev?.arpp ?? null} /></td>
                    <td className={`${styles.rppRight} ${styles.rppRight2}`}><Chip cur={cur?.arpp ?? null} prev={py?.arpp ?? null} newWhenMissing /></td>
                    <td className={`${styles.rppRight} ${styles.rppRight1}`}>{fmtInt(cur?.players ?? 0)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <details className={styles.rppHow} data-testid="rpp-how">
            <summary>How this is counted</summary>
            <dl>
              <dt>Per player</dt><dd>Revenue from paying players that month, divided by the players who played or held a paying membership that month.</dd>
              <dt>Network vs cities</dt><dd>A player who plays in two cities counts once for MatchDay but once in each city, so cities don&rsquo;t average to the top number.</dd>
              <dt>Left out</dt><dd>Staff, test and fake accounts. Deleted accounts count neither their revenue nor themselves.</dd>
              <dt>&ldquo;—&rdquo;</dt><dd>The {view === "city" ? "city" : "field"} didn&rsquo;t exist yet in that month.</dd>
            </dl>
          </details>
        </>
      ) : (
        <section className={styles.card} data-testid="rpp-annual">
          <div className={styles.cardHead}><div className={styles.cardTitle}>By year</div></div>
          <div className={styles.tableWrap}>
            <table className={styles.dataTable}>
              <thead>
                <tr><th>Year</th><th>Revenue</th><th>Paying players</th><th>Per player</th><th>vs prior year</th></tr>
              </thead>
              <tbody>
                {annual.map((y, i) => {
                  const prior = annual[i - 1];
                  return (
                    <tr key={y.year} data-testid="rpp-year" data-year={y.year}>
                      <td className={styles.nameCell}>{y.year}{y.ytd ? ` YTD (Jan–${shortMonth(to)})` : ""}</td>
                      <td>{money(y.net, 0)}</td>
                      <td>{fmtInt(y.players)}</td>
                      <td>{money(y.arpp)}</td>
                      <td>{prior ? <Chip cur={y.arpp} prev={prior.arpp} /> : <span className={styles.nd}>—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
