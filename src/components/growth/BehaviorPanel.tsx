"use client";

// Player behavior evolution — v2 card. Ported from
// mockups/behavior-evolution-v2.html (authoritative structure, copy, colors and
// chart algorithm). Two views: "Overall Matchday" plots the four core metrics as
// network series; "City Detail" plots the seven play-markets for one selected
// metric. All series/values come from the shared computation (growthMetricGrid /
// GrowthData) so this card can never disagree with the Player Data Room.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { GrowthData, BehaviorPoint } from "@/lib/growthAnalytics";
import type { Period } from "./GlobalPeriod";
import { METRIC_LABEL, networkSeries, metricValue, IS_RATE, type GridMetric } from "@/lib/growthMetricGrid";
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
// A palette for pitches — more fields than cities, so it cycles. Colour identifies a line against
// its neighbours; the table beneath carries the names.
const FIELD_COLORS = [
  "#2CDB87", "#2E79FF", "#F5A524", "#E5484D", "#8E4EC6", "#12A594",
  "#D6409F", "#6E56CF", "#F76808", "#46A758", "#3E63DD", "#AB4ABA",
];

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

type Row = { name: string; cells: number[]; total: number; mom: number; rank?: number; dot?: string; points?: boolean };

export default function BehaviorPanel({
  data,
  period,
  scopeChip,
}: {
  data: GrowthData;
  period: Period;
  scopeChip?: ReactNode;
}) {
  const [view, setView] = useState<"matchday" | "city" | "field">("matchday");
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
  const fieldMode = view === "field";
  const detailMode = cityMode || fieldMode;

  // REGISTRATIONS IS NOT OFFERED IN FIELD MODE AND MUST NOT BE ADDED BACK.
  // A registration carries a city (the one declared at signup) but never a field — nobody registers
  // at a pitch. Offering it per field would either repeat the city's number under every one of its
  // fields or invent an attribution that does not exist. City Detail keeps it, because a city IS
  // recorded at registration.
  // % RECURRING IS NOT OFFERED PER FIELD, AND THIS IS A BLOCKER, NOT A CHOICE.
  // It is derived as (total − new) / total, which requires new to be a SUBSET of total. In
  // behaviorByField it is not: 22 field-months have new > total, 8 of them inside the default
  // period, worst at ATH Pearland 2026-07 (new 234, total 30). The two series are built from
  // different populations — field totals exclude special events while the first-appearance count
  // does not fully align with that exclusion — so any recurring figure per field would be derived
  // from a contradiction. It is withheld until the populations reconcile rather than shown as 0%.
  // City and Overall are unaffected and DO offer it.
  const METRICS_FOR_MODE: BehaviorMetric[] = fieldMode
    ? (["newPlayers", "totalPlayers", "spots"] as BehaviorMetric[])
    : (["registrations", "newPlayers", "totalPlayers", "spots", "pctRecurring"] as BehaviorMetric[]);

  // Switching into field mode while Registrations is selected must not leave a metric the mode
  // does not offer.
  useEffect(() => {
    if (!METRICS_FOR_MODE.includes(metric)) setMetric("totalPlayers" as BehaviorMetric);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // THE PITCHES IN THE SELECTED PERIOD, same rule as cities: any spots in a displayed month.
  const fields = useMemo(() => {
    const inPeriod = new Set(months);
    return Object.keys(data.behaviorByField)
      .filter((f) => data.behaviorByField[f].points.some((p) => inPeriod.has(p.m) && (p.spots ?? 0) > 0))
      .sort((a, b) => a.localeCompare(b));
  }, [data.behaviorByField, months]);

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

    // A RATE MOVES IN PERCENTAGE POINTS, NOT PERCENT. "% recurring went from 40% to 44%" is +4
    // POINTS, not +10%. Reporting the relative change of a percentage is a classic way to overstate
    // a move by a factor of the base, and it is the one thing this metric makes easy to get wrong.
    const isRate = IS_RATE.has(metric as GridMetric);
    const toRow = (name: string, cells: number[], extra?: { rank: number; dot: string }, rateRow = false): Row => {
      const last = cells[cells.length - 1] ?? 0;
      const prev = cells[cells.length - 2] ?? 0;
      const rate = rateRow || (isRate && !!extra);
      // A rate's "period" figure is its LATEST value, never a sum — summing percentages is meaningless.
      const total = rate ? last : cells.reduce((a, b) => a + b, 0);
      const mom = rate ? last - prev : pctChange(last, prev);
      return { name, cells, total, mom, points: rate, ...extra };
    };

    // NOT `!cityMode` — field mode is also not city mode, and this branch would swallow it,
    // rendering the overall series under the Field Detail heading.
    if (!detailMode) {
      series = METRIC_DEFS.map((md) => ({
        data: networkSeries(data, md.key, months).map((v) => v ?? 0),
        color: md.color,
        label: METRIC_LABEL[md.key],
        width: 3,
      }));
      rows = series.map((s) => toRow(s.label, s.data));
      // BOTH RECURRING FIGURES AS ROWS. The count says how many came back; the rate says whether we
      // are keeping them. A count falls whenever the month is smaller even when loyalty has not
      // moved, so the rate is the one that carries the signal — and the rate alone hides the size
      // of the group it describes.
      for (const rm of ["recurring", "pctRecurring"] as GridMetric[]) {
        rows.push(toRow(METRIC_LABEL[rm], networkSeries(data, rm, months).map((v) => v ?? 0), undefined, rm === "pctRecurring"));
      }
      chartTitle = "Overall Matchday performance";
      chartSub = `${monthRange} · registrations, new players, total players and spots booked`;
      detailTitle = "Historical Matchday metrics";
      scope = "All Matchday";
    } else if (fieldMode) {
      const idxByField: Record<string, Map<string, BehaviorPoint>> = {};
      for (const f of fields) idxByField[f] = new Map(data.behaviorByField[f].points.map((p) => [p.m, p]));
      series = fields.map((f, k) => ({
        data: months.map((m) => metricValue(idxByField[f].get(m), metric as GridMetric) ?? 0),
        color: FIELD_COLORS[k % FIELD_COLORS.length],
        label: data.behaviorByField[f].label,
        width: 2.4,
      }));
      rows = series.map((s2, k) => toRow(s2.label, s2.data, { rank: k + 1, dot: s2.color }));
      const label = METRIC_LABEL[metric as GridMetric];
      chartTitle = `${label} by field`;
      chartSub = `${monthRange} · every pitch with matches in the period`;
      detailTitle = `${label} field detail`;
      scope = "All fields";
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
  }, [cityMode, fieldMode, detailMode, data, months, cities, fields, metric]);

  const metricPeriodText = `${months.length} month${months.length === 1 ? "" : "s"} · oldest to newest`;
  const firstColHead = fieldMode ? "Field" : cityMode ? "City" : "Metric";

  const exportCsv = () => {
    const header = [firstColHead, ...months.map(monthLabel), "Selected period", "Latest MoM"];
    const body = model.rows.map((r) => [
      r.name,
      // A rate is written with its unit so a spreadsheet cannot mistake 44 for a count.
      ...r.cells.map((c) => (r.points ? `${c.toFixed(1)}%` : String(c))),
      r.points ? `${r.total.toFixed(1)}%` : String(r.total),
      // PERCENTAGE POINTS for a rate, percent for a count — the unit is in the value, so the
      // column cannot be read as the wrong kind of change.
      r.points ? `${r.mom >= 0 ? "+" : ""}${r.mom.toFixed(1)} pts` : `${r.mom >= 0 ? "+" : ""}${r.mom.toFixed(1)}%`,
    ]);

    // IN DETAIL MODES THE ROWS ARE ONE METRIC ACROSS SCOPES, so the recurring pair would otherwise
    // be missing from the file entirely. Both are appended per scope, and they reconcile against
    // total and new by construction: recurring = total − new, % = recurring / total.
    if (detailMode) {
      const scopes = fieldMode ? fields : cities;
      const pointsOf = (k: string) =>
        new Map((fieldMode ? data.behaviorByField[k].points : data.behaviorByCity[k]).map((p) => [p.m, p]));
      for (const rm of ["newPlayers", "totalPlayers", "recurring", "pctRecurring"] as GridMetric[]) {
        for (const k of scopes) {
          const idx = pointsOf(k);
          const cells = months.map((m) => metricValue(idx.get(m), rm) ?? 0);
          const rate = rm === "pctRecurring";
          const last = cells[cells.length - 1] ?? 0;
          const prev = cells[cells.length - 2] ?? 0;
          body.push([
            `${fieldMode ? data.behaviorByField[k].label : k} · ${METRIC_LABEL[rm]}`,
            ...cells.map((c) => (rate ? `${c.toFixed(1)}%` : String(c))),
            rate ? `${last.toFixed(1)}%` : String(cells.reduce((a, b) => a + b, 0)),
            rate
              ? `${last - prev >= 0 ? "+" : ""}${(last - prev).toFixed(1)} pts`
              : `${pctChange(last, prev) >= 0 ? "+" : ""}${pctChange(last, prev).toFixed(1)}%`,
          ]);
        }
      }
    }
    downloadCsv(
      `player-behavior-evolution-${fieldMode ? `field-${metric}` : cityMode ? `city-${metric}` : "matchday"}.csv`,
      [header, ...body],
    );
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
            <button
              type="button"
              className={`${styles.segBtn} ${fieldMode ? styles.segBtnActive : ""}`}
              data-value="field"
              data-testid="behavior-view-field"
              onClick={() => setView("field")}
            >
              Field Detail
            </button>
          </div>
          <div className={`${styles.filterField} ${detailMode ? "" : styles.hidden}`} id="growthBehaviorMetricField">
            <label htmlFor="growthBehaviorMetric">Metric</label>
            <select
              className={styles.compactSelect}
              id="growthBehaviorMetric"
              data-testid="behavior-metric"
              value={metric}
              onChange={(e) => setMetric(e.target.value as BehaviorMetric)}
            >
              {/* FIELD MODE OFFERS NO REGISTRATIONS — see METRICS_FOR_MODE. */}
              {METRICS_FOR_MODE.map((mk) => (
                <option key={mk} value={mk}>{METRIC_LABEL[mk as GridMetric]}</option>
              ))}
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
                  <td key={i}>{r.points ? `${v.toFixed(1)}%` : fmt(v)}</td>
                ))}
                <td>{r.points ? `${r.total.toFixed(1)}%` : fmt(r.total)}</td>
                <td>
                  {/* PERCENTAGE POINTS for a rate. A rate that moves 40% → 44% moved +4 POINTS;
                      calling it +10% overstates it by the size of the base. */}
                  <span
                    className={`${styles.status} ${r.mom >= 0 ? styles.statusGreen : styles.statusRed}`}
                    data-testid={r.points ? "behavior-mom-points" : undefined}
                  >
                    {r.mom >= 0 ? "+" : ""}
                    {r.mom.toFixed(1)}
                    {r.points ? " pts" : "%"}
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
