"use client";

// REVENUE PACE — the selected period at a readable grain, against the period before it.
//
// THE GRAIN FOLLOWS THE PERIOD. Month by day, quarter by week, year by month. It used to chart one
// month by day at every grain, and the month it picked was `period.months[last]` — which on Quarter
// and Year is a month in the FUTURE. Measured on 21 Aug 2026: selecting Q3 2026 charted Sep 2026
// (0 points, subtitle "compared with —"), and selecting 2026 charted Dec 2026 (0 points). The card
// was not slow-and-crowded at those grains, it was EMPTY, and the empty chart was not distinguished
// from a chart of real zeroes.
//
// THE TITLE IS DERIVED FROM THE GRAIN. "Daily revenue pace" is a lie on two of the three views, so
// the word comes from GRAIN_WORD and nothing in this file hardcodes "Daily".
//
// WEEKS ARE MONDAY-START, like everything else in this app, and the axis reads the week's start
// date rather than a week number — "Aug 17", not "W34". Nobody navigates by week number.
//
// THE TRAILING BUCKET IS USUALLY PARTIAL. The current week or month is incomplete, so its point
// sits below a completed one for a reason that is not performance. Partial points are drawn HOLLOW,
// the same treatment ReviewsClient uses for its partial week, and the readout says so. A bucket
// clipped by the period's own edge (the first week of a quarter that starts on a Wednesday) is
// marked by the same rule — it is short for a calendar reason too.
//
// ── WHY IT WAS SLOW, MEASURED BEFORE IT WAS CHANGED ────────────────────────────────────────────
// Instrumented on the dev server, 21 Aug 2026, counting every /rest/v1/ request per grain switch:
//
//   switch      pace-card requests    rows       rest of the page
//   → Quarter   7                     ~6,300     243 requests (169 of them mdapi_match_players)
//   → Year      14                    ~6,300     197 requests (156 mdapi_match_players)
//   → Month     12                    ~6,300      44 requests
//
// So: (a) it refetched the WHOLE window on every period change, because the effect was keyed on the
// anchor month and the lower bound was always `year - 1` January — about 6,300 rows, seven pages,
// every single time; (b) the aggregation was NOT the problem — 17 dailySeries passes over 6,329
// rows benchmark at 2.6ms warm, 11ms cold, and they were already memoised per dataset, not per
// render; (c) the pace card is NOT what makes the switch feel slow — on the Year switch its
// subtitle took 7,262ms while it issued 14 of the page's 211 requests. It was queued behind the
// rest of the page, which pages mdapi_match_players ~160 times per switch.
//
// THE FIX IS (a), WHICH IS THE ONLY PART THAT IS THIS CARD'S. One stable query from the record
// floor to the end of the current year, kept across every period change with a high-water mark, so
// switching grain costs this card ZERO network. It cannot fix (c) — that is the page's loaders, and
// pretending otherwise would be the memo that shaves nothing.
//
// BOTH SERIES SHARE THE FILTERS. A city or field filter that moved one line and not the other would
// be worse than no filter at all — it would invite a comparison between two different businesses.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useFinancePeriod } from "@/lib/financePeriodContext";
import { useAuth } from "@/lib/useAuth";
import { EARLIEST_QUARTER } from "@/lib/quarters";
import type { Grain } from "@/lib/financePeriod";
import { fmtMoney } from "@/components/growth/format";
import s from "./financeSection.module.css";

type Row = { date: string; city: string; venue: string | null; type: string; gross: number };
type Compare = "period" | "quarter" | "year";

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_FULL = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

// THE ONE PLACE THE GRAIN WORD LIVES. Title, subtitle and readout all read from here, so "daily"
// cannot survive on a weekly chart.
const GRAIN_WORD: Record<Grain, { title: string; by: string }> = {
  month: { title: "Daily", by: "by day" },
  quarter: { title: "Weekly", by: "by week" },
  year: { title: "Monthly", by: "by month" },
};

const RECORD_FLOOR = `${EARLIEST_QUARTER.year}-${String((EARLIEST_QUARTER.quarter - 1) * 3 + 1).padStart(2, "0")}-01`;

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** MONDAY-START, the same convention as Master Schedule and Reviews. Sunday is day 0 in JS. */
const mondayOf = (d: Date) => addDays(d, -((d.getDay() + 6) % 7));
const shortDate = (d: Date) => `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;

// MEMBERSHIP vs DPP is a `type` on the row. Anything not obviously a membership is direct play.
const isMembership = (t: string) => /member/i.test(t ?? "");

/* ── THE ROW CACHE LIVES OUTSIDE THE COMPONENT, DELIBERATELY ───────────────────────────────────
 * RevenueSection.tsx:426 returns a bare "Loading…" for the WHOLE section while its own data
 * reloads, so this card is UNMOUNTED and remounted on every period change. A useRef high-water mark
 * therefore never survives to be read — measured: the Year switch still issued 16 requests with the
 * ref in place. Module scope is the only scope that outlives the parent's unmount.
 *
 * IT IS ONE SLOT WITH A SUPERSET TEST, not a map. A map keyed on the exact range would refetch to
 * answer a NARROWER question while the wider row set is already in hand, which is the whole reason
 * this is fast: every period inside the current year asks for the same upper bound, and a period in
 * a future year is answered by the wider slot rather than by a second read.
 *
 * WHAT THE SLOT RECORDS IS THE RANGE THE COMPLETED FETCH ACTUALLY COVERED, and BOTH bounds of it.
 * The lower bound is a constant today, so keying on the upper alone is sound — but sound by
 * coincidence of the constant rather than by the record, and a floor that later varies would make
 * a stale slot answer for a range it never read.
 *
 * IT IS KEYED ON THE IDENTITY THE ROWS WERE READ AS. RLS resolves against the logged-in user, so a
 * user swap with no document navigation could otherwise be served another account's rows. The id is
 * compared, never rendered, never logged and never put in the DOM.
 *
 * THE WRITE IS MONOTONIC. Two fetches can be in flight with different upper bounds, and they can
 * finish in either order: a late-finishing NARROW fetch must not replace a wider slot, or the next
 * period that needs the wide range silently reads a row set that never covered it. */
type Range = { uid: string; from: string; to: string };
let CACHE: (Range & { rows: Row[] }) | null = null;
let INFLIGHT: (Range & { p: Promise<Row[]> }) | null = null;

/** Same reader, and a range that contains the one being asked for. Both are required. */
const covers = (have: Range | null, want: Range) =>
  !!have && have.uid === want.uid && have.from <= want.from && have.to >= want.to;

/** For assertions only — the range and the SIZE of what is held. Never the identity. */
export function paceCacheSnapshot(): { from: string; to: string; rows: number } | null {
  return CACHE ? { from: CACHE.from, to: CACHE.to, rows: CACHE.rows.length } : null;
}

async function loadRows(want: Range): Promise<Row[]> {
  if (covers(CACHE, want)) return CACHE!.rows;
  // ONE IN-FLIGHT SLOT, reusable only when what is already flying covers the request. A WIDER
  // request starts its own fetch — correct, and rare enough to be worth no machinery.
  if (covers(INFLIGHT, want)) return INFLIGHT!.p;
  const p = (async () => {
    // PAGED. PostgREST caps a response at 1,000 rows, and an unpaged read silently returned the
    // OLDEST 1,000 and nothing since — the current month charted empty and both comparisons read
    // "no revenue on record" for months holding tens of thousands of dollars.
    const page = 1000;
    const acc: Row[] = [];
    for (let from = 0; ; from += page) {
      const { data, error } = await supabase
        .from("fin_revenue").select("date, city, venue, type, gross")
        .gte("date", want.from).lte("date", want.to).order("date").range(from, from + page - 1);
      // A FAILED PAGE IS NOT AN EMPTY MONTH. Throwing leaves CACHE untouched so the next mount
      // retries, rather than pinning a truncated read as the answer for the rest of the session.
      // It also means a slot is only ever written by a fetch that reached the end of its range.
      if (error) throw error;
      if (!data) break;
      acc.push(...(data as Row[]));
      if (data.length < page) break;
    }
    // MONOTONIC. Skip the write when what is already there covers this range — that is a wider slot
    // for the same reader, and this fetch has nothing to add. A different reader never covers, so a
    // swap replaces rather than being blocked by a stale width.
    if (!covers(CACHE, want)) CACHE = { ...want, rows: acc };
    return acc;
  })();
  INFLIGHT = { ...want, p };
  try { return await p; } finally { if (INFLIGHT?.p === p) INFLIGHT = null; }
}

type Bucket = {
  /** Inclusive calendar span of the bucket itself, BEFORE the period clips it. */
  start: Date;
  end: Date;
  axis: string;     // x-axis tick
  readout: string;  // what the tooltip calls it
  /** Not fully covered by the period AND already elapsed. Drawn hollow, said out loud. */
  partial: boolean;
  /** Entirely in the future — no line is drawn to it at all. */
  future: boolean;
};

/**
 * THE BUCKETS FOR ONE WINDOW AT ONE GRAIN. `today` clips the partial flag; a window entirely in the
 * past (the comparison period) has no partial buckets except the ones its own edges clip.
 */
function bucketsFor(grain: Grain, start: Date, end: Date, today: Date): Bucket[] {
  const out: Bucket[] = [];
  const mark = (bs: Date, be: Date, axis: string, readout: string) => {
    // FULL means: the bucket begins no earlier than the window, ends no later than the window, and
    // has ALREADY FINISHED — strictly before today, because the day in progress is not a day's
    // trading yet. That is the same rule the pace rate uses when it excludes the current day.
    const covered = bs >= start && be <= end && be < today;
    out.push({ start: bs, end: be, axis, readout, partial: !covered, future: bs > today });
  };
  if (grain === "month") {
    for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
      mark(d, d, String(d.getDate()), `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`);
    }
  } else if (grain === "quarter") {
    // EVERY MONDAY-START WEEK THAT INTERSECTS THE PERIOD. A quarter beginning mid-week produces a
    // clipped leading bucket rather than a shifted grid — weeks stay weeks across the whole app.
    for (let w = mondayOf(start); w <= end; w = addDays(w, 7)) {
      mark(w, addDays(w, 6), shortDate(w), `Week of ${shortDate(w)}`);
    }
  } else {
    for (let m = new Date(start.getFullYear(), start.getMonth(), 1); m <= end;
         m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
      const last = new Date(m.getFullYear(), m.getMonth() + 1, 0);
      mark(m, last, MONTH_SHORT[m.getMonth()], `${MONTH_FULL[m.getMonth()]} ${m.getFullYear()}`);
    }
  }
  return out;
}

/**
 * SUM THE ROWS INTO THE BUCKETS, clipped to the window. Rows outside [start,end] are dropped before
 * bucketing, which is what makes the series sum to the period's own total to the dollar — a bucket
 * that hangs outside the period never contributes the days that hang with it.
 */
function seriesFor(
  rows: Row[], buckets: Bucket[], start: Date, end: Date,
  city: string, field: string, kind: string,
): number[] {
  const out = new Array<number>(buckets.length).fill(0);
  if (!buckets.length) return out;
  const lo = ymd(start), hi = ymd(end);
  // Bucket lookup by date, built once. Linear scan per row would be O(rows × buckets) — 6,300 × 92
  // at day grain, which is the one place in this file where the obvious loop is the wrong one.
  const index = new Map<string, number>();
  buckets.forEach((b, i) => {
    for (let d = b.start > start ? new Date(b.start) : new Date(start); d <= b.end && d <= end; d = addDays(d, 1)) {
      index.set(ymd(d), i);
    }
  });
  for (const r of rows) {
    const date = r.date;
    if (!date || date < lo || date > hi) continue;
    if (city !== "All cities" && r.city !== city) continue;
    if (field !== "All fields" && (r.venue ?? "") !== field) continue;
    if (kind === "dpp" && isMembership(r.type)) continue;
    if (kind === "member" && !isMembership(r.type)) continue;
    const i = index.get(date);
    if (i !== undefined) out[i] += Number(r.gross ?? 0);
  }
  return out;
}

/** The window the comparison covers, and what to call it. */
function comparisonWindow(grain: Grain, start: Date, mode: Compare): { start: Date; end: Date; label: string } {
  const y = start.getFullYear(), m = start.getMonth();
  if (mode === "quarter") {
    // MONTH GRAIN ONLY. The quarter before the one this month sits in, averaged per day-of-month.
    const q = Math.floor(m / 3) - 1;
    const qy = q < 0 ? y - 1 : y, qq = q < 0 ? 3 : q;
    return {
      start: new Date(qy, qq * 3, 1), end: new Date(qy, qq * 3 + 3, 0),
      label: `${MONTH_SHORT[qq * 3]}–${MONTH_SHORT[qq * 3 + 2]} ${qy} avg`,
    };
  }
  if (mode === "year") {
    return { start: new Date(y - 1, 0, 1), end: new Date(y - 1, 12, 0), label: `${y - 1} monthly avg` };
  }
  // THE PREVIOUS PERIOD OF THE SAME GRAIN — the comparison every grain has.
  if (grain === "month") {
    const py = m === 0 ? y - 1 : y, pm = m === 0 ? 11 : m - 1;
    return { start: new Date(py, pm, 1), end: new Date(py, pm + 1, 0), label: `${MONTH_SHORT[pm]} ${py}` };
  }
  if (grain === "quarter") {
    const q = Math.floor(m / 3) - 1;
    const qy = q < 0 ? y - 1 : y, qq = q < 0 ? 3 : q;
    return { start: new Date(qy, qq * 3, 1), end: new Date(qy, qq * 3 + 3, 0), label: `Q${qq + 1} ${qy}` };
  }
  return { start: new Date(y - 1, 0, 1), end: new Date(y - 1, 12, 0), label: String(y - 1) };
}

export default function DailyRevenuePace() {
  const { period, now } = useFinancePeriod();
  // THE IDENTITY THE ROWS ARE READ AS — compared inside the cache, never rendered or logged.
  // useAuth is a module singleton with its own subscriber list, so this costs no extra request.
  const { appUser, isLoading: authLoading } = useAuth();
  const grain = period.grain;
  const today = useMemo(() => midnight(now), [now]);

  const [compare, setCompare] = useState<Compare>("period");
  const [city, setCity] = useState("All cities");
  const [field, setField] = useState("All fields");
  const [kind, setKind] = useState("total");
  const [rows, setRows] = useState<Row[] | null>(null);

  /* ── ONE QUERY, KEPT ─────────────────────────────────────────────────────────────────────────
   * MEASURED CAUSE OF THE SLOWNESS. The old effect was keyed on the anchor month with a lower bound
   * of `year - 1` January, so every period change refetched ~6,300 rows over seven pages. The window
   * here is the whole record up to the end of the CURRENT year, which covers month, quarter and year
   * of the selected year in one read — so a grain switch issues no request at all. The high-water
   * mark is what makes that true across navigation: only a period reaching past what has already
   * been fetched triggers a second read, and it then covers everything below it too. */
  const needTo = useMemo(() => {
    const endOfThisYear = new Date(now.getFullYear(), 11, 31);
    return ymd(period.end > endOfThisYear ? period.end : endOfThisYear);
  }, [period.end, now]);

  const want = useMemo(
    () => ({ uid: appUser?.id ?? "", from: RECORD_FLOOR, to: needTo }),
    [appUser?.id, needTo],
  );

  useEffect(() => {
    // WAIT FOR AUTH RATHER THAN FETCHING AS NOBODY. Reading under a placeholder identity and then
    // again under the real one would double every cold load and cache a row set nobody asked for.
    if (authLoading || !want.uid) return;
    let live = true;
    // SYNCHRONOUS WHEN IT IS ALREADY CACHED — no flash of "Loading…" on a grain change, because
    // there is nothing to load.
    if (covers(CACHE, want)) { setRows(CACHE!.rows); return; }
    void loadRows(want).then((r) => { if (live) setRows(r); }).catch(() => { if (live) setRows([]); });
    return () => { live = false; };
  }, [want, authLoading]);

  // THE OPTION LISTS COME FROM THE WHOLE RECORD, not from the selected window. Deriving them from a
  // narrow window would drop a city from the dropdown in a month it happened not to trade.
  const cities = useMemo(
    () => ["All cities", ...[...new Set((rows ?? []).map((r) => r.city).filter(Boolean))].sort()],
    [rows],
  );
  const fields = useMemo(
    () => ["All fields", ...[...new Set((rows ?? []).map((r) => r.venue ?? "").filter(Boolean))].sort()],
    [rows],
  );

  const buckets = useMemo(
    () => bucketsFor(grain, period.start, period.end, today),
    [grain, period.start, period.end, today],
  );

  const current = useMemo(
    () => (rows ? seriesFor(rows, buckets, period.start, period.end, city, field, kind) : []),
    [rows, buckets, period.start, period.end, city, field, kind],
  );

  // THE LAST BUCKET THE PERIOD HAS ACTUALLY REACHED. Future buckets are omitted rather than drawn at
  // zero — a year view drawing Sep–Dec at $0 in August reads as a collapse, not as "not yet".
  const drawnTo = useMemo(() => {
    let n = 0;
    buckets.forEach((b, i) => { if (!b.future) n = i + 1; });
    return n;
  }, [buckets]);

  /* THE THREE COMPARISONS. Only "previous period" is defined at every grain: an average day of the
   * prior quarter is a month-grain idea, and there is no honest reading of it against a chart of
   * weeks. The other two are DISABLED WITH THE REASON at quarter and year rather than hidden, and
   * rather than quietly plotting something invented. */
  const comparisons = useMemo(() => {
    if (!rows) return null;
    const out = {} as Record<Compare, { label: string; data: number[]; has: boolean; why?: string }>;
    for (const mode of ["period", "quarter", "year"] as Compare[]) {
      if (mode !== "period" && grain !== "month") {
        const w = comparisonWindow("month", period.start, mode);
        out[mode] = {
          label: w.label, data: [], has: false,
          why: `An average day of ${w.label.replace(/ avg$/, "")} cannot be plotted against ${GRAIN_WORD[grain].by.replace("by ", "")}s — switch to the Month view for that comparison.`,
        };
        continue;
      }
      const w = comparisonWindow(grain, period.start, mode);
      if (mode === "period") {
        const cb = bucketsFor(grain, w.start, w.end, today);
        const data = seriesFor(rows, cb, w.start, w.end, city, field, kind);
        out[mode] = { label: w.label, data, has: data.some((v) => v > 0) };
      } else {
        // AN AVERAGE OF WHOLE MONTHS, by day-of-month. Not rounded per day: rounding each of 31 days
        // put the series $2 away from the month's own gross, and an assertion that has to carry a
        // tolerance stops catching the thing it is for.
        const months: [number, number][] = [];
        for (let m = new Date(w.start); m <= w.end; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
          months.push([m.getFullYear(), m.getMonth()]);
        }
        const series = months.map(([yy, mm]) => {
          const ms = new Date(yy, mm, 1), me = new Date(yy, mm + 1, 0);
          return seriesFor(rows, bucketsFor("month", ms, me, today), ms, me, city, field, kind);
        });
        const width = Math.max(...series.map((x) => x.length), 0);
        const data = Array.from({ length: width }, (_, d) =>
          series.reduce((sum, x) => sum + (x[d] ?? 0), 0) / series.length);
        out[mode] = { label: w.label, data, has: series.some((x) => x.some((v) => v > 0)) };
      }
    }
    return out;
  }, [rows, grain, period.start, today, city, field, kind]);

  // A COMPARISON THAT IS NOT AVAILABLE AT THIS GRAIN MUST NOT STAY SELECTED. Switching from Month to
  // Quarter with "previous year avg" chosen would otherwise draw nothing and say nothing.
  useEffect(() => {
    if (grain !== "month" && compare !== "period") setCompare("period");
  }, [grain, compare]);

  const comp = comparisons?.[compare] ?? null;
  // DRAWN IN FULL, never cut to what the current period has reached. Two lines of different lengths
  // is the point: the short one is what has happened, the long one is what it is being measured
  // against for the rest of the period.
  const compData = comp && comp.has ? comp.data : [];
  const curData = useMemo(() => current.slice(0, Math.max(drawnTo, 1)), [current, drawnTo]);

  // ── the plot ────────────────────────────────────────────────────────────────────────────────
  const W = 980, H = 260, ML = 68, MR = 24, MT = 18, MB = 34;
  const plotW = W - ML - MR, plotH = H - MT - MB;
  const nPts = Math.max(buckets.length || 1, compData.length);
  const peak = Math.max(1, ...curData, ...compData);
  // A rounded ceiling, so the axis reads in round money rather than the exact maximum.
  const step = Math.pow(10, Math.max(0, String(Math.round(peak)).length - 2));
  const maxY = Math.max(step, Math.ceil((peak * 1.12) / step) * step);
  const x = (i: number) => ML + (nPts === 1 ? plotW / 2 : (i * plotW) / (nPts - 1));
  const y = (v: number) => MT + plotH - (v / maxY) * plotH;
  const path = (d: number[]) => d.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");

  // Never crowd the axis: show every tick when there are few, thin them when there are many.
  const tickEvery = Math.max(1, Math.ceil(nPts / 12));

  /* ── HOVER READOUT ────────────────────────────────────────────────────────────────────────
   * SNAPS TO THE NEAREST BUCKET FROM ANYWHERE IN THE PLOT, at any height. Hit-testing the line
   * itself would be unusable — it is 2-3px wide across a 980-unit viewBox — so the whole plot is
   * one target and the x position picks the bucket.
   *
   * PINNED is the touch path. A tap sets it; a tap on another point moves it; a tap outside clears
   * it. Without that the chart is inert on a phone, where there is no hover at all.
   */
  const [hoverAt, setHoverAt] = useState<number | null>(null);
  const [pinned, setPinned] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Pointer x → bucket index. The SVG scales to its container, so client pixels are converted back
  // into viewBox units before comparing against the same x() the paths are drawn with.
  const pointAt = useCallback((clientX: number): number | null => {
    const el = svgRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0) return null;
    const ux = (clientX - r.left) * (W / r.width);
    if (ux < ML - 12 || ux > ML + plotW + 12) return null;
    const i = nPts === 1 ? 0 : Math.round(((ux - ML) / plotW) * (nPts - 1));
    return Math.max(0, Math.min(nPts - 1, i));
  }, [W, ML, plotW, nPts]);

  // Dismiss a pinned readout on any pointer-down outside the chart.
  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: PointerEvent) => {
      if (svgRef.current?.contains(e.target as Node)) return;
      setPinned(false);
      setHoverAt(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [pinned]);

  // THE READOUT'S VALUES COME FROM THE SERIES THE CHART WAS GIVEN, not from anything re-derived.
  const readout = useMemo(() => {
    if (hoverAt == null) return null;
    const i = hoverAt;
    const b = buckets[i] ?? null;
    const cur = i < drawnTo ? current[i] ?? null : null;
    const cmp = comp?.has ? comp.data[i] ?? null : null;
    return {
      i,
      // THE LABEL IS THE BUCKET'S OWN — "Week of Aug 17" on a weekly chart, never a bare date.
      pointLabel: b?.readout ?? `Point ${i + 1}`,
      partial: !!b?.partial && cur != null,
      curLabel: period.label,
      cmpLabel: comp?.label ?? null,
      cur, cmp,
      // CURRENT MINUS COMPARISON, in that order. Only when both sides exist.
      diff: cur != null && cmp != null ? cur - cmp : null,
    };
  }, [hoverAt, buckets, current, drawnTo, comp, period.label]);

  const scope = field !== "All fields" ? field : city !== "All cities" ? city : "All Matchday";
  // Read during render so every re-render republishes it — a late-resolving fetch changes the slot
  // without re-rendering anyone, and the next render is when it becomes observable.
  const cacheSnap = paceCacheSnapshot();
  const word = GRAIN_WORD[grain];
  const partialIdx = useMemo(
    () => buckets.map((b, i) => (b.partial && i < drawnTo ? i : -1)).filter((i) => i >= 0),
    [buckets, drawnTo],
  );

  return (
    <div className={s.card} data-testid="pace-card" data-grain={grain}
      // THE CACHE'S OWN STATE, for assertions: the range it holds and HOW MANY rows it holds. A
      // range without its matching row count is the exact bug the monotonic write exists to stop,
      // so both are published. The identity in the key is deliberately NOT here.
      data-cacherange={cacheSnap ? `${cacheSnap.from}..${cacheSnap.to}` : ""}
      data-cacherows={cacheSnap ? String(cacheSnap.rows) : ""}>
      <div className={s.cardHead}>
        <div>
          <div className={s.cardTitle} data-testid="pace-title">{word.title} revenue pace</div>
          <div className={s.cardSub} data-testid="pace-sub">
            {scope} · {period.label} {word.by} compared with {comp?.has ? comp.label : "—"}
          </div>
        </div>
        <div className={s.ctrlStack}>
          <div className={s.ctrlGroup}>
            <span className={s.ctrlLab}>Compare with</span>
            <div className={s.seg} role="group" aria-label="Comparison series">
              {([
                ["period", `Previous ${grain}`],
                ["quarter", "Previous quarter avg"],
                ["year", "Previous year avg"],
              ] as [Compare, string][]).map(([v, t]) => {
                const c = comparisons?.[v];
                const has = c?.has ?? true;
                return (
                  <button key={v} type="button" disabled={!has}
                    data-testid={`pace-cmp-${v}`} data-disabled={!has ? "true" : "false"}
                    aria-pressed={compare === v}
                    className={compare === v ? s.on : ""}
                    // DISABLED WITH THE REASON, never hidden and never silently empty.
                    title={has ? undefined : (c?.why ?? `No revenue on record for ${c?.label ?? "that period"} — nothing to compare against.`)}
                    onClick={() => has && setCompare(v)}>{t}</button>
                );
              })}
            </div>
          </div>
          <div className={s.ctrlGroup}>
            <span className={s.ctrlLab}>View</span>
            <select className={s.sel} data-testid="pace-city" value={city} onChange={(e) => setCity(e.target.value)}>
              {cities.map((c) => <option key={c}>{c}</option>)}
            </select>
            <select className={s.sel} data-testid="pace-field" value={field} onChange={(e) => setField(e.target.value)}>
              {fields.map((f) => <option key={f}>{f}</option>)}
            </select>
            <select className={s.sel} data-testid="pace-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="total">DPP + Membership</option>
              <option value="dpp">DPP only</option>
              <option value="member">Membership only</option>
            </select>
          </div>
        </div>
      </div>

      {rows === null ? (
        <div className={s.legend} data-testid="pace-loading">Loading…</div>
      ) : (
        <div className={s.paceWrap}>
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%" role="img" data-testid="pace-chart"
          aria-label={`${word.title} revenue for ${period.label}, ${scope}`}
          // THE SERIES AS GIVEN, for assertions. The rendered path is rounded to 0.1 viewBox
          // units — about $5 at a $20k axis — so a test that recovers values from `d` can never
          // check them to the dollar. These are the exact arrays the readout reads.
          data-current={JSON.stringify(curData)}
          data-compare={JSON.stringify(compData)}
          data-partial={JSON.stringify(partialIdx)}
          data-labels={JSON.stringify(buckets.map((b) => b.readout))}
          onPointerMove={(e) => { if (!pinned) setHoverAt(pointAt(e.clientX)); }}
          onPointerLeave={() => { if (!pinned) setHoverAt(null); }}
          onPointerDown={(e) => {
            // TAP TO PIN. A tap on another point moves it; a second tap on the same one releases it.
            const d = pointAt(e.clientX);
            if (d == null) return;
            if (pinned && d === hoverAt) { setPinned(false); setHoverAt(null); return; }
            setHoverAt(d);
            setPinned(true);
          }}>
          {[0, 1, 2, 3, 4].map((i) => {
            const yy = MT + (i * plotH) / 4;
            return (
              <g key={i}>
                <line x1={ML} y1={yy} x2={ML + plotW} y2={yy} stroke="#e6e2d8" strokeWidth={1} />
                <text x={ML - 10} y={yy + 4} textAnchor="end" fontSize={10} fill="#7b8b82">
                  {fmtMoney(maxY - (maxY * i) / 4)}
                </text>
              </g>
            );
          })}
          {buckets.map((b, i) => (i % tickEvery === 0 || i === buckets.length - 1 ? (
            <text key={i} x={x(i)} y={H - 12} textAnchor="middle" fontSize={10} fill="#7b8b82">{b.axis}</text>
          ) : null))}
          {compData.length > 0 && (
            <path d={path(compData)} fill="none" stroke="#3f7fd6" strokeWidth={2}
              strokeLinecap="round" strokeLinejoin="round" data-testid="pace-line-compare" />
          )}
          <path d={path(curData)} fill="none" stroke="#2fa36b" strokeWidth={3}
            strokeLinecap="round" strokeLinejoin="round" data-testid="pace-line-current" />

          {/* THE PARTIAL MARK — hollow, the same treatment ReviewsClient gives a partial week. It is
              always drawn, not only on hover, because the reason the point sits low has to be
              visible before anyone reaches for the mouse to ask. */}
          {partialIdx.map((i) => (
            <circle key={i} cx={x(i)} cy={y(current[i] ?? 0)} r={4} fill="#fff" stroke="#2fa36b"
              strokeWidth={2} data-testid="pace-dot-partial" data-i={i} />
          ))}

          {readout && (
            <g data-testid="pace-crosshair" pointerEvents="none">
              <line x1={x(readout.i)} y1={MT} x2={x(readout.i)} y2={MT + plotH}
                stroke="#12352b" strokeOpacity={0.28} strokeWidth={1} strokeDasharray="3 3" />
              {readout.cmp != null && (
                <circle cx={x(readout.i)} cy={y(readout.cmp)} r={4.5} fill="#fff" stroke="#3f7fd6"
                  strokeWidth={2.5} data-testid="pace-dot-compare" />
              )}
              {readout.cur != null && (
                <circle cx={x(readout.i)} cy={y(readout.cur)} r={4.5} fill="#fff" stroke="#2fa36b"
                  strokeWidth={2.5} data-testid="pace-dot-current" />
              )}
            </g>
          )}

          {/* THE WHOLE PLOT IS THE TARGET. Last in the SVG so it takes the events, transparent so
              it changes nothing visually. Without it a pointer over empty plot space hits nothing
              and the readout only appears on the 2px line. */}
          <rect x={ML} y={MT} width={plotW} height={plotH} fill="transparent"
            data-testid="pace-hit" style={{ cursor: "crosshair" }} />
        </svg>

        {readout && (
          <div className={s.paceTip} data-testid="pace-readout"
            data-day={readout.i + 1}
            data-partial={readout.partial ? "true" : "false"}
            // FOLLOWS THE CURSOR, STAYS INSIDE THE CHART. Positioned as a percentage of the same
            // viewBox the crosshair uses, and flipped to the left of the crosshair once it would
            // otherwise run past the right edge.
            style={(() => {
              const px = (x(readout.i) / W) * 100;
              const flip = px > 62;
              return flip
                ? { right: `${100 - px}%`, marginRight: 10 }
                : { left: `${px}%`, marginLeft: 10 };
            })()}>
            <div className={s.paceTipDay} data-testid="pace-readout-label">{readout.pointLabel}</div>
            <div className={s.paceTipRow}>
              <span><i className={s.dot} style={{ background: "#2fa36b" }} />{readout.curLabel}</span>
              <b data-testid="pace-readout-current">{readout.cur == null ? "—" : fmtMoney(readout.cur)}</b>
            </div>
            {readout.cmpLabel && (
              <div className={s.paceTipRow}>
                <span><i className={s.dot} style={{ background: "#3f7fd6" }} />{readout.cmpLabel}</span>
                <b data-testid="pace-readout-compare">{readout.cmp == null ? "—" : fmtMoney(readout.cmp)}</b>
              </div>
            )}
            {/* NO DIFFERENCE ROW WHEN EITHER SIDE IS MISSING — a difference against nothing is not
                zero, and printing $0 there would read as parity. */}
            {readout.diff != null && (
              <div className={s.paceTipDiff} data-testid="pace-readout-diff"
                data-sign={readout.diff >= 0 ? "pos" : "neg"}>
                {readout.diff >= 0 ? "+" : "−"}{fmtMoney(Math.abs(readout.diff))}
              </div>
            )}
            {readout.partial && (
              <div className={s.paceTipPartial} data-testid="pace-readout-partial">
                Still open — not comparable on volume.
              </div>
            )}
          </div>
        )}
        </div>
      )}

      <div className={s.legend}>
        <span><i className={s.dot} style={{ background: "#2fa36b" }} />{period.label}</span>
        {comp?.has
          ? <span><i className={s.dot} style={{ background: "#3f7fd6" }} />{comp.label}</span>
          : <span data-testid="pace-cmp-empty">
              No revenue on record for {comp?.label ?? "the comparison period"} — that comparison is unavailable, not zero.
            </span>}
        {partialIdx.length > 0 && (
          <span data-testid="pace-partial-note">
            <i className={s.dotHollow} />
            Hollow point{partialIdx.length === 1 ? "" : "s"} — still open, not comparable on volume.
          </span>
        )}
      </div>
    </div>
  );
}
