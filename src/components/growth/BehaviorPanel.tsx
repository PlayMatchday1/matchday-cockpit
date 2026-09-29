"use client";

// Player behavior evolution — v2 card. Ported from
// mockups/behavior-evolution-v2.html (authoritative structure, copy, colors and
// chart algorithm). Two views: "Overall Matchday" plots the four core metrics as
// network series; "City Detail" plots the seven play-markets for one selected
// metric. All series/values come from the shared computation (growthMetricGrid /
// GrowthData) so this card can never disagree with the Player Data Room.

import { supabase } from "@/lib/supabase";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { GrowthData, BehaviorPoint } from "@/lib/growthAnalytics";
import type { Period } from "./GlobalPeriod";
import { METRIC_LABEL, networkSeries, metricValue, hasFieldDimension, isAdditive, isDistinct,
  sumAcrossBuckets, IS_RATE, type GridMetric } from "@/lib/growthMetricGrid";
import { UNASSIGNED_CITY } from "@/lib/growthAnalytics";
import { downloadCsv } from "./format";
import { exportBody, exportHeader } from "@/lib/behaviorExport";
import styles from "./playerBehavior.module.css";
import {
  changeColumnLabel, grainUnitWord, matchedMonthWindow, monthEnd, weekRangeLabel, weekTick, type Granularity, isWeekComplete, isBucketComplete, lastTwoComplete, chicagoToday } from "@/lib/weekBuckets";

/* THE WEEKLY PAYLOAD, as /api/lifecycle/behavior-weekly returns it. `w` is a Monday YYYY-MM-DD;
 * it is renamed to `m` on the way in so the rest of this file is unchanged. */
type WeekPoint = { w: string; registrations: number; newPlayers: number; totalPlayers: number; spots: number };
/** One requested window's aggregate. totalPlayers and recurring are DISTINCT over the whole window,
 *  which is the only way they can be right; see growthMetricGrid's AdditiveMetric guard. */
type WindowAgg = {
  from: string; to: string;
  registrations: number; newPlayers: number; spots: number;
  totalPlayers: number; recurring: number;
};
type WeeklyPayload = {
  axis: string[];
  overall: WeekPoint[];
  byCity: Record<string, WeekPoint[]>;
  byField?: Record<string, { label: string; city: string; points: WeekPoint[] }>;
  window?: { start: string | null; end: string | null; weeks: number; dropped: number; futureDropped?: number; today?: string };
};
const BEHAVIOR_GRAN_KEY = "behavior:granularity";
const BEHAVIOR_FIELDS_KEY = "behavior:fields";
/* EIGHT. Past this the lines are indistinguishable whatever the palette does — the standard one
 * has 12 entries and it is not the constraint; the eye is. The cap is stated on the control at the
 * moment it bites rather than silently ignoring the ninth click. */
const FIELD_MAX = 8;
/** How many pitches to draw before the operator has chosen any. */
const FIELD_DEFAULT_N = 5;

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
/* ONE LABELLER FOR ALL THREE GRAINS. A weekly key is a Monday YYYY-MM-DD and reads as its full date
 * range — "Aug 24 – Aug 30", never a week number. A daily key is YYYY-MM-DD and reads as one day. A
 * monthly key is YYYY-MM and is unchanged. */
const dayLabelOf = (k: string) => `${MON_ABBR[Number(k.slice(5, 7)) - 1]} ${Number(k.slice(8, 10))}`;
const bucketLabel = (k: string, g: Granularity) =>
  g === "daily" ? dayLabelOf(k) : g === "weekly" ? weekRangeLabel(k) : monthLabel(k);
/* THE CHART AXIS gets the short form: 13 full ranges will not fit across a chart, so the tick is
 * the Monday and the table below carries both ends. A day is already short. */
const bucketTick = (k: string, g: Granularity) =>
  g === "daily" ? dayLabelOf(k) : g === "weekly" ? weekTick(k) : monthLabel(k);
const fmt = (n: number) => n.toLocaleString("en-US");
const pctChange = (a: number, b: number) => (b === 0 ? (a === 0 ? 0 : 100) : ((a - b) / b) * 100);

/* ── CHART GEOMETRY ───────────────────────────────────────────────────────────────────────────
 * THE RIGHT GUTTER WAS 132px AND HELD THE END-OF-LINE SERIES LABELS. Those labels collided —
 * "Registrations" at y=293 and "New players" at y=306 were 13px apart at font-size 11 weight 900,
 * i.e. touching — and no amount of nudging fixes four labels competing for one margin. They are a
 * legend above the plot now, which is what the rest of Clubhouse does, so the gutter shrinks to a
 * hair and the plot gets the 106px back. That extra width is also what lets the x axis carry twice
 * as many labels without them touching. */
const VW = 1120, VH = 350, M = { l: 70, r: 26, t: 20, b: 46 };
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

function buildChart(
  series: Series[], months: string[], gran: Granularity = "monthly",
  complete: readonly boolean[] = [],
) {
  const flat = series.flatMap((s) => s.data);
  const ticks = niceTicks(Math.max(1, ...flat), 5);
  const top = ticks[ticks.length - 1];
  const yAt = (v: number) => M.t + IH - (v / top) * IH;
  const xAt = (i: number) => M.l + (months.length === 1 ? IW / 2 : (i * IW) / (months.length - 1));

  const gridlines = ticks.map((t) => ({ y: yAt(t), label: tickLabel(t) }));
  /* THE BASELINE. The gridlines used to float with nothing closing the plot at the bottom, so a
   * value near zero had no edge to sit on. MembershipActiveChart draws its zero line the same
   * weight as the rest; this is that line, at y = 0. */
  const baseline = yAt(0);

  /* ── X LABELS, THINNED SO THEY CANNOT TOUCH ───────────────────────────────────────────────────
   * MEASURED BEFORE THIS CHANGE: at a 1500px viewport, 15 of 28 adjacent label pairs sat closer
   * than 4px and several overlapped outright — "Mar 16Mar 23" ran together as one word.
   *
   * The step is DERIVED from the width each label actually needs, never pinned: a weekly tick is
   * "Aug 31" at ~34px and a monthly one is "Aug 2026" at ~48px, and the count changes with the
   * period. LABEL_W is the widest label plus the smallest gap that still reads as two labels.
   *
   * ANCHORED TO THE RIGHT. `(n - 1 - i) % every` keeps the NEWEST bucket labelled and thins
   * backwards from it; thinning forwards from index 0 drops the most recent week, which is the one
   * the reader came for. The hover tooltip names every week exactly, so nothing is lost. */
  const LABEL_W = gran === "weekly" ? 46 : 62;
  const every = Math.max(1, Math.ceil((months.length * LABEL_W) / Math.max(1, IW)));
  const monthTicks = months.map((m, i) => ({
    x: xAt(i),
    label: bucketTick(m, gran),
    show: (months.length - 1 - i) % every === 0,
  }));

  /* ── THE PARTIAL BUCKET IS DRAWN DIFFERENTLY ──────────────────────────────────────────────────
   * Its incoming segment is dashed and its marker is hollow. Not a separate colour: the series
   * must stay identifiable, and a fifth colour on a four-colour chart reads as a fifth series. */
  const partialIdx = complete.length === months.length ? complete.lastIndexOf(false) : -1;
  const isPartial = (i: number) => i === partialIdx && i === months.length - 1;

  const seg = (data: number[], from: number, to: number) =>
    data.slice(from, to + 1)
      .map((v, k) => `${k ? "L" : "M"}${xAt(from + k).toFixed(1)},${yAt(v).toFixed(1)}`).join(" ");

  const last = months.length - 1;
  const polys = series.map((s) => ({
    // The solid run stops at the last COMPLETE bucket when the final one is partial.
    d: seg(s.data, 0, isPartial(last) ? Math.max(0, last - 1) : last),
    // …and the partial tail is its own dashed path. Empty when nothing is partial.
    dPartial: isPartial(last) && last > 0 ? seg(s.data, last - 1, last) : "",
    color: s.color,
    width: s.width,
    cx: xAt(last),
    cy: yAt(s.data[last] ?? 0),
  }));

  /* HOVER GEOMETRY. One x per bucket and every series' y at it, so the render can put a marker on
   * each line and a tooltip beside them without recomputing the scale. */
  const pts = months.map((m, i) => ({
    i, key: m, x: xAt(i),
    ys: series.map((s) => yAt(s.data[i] ?? 0)),
    vals: series.map((s) => s.data[i] ?? 0),
  }));

  return { gridlines, baseline, monthTicks, polys, pts, partialIdx, plot: { l: M.l, r: M.l + IW, t: M.t, b: M.t + IH } };
}

type Row = { name: string; cells: number[]; total: number; mom: number; rank?: number; dot?: string;
  points?: boolean;
  /** The city name or field key this row is, in detail modes. Null in Overall, where rows ARE metrics. */
  entity?: string };

export default function BehaviorPanel({
  data,
  period,
  authHeaders,
  scopeChip,
}: {
  data: GrowthData;
  period: Period;
  /** The provider's own Authorization header. ONE AUTH PATH PER PAGE; see the aggregate effect. */
  authHeaders: Record<string, string>;
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
  /* THE CACHE KEY CARRIES THE GRAIN. Without it, switching weekly → daily over one window served the
   * weekly payload out of cache and rendered week sums in day columns: plausible numbers, wrong axis,
   * and no error anywhere. */
  const winKey = `${gran}:${period.start}:${period.end}`;
  useEffect(() => {
    if (gran === "monthly") return;
    const cached = weeklyCache.current.get(winKey);
    if (cached) { setWeekly(cached); setWeeklyErr(null); return; }
    let dead = false;
    /* CLEARED FIRST. Without this the previous window's chart stays on screen while the new one
     * loads, under the new window's caption — the reader would be looking at Mar–Aug's bars
     * labelled Jun–Sep and have no way to tell. */
    setWeekly(null); setWeeklyErr(null);
    (async () => {
      try {
        /* ── getSession, NOT THE PROVIDER'S authHeaders ─────────────────────────────────────────
         * Switching this to the provider's header BROKE weekly grain: the table rendered zero
         * columns because the request 401'd. So `g.authHeaders` is EMPTY by the time this runs, and
         * getSession was never what was wrong with this fetch. Reverted, and the finding recorded
         * rather than the symptom chased: whatever stalls the window aggregate, it is not this. */
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        const res = await fetch(
          `/api/lifecycle/behavior-weekly?grain=${gran}`
            + `&start=${encodeURIComponent(gran === "daily" ? period.end : period.start)}`
            + `&end=${encodeURIComponent(period.end)}`,
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
  /* NOT `gran === "weekly"` ANY MORE. Daily reads the SAME fetched payload from the same route with
   * grain=daily, so the test is "is this the monthly aggregate or the re-derived one". Writing it as
   * a weekly check would have sent daily to the monthly maps and rendered a month's value in every
   * day column, which looks like data rather than like a bug. */
  const fetched = gran !== "monthly";
  const src = fetched && weeklyData ? weeklyData : data;
  const months = useMemo(
    () => (fetched && weekly
      ? weekly.axis
      : data.behaviorOverall.map((p) => p.m).filter((m) => m >= period.start && m <= period.end)),
    [fetched, weekly, data.behaviorOverall, period],
  );

  /* ── DECLARED HERE, ABOVE THE MODEL THAT READS IT ─────────────────────────────────────────
   * This block sat below the model's useMemo, and toRow reads winAgg: the page died with "Cannot
   * access 'winAgg' before initialization" and rendered its error boundary. TDZ IS A RUNTIME ERROR
   * AND tsc PASSES ON IT - twice in this change - so the only thing that catches it is opening the
   * page. Second instance: the route's own window accumulators had the same fault. */
  /* ── THE MATCHED WINDOW NEEDS DAY RESOLUTION, SO IT FETCHES ITS OWN ───────────────────────
   * The change column compares DAYS 1..N of the final period against days 1..N of the one before it,
   * and at monthly grain the monthly aggregate cannot answer that: "August's first 27 days" is not a
   * number a month total contains. So the two months either side of the boundary are fetched at DAY
   * grain, from the same route, and summed into the two windows.
   *
   * ONLY WHEN THE FINAL COLUMN IS PART-ELAPSED. A closed final period has nothing to match, and the
   * comparison reverts to whole periods, which the monthly data already holds - so no request is made
   * and nothing about the closed case changes.
   *
   * THIS REPLACES lastTwoComplete FOR THIS COLUMN, and that helper was RIGHT while the current month
   * was off the axis: with nothing part-elapsed on screen there was nothing to match, and skipping
   * the partial bucket was the honest move. With the current period as a column, skipping it means
   * the pill describes two periods nobody is looking at. */
  const matchWin = useMemo(() => {
    if (gran !== "monthly" || months.length < 2) return null;
    const lastM = months[months.length - 1];
    const prevM = months[months.length - 2];
    const win = matchedMonthWindow(lastM, prevM, chicagoToday());
    return win.days == null ? null : { ...win, lastM, prevM };
  }, [gran, months]);

  /* ── THE WINDOWS THIS PAGE ASKS THE ROUTE TO AGGREGATE ────────────────────────────────────
   * THREE, in one request:
   *   0  the whole displayed period  -> the PERIOD TOTAL for a distinct count
   *   1  the final period, days 1..N -> the day-matched change, latest side
   *   2  the previous period, 1..N   -> the day-matched change, earlier side
   *
   * WINDOW 0 IS REQUESTED WHATEVER THE GRAIN, because the Period total column is wrong at every
   * grain without it: summing per-bucket Set sizes overstated Apr-Sep by 86.9% (15,625 against a
   * true 8,361) and looked right because it landed 0.9% from the all-time figure. Windows 1 and 2
   * are only requested when the final column is part-elapsed. */
  const periodDays = useMemo(() => {
    if (months.length === 0) return null;
    const first = months[0];
    const last = months[months.length - 1];
    const toDay = (k: string, end: boolean) =>
      k.length === 7 ? (end ? monthEnd(k) : `${k}-01`) : k;
    return { from: toDay(first, false), to: toDay(last, true) };
  }, [months]);

  const windowsParam = useMemo(() => {
    if (!periodDays) return "";
    const list = [`${periodDays.from}:${periodDays.to}`];
    if (matchWin) list.push(`${matchWin.last.from}:${matchWin.last.to}`, `${matchWin.prev.from}:${matchWin.prev.to}`);
    return list.join(",");
  }, [periodDays, matchWin]);

  const [winAgg, setWinAgg] = useState<WindowAgg[] | null>(null);
  useEffect(() => {
    if (!windowsParam) { setWinAgg(null); return; }
    let dead = false;
    (async () => {
      try {
        /* ── ONE AUTH PATH PER PAGE ────────────────────────────────────────────────────────────
         * The token comes from GrowthDataProvider, which has already authenticated two requests by
         * the time this runs. A second auth path on the same page is redundant whether or not
         * getSession() was what blocked here - and it WAS blocking: this effect entered twice with
         * correct parameters and nothing after its first await ever executed, with neither the
         * success nor the failure branch reached.
         *
         * THE AXIS IS IRRELEVANT TO THE AGGREGATE, so this asks for the cheapest one it can: a single
         * month at day grain. The windows carry their own bounds and the route widens its reads to
         * cover them. */
        const res = await fetch(
          `/api/lifecycle/behavior-weekly?grain=daily`
            + `&start=${encodeURIComponent(period.end)}&end=${encodeURIComponent(period.end)}`
            + `&windows=${encodeURIComponent(windowsParam)}`,
          { cache: "no-store", headers: authHeaders },
        );
        const j = await res.json();
        if (!res.ok) throw new Error(j?.error ?? `HTTP ${res.status}`);
        if (!dead) setWinAgg((j as { windows?: WindowAgg[] }).windows ?? null);
      } catch (e) {
        /* A FAILED AGGREGATE LEAVES THE DISTINCT TOTALS AS A DASH rather than falling back to the
         * sum. The sum is the wrong number; an em-dash is an honest absence.
         * LOGGED, NOT SWALLOWED. A silent catch here is indistinguishable from "no aggregate was
         * asked for", which cost an hour once already. */
        // eslint-disable-next-line no-console
        console.error("behavior window aggregate failed:", e);
        if (!dead) setWinAgg(null);
      }
    })();
    return () => { dead = true; };
  }, [windowsParam, period.end, authHeaders]);


  /* ── WHICH BUCKETS ARE FINISHED ───────────────────────────────────────────────────────────────
   * The clock comes from the PAYLOAD, not from this browser: the buckets were cut in
   * America/Chicago and a viewer in another zone would otherwise mark the wrong week partial.
   * chicagoToday() is the fallback for the first render, before the payload lands.
   *
   * MONTHLY NOW OBEYS THE SAME RULE. It used to treat every month as complete — flagged when the
   * weekly fix landed and fixed here. It did not bite on arrival because the period bar's quick
   * pills already end on the last COMPLETE month; a hand-picked range ending inside the current
   * month had precisely the defect weekly had, and the change column compared a part-month against
   * a whole one. One predicate, isBucketComplete, so the two granularities cannot drift. */
  const todayYmd = weekly?.window?.today ?? chicagoToday();
  const complete = useMemo(
    () => months.map((m) => isBucketComplete(m, todayYmd, gran)),
    [gran, months, todayYmd],
  );
  /* THE PAIR THE CHANGE COLUMN COMPARES. The last two COMPLETE buckets — never the partial one,
   * which is what produced −68.4% from one day against seven. */
  const cmp = useMemo(() => lastTwoComplete(complete), [complete]);
  const partialIdx = complete.lastIndexOf(false);

  /* ── THE CITY LIST: ANY ACTIVITY IN THE PERIOD, NOT JUST PLAY ─────────────────────────────────
   * THIS FILTER WAS `spots > 0` AND THAT IS WHY THE ROWS DID NOT SUM. A city with registrations
   * and no matches — New York City (102) and El Paso (90) over Mar–Aug 2026 — was computed,
   * returned in the payload, and then dropped on the way to the screen. The table showed seven
   * cities totalling 7,680 under an overall series reading 9,482 and nothing accounted for the
   * difference.
   *
   * The old rule was deliberate: it kept "declared-only markets" out of a list meant to show
   * places MatchDay operates. That trade is now reversed on purpose. A market with a hundred
   * signups and no pitch is a fact worth seeing, and a table whose rows do not add up to its own
   * header teaches the reader to distrust every number on the page.
   *
   * A city qualifies on ANY metric being non-zero, not on spots alone. It is still scoped to the
   * PERIOD, so a city that existed only in 2024 stays out of a 2026 window. */
  /* ── THE SEVEN PLAY MARKETS, AND WHAT IS EXCLUDED ─────────────────────────────────────────
   * This page is about PLAYING, so a city belongs on it if MatchDay runs matches there. Measured
   * from growth_play_dims on prod 2026-09-27, nine cities have play rows and seven are markets:
   *
   *   ATX 101,586 spots · HOU 27,659 · SATX 21,894 · DFW 2,778 · STL 2,592 · ATL 2,406 · OKC 1,537
   *
   * THREE ARE EXCLUDED, EACH FOR ITS OWN REASON, named rather than filtered silently:
   *   EL PASO   0 play rows. Registrations but no matches, so nothing to show on a page about
   *             playing - the same shape as registrations having no field.
   *   WARSAW    a separate operator on a brand licence. 1 field, 214 spots, Aug-Sep 2026.
   *   NEW YORK  no CURRENT operation. It DID run three fields - NYCSC at DeWitt Clinton Park, at
   *             Nike Field, at Pier 40 - for one month, 2025-10, 85 spots. "No pitch" was too
   *             strong a claim and is corrected here.
   *
   * NOT DERIVED FROM THE DATA, because the data cannot tell a market from a licensee or a closed
   * city from an open one. A list is the honest form, and the counts are here so a reader can see
   * what each exclusion costs. */
  const NON_MARKET_CITIES = useMemo(
    () => new Set(["Warsaw", "New York City", "El Paso", UNASSIGNED_CITY]), []);
  const cities = useMemo(() => {
    const inPeriod = new Set(months);
    const active = (p: BehaviorPoint) =>
      (p.spots ?? 0) > 0 || (p.registrations ?? 0) > 0 || (p.totalPlayers ?? 0) > 0 || (p.newPlayers ?? 0) > 0;
    return Object.keys(src.behaviorByCity)
      .filter((c) => !NON_MARKET_CITIES.has(c))
      .filter((c) => src.behaviorByCity[c].some((p) => inPeriod.has(p.m) && active(p)))
      /* UNASSIGNED SORTS LAST. It is a residual, not a market, and alphabetical order would file
       * it between St. Louis and Warsaw as though it were one. */
      .sort((a, b) => (a === UNASSIGNED_CITY ? 1 : b === UNASSIGNED_CITY ? -1 : 0) || a.localeCompare(b));
  }, [src.behaviorByCity, months, NON_MARKET_CITIES]);
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

  /* ── FIELD SELECTION ──────────────────────────────────────────────────────────────────────────
   * Field Detail plotted all 43 pitches at once. Forty-three lines through one 4-colour palette is
   * not a chart, and the legend for it filled a third of the card.
   *
   * `null` MEANS "I HAVE NOT CHOSEN", NOT "NOTHING". That distinction is the whole state machine:
   * null re-derives the top N whenever the metric changes, a Set is the operator's own choice and
   * survives a metric change untouched. Clear goes back to null — to the default five, never to an
   * empty chart, because an empty chart is indistinguishable from a broken one.
   *
   * NOTHING SELECTED MUST NOT MEAN DRAW EVERYTHING. That is the rule the old code broke. */
  const [fieldSel, setFieldSel] = useState<Set<string> | null>(null);
  const [fieldQuery, setFieldQuery] = useState("");
  const [capHit, setCapHit] = useState(false);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(BEHAVIOR_FIELDS_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw);
      // An empty array persisted would restore an empty chart; null is the only "no choice" value.
      if (Array.isArray(arr) && arr.length > 0) setFieldSel(new Set(arr.map(String)));
    } catch { /* private mode, or an older blob */ }
  }, []);
  useEffect(() => {
    try {
      if (fieldSel === null) window.localStorage.removeItem(BEHAVIOR_FIELDS_KEY);
      else window.localStorage.setItem(BEHAVIOR_FIELDS_KEY, JSON.stringify([...fieldSel]));
    } catch { /* private mode */ }
  }, [fieldSel]);

  // THE PITCHES IN THE SELECTED PERIOD, same rule as cities: any spots in a displayed month.
  const fields = useMemo(() => {
    const inPeriod = new Set(months);
    return Object.keys(src.behaviorByField)
      .filter((f) => src.behaviorByField[f].points.some((p) => inPeriod.has(p.m) && (p.spots ?? 0) > 0))
      .sort((a, b) => a.localeCompare(b));
  }, [src.behaviorByField, months]);


  /* ── THE DEFAULT FIVE ─────────────────────────────────────────────────────────────────────────
   * Ranked by THE SAME FIGURE THE TABLE'S "Selected period" COLUMN SHOWS — a sum for a count and
   * the latest value for a rate. Not a second definition of "biggest": if the ranking used a mean
   * while the table showed a sum, the top five would not be the five largest rows on screen and
   * nobody could check it by looking. */
  const fieldRank = useMemo(() => {
    const rate = IS_RATE.has(metric as GridMetric);
    const score = (f: string) => {
      const idx = new Map(src.behaviorByField[f].points.map((p) => [p.m, p]));
      const cells = months.map((m) => metricValue(idx.get(m), metric as GridMetric) ?? 0);
      return rate ? (cells[cells.length - 1] ?? 0) : cells.reduce((a, b) => a + b, 0);
    };
    return fields.map((f) => ({ f, score: score(f) }))
      // TIE-BROKEN BY NAME so the default is stable across reloads. An unstable default would
      // change the chart on refresh with nothing having happened.
      .sort((a, b) => b.score - a.score || a.f.localeCompare(b.f));
  }, [fields, src.behaviorByField, months, metric]);

  const defaultFields = useMemo(
    () => fieldRank.slice(0, FIELD_DEFAULT_N).map((r) => r.f),
    [fieldRank],
  );

  /* WHAT IS ACTUALLY DRAWN. A stored selection is intersected with the fields that exist in this
   * period — a pitch with no matches this window would otherwise be an invisible member of the
   * selection, counted in the cap and drawn as a flat zero. If nothing survives, fall back to the
   * default rather than to an empty chart. */
  const selectedFields = useMemo(() => {
    if (fieldSel === null) return defaultFields;
    const live = fields.filter((f) => fieldSel.has(f));
    return live.length ? live.slice(0, FIELD_MAX) : defaultFields;
  }, [fieldSel, fields, defaultFields]);
  const usingDefault = fieldSel === null || fields.filter((f) => fieldSel.has(f)).length === 0;

  /* THE CHIPS, GROUPED BY CITY. City order follows the City Detail table exactly — same array,
   * same sort — so the two controls read in one order rather than two.
   *
   * A FIELD THAT CANNOT BE PLACED GETS AN "Unassigned" HEADING, NOT A DROP. 0 of 43 land there
   * today (measured 2026-09-01: every field carries a city_identifier that normalizeMatchCity
   * maps). The group exists so an unplaceable pitch is visible the day one appears. */
  const fieldGroups = useMemo(() => {
    const byCity = new Map<string, string[]>();
    for (const f of fields) {
      const c = src.behaviorByField[f]?.city?.trim() || UNASSIGNED_CITY;
      (byCity.get(c) ?? byCity.set(c, []).get(c)!).push(f);
    }
    const order = [...cities, ...[...byCity.keys()].filter((c) => !cities.includes(c))];
    return order
      .filter((c) => byCity.has(c))
      .sort((a, b) => (a === UNASSIGNED_CITY ? 1 : b === UNASSIGNED_CITY ? -1 : 0))
      .map((c) => ({ city: c, fields: byCity.get(c)!.slice().sort((a, b) => a.localeCompare(b)) }));
  }, [fields, src.behaviorByField, cities]);
  const unplaceableFields = useMemo(
    () => fieldGroups.find((g) => g.city === UNASSIGNED_CITY)?.fields.length ?? 0,
    [fieldGroups],
  );

  /* SEARCH FILTERS THE CHIPS, NEVER THE SELECTION. Typing "hattrick" must not silently deselect
   * the pitches that scrolled out of view — the chart would change while the operator was only
   * looking for something. */
  const visibleGroups = useMemo(() => {
    const q = fieldQuery.trim().toLowerCase();
    if (!q) return fieldGroups;
    return fieldGroups
      .map((g) => ({ ...g, fields: g.fields.filter((f) => f.toLowerCase().includes(q)) }))
      .filter((g) => g.fields.length > 0);
  }, [fieldGroups, fieldQuery]);
  const visibleCount = useMemo(() => visibleGroups.reduce((a, g) => a + g.fields.length, 0), [visibleGroups]);

  const toggleField = (f: string) => {
    setCapHit(false);
    setFieldSel((prev) => {
      const base = prev === null ? new Set(defaultFields) : new Set(prev);
      if (base.has(f)) {
        base.delete(f);
        // The last chip off returns to the default rather than clearing the chart.
        return base.size === 0 ? null : base;
      }
      if (base.size >= FIELD_MAX) { setCapHit(true); return prev; }
      base.add(f);
      return base;
    });
  };
  /* "SELECT ALL" TAKES THE VISIBLE ONES UP TO THE CAP, and says so when it truncates. It is most
   * useful after a search — "hattrick" then Select all — and with 43 unfiltered chips an honest
   * eight beats a button that does nothing. */
  const selectAllVisible = () => {
    const all = visibleGroups.flatMap((g) => g.fields);
    setCapHit(all.length > FIELD_MAX);
    setFieldSel(new Set(all.slice(0, FIELD_MAX)));
  };
  const clearFields = () => { setCapHit(false); setFieldQuery(""); setFieldSel(null); };


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
    /* WHICH METRIC A ROW IS, so the total can be computed the right way. Overall rows know it; in
     * detail modes every row is the SELECTED metric, so they all share one. */
    const toRow = (
      name: string, cells: number[],
      extra?: { rank: number; dot: string; entity?: string },
      rateRow = false,
      key?: GridMetric,
    ): Row => {
      const distinctKey = key && isDistinct(key) ? key : null;
      const additiveKey = key && isAdditive(key) ? key : null;
      /* THE CHANGE IS BETWEEN THE LAST TWO COMPLETE BUCKETS. It used to be the last two cells
       * whatever they were, so on 2026-09-01 every row compared one day of Aug 31 – Sep 6 against
       * a whole week and reported a 45–68% collapse that had not happened.
       *
       * THE "SELECTED PERIOD" TOTAL STILL INCLUDES THE PARTIAL WEEK, on purpose — it is a sum of
       * what actually happened in the window, and a partial week's registrations really did occur.
       * Only the CHANGE is a comparison, and only a comparison needs like for like. */
      const li = cmp ? cmp.last : cells.length - 1;
      const pi = cmp ? cmp.prev : cells.length - 2;
      const last = cells[li] ?? 0;
      const prev = cells[pi] ?? 0;
      const rate = rateRow || (isRate && !!extra);
      /* ── THE PERIOD TOTAL, AND THE ONE THAT WAS WRONG FOR SIX MONTHS ─────────────────────────
       *   A RATE is its LATEST value, never a sum: averaging percentages is meaningless.
       *   A DISTINCT COUNT is the route's window aggregate, never a sum: adding per-bucket Set
       *     sizes double-counts everyone who appears in two, which overstated Apr-Sep by 86.9%
       *     (15,625 against a true 8,361) and read as right because it landed 0.9% from the
       *     all-time figure.
       *   EVERYTHING ELSE is additive and sums, through sumAcrossBuckets, which will not accept a
       *     distinct key - see the AdditiveMetric guard in growthMetricGrid.
       *
       * A MISSING AGGREGATE IS NULL, NOT A FALLBACK TO THE SUM. The sum is the wrong number; a dash
       * says so. Only the OVERALL rows can use it today, because the aggregate is network-wide -
       * a per-city distinct count is a further window per city and is not requested. */
      const distinctTotal = distinctKey && winAgg?.[0] ? winAgg[0][distinctKey] : null;
      const total = rate
        ? cells[cells.length - 1] ?? 0
        : distinctKey
          ? (distinctTotal ?? NaN)
          : sumAcrossBuckets(additiveKey ?? "spots", cells);
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
      rows = series.map((s, k) => toRow(s.label, s.data, undefined, false, METRIC_DEFS[k].key as GridMetric));
      // BOTH RECURRING FIGURES AS ROWS. The count says how many came back; the rate says whether we
      // are keeping them. A count falls whenever the month is smaller even when loyalty has not
      // moved, so the rate is the one that carries the signal — and the rate alone hides the size
      // of the group it describes.
      for (const rm of ["recurring", "pctRecurring"] as GridMetric[]) {
        rows.push(toRow(METRIC_LABEL[rm], networkSeries(src, rm, months).map((v) => v ?? 0), undefined, rm === "pctRecurring", rm));
      }
      chartTitle = "Overall Matchday performance";
      chartSub = `${monthRange} · registrations, new players, total players and spots booked`;
      detailTitle = "Player Metrics";
      scope = "Overall";
    } else if (fieldMode) {
      /* ONLY THE SELECTED PITCHES. This mapped over every field in the period — 43 of them — so
       * the palette wrapped four times, the legend filled a third of the card, and no individual
       * line could be followed. COLOURS ARE ASSIGNED BY POSITION IN THE SELECTION, so they are
       * reassigned whenever the selection changes and are never stretched across 43 series. With
       * the cap at 8 and a 12-entry palette, no two selected fields can share a colour. */
      const idxByField: Record<string, Map<string, BehaviorPoint>> = {};
      for (const f of selectedFields) idxByField[f] = new Map(src.behaviorByField[f].points.map((p) => [p.m, p]));
      series = selectedFields.map((f, k) => ({
        data: months.map((m) => metricValue(idxByField[f].get(m), metric as GridMetric) ?? 0),
        color: FIELD_COLORS[k % FIELD_COLORS.length],
        label: src.behaviorByField[f].label,
        width: 2.4,
      }));
      // THE TABLE FOLLOWS THE CHART, in the same order — rows are built from the same array.
      rows = series.map((s2, k) => toRow(s2.label, s2.data, { rank: k + 1, dot: s2.color, entity: selectedFields[k] }, false, metric as GridMetric));
      const label = METRIC_LABEL[metric as GridMetric];
      chartTitle = `${label} by field`;
      /* THE HEADER SAYS WHAT IT IS SHOWING AND OUT OF HOW MANY. A chart drawing 5 of 43 lines
       * without saying so reads as "these are the pitches". */
      chartSub = usingDefault
        ? `${monthRange} · Top ${selectedFields.length} of ${fields.length} fields by ${label.toLowerCase()}`
        : `${monthRange} · ${selectedFields.length} of ${fields.length} fields selected`;
      detailTitle = `${label} field detail`;
      scope = usingDefault ? `Top ${selectedFields.length} of ${fields.length}` : `${selectedFields.length} of ${fields.length} selected`;
    } else {
      const idxByCity: Record<string, Map<string, BehaviorPoint>> = {};
      for (const c of cities) idxByCity[c] = new Map(src.behaviorByCity[c].map((p) => [p.m, p]));
      series = cities.map((c) => ({
        data: months.map((m) => metricValue(idxByCity[c].get(m), metric as GridMetric) ?? 0),
        color: CITY_COLORS[c] ?? NEUTRAL_COLOR,
        label: c,
        width: 2.9,
      }));
      rows = series.map((s, k) => toRow(s.label, s.data, { rank: k + 1, dot: s.color, entity: cities[k] }, false, metric as GridMetric));
      const label = METRIC_LABEL[metric as GridMetric];
      chartTitle = `${label} by city`;
      chartSub = `${monthRange} · every city`;
      detailTitle = `${label} city detail`;
      scope = "All cities";
    }

    const chart = series.length && months.length ? buildChart(series, months, gran, complete) : null;
    /* THE LEGEND, replacing the end-of-line labels that overlapped. Colour and name in reading
     * order, above the plot, where four of them fit on one line and none can collide. */
    const legend = series.map((sx) => ({ label: sx.label, color: sx.color }));
    /* THE CEILING, SAID OUT LOUD. A custom range longer than 53 weeks keeps the most recent 53;
     * without this line the chart would read as the whole period and be short by the difference. */
    const dropped = fetched ? (weekly?.window?.dropped ?? 0) : 0;
    if (dropped > 0) chartSub += ` · earliest ${dropped} week${dropped === 1 ? "" : "s"} of this period not shown (53-week maximum)`;
    return { chart, rows, chartTitle, chartSub, detailTitle, scope, legend };
  /* winAgg IS A DEPENDENCY. toRow reads it for the distinct totals, and without it here the rows kept
   * their placeholder when the aggregate landed: the two distinct metrics rendered a dash forever and
   * looked like a deliberate "not available" rather than a memo that never recomputed. */
  }, [cityMode, fieldMode, detailMode, src, months, cities, fields, selectedFields, usingDefault, metric, gran, weekly, complete, cmp, winAgg]);

  /* ── HOVER ────────────────────────────────────────────────────────────────────────────────────
   * The chart had nothing to hover. The other Clubhouse charts put a marker on the series and name
   * the bucket, which is also what makes thinning the x axis safe: a label that is not printed is
   * still one hover away. Index-based, resolved from the pointer's x in VIEWBOX units — the svg is
   * width:100% so client pixels are the wrong scale. */
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  /* ── ONE ROW OPEN AT A TIME ────────────────────────────────────────────────────────────────
   * Ryan: "clicking a city should reveal a dropdown of the metrics". With entities as rows and time
   * as columns the metric is the THIRD dimension, and this is where it fits without a second table.
   * A single open row rather than many, because six child rows per city across seven cities is
   * forty-nine rows and no longer a comparison. */
  const [openRow, setOpenRow] = useState<string | null>(null);
  /* ── SORTING, WHICH THIS PAGE HAS NEVER HAD ────────────────────────────────────────────────
   * `col` is a bucket key or "total". Absent in Overall, where ranking six metrics by size means
   * nothing, so the state simply goes unread there rather than being conditionally created. */
  const [sort, setSort] = useState<{ col: string; dir: "asc" | "desc" } | null>(null);
  /* THE CHART IS NOT THE DEFAULT VIEW. Not deleted: spots booked runs 6,573 to 9,716 while new
   * players runs 585 to 1,123, so on ONE SHARED AXIS three of the four series are flat lines along
   * the bottom and a real move in new players cannot show. That is a dual-scale problem, not a
   * clutter one, which is why the fix is a toggle rather than a redesign. */
  const [chartOpen, setChartOpen] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const c = model.chart;
    if (!c || !c.pts.length) return;
    const r = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * VW;
    let best = 0, bd = Infinity;
    for (const pt of c.pts) { const d = Math.abs(pt.x - vx); if (d < bd) { bd = d; best = pt.i; } }
    setHoverIdx(best);
  };

  /* THE UNIT FOLLOWS THE GRANULARITY. This read "26 months · oldest to newest" in weekly mode,
   * because `months` is the axis whatever the axis is made of. A count is not unit-free. */
  /* THE UNIT WORD FOLLOWS THE GRAIN, from weekBuckets so the header and the CSV cannot disagree. */
  const unitWord = grainUnitWord(gran);
  const unit = unitWord;
  /* THE "N months · oldest to newest" LINE IS GONE. It restated the axis the reader is looking at,
   * and in weekly mode it said "4 weeks" beside a table of months. Nothing replaces it: the column
   * headers already name every bucket. */
  const firstColHead = fieldMode ? "Field" : cityMode ? "City" : "Metric";
  /* WHICH TWO BUCKETS THE CHANGE COLUMN USED, named on the column itself and in its tooltip. */
  const bucketUnit = unitWord;
  const cmpSub = cmp
    ? (gran === "weekly"
      ? `${weekTick(months[cmp.prev])} → ${weekTick(months[cmp.last])}`
      : `${monthLabel(months[cmp.prev])} → ${monthLabel(months[cmp.last])}`)
    : "";
  /* ── SORTING, APPLIED AFTER THE MODEL AND ONLY IN DETAIL MODES ────────────────────────────
   * Ranking six metrics by size says nothing, so Overall is left alone rather than given a control
   * that would look consistent and mean nothing.
   *
   * SORTED FROM A COPY. Mutating model.rows would reorder the CSV and the chart legend too, and the
   * chart's colours are assigned by position - a sort would then recolour the lines. */
  const sortedRows = useMemo(() => {
    if (!detailMode || !sort) return model.rows;
    const at = (r: Row): number => {
      if (sort.col === "total") return r.total;
      const i = months.indexOf(sort.col);
      return i >= 0 ? (r.cells[i] ?? 0) : 0;
    };
    const out = [...model.rows];
    out.sort((a, b) => (sort.dir === "desc" ? at(b) - at(a) : at(a) - at(b)));
    return out;
  }, [model.rows, sort, detailMode, months]);

  /* ── THE SIX METRICS FOR ONE OPEN ENTITY ──────────────────────────────────────────────────
   * REGISTRATIONS HAVE NO FIELD. A player registers before choosing a pitch, so that row is absent
   * from a field's expansion rather than rendered as zero - the same shape as downloads having no
   * city on the funnel, and the page says so. hasFieldDimension owns that rule. */
  const childRows = useMemo(() => {
    if (!detailMode || !openRow) return [];
    const points = fieldMode
      ? src.behaviorByField[openRow]?.points
      : src.behaviorByCity[openRow];
    if (!points) return [];
    const idx = new Map(points.map((pt) => [pt.m, pt]));
    const keys = (["registrations", "newPlayers", "totalPlayers", "spots", "recurring", "pctRecurring"] as GridMetric[])
      .filter((k) => !fieldMode || hasFieldDimension(k));
    return keys.map((k) => {
      const cells = months.map((m) => metricValue(idx.get(m), k) ?? 0);
      const rate = k === "pctRecurring";
      const li = cmp ? cmp.last : cells.length - 1;
      const pi = cmp ? cmp.prev : cells.length - 2;
      const last = cells[li] ?? 0;
      const prev = cells[pi] ?? 0;
      return {
        name: METRIC_LABEL[k], cells,
        total: rate ? cells[cells.length - 1] ?? 0 : cells.reduce((a, b) => a + b, 0),
        mom: rate ? last - prev : pctChange(last, prev),
        points: rate,
      } as Row;
    });
  }, [detailMode, openRow, fieldMode, src, months, cmp]);

  /* aria-sort ON THE HEADER, so the state is ANNOUNCED and not only coloured. "none" on a sortable
   * column that is not the active one; absent entirely where sorting does not exist. */
  const sortAria = (col: string): "ascending" | "descending" | "none" | undefined =>
    !detailMode ? undefined
      : sort?.col === col ? (sort.dir === "asc" ? "ascending" : "descending")
      : "none";
  /* FIRST CLICK DESCENDS. "Highest to lowest" is what was asked for, so the first press gives it. */
  const toggleSort = (col: string) =>
    setSort((cur) => (cur?.col === col
      ? { col, dir: cur.dir === "desc" ? "asc" : "desc" }
      : { col, dir: "desc" }));

  /* ONE STRING FOR THE COLUMN HEADING, read by the screen AND the file. Two copies of this is how
   * a header and an export disagree about what they compared. */
  const changeHeadText = cmpSub
    ? `Change vs. last ${unitWord} (${cmpSub})`
    : `Change vs. last ${unitWord}`;
  const cmpTitle = cmp
    ? `${gran === "weekly" ? "Week over week" : "Month over month"} — ${bucketLabel(months[cmp.last], gran)} `
      + `against ${bucketLabel(months[cmp.prev], gran)}. Both are COMPLETE ${bucketUnit}s; `
      + `a ${bucketUnit} still running is never used here.`
    : `Not enough complete ${bucketUnit}s in this period to compute a change.`;

  const exportCsv = () => {
    /* ── THE EXPORT CARRIES ALL THREE RULES, NOT JUST THE ARITHMETIC ─────────────────────────────
     * The change figure already follows `cmp`, so it excludes a partial bucket by construction.
     * The other two rules have to be written into the file itself, because a CSV has no dashed
     * line and no amber tag to inherit:
     *
     *   1. THE PARTIAL COLUMN IS LABELLED. "Sep 2026 (partial)" in the header, so a column that is
     *      three days of a month cannot be read as a month.
     *   2. THE CHANGE COLUMN NAMES ITS PAIR, exactly as the screen does.
     *
     * This is the specific failure being guarded against: when the weekly fix landed, the screen
     * was corrected and the export kept shipping the old number. It is the same `cmp` and the same
     * `complete` array on both sides now, so they cannot diverge without both moving. */
    /* BUILT BY lib/behaviorExport FROM model.rows — THE SAME ROWS THE TABLE RENDERS. Not a second
     * computation: that is exactly what diverged when the weekly fix landed on screen and the file
     * kept shipping the old change. The guard compares the two cell for cell. */
    const header = exportHeader({
      firstColHead,
      bucketLabels: months.map((k) => bucketLabel(k, gran)),
      complete,
      changeHead: changeHeadText,
    });
    const body = exportBody(model.rows);

    // IN DETAIL MODES THE ROWS ARE ONE METRIC ACROSS SCOPES, so the recurring pair would otherwise
    // be missing from the file entirely. Both are appended per scope, and they reconcile against
    // total and new by construction: recurring = total − new, % = recurring / total.
    if (detailMode) {
      // THE EXPORT FOLLOWS THE SELECTION, like the table. A CSV carrying all 43 pitches under a
      // chart showing 5 is two different answers to one question.
      const scopes = fieldMode ? selectedFields : cities;
      const pointsOf = (k: string) =>
        new Map((fieldMode ? src.behaviorByField[k].points : src.behaviorByCity[k]).map((p) => [p.m, p]));
      for (const rm of ["newPlayers", "totalPlayers", "recurring", "pctRecurring"] as GridMetric[]) {
        for (const k of scopes) {
          const idx = pointsOf(k);
          const cells = months.map((m) => metricValue(idx.get(m), rm) ?? 0);
          const rate = rm === "pctRecurring";
          /* THE SAME COMPLETE-BUCKETS RULE AS THE TABLE. This is the second place a change is
           * computed from these buckets and it had the same defect: the exported file compared the
           * partial week against a whole one, so a CSV opened in a spreadsheet carried the -68%
           * that the screen no longer shows. Two change figures for the same pair of weeks, one
           * right and one wrong, is worse than the original bug. */
          const li = cmp ? cmp.last : cells.length - 1;
          const pi = cmp ? cmp.prev : cells.length - 2;
          const last = cells[li] ?? 0;
          const prev = cells[pi] ?? 0;
          body.push([
            `${fieldMode ? src.behaviorByField[k].label : k} · ${METRIC_LABEL[rm]}`,
            ...cells.map((c) => (rate ? `${c.toFixed(1)}%` : String(c))),
            rate ? `${(cells[cells.length - 1] ?? 0).toFixed(1)}%` : String(cells.reduce((a, b) => a + b, 0)),
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
            {/* DAILY NARROWS THE RANGE TO ONE MONTH, visibly, in the pickers the operator can
                reopen. Six months of days is 180 columns, which is not a table anyone reads. */}
            <button
              type="button"
              className={`${styles.segBtn} ${gran === "daily" ? styles.segBtnActive : ""}`}
              data-value="daily"
              data-testid="behavior-gran-daily"
              onClick={() => setGran("daily")}
            >
              Daily
            </button>
          </div>
          <div className={styles.segmented} id="growthBehaviorView">
            <button
              type="button"
              className={`${styles.segBtn} ${!cityMode ? styles.segBtnActive : ""}`}
              data-value="matchday"
              onClick={() => setView("matchday")}
            >
              Overall
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
      {/* ── THE CHART, BEHIND A TOGGLE, NOT DELETED ─────────────────────────────────────────────
          Ryan: "remove the line graphs, keep everything in tables, but make it so you can open the
          graphs still, just not the default view."

          THE REASON IS A DUAL-SCALE PROBLEM, NOT CLUTTER, which is why the fix is a toggle rather
          than a redesign: spots booked runs 6,573 to 9,716 while new players runs 585 to 1,123, so on
          ONE SHARED AXIS three of the four series are flat lines along the bottom and a real move in
          new players cannot show. Said on the page, with the figures, so the toggle is not a mystery.
          hidden RATHER THAN UNMOUNTED, so opening it does not re-run buildChart. */}
      <div className={styles.chartToggleRow}>
        <button type="button" className={styles.btn} data-testid="behavior-chart-toggle"
          aria-expanded={chartOpen} onClick={() => setChartOpen((v) => !v)}>
          {chartOpen ? "Hide chart" : "Show chart"}
        </button>
        {chartOpen && (
          <span className={styles.chartHint} data-testid="behavior-chart-hint">
            One shared axis cannot carry these together: spots booked runs 6,573 to 9,716 while new
            players runs 585 to 1,123, so three of the four series flatten along the bottom and a real
            move in new players cannot show. The tables are the reliable read.
          </span>
        )}
      </div>
      <div className={styles.chart} data-testid="behavior-chartbox" hidden={!chartOpen}>
        {/* THE LEGEND, above the plot. This replaces four end-of-line labels that overlapped in
            the right margin; a horizontal row cannot collide however many series there are, it
            wraps. */}
        {/* FIELD MODE GETS CHIPS INSTEAD OF A LEGEND. The chips ARE the legend — each carries its
            series colour — and they are also the control, so one row does both jobs where the old
            legend did one badly across 43 entries. City and Overall keep the plain legend; 8
            series there is fine and needs no control. */}
        {fieldMode ? (
          <div className={styles.fieldPicker} data-testid="behavior-field-picker">
            <div className={styles.fieldBar}>
              <input
                className={styles.fieldSearch}
                data-testid="behavior-field-search"
                type="search"
                placeholder={`Search ${fields.length} fields…`}
                aria-label="Search fields"
                value={fieldQuery}
                onChange={(e) => setFieldQuery(e.target.value)}
              />
              <button type="button" className={styles.fieldBtn} data-testid="behavior-field-all"
                onClick={selectAllVisible}>
                Select all{fieldQuery.trim() ? ` (${visibleCount})` : ""}
              </button>
              <button type="button" className={styles.fieldBtn} data-testid="behavior-field-clear"
                onClick={clearFields} title={`Return to the top ${FIELD_DEFAULT_N} by the selected metric`}>
                Clear
              </button>
              <span className={styles.fieldCount} data-testid="behavior-field-count">
                {selectedFields.length} of {fields.length} selected
                {usingDefault ? ` · default top ${selectedFields.length}` : ""}
              </span>
            </div>
            {/* THE CAP, EXPLAINED WHERE IT BITES rather than by a click that does nothing. */}
            {capHit && (
              <div className={styles.fieldCap} data-testid="behavior-field-cap">
                {FIELD_MAX} fields is the maximum — beyond that the lines are indistinguishable
                whatever the palette does. Remove one to add another.
              </div>
            )}
            {visibleCount === 0 && (
              <div className={styles.fieldCap} data-testid="behavior-field-noresults">
                No field matches “{fieldQuery}”. The selection is unchanged.
              </div>
            )}
            {visibleGroups.map((g) => (
              <div key={g.city} className={styles.fieldGroup} data-testid="behavior-field-group" data-city={g.city}>
                <span className={styles.fieldGroupName}>{g.city}</span>
                {g.fields.map((f) => {
                  const k = selectedFields.indexOf(f);
                  const on = k >= 0;
                  return (
                    <button
                      type="button"
                      key={f}
                      data-testid="behavior-field-chip"
                      data-field={f}
                      data-on={on ? "1" : "0"}
                      aria-pressed={on}
                      className={`${styles.fieldChip}${on ? ` ${styles.fieldChipOn}` : ""}`}
                      onClick={() => toggleField(f)}
                    >
                      {on && <i className={styles.legendSwatch} style={{ background: FIELD_COLORS[k % FIELD_COLORS.length] }} />}
                      {src.behaviorByField[f]?.label ?? f}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        ) : (
        <div className={styles.legend} data-testid="behavior-legend">
          {model.legend.map((l) => (
            <span key={l.label} className={styles.legendItem} data-testid="behavior-legend-item">
              <i className={styles.legendSwatch} style={{ background: l.color }} />
              {l.label}
            </span>
          ))}
          {/* BOTH GRANULARITIES. A part-month is as misleading as a part-week and is marked the
              same way — the label is the only thing that differs. */}
          {partialIdx >= 0 && (
            <span className={styles.legendItem} data-testid="behavior-legend-partial">
              <i className={styles.legendDash} />
              {bucketLabel(months[partialIdx], gran)} is still running — partial
            </span>
          )}
        </div>
        )}
        <div className={styles.plotWrap}>
        <svg
          ref={svgRef}
          className={styles.chartSvg}
          id="playerBehaviorChart"
          viewBox={`0 0 ${VW} ${VH}`}
          preserveAspectRatio="xMidYMid meet"
          onMouseMove={onMove}
          onMouseLeave={() => setHoverIdx(null)}
        >
          {c && (
            <>
              {/* GRIDLINES FIRST, so every line draws on top of them — the order
                  MembershipActiveChart uses, and the reason its lines read as data rather than as
                  more grid. */}
              {c.gridlines.map((g, i) => (
                <g key={`g${i}`}>
                  <line className={styles.gl} x1={M.l} y1={g.y.toFixed(1)} x2={M.l + IW} y2={g.y.toFixed(1)} />
                  <text className={styles.axis} x={M.l - 12} y={(g.y + 3.5).toFixed(1)} textAnchor="end">
                    {g.label}
                  </text>
                </g>
              ))}
              {/* THE BASELINE. Darker than a gridline; the plot needs a floor to sit on. */}
              <line className={styles.baseline} x1={M.l} y1={c.baseline.toFixed(1)} x2={M.l + IW} y2={c.baseline.toFixed(1)} />

              {/* THINNED X LABELS — see buildChart. `show` is false for the ones that would touch. */}
              {c.monthTicks.map((t, i) => (t.show ? (
                <text key={`m${i}`} data-testid="behavior-axis-tick" className={styles.axis}
                  x={t.x.toFixed(1)} y={VH - M.b + 24} textAnchor="middle">
                  {t.label}
                </text>
              ) : null))}

              {c.polys.map((p, i) => (
                <g key={`p${i}`}>
                  <path d={p.d} fill="none" stroke={p.color} strokeWidth={p.width}
                    strokeLinejoin="round" strokeLinecap="round" />
                  {/* THE PARTIAL TAIL, DASHED. Same colour — it is the same series, not a fifth one. */}
                  {p.dPartial && (
                    <path data-testid="behavior-partial-seg" d={p.dPartial} fill="none" stroke={p.color}
                      strokeWidth={p.width} strokeDasharray="5 4" strokeLinecap="round" opacity={0.75} />
                  )}
                  {/* A HOLLOW end marker when the last bucket is partial, filled when it is not.
                      MembershipActiveChart marks its in-progress point the same way. */}
                  <circle cx={p.cx.toFixed(1)} cy={p.cy.toFixed(1)} r={3.6}
                    fill={p.dPartial ? "#fff" : p.color} stroke={p.color} strokeWidth={p.dPartial ? 2 : 0} />
                </g>
              ))}

              {/* THE PARTIAL BUCKET, NAMED ON THE AXIS. A dashed line says "different"; only the
                  word says WHAT is different. */}
              {c.partialIdx >= 0 && c.partialIdx === c.pts.length - 1 && (
                <>
                  <line className={styles.partialRule} x1={c.pts[c.partialIdx].x} y1={M.t}
                    x2={c.pts[c.partialIdx].x} y2={c.plot.b} />
                  <text data-testid="behavior-partial-note" className={styles.partialNote}
                    x={c.pts[c.partialIdx].x} y={VH - M.b + 36} textAnchor="end">
                    {gran === "weekly" ? "partial week" : "partial month"}
                  </text>
                </>
              )}

              {/* HOVER: a rule, a marker on every series, and a tooltip naming the bucket. */}
              {hoverIdx != null && c.pts[hoverIdx] && (
                <g data-testid="behavior-hover">
                  <line className={styles.hoverRule} x1={c.pts[hoverIdx].x} y1={M.t} x2={c.pts[hoverIdx].x} y2={c.plot.b} />
                  {c.pts[hoverIdx].ys.map((y, k) => (
                    <circle key={`h${k}`} data-testid="behavior-hover-dot"
                      cx={c.pts[hoverIdx].x.toFixed(1)} cy={y.toFixed(1)} r={5}
                      fill="#fff" stroke={model.legend[k]?.color ?? "#888"} strokeWidth={2.5} />
                  ))}
                </g>
              )}
            </>
          )}        </svg>
        {/* THE TOOLTIP — HTML rather than SVG text, so it can have a background, padding and wrap
            without hand-laying every box. Positioned in PERCENT of the plot, because the svg
            scales to the container and viewBox units are not client pixels. */}
        {hoverIdx != null && c && c.pts[hoverIdx] && (
          <div
            className={styles.tip}
            data-testid="behavior-tooltip"
            style={{
              left: `${(c.pts[hoverIdx].x / VW) * 100}%`,
              // Flip to the left of the rule past the midpoint so the tip never leaves the card.
              transform: c.pts[hoverIdx].x > VW / 2 ? "translate(-100%, 0)" : "translate(0, 0)",
            }}
          >
            <div className={styles.tipHead} data-testid="behavior-tooltip-bucket">
              {bucketLabel(months[hoverIdx], gran)}
              {!complete[hoverIdx] && <span className={styles.tipPartial}>partial</span>}
            </div>
            {model.legend.map((l, k) => (
              <div key={l.label} className={styles.tipRow}>
                <i className={styles.legendSwatch} style={{ background: l.color }} />
                <span className={styles.tipName}>{l.label}</span>
                <span className={styles.tipVal}>{fmt(c.pts[hoverIdx].vals[k] ?? 0)}</span>
              </div>
            ))}
          </div>
        )}
        </div>
      </div>

      {/* detail head */}
      <div className={styles.metricsDetailHead}>
        <div>
          <strong className={styles.detailStrong} id="growthDetailTitle">
            {model.detailTitle}
          </strong>

        </div>
        <span className={styles.behaviorScope} id="growthBehaviorScope">
          {model.scope}
        </span>
      </div>

      {/* ── A NUMBER THAT USED TO BE THERE DOES NOT JUST VANISH ────────────────────────────────
          Total players and Returning players are DISTINCT counts, and their Period total was the sum
          of the monthly figures - which double-counts anyone who played in two of them. Over Apr-Sep
          that read 15,625 against a true 8,361: 86.9% too high, and it looked right because it landed
          0.9% from the all-time player count.
          THE WRONG NUMBER IS GONE AND THE RIGHT ONE IS NOT WIRED IN YET, so the cell is a dash. A
          dash with no explanation is its own defect when a figure has been on screen for months, so
          the reason is on the page. THE PER-PERIOD COLUMNS ARE UNAFFECTED and always were: only the
          total was summing something that must not be summed. */}
      {!detailMode && winAgg === null && (
        <p className={styles.tableNote} data-testid="behavior-distinct-note">
          <b>Total players</b> and <b>Returning players</b> are distinct counts, so their period
          figure is not the sum of the months and is being rewired; it shows a dash meanwhile. Every
          month column is correct, and so is <b>Returning player %</b>, which has always read its
          latest value rather than an average.
        </p>
      )}
      {/* REGISTRATIONS HAVE NO FIELD, said where the missing row is. A player registers before
          choosing a pitch, so a field's expansion is five metrics rather than six - and a reader who
          counts them deserves the reason rather than a suspicion. */}
      {fieldMode && (
        <p className={styles.tableNote} data-testid="behavior-no-field-registrations">
          A field&rsquo;s metrics are five, not six: <b>registrations have no field</b>. A player
          registers before choosing a pitch, so there is no honest per-pitch figure to show.
        </p>
      )}
      {/* summary table */}
      <div className={styles.summaryWrap}>
        <table className={styles.table}>
          <thead id="growthSummaryHead">
            <tr>
              <th className={styles.stickyHead} data-testid="behavior-th" data-k="name">{firstColHead}</th>
              {/* THE HEADER IS THE BUCKET, NOT ITS MONTH. `monthLabel` was used unconditionally,
                  so in weekly mode five consecutive columns all read "Jun 2026" — 21 of 27 headers
                  were duplicates and the table could not be read at all. bucketLabel is the same
                  labeller the CSV already used and it names the full range: "Jun 1 – Jun 7". */}
              {months.map((m, i) => (
                <th key={m} data-testid="behavior-col-head" data-k={m}
                    data-partial={!complete[i] ? "1" : "0"}
                    aria-sort={sortAria(m)}
                    className={`${!complete[i] ? styles.thPartial : ""} ${detailMode ? styles.sortable : ""}`}
                    onClick={detailMode ? () => toggleSort(m) : undefined}>
                  {bucketLabel(m, gran)}
                  {/* ── THE LIVE COLUMN IS MARKED ONCE, ON THE HEADER ─────────────────────────
                      Not on six cells: one caveat said six times reads as six caveats. The current
                      period is a column now because the change pill compares a MATCHED WINDOW, so
                      including it is safe - but clamping it is not the same as pretending it closed. */}
                  {!complete[i] && <span className={styles.thPartialTag} data-testid="behavior-in-progress">in progress</span>}
                </th>
              ))}
              <th data-testid="behavior-period-total-head" data-k="total"
                  aria-sort={sortAria("total")}
                  className={detailMode ? styles.sortable : undefined}
                  onClick={detailMode ? () => toggleSort("total") : undefined}>
                Period total
              </th>
              {/* THE COLUMN SAYS WHICH TWO BUCKETS IT COMPARED. "Latest WoW" over an unnamed pair
                  is how a partial week hid inside a −68% badge for as long as it did. */}
              {/* ── THE CHANGE COLUMN NAMES THE UNIT AND THE WINDOW ──────────────────────────
                  "Latest MoM" over a daily column would be wrong, so the unit follows the grain.
                  And the SUB-LINE names the two windows it actually used, with both weekend counts,
                  which is what lets this pill sit beside cells it does not equal without lying. */}
              <th title={cmpTitle} data-testid="behavior-change-head">
                Change vs. last {unitWord}
                {cmpSub && <span className={styles.thSub} data-testid="behavior-change-sub">{cmpSub}</span>}
              </th>
            </tr>
          </thead>
          <tbody id="growthSummaryBody">
            {sortedRows.map((r) => (
              <Fragment key={r.name}>
              <tr data-testid="behavior-row" data-name={r.name}
                  data-open={r.entity && openRow === r.entity ? "1" : "0"}
                  className={r.entity ? styles.rowClickable : undefined}
                  onClick={r.entity ? () => setOpenRow(openRow === r.entity ? null : r.entity!) : undefined}>
                <td className={`${styles.nameCell} ${styles.stickyCell}`}>
                  {r.rank != null && <span className={styles.rank}>{r.rank}</span>}
                  {r.dot && <span className={styles.cityKey} style={{ background: r.dot }} />}
                  {r.name}
                  {/* THE AFFORDANCE, because a row that opens has to look like one. */}
                  {r.entity && <span className={styles.rowCaret} aria-hidden="true">{openRow === r.entity ? "▾" : "▸"}</span>}
                </td>
                {r.cells.map((v, i) => (
                  <td key={i}>{r.points ? `${v.toFixed(1)}%` : fmt(v)}</td>
                ))}
                {/* A DASH WHERE A DISTINCT TOTAL IS NOT AVAILABLE. Never the sum: the sum is the
                    wrong number, and "—" says so. Never "NaN" either, which reads as a crash. */}
                <td data-testid="behavior-period-total">
                  {r.points ? `${r.total.toFixed(1)}%`
                    : Number.isFinite(r.total) ? fmt(r.total)
                    : <span title="A distinct count over this period is not available right now. It is never the sum of the monthly figures, which double-counts anyone who played in two of them.">—</span>}
                </td>
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
              {/* ── ALL SIX METRICS FOR THE OPEN ENTITY ──────────────────────────────────────
                  A field's expansion omits REGISTRATIONS: a player registers before choosing a
                  pitch, so there is no honest per-field figure and the page says so below. */}
              {r.entity && openRow === r.entity && childRows.map((cr) => (
                <tr key={`${r.name}-${cr.name}`} data-testid="behavior-child" data-metric={cr.name}
                    className={styles.childRow}>
                  <td className={`${styles.nameCell} ${styles.stickyCell} ${styles.childName}`}>{cr.name}</td>
                  {cr.cells.map((v, i) => (
                    <td key={i}>{cr.points ? `${v.toFixed(1)}%` : fmt(v)}</td>
                  ))}
                  <td>{cr.points ? `${cr.total.toFixed(1)}%` : fmt(cr.total)}</td>
                  <td>
                    <span className={`${styles.status} ${cr.mom >= 0 ? styles.statusGreen : styles.statusRed}`}>
                      {cr.mom >= 0 ? "+" : ""}{cr.mom.toFixed(1)}{cr.points ? " pts" : "%"}
                    </span>
                  </td>
                </tr>
              ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      </>
      )}
    </div>
  );
}
