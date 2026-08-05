"use client";

// Player behavior evolution — v2 card. Ported from
// mockups/behavior-evolution-v2.html (authoritative structure, copy, colors and
// chart algorithm). Two views: "Overall Matchday" plots the four core metrics as
// network series; "City Detail" plots the seven play-markets for one selected
// metric. All series/values come from the shared computation (growthMetricGrid /
// GrowthData) so this card can never disagree with the Player Data Room.

import { useMemo, useState, type ReactNode } from "react";
import type { GrowthData, BehaviorPoint } from "@/lib/growthAnalytics";
import type { Period } from "./GlobalPeriod";
import { METRIC_LABEL, networkSeries, metricValue, type GridMetric } from "@/lib/growthMetricGrid";
import { downloadCsv } from "./format";
import styles from "./playerBehavior.module.css";

type BehaviorMetric = "registrations" | "newPlayers" | "totalPlayers" | "spots";

// Four core metrics + mockup colors, in the fixed display order.
const METRIC_DEFS: { key: BehaviorMetric; color: string }[] = [
  { key: "registrations", color: "#31d894" },
  { key: "newPlayers", color: "#3982ff" },
  { key: "totalPlayers", color: "#ffbe3d" },
  { key: "spots", color: "#8f67ff" },
];

const CITY_COLORS: Record<string, string> = {
  Atlanta: "#31d894",
  Austin: "#3982ff",
  Dallas: "#ffbe3d",
  Houston: "#8f67ff",
  OKC: "#f16464",
  "San Antonio": "#0fa4a0",
  "St. Louis": "#c74d94",
};
const NEUTRAL_COLOR = "#65716b"; // fallback for any unexpected city

const MON_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (m: string) => `${MON_ABBR[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const fmt = (n: number) => n.toLocaleString("en-US");
const pctChange = (a: number, b: number) => (b === 0 ? (a === 0 ? 0 : 100) : ((a - b) / b) * 100);

// ── chart geometry (ported verbatim from the mockup) ────────────────────────
const VW = 1120, VH = 350, M = { l: 70, r: 132, t: 20, b: 46 };
const IW = VW - M.l - M.r, IH = VH - M.t - M.b;

// Steps only by (1|2|5|10)×10^n and loops until the final tick is >= hi, so the
// top series can never clip off the top of the chart.
function niceTicks(hi: number, want = 5): number[] {
  const rough = hi / (want || 5);
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const n = rough / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
  const out: number[] = [];
  let v = 0;
  while (v < hi - 1e-9) {
    out.push(Math.round(v * 1e6) / 1e6);
    v += step;
  }
  out.push(Math.round(v * 1e6) / 1e6);
  if (out.length < 2) out.push(step);
  return out;
}
const tickLabel = (v: number) => (v >= 1000 && v % 1000 === 0 ? v / 1000 + "K" : fmt(v));

type Series = { data: number[]; color: string; label: string; width: number };

function buildChart(series: Series[], months: string[]) {
  const flat = series.flatMap((s) => s.data);
  const ticks = niceTicks(Math.max(1, ...flat), 5);
  const top = ticks[ticks.length - 1];
  const yAt = (v: number) => M.t + IH - (v / top) * IH;
  const xAt = (i: number) => M.l + (months.length === 1 ? IW / 2 : (i * IW) / (months.length - 1));

  const gridlines = ticks.map((t) => ({ y: yAt(t), label: tickLabel(t) }));
  const monthTicks = months.map((m, i) => ({ x: xAt(i), label: monthLabel(m) }));

  const polys = series.map((s) => ({
    d: s.data.map((v, i) => `${i ? "L" : "M"}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(" "),
    color: s.color,
    width: s.width,
    cx: xAt(s.data.length - 1),
    cy: yAt(s.data[s.data.length - 1]),
  }));

  // Direct labels are the legend, so they must stay legible and inside the plot
  // band. Push down for a 13px min gap; if the stack overruns the bottom slide
  // the whole group up; if the top then rises above TOP, clamp and re-space.
  const labels = series.map((s) => ({
    y: yAt(s.data[s.data.length - 1]),
    color: s.color,
    text: s.label,
  }));
  labels.sort((a, b) => a.y - b.y);
  const GAP = 13, TOP = M.t + 5, BOT = M.t + IH - 2;
  for (let i = 1; i < labels.length; i++)
    if (labels[i].y - labels[i - 1].y < GAP) labels[i].y = labels[i - 1].y + GAP;
  const over = labels[labels.length - 1].y - BOT;
  if (over > 0) labels.forEach((l) => (l.y -= over));
  if (labels[0].y < TOP) {
    labels[0].y = TOP;
    for (let i = 1; i < labels.length; i++)
      if (labels[i].y - labels[i - 1].y < GAP) labels[i].y = labels[i - 1].y + GAP;
  }

  return { gridlines, monthTicks, polys, labels };
}

type Row = { name: string; cells: number[]; total: number; mom: number; rank?: number; dot?: string };

export default function BehaviorPanel({
  data,
  period,
  scopeChip,
}: {
  data: GrowthData;
  period: Period;
  scopeChip?: ReactNode;
}) {
  const [view, setView] = useState<"matchday" | "city">("matchday");
  const [metric, setMetric] = useState<BehaviorMetric>("totalPlayers");

  const months = useMemo(
    () => data.behaviorOverall.map((p) => p.m).filter((m) => m >= period.start && m <= period.end),
    [data.behaviorOverall, period],
  );

  // The play-markets IN THE SELECTED PERIOD: cities with any spots > 0 across the
  // displayed months, sorted alphabetically. Scoping to the period (not all time)
  // is what keeps declared-only / one-off markets out — e.g. NYC had a single
  // match in 2025-10 (85 spots) but zero in Feb–Jul, and El Paso / New York City
  // have no matches at all. For the default Feb–Jul period this is the seven
  // established markets.
  const cities = useMemo(() => {
    const inPeriod = new Set(months);
    return Object.keys(data.behaviorByCity)
      .filter((c) => data.behaviorByCity[c].some((p) => inPeriod.has(p.m) && (p.spots ?? 0) > 0))
      .sort((a, b) => a.localeCompare(b));
  }, [data.behaviorByCity, months]);

  const cityMode = view === "city";

  const model = useMemo(() => {
    // series + table rows follow the current view.
    let series: Series[];
    let rows: Row[];
    let chartTitle: string;
    let chartSub: string;
    let detailTitle: string;
    let scope: string;

    const monthRange =
      months.length > 0 ? `${monthLabel(months[0])} – ${monthLabel(months[months.length - 1])}` : "";

    const toRow = (name: string, cells: number[], extra?: { rank: number; dot: string }): Row => {
      const total = cells.reduce((a, b) => a + b, 0);
      const mom = pctChange(cells[cells.length - 1] ?? 0, cells[cells.length - 2] ?? 0);
      return { name, cells, total, mom, ...extra };
    };

    if (!cityMode) {
      series = METRIC_DEFS.map((md) => ({
        data: networkSeries(data, md.key, months).map((v) => v ?? 0),
        color: md.color,
        label: METRIC_LABEL[md.key],
        width: 3,
      }));
      rows = series.map((s) => toRow(s.label, s.data));
      chartTitle = "Overall Matchday performance";
      chartSub = `${monthRange} · registrations, new players, total players and spots booked`;
      detailTitle = "Historical Matchday metrics";
      scope = "All Matchday";
    } else {
      const idxByCity: Record<string, Map<string, BehaviorPoint>> = {};
      for (const c of cities) idxByCity[c] = new Map(data.behaviorByCity[c].map((p) => [p.m, p]));
      series = cities.map((c) => ({
        data: months.map((m) => metricValue(idxByCity[c].get(m), metric as GridMetric) ?? 0),
        color: CITY_COLORS[c] ?? NEUTRAL_COLOR,
        label: c,
        width: 2.9,
      }));
      rows = series.map((s, k) => toRow(s.label, s.data, { rank: k + 1, dot: s.color }));
      const label = METRIC_LABEL[metric as GridMetric];
      chartTitle = `${label} by city`;
      chartSub = `${monthRange} · every city`;
      detailTitle = `${label} city detail`;
      scope = "All cities";
    }

    const chart = series.length && months.length ? buildChart(series, months) : null;
    return { chart, rows, chartTitle, chartSub, detailTitle, scope };
  }, [cityMode, data, months, cities, metric]);

  const metricPeriodText = `${months.length} month${months.length === 1 ? "" : "s"} · oldest to newest`;
  const firstColHead = cityMode ? "City" : "Metric";

  const exportCsv = () => {
    const header = [firstColHead, ...months.map(monthLabel), "Selected period", "Latest MoM"];
    const body = model.rows.map((r) => [
      r.name,
      ...r.cells.map((c) => String(c)),
      String(r.total),
      `${r.mom >= 0 ? "+" : ""}${r.mom.toFixed(1)}%`,
    ]);
    downloadCsv(`player-behavior-evolution-${cityMode ? `city-${metric}` : "matchday"}.csv`, [header, ...body]);
  };

  const c = model.chart;

  return (
    <div className={styles.root}>
      {/* card header */}
      <div className={styles.tableHead}>
        <div>
          <div className={styles.tableTitle}>Player behavior evolution</div>
          <div className={styles.cardSubHead}>
            Start with overall Matchday performance across the four core player metrics, then switch to City Detail to
            compare every city for one metric.
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
          {scopeChip}
          <button type="button" className={styles.btn} id="growthExport" onClick={exportCsv}>
            Export
          </button>
        </div>
      </div>

      {/* controls row */}
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle} id="playerBehaviorChartTitle">
            {model.chartTitle}
          </div>
          <div className={styles.cardSub} id="playerBehaviorChartSub">
            {model.chartSub}
          </div>
        </div>
        <div className={styles.behaviorControls}>
          <div className={styles.segmented} id="growthBehaviorView">
            <button
              type="button"
              className={`${styles.segBtn} ${!cityMode ? styles.segBtnActive : ""}`}
              data-value="matchday"
              onClick={() => setView("matchday")}
            >
              Overall Matchday
            </button>
            <button
              type="button"
              className={`${styles.segBtn} ${cityMode ? styles.segBtnActive : ""}`}
              data-value="city"
              onClick={() => setView("city")}
            >
              City Detail
            </button>
          </div>
          <div className={`${styles.filterField} ${cityMode ? "" : styles.hidden}`} id="growthBehaviorMetricField">
            <label htmlFor="growthBehaviorMetric">Metric</label>
            <select
              className={styles.compactSelect}
              id="growthBehaviorMetric"
              value={metric}
              onChange={(e) => setMetric(e.target.value as BehaviorMetric)}
            >
              <option value="registrations">Registrations</option>
              <option value="newPlayers">New players</option>
              <option value="totalPlayers">Total players</option>
              <option value="spots">Spots booked</option>
            </select>
          </div>
        </div>
      </div>

      {/* chart */}
      <div className={styles.chart}>
        <svg
          className={styles.chartSvg}
          id="playerBehaviorChart"
          viewBox={`0 0 ${VW} ${VH}`}
          preserveAspectRatio="xMidYMid meet"
        >
          {c && (
            <>
              {c.gridlines.map((g, i) => (
                <g key={`g${i}`}>
                  <line className={styles.gl} x1={M.l} y1={g.y.toFixed(1)} x2={M.l + IW} y2={g.y.toFixed(1)} />
                  <text className={styles.axis} x={M.l - 12} y={(g.y + 3.5).toFixed(1)} textAnchor="end">
                    {g.label}
                  </text>
                </g>
              ))}
              {c.monthTicks.map((t, i) => (
                <text key={`m${i}`} className={styles.axis} x={t.x.toFixed(1)} y={VH - M.b + 24} textAnchor="middle">
                  {t.label}
                </text>
              ))}
              {c.polys.map((p, i) => (
                <g key={`p${i}`}>
                  <path
                    d={p.d}
                    fill="none"
                    stroke={p.color}
                    strokeWidth={p.width}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                  <circle cx={p.cx.toFixed(1)} cy={p.cy.toFixed(1)} r={3.6} fill={p.color} />
                </g>
              ))}
              {c.labels.map((l, i) => (
                <text
                  key={`l${i}`}
                  className={styles.serieslab}
                  x={M.l + IW + 10}
                  y={(l.y + 4).toFixed(1)}
                  fill={l.color}
                >
                  {l.text}
                </text>
              ))}
            </>
          )}
        </svg>
      </div>

      {/* detail head */}
      <div className={styles.metricsDetailHead}>
        <div>
          <strong className={styles.detailStrong} id="growthDetailTitle">
            {model.detailTitle}
          </strong>
          <span className={styles.metricPeriod} id="growthMetricPeriod">
            {metricPeriodText}
          </span>
        </div>
        <span className={styles.behaviorScope} id="growthBehaviorScope">
          {model.scope}
        </span>
      </div>

      {/* summary table */}
      <div className={styles.summaryWrap}>
        <table className={styles.table}>
          <thead id="growthSummaryHead">
            <tr>
              <th>{firstColHead}</th>
              {months.map((m) => (
                <th key={m}>{monthLabel(m)}</th>
              ))}
              <th>Selected period</th>
              <th>Latest MoM</th>
            </tr>
          </thead>
          <tbody id="growthSummaryBody">
            {model.rows.map((r) => (
              <tr key={r.name}>
                <td className={styles.nameCell}>
                  {r.rank != null && <span className={styles.rank}>{r.rank}</span>}
                  {r.dot && <span className={styles.cityKey} style={{ background: r.dot }} />}
                  {r.name}
                </td>
                {r.cells.map((v, i) => (
                  <td key={i}>{fmt(v)}</td>
                ))}
                <td>{fmt(r.total)}</td>
                <td>
                  <span className={`${styles.status} ${r.mom >= 0 ? styles.statusGreen : styles.statusRed}`}>
                    {r.mom >= 0 ? "+" : ""}
                    {r.mom.toFixed(1)}%
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
