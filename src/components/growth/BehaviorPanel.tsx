"use client";

// Player behavior evolution — v2 card. Ported from
// mockups/behavior-evolution-v2.html (authoritative structure, copy, colors and
// chart algorithm). Two views: "Overall Matchday" plots the four core metrics as
// network series; "City Detail" plots the seven play-markets for one selected
// metric. All series/values come from the shared computation (growthMetricGrid /
// GrowthData) so this card can never disagree with the Player Data Room.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { GrowthData, BehaviorPoint } from "@/lib/growthAnalytics";
import type { Period } from "./GlobalPeriod";
import { METRIC_LABEL, networkSeries, metricValue, IS_RATE, type GridMetric } from "@/lib/growthMetricGrid";
import { downloadCsv } from "./format";
import styles from "./playerBehavior.module.css";
import { supabase } from "@/lib/supabase";
import {
  changeColumnLabel, changeColumnTitle, weekRangeLabel, weekTick, type Granularity,
} from "@/lib/weekBuckets";

/* THE WEEKLY PAYLOAD, as /api/lifecycle/behavior-weekly returns it. `w` is a Monday YYYY-MM-DD;
 * it is renamed to `m` on the way in so the rest of this file is unchanged. */
type WeekPoint = { w: string; registrations: number; newPlayers: number; totalPlayers: number; spots: number };
type WeeklyPayload = {
  axis: string[];
  overall: WeekPoint[];
  byCity: Record<string, WeekPoint[]>;
  byField?: Record<string, { label: string; city: string; points: WeekPoint[] }>;
  window?: { start: string | null; end: string | null; weeks: number; dropped: number };
};
const BEHAVIOR_GRAN_KEY = "behavior:granularity";

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
/* ONE LABELLER FOR BOTH GRANULARITIES. A weekly key is a Monday YYYY-MM-DD and reads as its full
 * date range — "Aug 24 – Aug 30", never a week number. A monthly key is YYYY-MM and is unchanged. */
const bucketLabel = (k: string, g: Granularity) => (g === "weekly" ? weekRangeLabel(k) : monthLabel(k));
/* THE CHART AXIS gets the short form: 13 full ranges will not fit across a chart, so the tick is
 * the Monday and the table below carries both ends. */
const bucketTick = (k: string, g: Granularity) => (g === "weekly" ? weekTick(k) : monthLabel(k));
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

function buildChart(series: Series[], months: string[], gran: Granularity = "monthly") {
  const flat = series.flatMap((s) => s.data);
  const ticks = niceTicks(Math.max(1, ...flat), 5);
  const top = ticks[ticks.length - 1];
  const yAt = (v: number) => M.t + IH - (v / top) * IH;
  const xAt = (i: number) => M.l + (months.length === 1 ? IW / 2 : (i * IW) / (months.length - 1));

  const gridlines = ticks.map((t) => ({ y: yAt(t), label: tickLabel(t) }));
  const monthTicks = months.map((m, i) => ({ x: xAt(i), label: bucketTick(m, gran) }));

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

  /* ── GRANULARITY ────────────────────────────────────────────────────────────────────────────
   * MONTHLY IS THE DEFAULT AND IS UNTOUCHED. Weekly is normalised into the SAME point shape the
   * monthly path already uses — `{ m, registrations, newPlayers, totalPlayers, spots }` where `m`
   * is a Monday YYYY-MM-DD instead of a YYYY-MM. That is the whole trick, and it is why this is a
   * ~40-line change to a 498-line panel rather than a rewrite: every downstream consumer —
   * networkSeries, indexPoints, toRow, buildChart, the city and field branches — keys on `.m` and
   * neither knows nor cares what the string means. Only the LABELS and the axis change.
   *
   * WEEKLY OBEYS THE PERIOD PICKER, exactly as monthly does. It did not at first — weekly rendered
   * a fixed last-13-weeks and the picker above it did nothing, which is a control that looks live
   * and is not one. The picker's month range now IS the weekly window: every week whose Monday
   * falls inside it. "Last 3 months" gives 13 or 14 weeks and "Last 6 months" 26 or 27 — derived
   * from the calendar, because months are not four weeks long. */
  const [gran, setGran] = useState<Granularity>("monthly");
  const [weekly, setWeekly] = useState<WeeklyPayload | null>(null);
  const [weeklyErr, setWeeklyErr] = useState<string | null>(null);
  useEffect(() => {
    try {
      const g = window.localStorage.getItem(BEHAVIOR_GRAN_KEY);
      if (g === "weekly" || g === "monthly") setGran(g);
    } catch { /* private mode */ }
  }, []);
  useEffect(() => {
    try { window.localStorage.setItem(BEHAVIOR_GRAN_KEY, gran); } catch { /* private mode */ }
  }, [gran]);
  /* ONE FETCH PER WINDOW, CACHED BY IT. The period bar's quick pills are one click apart, so
   * flipping 6 → 3 → 6 must not re-run the read three times. The cache is a ref rather than state
   * because writing to it must not itself render. */
  const weeklyCache = useRef(new Map<string, WeeklyPayload>());
  const winKey = `${period.start}:${period.end}`;
  useEffect(() => {
    if (gran !== "weekly") return;
    const cached = weeklyCache.current.get(winKey);
    if (cached) { setWeekly(cached); setWeeklyErr(null); return; }
    let dead = false;
    /* CLEARED FIRST. Without this the previous window's chart stays on screen while the new one
     * loads, under the new window's caption — the reader would be looking at Mar–Aug's bars
     * labelled Jun–Sep and have no way to tell. */
    setWeekly(null); setWeeklyErr(null);
    (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        const res = await fetch(
          `/api/lifecycle/behavior-weekly?start=${encodeURIComponent(period.start)}&end=${encodeURIComponent(period.end)}`,
          { cache: "no-store", headers: token ? { Authorization: `Bearer ${token}` } : {} },
        );
        const j = await res.json();
        if (!res.ok) throw new Error(j?.error ?? `HTTP ${res.status}`);
        if (!dead) { weeklyCache.current.set(winKey, j as WeeklyPayload); setWeekly(j as WeeklyPayload); }
      } catch (e) {
        // A FAILED FETCH IS AN ERROR, never an empty chart — the two look identical otherwise.
        if (!dead) setWeeklyErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { dead = true; };
  }, [gran, winKey, period.start, period.end]);

  /* THE WEEKLY DATA, WEARING THE MONTHLY SHAPE. `w` becomes `m`; nothing downstream changes. */
  const weeklyData = useMemo<GrowthData | null>(() => {
    if (!weekly) return null;
    const pt = (p: WeekPoint): BehaviorPoint => ({
      m: p.w, registrations: p.registrations, newPlayers: p.newPlayers,
      totalPlayers: p.totalPlayers, spots: p.spots,
    });
    const byCity: Record<string, BehaviorPoint[]> = {};
    for (const [c, ps] of Object.entries(weekly.byCity)) byCity[c] = ps.map(pt);
    const byField: GrowthData["behaviorByField"] = {};
    for (const [f, v] of Object.entries(weekly.byField ?? {})) {
      byField[f] = { label: v.label, city: v.city, points: v.points.map(pt) };
    }
    // Spread the real payload so anything this panel does not touch keeps working.
    return { ...data, behaviorOverall: weekly.overall.map(pt), behaviorByCity: byCity, behaviorByField: byField };
  }, [weekly, data]);

  /* FROM HERE DOWN, `src` REPLACES `data` AND `months` IS THE AXIS. Monthly resolves to exactly
   * what it resolved to before — same array, same filter, same order. */
  const src = gran === "weekly" && weeklyData ? weeklyData : data;
  const months = useMemo(
    () => (gran === "weekly" && weekly
      ? weekly.axis
      : data.behaviorOverall.map((p) => p.m).filter((m) => m >= period.start && m <= period.end)),
    [gran, weekly, data.behaviorOverall, period],
  );

  // The play-markets IN THE SELECTED PERIOD: cities with any spots > 0 across the
  // displayed months, sorted alphabetically. Scoping to the period (not all time)
  // is what keeps declared-only / one-off markets out — e.g. NYC had a single
  // match in 2025-10 (85 spots) but zero in Feb–Jul, and El Paso / New York City
  // have no matches at all. For the default Feb–Jul period this is the seven
  // established markets.
  const cities = useMemo(() => {
    const inPeriod = new Set(months);
    return Object.keys(src.behaviorByCity)
      .filter((c) => src.behaviorByCity[c].some((p) => inPeriod.has(p.m) && (p.spots ?? 0) > 0))
      .sort((a, b) => a.localeCompare(b));
  }, [src.behaviorByCity, months]);

  const cityMode = view === "city";
  const fieldMode = view === "field";
  const detailMode = cityMode || fieldMode;

  // REGISTRATIONS IS NOT OFFERED IN FIELD MODE AND MUST NOT BE ADDED BACK.
  // A registration carries a city (the one declared at signup) but never a field — nobody registers
  // at a pitch. Offering it per field would either repeat the city's number under every one of its
  // fields or invent an attribution that does not exist. City Detail keeps it, because a city IS
  // recorded at registration.
  // % RECURRING IS OFFERED EVERYWHERE. It was withheld from field mode while behaviorByField had
  // 22 field-months where new exceeded total — a rate derived from a contradiction. That is fixed
  // at the source: events now count toward a field's players, spots AND new players alike, the same
  // single population the partner dashboard uses. Verified: 22 violations → 0, and PARMER Stadium
  // Aug 2026 agrees with the partner page exactly (128 = 128).
  const METRICS_FOR_MODE: BehaviorMetric[] = fieldMode
    ? (["newPlayers", "totalPlayers", "spots", "pctRecurring"] as BehaviorMetric[])
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
    return Object.keys(src.behaviorByField)
      .filter((f) => src.behaviorByField[f].points.some((p) => inPeriod.has(p.m) && (p.spots ?? 0) > 0))
      .sort((a, b) => a.localeCompare(b));
  }, [src.behaviorByField, months]);

  const model = useMemo(() => {
    // series + table rows follow the current view.
    let series: Series[];
    let rows: Row[];
    let chartTitle: string;
    let chartSub: string;
    let detailTitle: string;
    let scope: string;

    /* THE CAPTION NAMES THE ACTUAL RANGE. Weekly reads "Jun 8 – Jun 14 – Aug 31 – Sep 6", which is
     * unreadable, so it names the first Monday and the last Sunday instead — one range, not two. */
    const monthRange = months.length === 0 ? ""
      : gran === "weekly"
        ? `${weekTick(months[0])} – ${weekRangeLabel(months[months.length - 1]).split(" – ")[1]}`
        : `${monthLabel(months[0])} – ${monthLabel(months[months.length - 1])}`;

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
        data: networkSeries(src, md.key, months).map((v) => v ?? 0),
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
        rows.push(toRow(METRIC_LABEL[rm], networkSeries(src, rm, months).map((v) => v ?? 0), undefined, rm === "pctRecurring"));
      }
      chartTitle = "Overall Matchday performance";
      chartSub = `${monthRange} · registrations, new players, total players and spots booked`;
      detailTitle = "Historical Matchday metrics";
      scope = "All Matchday";
    } else if (fieldMode) {
      const idxByField: Record<string, Map<string, BehaviorPoint>> = {};
      for (const f of fields) idxByField[f] = new Map(src.behaviorByField[f].points.map((p) => [p.m, p]));
      series = fields.map((f, k) => ({
        data: months.map((m) => metricValue(idxByField[f].get(m), metric as GridMetric) ?? 0),
        color: FIELD_COLORS[k % FIELD_COLORS.length],
        label: src.behaviorByField[f].label,
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
      for (const c of cities) idxByCity[c] = new Map(src.behaviorByCity[c].map((p) => [p.m, p]));
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

    const chart = series.length && months.length ? buildChart(series, months, gran) : null;
    /* THE CEILING, SAID OUT LOUD. A custom range longer than 53 weeks keeps the most recent 53;
     * without this line the chart would read as the whole period and be short by the difference. */
    const dropped = gran === "weekly" ? (weekly?.window?.dropped ?? 0) : 0;
    if (dropped > 0) chartSub += ` · earliest ${dropped} week${dropped === 1 ? "" : "s"} of this period not shown (53-week maximum)`;
    return { chart, rows, chartTitle, chartSub, detailTitle, scope };
  }, [cityMode, fieldMode, detailMode, src, months, cities, fields, metric, gran, weekly]);

  /* THE UNIT FOLLOWS THE GRANULARITY. This read "26 months · oldest to newest" in weekly mode,
   * because `months` is the axis whatever the axis is made of. A count is not unit-free. */
  const unit = gran === "weekly" ? "week" : "month";
  const metricPeriodText = `${months.length} ${unit}${months.length === 1 ? "" : "s"} · oldest to newest`;
  const firstColHead = fieldMode ? "Field" : cityMode ? "City" : "Metric";

  const exportCsv = () => {
    const header = [firstColHead, ...months.map((k) => bucketLabel(k, gran)), "Selected period", `Latest ${changeColumnLabel(gran)}`];
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
        new Map((fieldMode ? src.behaviorByField[k].points : src.behaviorByCity[k]).map((p) => [p.m, p]));
      for (const rm of ["newPlayers", "totalPlayers", "recurring", "pctRecurring"] as GridMetric[]) {
        for (const k of scopes) {
          const idx = pointsOf(k);
          const cells = months.map((m) => metricValue(idx.get(m), rm) ?? 0);
          const rate = rm === "pctRecurring";
          const last = cells[cells.length - 1] ?? 0;
          const prev = cells[cells.length - 2] ?? 0;
          body.push([
            `${fieldMode ? src.behaviorByField[k].label : k} · ${METRIC_LABEL[rm]}`,
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
          {/* GRANULARITY. Monthly is the default and is what this panel has always shown; Weekly
              is an addition beside it, using the same segmented control the view switcher uses so
              the two read as peers rather than one being a mode of the other. */}
          <div className={styles.segmented} id="growthBehaviorGranularity" data-testid="behavior-granularity">
            <button
              type="button"
              className={`${styles.segBtn} ${gran === "monthly" ? styles.segBtnActive : ""}`}
              data-value="monthly"
              data-testid="behavior-gran-monthly"
              onClick={() => setGran("monthly")}
            >
              Monthly
            </button>
            <button
              type="button"
              className={`${styles.segBtn} ${gran === "weekly" ? styles.segBtnActive : ""}`}
              data-value="weekly"
              data-testid="behavior-gran-weekly"
              onClick={() => setGran("weekly")}
            >
              Weekly
            </button>
          </div>
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

      {gran === "weekly" && weeklyErr ? (
        <div className={styles.chart} data-testid="behavior-weekly-error" style={{ padding: 24, color: "#a8391a" }}>
          <b>The weekly data could not be loaded — this is not an empty chart.</b> {weeklyErr}
        </div>
      ) : gran === "weekly" && !weekly ? (
        <div className={styles.chart} data-testid="behavior-weekly-loading" style={{ padding: 24 }}>Loading {monthLabel(period.start)} – {monthLabel(period.end)} by week…</div>
      ) : (
      <>
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
              <th title={changeColumnTitle(gran)}>Latest {changeColumnLabel(gran)}</th>
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
      </>
      )}
    </div>
  );
}
