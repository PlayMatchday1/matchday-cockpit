"use client";

/* PLAYER ACTIVITY — signups, bookings and returning players, as tables.
 *
 * Built to scripts/mocks/player-activity-v2.html, which is the spec: its structure, its wording and
 * its `data-testid`s. Its NUMBERS are illustrative and none of them are copied — every figure here
 * comes from /api/lifecycle (monthly) or /api/lifecycle/behavior-weekly (weekly, daily, and the
 * distinct-window aggregate).
 *
 * ── ONE TIME CONTROL ─────────────────────────────────────────────────────────────────────────
 * The period bubbles are gone from this page (SectionFrame period={false}). The range is the SAME
 * control Player Funnel uses — MonthRangeBar, extracted rather than copied — and it is the only
 * thing that says what window is on screen.
 *
 * ── THE THREE TOTALS, WHICH ARE NOT ONE RULE ─────────────────────────────────────────────────
 *   ADDITIVE (registrations, new players, spots) — the sum over the range's MONTHS, through
 *     sumAcrossBuckets, which will not accept anything else. Deliberately computed from months
 *     rather than from the rendered buckets so it is IDENTICAL in Monthly, Weekly and Daily: weeks
 *     straddle month boundaries and summing them would make the same range total differently
 *     depending on which grain you happened to be looking at.
 *   DISTINCT (total players, returning players) — the route's window aggregate, one Set over the
 *     whole window, marked "unique". NEVER a sum of the buckets: that was 86.9% high on Apr-Sep
 *     2026 and read as right because it landed 0.9% from the all-time figure.
 *   RATE (returning player %) — summed returning over summed total across the buckets, marked
 *     "avg". It used to take the LATEST bucket, which answered a different question than the column
 *     header asked.
 *
 * ── AND THE AGGREGATE IS GROUPED ─────────────────────────────────────────────────────────────
 * `windows[0].byCity` / `.byField` carry a distinct count per city and per field. Reading the
 * NETWORK figure for every row is what printed the same 8,955 on all 26 field rows.
 */

import { supabase } from "@/lib/supabase";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { GrowthData, BehaviorPoint } from "@/lib/growthAnalytics";
import { metricValue, isAdditive, sumAcrossBuckets, type GridMetric } from "@/lib/growthMetricGrid";
import { downloadCsv } from "./format";
import { exportBody, exportHeader } from "@/lib/behaviorExport";
import MonthRangeBar, { orderRange, type MonthRange } from "./MonthRangeBar";
import { chicagoToday, isBucketComplete, type Granularity } from "@/lib/weekBuckets";
import styles from "./playerActivity.module.css";

/* ── METRICS ──────────────────────────────────────────────────────────────────────────────────
 * The KEYS are the mock's, because they are what the `data-testid`s are built from. They map onto
 * GridMetric for the actual arithmetic, which is shared with the Data Room and is not duplicated
 * here. `returning` is GridMetric's `recurring`; the label has said "Returning" for a while and the
 * key had not caught up. */
export type PaKey = "registrations" | "newPlayers" | "totalPlayers" | "spots" | "returning" | "returningPct";
type Kind = "add" | "distinct" | "rate";

const GRID_OF: Record<PaKey, GridMetric> = {
  registrations: "registrations", newPlayers: "newPlayers", totalPlayers: "totalPlayers",
  spots: "spots", returning: "recurring", returningPct: "pctRecurring",
};

/* THE DESCRIPTIONS ARE RYAN'S WORDING, VERBATIM, and they are the ONLY copy about what a metric
 * means. They live behind the "i" beside the name — not printed on the page, not a legend, not a
 * footnote. */
const METRICS: { key: PaKey; label: string; kind: Kind; field: boolean; desc: string }[] = [
  { key: "registrations", label: "Registrations", kind: "add", field: false,
    desc: "Completed signups, grouped by city selected at signup." },
  { key: "newPlayers", label: "New players", kind: "add", field: true,
    desc: "Players who played their first MatchDay match." },
  { key: "totalPlayers", label: "Total players", kind: "distinct", field: true,
    desc: "Players who played, counted once per period." },
  { key: "spots", label: "Spots booked", kind: "add", field: true,
    desc: "Total spots booked in matches that took place." },
  { key: "returning", label: "Returning players", kind: "distinct", field: true,
    desc: "Players who played again after an earlier match." },
  { key: "returningPct", label: "Returning player %", kind: "rate", field: true,
    desc: "Percentage of players who were returning." },
];
const M = Object.fromEntries(METRICS.map((m) => [m.key, m])) as Record<PaKey, typeof METRICS[number]>;

/* ── THE SEVEN ACTIVE CITIES ──────────────────────────────────────────────────────────────────
 * The same seven as PAID_MARKETS in lib/adsOverview, spelled the way the growth city vocabulary
 * spells them. Everything else the data carries — El Paso, New York City, Warsaw, Unassigned — is
 * OUTSIDE and appears only behind the toggle. Warsaw is a licensed operator and is still counted in
 * Overall; the toggle governs whether it gets its own ROW, not whether it exists. */
const ACTIVE_CITIES = ["Atlanta", "Austin", "Dallas", "Houston", "OKC", "San Antonio", "St. Louis"];

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const mLabel = (k: string) => `${MON[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`;
const dLabel = (k: string) => `${MON[Number(k.slice(5, 7)) - 1]} ${Number(k.slice(8, 10))}`;
const fmtN = (v: number) => Math.round(v).toLocaleString("en-US");
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** A day string for the first day of a month, and for its last ELAPSED day. */
const monthStart = (m: string) => `${m}-01`;
function monthLastElapsed(m: string, today: string): string {
  const last = new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0).getDate();
  const end = `${m}-${String(last).padStart(2, "0")}`;
  return end > today ? today : end;
}

type WeekPoint = { w: string; registrations: number; newPlayers: number; totalPlayers: number; spots: number };
/** One scope's distinct aggregate over the requested window. */
type WinScope = { registrations: number; newPlayers: number; spots: number; totalPlayers: number; recurring: number };
type WindowAgg = WinScope & { from: string; to: string; byCity: Record<string, WinScope>; byField: Record<string, WinScope> };
type WeeklyPayload = {
  axis: string[];
  overall: WeekPoint[];
  byCity: Record<string, WeekPoint[]>;
  byField?: Record<string, { label: string; city: string; points: WeekPoint[] }>;
  windows?: WindowAgg[];
  window?: { today?: string };
};

type Entity = { type: "overall" | "city" | "field"; id: string; name: string; city?: string };
type Bucket = { id: string; label: string; sub?: string; cur: boolean };
type Group = "overall" | "cities" | "fields" | "compare";
type SortState = { col: string; dir: "asc" | "desc" };

/* ── THE TOOLTIP ──────────────────────────────────────────────────────────────────────────────
 * ONE floating node for the whole page rather than one per "i". Hover, tap and keyboard focus all
 * open it; blur, mouseout, scroll and Escape close it. It is `role="tooltip"`, it is pointer-events
 * none so it can never eat the click that opened it, and there is nothing behind it on the page —
 * the description exists ONLY here. */
function useTip() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const show = useCallback((el: HTMLElement, text: string) => {
    const r = el.getBoundingClientRect();
    setTip({ text, x: r.left + r.width / 2, y: r.bottom + 8 });
  }, []);
  const hide = useCallback(() => setTip(null), []);
  useEffect(() => {
    if (!tip) return;
    const onScroll = () => setTip(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setTip(null); };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("scroll", onScroll, true); window.removeEventListener("keydown", onKey); };
  }, [tip]);
  return { tip, show, hide };
}

/* ── THESE FOUR LIVE AT MODULE SCOPE, AND THAT IS THE BUG FIX, NOT A TIDY-UP ──────────────────
 * They were defined INSIDE PlayerActivityPanel. A component declared in a render body is a NEW
 * FUNCTION REFERENCE on every render, so React treats it as a different component TYPE and unmounts
 * and remounts its whole subtree each time any state changes.
 *
 * FOR THE TOOLTIP THAT IS NOT A PERFORMANCE NOTE, IT IS A BROKEN CONTROL. Hovering an "i" sets
 * state; the re-render destroys the very <span> the pointer is over and mounts a fresh one; the
 * `mouseleave` then never fires on a node that no longer exists, and THE TOOLTIP NEVER CLOSES. It
 * was caught by the acceptance script waiting 30s for it to hide — sixty-three polls, all visible.
 * Hoisted, the span is the same DOM node across renders and hover behaves.
 */
type InfoApi = { open: boolean; show: (el: HTMLElement, text: string) => void; hide: () => void };

function Info({ label, desc, testId, api }: { label: string; desc: string; testId?: string; api: InfoApi }) {
  return (
    <span
      className={styles.info} tabIndex={0} role="button" data-testid={testId}
      aria-label={`What is ${label}?`}
      onMouseEnter={(e) => api.show(e.currentTarget, desc)}
      onMouseLeave={api.hide}
      onFocus={(e) => api.show(e.currentTarget, desc)}
      onBlur={api.hide}
      onClick={(e) => { e.stopPropagation(); api.open ? api.hide() : api.show(e.currentTarget, desc); }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); api.open ? api.hide() : api.show(e.currentTarget, desc); } }}
    >i</span>
  );
}

/* ── A FEW BARE CLASSNAMES RIDE ALONGSIDE THE CSS-MODULE ONES, ON PURPOSE ────────────────────
 * `sortable`, `si`, `name`, `city`, `cc` and `rank` are unstyled and unhashed. The acceptance
 * script (scripts/mocks/player-activity-v2.assert.mjs) selects on them exactly as the mock does —
 * `th.sortable .si`, `tbody .city`, `pa-row-soccer-central .name`, `pa-compare-cards .cc`. CSS
 * Modules rewrites `styles.city` to `playerActivity-module__hash__city`, which none of those
 * selectors can find, so without these the suite cannot address the structure it is checking.
 * THEY CARRY NO STYLES — every rule lives on the hashed class beside them — so deleting one breaks
 * the suite and changes nothing on screen, which is the failure mode worth naming here. */
type ThApi = { sortFor: (k: string) => SortState; onSort: (k: string, c: string) => void; grain: Granularity };

function Th({ inner, col, sortKey, cls, api }: {
  inner: ReactNode; col: string; sortKey?: string; cls?: string; api: ThApi;
}) {
  if (!sortKey) return <th className={cls} data-col={col}>{inner}</th>;
  const st = api.sortFor(sortKey);
  const on = st.col === col;
  return (
    <th
      className={`${styles.sortable} sortable ${cls ?? ""} ${on ? styles.sorted : ""}`}
      data-col={col} data-sortkey={sortKey}
      aria-sort={on ? (st.dir === "desc" ? "descending" : "ascending") : "none"}
      tabIndex={0} title="Sort by this column"
      data-testid={`pa-sort-${sortKey}-${col}`}
      onClick={() => api.onSort(sortKey, col)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); api.onSort(sortKey, col); } }}
    >
      <span className={styles.sh}>
        {inner}
        {/* ARROWS ARE ALWAYS VISIBLE, both of them, so a sortable column is legible as sortable
            before anyone clicks it. The active one is highlighted by `aria-sort` and the tint. */}
        <span className={`${styles.si} si`} aria-hidden="true"><span className={styles.u}>&#9650;</span><span className={styles.d}>&#9660;</span></span>
      </span>
    </th>
  );
}

function BucketTh({ b, sortKey, api }: { b: Bucket; sortKey?: string; api: ThApi }) {
  return (
    <Th
      col={b.id} sortKey={sortKey} cls={b.cur ? styles.cur : undefined} api={api}
      inner={<>
        {b.sub && api.grain !== "monthly" && <span className={styles.ip}>{b.sub}</span>}
        {b.label}
        {b.cur && <span className={styles.ip}>IN PROGRESS</span>}
      </>}
    />
  );
}

type Change = { v: number; pts: boolean; nA: boolean; isNew: boolean };
const changeText = (c: Change) =>
  c.nA ? "n/a" : c.isNew ? "new" : c.pts
    ? `${c.v > 0 ? "+" : ""}${c.v.toFixed(1)} pts`
    : `${c.v > 0 ? "+" : ""}${c.v.toFixed(1)}%`;

function ChangeCell({ c }: { c: Change }) {
  if (c.nA) return <span className={styles.zero}>n/a</span>;
  if (c.isNew) return <span className={`${styles.pill} ${styles.up}`}>new</span>;
  const dir = Math.abs(c.v) < 0.05 ? styles.flat : c.v > 0 ? styles.up : styles.down;
  return <span className={`${styles.pill} ${dir}`}>{changeText(c)}</span>;
}

export default function PlayerActivityPanel({ data, months }: { data: GrowthData; months: string[] }) {
  const { tip, show, hide } = useTip();
  const tipOpen = tip !== null;
  /** Bound once per render and handed to the module-scope <Info>; see the note on that component. */
  const infoApi: InfoApi = { open: tipOpen, show, hide };

  const today = chicagoToday();
  const curMonth = today.slice(0, 7);
  /* THE AXIS IS CLAMPED TO THE CURRENT BUSINESS MONTH. growth_play_dims carries BOOKED matches, so
   * the provider's month list runs into the future and a picker must not offer a month there can be
   * no data for. */
  const axisMonths = useMemo(() => months.filter((m) => m <= curMonth), [months, curMonth]);
  const first = axisMonths[0] ?? curMonth;
  const last = axisMonths[axisMonths.length - 1] ?? curMonth;

  /* ── THE DEFAULT: THE LAST SIX MONTHS ENDING IN THE CURRENT MONTH ────────────────────────────
   * The current month is INCLUDED and is marked in progress. That is this page's own rule and the
   * reason it does not use the shared defaultPeriod, which filters to completed months: the change
   * column here compares the last two COMPLETE buckets, so a partial column at the right edge
   * cannot be mistaken for a collapse. */
  const defaultStart = axisMonths[Math.max(0, axisMonths.length - 6)] ?? first;
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [grain, setGrain] = useState<Granularity>("monthly");
  const [group, setGroup] = useState<Group>("overall");
  const [metrics, setMetrics] = useState<PaKey[]>(["spots"]);
  const [cityFilter, setCityFilter] = useState("all");
  const [showInactive, setShowInactive] = useState(false);
  const [showOutside, setShowOutside] = useState(false);
  const [cmpA, setCmpA] = useState("Austin");
  const [cmpB, setCmpB] = useState("Houston");
  const [sort, setSort] = useState<Record<string, SortState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const range: MonthRange = useMemo(() => {
    const r = orderRange(from || defaultStart, to || last);
    // THE END NEVER RUNS PAST THE CURRENT BUSINESS MONTH.
    return { start: r.start, end: r.end > last ? last : r.end };
  }, [from, to, defaultStart, last]);

  /* DAILY IS ONE MONTH: the To month. 180 day columns is not a table anyone reads, and the route
   * caps it anyway — collapsing it HERE is what makes the cap visible rather than mysterious. */
  const effRange: MonthRange = grain === "daily" ? { start: range.end, end: range.end } : range;
  const rangeMonths = useMemo(
    () => axisMonths.filter((m) => m >= effRange.start && m <= effRange.end),
    [axisMonths, effRange.start, effRange.end],
  );

  /* ── THE WEEKLY / DAILY PAYLOAD ──────────────────────────────────────────────────────────────
   * Monthly reads the provider's data and fetches nothing. */
  const [weekly, setWeekly] = useState<WeeklyPayload | null>(null);
  const [weeklyErr, setWeeklyErr] = useState<string | null>(null);
  const cache = useRef(new Map<string, WeeklyPayload>());
  /* THE CACHE KEY CARRIES THE GRAIN. Without it, switching weekly → daily over one window served
   * the weekly payload out of cache and rendered week sums in day columns. */
  const winKey = `${grain}:${effRange.start}:${effRange.end}`;

  /* ── THE DISTINCT WINDOW, AS DAYS ────────────────────────────────────────────────────────────
   * One window: the displayed period. The CHANGE column does not need its own — it compares two
   * complete BUCKETS, and a per-bucket distinct count is already correct; only a count over a RANGE
   * cannot be derived from buckets. */
  const winSpec = useMemo(() => {
    if (!rangeMonths.length) return "";
    const f = monthStart(rangeMonths[0]);
    const t = monthLastElapsed(rangeMonths[rangeMonths.length - 1], today);
    return f <= t ? `${f}:${t}` : "";
  }, [rangeMonths, today]);

  const [winAgg, setWinAgg] = useState<WindowAgg | null>(null);
  const [winErr, setWinErr] = useState<string | null>(null);

  /* ── ONE FETCH, SERVING BOTH THE AXIS AND THE AGGREGATE ──────────────────────────────────────
   * ── AND THE FIX FOR THE STALL ────────────────────────────────────────────────────────────────
   * The aggregate used to be its OWN effect reading the provider's `g.authHeaders`, and it never
   * returned from its first `await`. Two things were wrong with that and they compounded:
   *
   *   1. `authHeaders` IS AN OBJECT IDENTITY IN A DEPENDENCY ARRAY. The provider hands down a fresh
   *      `{ Authorization }` and the effect listed it as a dep, so every render re-ran the effect
   *      and the cleanup set `dead = true` on the run that was still in flight. Nothing after the
   *      await could ever commit, which is EXACTLY the symptom, and it is why neither the success
   *      nor the failure branch was reached.
   *   2. The panel's OTHER fetch had already been switched to `authHeaders` once and 401'd, and the
   *      note left behind concluded "getSession was never what was wrong". That is true, and the
   *      half it did not draw is the load-bearing one: the working fetch is the one using
   *      getSession(), so the aggregate should use getSession() too.
   *
   * SO BOTH READS ARE ONE REQUEST ON ONE AUTH PATH, with STRING dependencies only. There is no
   * object in the dep array, which is what makes it impossible for this to churn again. */
  useEffect(() => {
    const needAxis = grain !== "monthly";
    if (!needAxis && !winSpec) { setWinAgg(null); return; }
    const key = `${winKey}|${winSpec}`;
    const cached = cache.current.get(key);
    if (cached) {
      setWeekly(needAxis ? cached : null); setWeeklyErr(null);
      setWinAgg(cached.windows?.[0] ?? null); setWinErr(null);
      return;
    }
    let dead = false;
    /* CLEARED FIRST. Without this the previous window's table stays on screen under the new
     * window's heading while the new read is in flight, and nothing says so. */
    setWeekly(null); setWeeklyErr(null); setWinAgg(null); setWinErr(null);
    (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        /* MONTHLY STILL ASKS FOR AN AXIS, the cheapest one it can — a single month at day grain —
         * because the route needs SOME axis and the windows carry their own bounds. Monthly throws
         * that axis away and keeps only `windows[0]`. */
        const g = needAxis ? grain : "daily";
        const s = needAxis ? effRange.start : effRange.end;
        const res = await fetch(
          `/api/lifecycle/behavior-weekly?grain=${g}`
            + `&start=${encodeURIComponent(s)}&end=${encodeURIComponent(effRange.end)}`
            + (winSpec ? `&windows=${encodeURIComponent(winSpec)}` : ""),
          { cache: "no-store", headers: token ? { Authorization: `Bearer ${token}` } : {} },
        );
        const j = await res.json();
        if (!res.ok) throw new Error(j?.error ?? `HTTP ${res.status}`);
        if (dead) return;
        const payload = j as WeeklyPayload;
        cache.current.set(key, payload);
        setWeekly(needAxis ? payload : null);
        setWinAgg(payload.windows?.[0] ?? null);
      } catch (e) {
        // A FAILED READ IS AN ERROR, never an empty table — the two look identical otherwise.
        const msg = e instanceof Error ? e.message : String(e);
        if (dead) return;
        if (needAxis) setWeeklyErr(msg);
        setWinErr(msg);
      }
    })();
    return () => { dead = true; };
  }, [grain, winKey, winSpec, effRange.start, effRange.end]);

  /* ── THE BUCKETS ─────────────────────────────────────────────────────────────────────────────*/
  const payloadToday = weekly?.window?.today ?? today;
  const buckets: Bucket[] = useMemo(() => {
    if (grain === "monthly") {
      return rangeMonths.map((m) => ({ id: m, label: mLabel(m), cur: !isBucketComplete(m, payloadToday, "monthly") }));
    }
    const ax = weekly?.axis ?? [];
    return ax.map((k) => ({
      id: k,
      label: grain === "daily" ? dLabel(k) : dLabel(k),
      sub: grain === "weekly" ? "WK OF" : MON.length ? "SMTWTFS"[new Date(`${k}T12:00:00`).getDay()] : undefined,
      cur: !isBucketComplete(k, payloadToday, grain),
    }));
  }, [grain, rangeMonths, weekly, payloadToday]);

  /* ── THE DATA INDEX ──────────────────────────────────────────────────────────────────────────
   * Monthly reads the provider's monthly series; weekly and daily read the fetched payload. Both
   * wear the same shape, so everything below this line is grain-agnostic. */
  const index = useMemo(() => {
    const pt = (p: WeekPoint): BehaviorPoint => ({
      m: p.w, registrations: p.registrations, newPlayers: p.newPlayers,
      totalPlayers: p.totalPlayers, spots: p.spots,
    });
    if (grain === "monthly") {
      const byField: Record<string, { label: string; city: string; points: BehaviorPoint[] }> = {};
      for (const [f, v] of Object.entries(data.behaviorByField)) byField[f] = v;
      return { overall: data.behaviorOverall, byCity: data.behaviorByCity, byField };
    }
    const byCity: Record<string, BehaviorPoint[]> = {};
    for (const [c, ps] of Object.entries(weekly?.byCity ?? {})) byCity[c] = ps.map(pt);
    const byField: Record<string, { label: string; city: string; points: BehaviorPoint[] }> = {};
    for (const [f, v] of Object.entries(weekly?.byField ?? {})) {
      byField[f] = { label: v.label, city: v.city, points: v.points.map(pt) };
    }
    return { overall: (weekly?.overall ?? []).map(pt), byCity, byField };
  }, [grain, data, weekly]);

  const pointsOf = useCallback((e: Entity): BehaviorPoint[] => {
    if (e.type === "overall") return index.overall;
    if (e.type === "city") return index.byCity[e.id] ?? [];
    return index.byField[e.id]?.points ?? [];
  }, [index]);

  const mapOf = useCallback((e: Entity) => {
    const m = new Map<string, BehaviorPoint>();
    for (const p of pointsOf(e)) m.set(p.m, p);
    return m;
  }, [pointsOf]);

  /** One cell. Registrations have no field dimension and read as a dash there, never a zero. */
  const cellVal = useCallback((idx: Map<string, BehaviorPoint>, e: Entity, k: PaKey, b: string): number | null => {
    if (k === "registrations" && e.type === "field") return null;
    return metricValue(idx.get(b), GRID_OF[k]);
  }, []);

  /** The scope's distinct aggregate, or null when it has not arrived / does not exist. */
  const winScope = useCallback((e: Entity): WinScope | null => {
    if (!winAgg) return null;
    if (e.type === "overall") return winAgg;
    /* A CITY OR FIELD WITH NO ROWS IN THE WINDOW IS A GENUINE ZERO, not a missing aggregate. The
     * route only emits keys it saw, so an absent key here means "nobody played", and a zeroed scope
     * is the honest reading — as against `null`, which would print a dash and imply we do not know. */
    const g = e.type === "city" ? winAgg.byCity : winAgg.byField;
    return g?.[e.id] ?? { registrations: 0, newPlayers: 0, spots: 0, totalPlayers: 0, recurring: 0 };
  }, [winAgg]);

  /* ── THE PERIOD TOTAL ────────────────────────────────────────────────────────────────────────
   * Three rules, and the whole point is that they are three. See the file header. */
  const totalOf = useCallback((e: Entity, k: PaKey, cells: (number | null)[]): number | null => {
    if (k === "registrations" && e.type === "field") return null;
    const kind = M[k].kind;
    if (kind === "add") {
      /* FROM THE MONTHS, NOT FROM THE RENDERED BUCKETS, so the grain cannot change the total.
       * sumAcrossBuckets accepts AdditiveMetric and nothing else — a distinct key here is a compile
       * error rather than a number that is 87% too high. */
      const gm = GRID_OF[k];
      if (!isAdditive(gm)) return null;
      const idx = new Map<string, BehaviorPoint>();
      const src = e.type === "overall" ? data.behaviorOverall
        : e.type === "city" ? data.behaviorByCity[e.id] ?? []
          : data.behaviorByField[e.id]?.points ?? [];
      for (const p of src) idx.set(p.m, p);
      return sumAcrossBuckets(gm, rangeMonths.map((m) => metricValue(idx.get(m), gm)));
    }
    if (kind === "distinct") {
      const w = winScope(e);
      if (!w) return null; // A DASH, never a fallback to the sum. The sum is the wrong number.
      return k === "totalPlayers" ? w.totalPlayers : w.recurring;
    }
    /* THE RATE: summed returning over summed total ACROSS THE BUCKETS. It used to take the latest
     * bucket, which answers "how was last month" under a header that says "the period". */
    void cells;
    let r = 0, t = 0;
    const idx = mapOf(e);
    for (const b of buckets) {
      const tp = metricValue(idx.get(b.id), "totalPlayers");
      const rc = metricValue(idx.get(b.id), "recurring");
      if (tp != null) t += tp;
      if (rc != null) r += rc;
    }
    return t ? (r / t) * 100 : null;
  }, [data, rangeMonths, winScope, mapOf, buckets]);

  /* ── THE CHANGE: THE LAST TWO COMPLETE BUCKETS, NAMED IN THE HEADER ──────────────────────────
   * Not the last two cells. On the 1st of a month that compares one day against a whole month and
   * reports a collapse that has not happened. */
  const cmpPair = useMemo(() => {
    const done = buckets.map((b, i) => ({ b, i })).filter((x) => !x.b.cur);
    if (done.length < 2) return null;
    return { prev: done[done.length - 2], last: done[done.length - 1] };
  }, [buckets]);

  const changeHead = cmpPair
    ? `${cmpPair.last.b.label} vs ${cmpPair.prev.b.label}`
    : `needs two complete ${grain === "monthly" ? "month" : grain === "weekly" ? "week" : "day"}s`;

  /** Percent for a count, POINTS for a rate. Reporting a rate's relative move overstates it. */
  const changeOf = (k: PaKey, cells: (number | null)[]): Change => {
    if (!cmpPair) return { v: 0, pts: false, nA: true, isNew: false };
    const a = cells[cmpPair.last.i], b = cells[cmpPair.prev.i];
    if (a == null || b == null) return { v: 0, pts: false, nA: true, isNew: false };
    if (M[k].kind === "rate") return { v: a - b, pts: true, nA: false, isNew: false };
    // ZERO TO ZERO IS "n/a", not 0% and not "new". Nothing happened either time.
    if (b === 0) return a === 0 ? { v: 0, pts: false, nA: true, isNew: false } : { v: 0, pts: false, nA: false, isNew: true };
    return { v: ((a - b) / b) * 100, pts: false, nA: false, isNew: false };
  };

  const fmtVal = (k: PaKey, v: number | null): string =>
    v == null ? "—" : k === "returningPct" ? `${v.toFixed(1)}%` : fmtN(v);

  /* ── ENTITIES ────────────────────────────────────────────────────────────────────────────────*/
  const allCities = useMemo(() => {
    const present = new Set([...Object.keys(index.byCity), ...ACTIVE_CITIES]);
    const active = ACTIVE_CITIES.filter((c) => present.has(c));
    const outside = [...present].filter((c) => !ACTIVE_CITIES.includes(c)).sort();
    return { active, outside };
  }, [index.byCity]);

  const cityEntities = useMemo<Entity[]>(
    () => (showOutside ? [...allCities.active, ...allCities.outside] : allCities.active)
      .map((c) => ({ type: "city" as const, id: c, name: c })),
    [showOutside, allCities],
  );

  const fieldEntities = useMemo<Entity[]>(() => {
    const all = Object.entries(index.byField)
      .map(([id, v]) => ({ type: "field" as const, id, name: v.label || id, city: v.city }))
      .filter((e) => cityFilter === "all" || e.city === cityFilter);
    if (showInactive) return all.sort((a, b) => a.name.localeCompare(b.name));
    /* ACTIVITY IS ANY PLAYER IN ANY RENDERED BUCKET. Filtering on spots alone would drop a pitch
     * that had players and no booking rows, and the toggle exists precisely so the quiet ones are
     * available rather than invisible. */
    return all.filter((e) => {
      const idx = mapOf(e);
      return buckets.some((b) => (metricValue(idx.get(b.id), "totalPlayers") ?? 0) > 0);
    }).sort((a, b) => a.name.localeCompare(b.name));
  }, [index.byField, cityFilter, showInactive, mapOf, buckets]);

  const fieldCities = useMemo(() => {
    const s = new Set<string>();
    for (const v of Object.values(index.byField)) if (v.city) s.add(v.city);
    return [...s].sort();
  }, [index.byField]);

  /* ── SORTING ─────────────────────────────────────────────────────────────────────────────────*/
  const sortFor = (key: string): SortState => sort[key] ?? { col: "total", dir: "desc" };
  const onSort = (key: string, col: string) =>
    setSort((s) => {
      const cur = s[key] ?? { col: "total", dir: "desc" as const };
      return { ...s, [key]: cur.col === col
        ? { col, dir: cur.dir === "desc" ? "asc" : "desc" }
        : { col, dir: col === "name" ? "asc" : "desc" } };
    });

  const toggleExpand = (k: string) =>
    setExpanded((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  /* ── EXPORT ──────────────────────────────────────────────────────────────────────────────────
   * Built from exportHeader / exportBody, the same pure functions the gate asserts against, and fed
   * the rows the table ALREADY rendered rather than a second computation. A second computation is
   * what once shipped a right number on screen and a wrong one in the file. */
  const onExport = () => {
    const rows: { name: string; cells: number[]; total: number; mom: number; points?: boolean }[] = [];
    const push = (e: Entity, k: PaKey, name: string) => {
      const idx = mapOf(e);
      const cells = buckets.map((b) => cellVal(idx, e, k, b.id));
      const c = changeOf(k, cells);
      rows.push({
        name, cells: cells.map((v) => v ?? 0), total: totalOf(e, k, cells) ?? 0,
        mom: c.nA ? 0 : c.v, points: M[k].kind === "rate",
      });
    };
    if (group === "overall") for (const m of METRICS) push({ type: "overall", id: "overall", name: "Overall" }, m.key, m.label);
    else if (group === "compare") {
      for (const m of METRICS) for (const c of [cmpA, cmpB]) push({ type: "city", id: c, name: c }, m.key, `${m.label} — ${c}`);
    } else {
      const ents = group === "cities" ? cityEntities : fieldEntities;
      for (const k of metrics) for (const e of ents) push(e, k, `${M[k].label} — ${e.name}`);
    }
    const head = exportHeader({
      firstColHead: group === "overall" ? "Metric" : group === "fields" ? "Field" : "City",
      bucketLabels: buckets.map((b) => b.label),
      complete: buckets.map((b) => !b.cur),
      changeHead,
    });
    downloadCsv(`player-activity-${grain}-${effRange.start}-to-${effRange.end}.csv`, [head, ...exportBody(rows)]);
  };

  /* ── SHARED RENDER BITS ──────────────────────────────────────────────────────────────────────*/
  /* Th / BucketTh / ChangeCell / Info ARE MODULE-SCOPE COMPONENTS, deliberately — see the note
   * above Info. These three lines are the only state they need. */
  const thApi: ThApi = { sortFor, onSort, grain };
  const unitTag = (k: PaKey) =>
    M[k].kind === "distinct" ? <span className={styles.u}>unique</span>
      : M[k].kind === "rate" ? <span className={styles.u}>avg</span> : null;

  /* ── OVERALL ─────────────────────────────────────────────────────────────────────────────────
   * Metrics are the ROWS here, so there is nothing to sort: no `aria-sort`, no arrows. */
  const renderOverall = () => {
    const e: Entity = { type: "overall", id: "overall", name: "All of MatchDay" };
    const idx = mapOf(e);
    return (
      <div className={styles.section} data-testid="pa-section-overall">
        <div className={styles.sechead}>
          <h3>All of MatchDay</h3>
          <span className={styles.meta}>{buckets.length} {grain === "monthly" ? "months" : grain === "weekly" ? "weeks" : "days"}</span>
        </div>
        <div className={styles.tw}>
          <table data-testid="pa-table-overall">
            <thead><tr>
              <th>Metric</th>
              {buckets.map((b) => <BucketTh key={b.id} b={b} api={thApi} />)}
              <th className={styles.tot}>Period total</th>
              <th className={styles.chg}>Change<span className={styles.ip}>{changeHead}</span></th>
            </tr></thead>
            <tbody>
              {METRICS.map((m) => {
                const cells = buckets.map((b) => cellVal(idx, e, m.key, b.id));
                const t = totalOf(e, m.key, cells);
                return (
                  <tr key={m.key} data-testid={`pa-row-${m.key}`}>
                    <td className={styles.metricName}>{m.label}<Info api={infoApi} label={m.label} desc={m.desc} testId={`pa-info-${m.key}`} /></td>
                    {cells.map((v, i) => (
                      <td key={buckets[i].id} className={buckets[i].cur ? styles.cur : undefined}>
                        {v === 0 ? <span className={styles.zero}>0</span> : fmtVal(m.key, v)}
                      </td>
                    ))}
                    <td className={styles.tot} data-testid={`pa-total-${m.key}`}>
                      {t == null && M[m.key].kind === "distinct"
                        // AN HONEST ABSENCE, with the reason on it. Never the sum.
                        ? <span title={winErr ? `Unique count unavailable: ${winErr}` : "Unique count is still loading"}>—</span>
                        : fmtVal(m.key, t)}
                      {t != null && unitTag(m.key)}
                    </td>
                    <td className={styles.chg}><ChangeCell c={changeOf(m.key, cells)} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  /* ── CITIES / FIELDS: ONE SECTION PER SELECTED METRIC ────────────────────────────────────────*/
  const renderEntitySection = (k: PaKey) => {
    const isField = group === "fields";
    const ents = isField ? fieldEntities : cityEntities;
    const st = sortFor(k);
    const rows = ents.map((e) => {
      const idx = mapOf(e);
      const cells = buckets.map((b) => cellVal(idx, e, k, b.id));
      return { e, cells, total: totalOf(e, k, cells), ch: changeOf(k, cells) };
    });
    const sv = (r: typeof rows[number]): number | string => {
      if (st.col === "name") return r.e.name;
      if (st.col === "total") return r.total ?? -Infinity;
      if (st.col === "change") return r.ch.nA ? -Infinity : r.ch.isNew ? Infinity : r.ch.v;
      const i = buckets.findIndex((b) => b.id === st.col);
      return i < 0 ? -Infinity : r.cells[i] ?? -Infinity;
    };
    rows.sort((x, y) => {
      const a = sv(x), b = sv(y);
      const c = typeof a === "string" ? a.localeCompare(b as string) : (a as number) - (b as number);
      return st.dir === "desc" ? -c : c;
    });
    const colName = st.col === "name" ? (isField ? "Field" : "City")
      : st.col === "total" ? "Period total"
        : st.col === "change" ? "Change"
          : buckets.find((b) => b.id === st.col)?.label ?? st.col;
    const dirWord = st.col === "name"
      ? (st.dir === "desc" ? "Z to A" : "A to Z")
      : (st.dir === "desc" ? "high to low" : "low to high");
    // A FIELD HAS FIVE METRICS, A CITY SIX. Registrations have no pitch.
    const detailMetrics = METRICS.filter((m) => !isField || m.field);

    return (
      <div key={k} className={styles.section} data-testid={`pa-section-${k}`}>
        <div className={styles.sechead}>
          <h3>{M[k].label}<Info api={infoApi} label={M[k].label} desc={M[k].desc} testId={`pa-info-section-${k}`} /></h3>
          <span className={styles.meta} data-testid={`pa-count-${k}`}>
            {ents.length} {isField ? "fields" : "cities"}{isField && !showInactive ? " with activity" : ""}
          </span>
          {/* THE SORT STATE IN WORDS. An arrow says which way; only this says what by. */}
          <span className={styles.sortnote} data-testid={`pa-sortnote-${k}`}>
            Sorted by <b>{colName}</b>, {dirWord}. Click a header to sort, a row to see all its metrics.
          </span>
        </div>
        <div className={styles.tw}>
          <table data-testid={`pa-table-${k}`}>
            <thead><tr>
              <Th api={thApi} inner={isField ? "Field" : "City"} col="name" sortKey={k} />
              {buckets.map((b) => <BucketTh key={b.id} b={b} sortKey={k} api={thApi} />)}
              <Th api={thApi} inner="Period total" col="total" sortKey={k} cls={styles.tot} />
              <Th api={thApi} inner={<>Change<span className={styles.ip}>{changeHead}</span></>} col="change" sortKey={k} cls={styles.chg} />
            </tr></thead>
            <tbody>
              {rows.map((r, i) => {
                const s = slug(r.e.id);
                const exKey = `${k}|${r.e.id}`;
                const open = expanded.has(exKey);
                const sc = (c: string) => (st.col === c ? ` ${styles.sorted}` : "");
                return (
                  <Fragment key={r.e.id}>
                    <tr
                      data-testid={`pa-row-${s}`} data-row data-expand={exKey}
                      aria-expanded={open} tabIndex={0} title={`Show all metrics for ${r.e.name}`}
                      onClick={() => toggleExpand(exKey)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleExpand(exKey); } }}
                    >
                      <td className={`${styles.nameCell}${sc("name")}`}>
                        <span className={`${styles.caret} ${open ? styles.caretOpen : ""}`} aria-hidden="true">▶</span>
                        <span className={`${styles.rank} rank`}>{i + 1}</span>
                        <span className={`${styles.name} name`}>
                          {r.e.name}
                          {isField && <span className={`${styles.city} city`}>{r.e.city}</span>}
                        </span>
                      </td>
                      {r.cells.map((v, ci) => (
                        <td key={buckets[ci].id} data-col={buckets[ci].id}
                          className={`${buckets[ci].cur ? styles.cur : ""}${sc(buckets[ci].id)}`}>
                          {v === 0 ? <span className={styles.zero}>0</span> : fmtVal(k, v)}
                        </td>
                      ))}
                      <td className={`${styles.tot}${sc("total")}`} data-col="total">
                        {r.total == null && M[k].kind === "distinct"
                          ? <span title={winErr ? `Unique count unavailable: ${winErr}` : "Unique count is still loading"}>—</span>
                          : fmtVal(k, r.total)}
                        {r.total != null && unitTag(k)}
                      </td>
                      <td className={`${styles.chg}${sc("change")}`}><ChangeCell c={r.ch} /></td>
                    </tr>
                    {/* ── THE DETAIL ROWS ─────────────────────────────────────────────────────
                        They are rendered INSIDE the parent's Fragment, so they travel with it
                        through a re-sort and can never be sorted away from the row they belong to.
                        They are also not in `rows`, so they cannot affect the order. */}
                    {open && detailMetrics.map((dm) => {
                      const idx = mapOf(r.e);
                      const dcells = buckets.map((b) => cellVal(idx, r.e, dm.key, b.id));
                      const dt = totalOf(r.e, dm.key, dcells);
                      return (
                        <tr key={dm.key} className={`${styles.detail} ${dm.key === k ? styles.curMetric : ""}`}
                          data-detail data-testid={`pa-detail-${k}-${s}-${dm.key}`}>
                          <td>{dm.label}<Info api={infoApi} label={dm.label} desc={dm.desc} /></td>
                          {dcells.map((v, ci) => (
                            <td key={buckets[ci].id} className={buckets[ci].cur ? styles.cur : undefined}>
                              {v === 0 ? <span className={styles.zero}>0</span> : fmtVal(dm.key, v)}
                            </td>
                          ))}
                          <td className={styles.tot} data-dtotal>
                            {dt == null && M[dm.key].kind === "distinct"
                              ? <span title={winErr ? `Unique count unavailable: ${winErr}` : "Unique count is still loading"}>—</span>
                              : fmtVal(dm.key, dt)}
                            {dt != null && unitTag(dm.key)}
                          </td>
                          <td className={styles.chg}><ChangeCell c={changeOf(dm.key, dcells)} /></td>
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  /* ── COMPARE ─────────────────────────────────────────────────────────────────────────────────*/
  const renderCompare = () => {
    const A: Entity = { type: "city", id: cmpA, name: cmpA };
    const B: Entity = { type: "city", id: cmpB, name: cmpB };
    const iA = mapOf(A), iB = mapOf(B);
    const cellsOf = (e: Entity, idx: Map<string, BehaviorPoint>, k: PaKey) => buckets.map((b) => cellVal(idx, e, k, b.id));
    /* THE GAP: PERCENT for a count, POINTS for a rate — the same distinction the change column
     * makes, for the same reason. */
    const gap = (k: PaKey, a: number | null, b: number | null): ReactNode => {
      if (a == null || b == null) return "";
      if (M[k].kind === "rate") {
        const d = a - b;
        return Math.abs(d) < 0.05 ? "level"
          : <span className={`${styles.gapv} ${d > 0 ? styles.gA : styles.gB}`}>{d > 0 ? "+" : ""}{d.toFixed(1)} pts</span>;
      }
      if (a === b) return "level";
      if (!b) return <span className={`${styles.gapv} ${styles.gA}`}>{cmpA} only</span>;
      if (!a) return <span className={`${styles.gapv} ${styles.gB}`}>{cmpB} only</span>;
      const d = ((a - b) / b) * 100;
      return <span className={`${styles.gapv} ${d > 0 ? styles.gA : styles.gB}`}>{d > 0 ? "+" : ""}{d.toFixed(0)}%</span>;
    };
    return (
      <div className={styles.section} data-testid="pa-section-compare">
        <div className={styles.sechead}>
          <h3><span className={styles.swA} />{cmpA} vs <span className={styles.swB} />{cmpB}</h3>
          <span className={styles.meta}>
            {grain === "daily" ? mLabel(effRange.end) : `${mLabel(effRange.start)} to ${mLabel(effRange.end)}`}
          </span>
        </div>
        <div className={styles.cards} data-testid="pa-compare-cards">
          {METRICS.map((m) => {
            const ta = totalOf(A, m.key, cellsOf(A, iA, m.key));
            const tb = totalOf(B, m.key, cellsOf(B, iB, m.key));
            const mx = Math.max(ta ?? 0, tb ?? 0) || 1;
            let lead: ReactNode = "Level";
            if (ta != null && tb != null) {
              if (m.kind === "rate") {
                const d = ta - tb;
                lead = Math.abs(d) < 0.05 ? "Level"
                  : <><b className={d > 0 ? styles.tA : styles.tB}>{d > 0 ? cmpA : cmpB}</b> higher by {Math.abs(d).toFixed(1)} pts</>;
              } else if (ta === tb) lead = "Level";
              else {
                const lo = Math.min(ta, tb), hi = Math.max(ta, tb);
                lead = lo === 0
                  ? <><b className={ta > tb ? styles.tA : styles.tB}>{ta > tb ? cmpA : cmpB}</b> only</>
                  : <><b className={ta > tb ? styles.tA : styles.tB}>{ta > tb ? cmpA : cmpB}</b> ahead by {(((hi - lo) / lo) * 100).toFixed(0)}%</>;
              }
            }
            return (
              <div key={m.key} className={`${styles.cc} cc`} data-testid={`pa-compare-card-${m.key}`}>
                <h4>{m.label}<Info api={infoApi} label={m.label} desc={m.desc} /></h4>
                <div className={styles.bar}>
                  <span className={styles.bn}>{cmpA}</span>
                  <div className={styles.trk}><div className={styles.fillA} style={{ width: `${((ta ?? 0) / mx) * 100}%` }} /></div>
                  <span data-testid={`pa-compare-a-${m.key}`}>{fmtVal(m.key, ta)}</span>
                </div>
                <div className={styles.bar}>
                  <span className={styles.bn}>{cmpB}</span>
                  <div className={styles.trk}><div className={styles.fillB} style={{ width: `${((tb ?? 0) / mx) * 100}%` }} /></div>
                  <span data-testid={`pa-compare-b-${m.key}`}>{fmtVal(m.key, tb)}</span>
                </div>
                <div className={styles.lead}>{lead}</div>
              </div>
            );
          })}
        </div>
        <div className={styles.tw}>
          <table data-testid="pa-table-compare">
            <thead><tr>
              <th>Metric</th>
              {buckets.map((b) => <BucketTh key={b.id} b={b} api={thApi} />)}
              <th className={styles.tot}>Period total</th>
              <th className={styles.chg}>Change<span className={styles.ip}>{changeHead}</span></th>
            </tr></thead>
            <tbody>
              {METRICS.map((m) => {
                const ca = cellsOf(A, iA, m.key), cb = cellsOf(B, iB, m.key);
                const ta = totalOf(A, m.key, ca), tb = totalOf(B, m.key, cb);
                return (
                  <Fragment key={m.key}>
                    <tr className={styles.grp}>
                      <td>{m.label}<Info api={infoApi} label={m.label} desc={m.desc} /></td>
                      {buckets.map((b) => <td key={b.id} />)}
                      <td className={styles.tot} /><td />
                    </tr>
                    {([[A, ca, ta, "a"], [B, cb, tb, "b"]] as const).map(([e, cells, t, side]) => (
                      <tr key={side} data-testid={`pa-cmp-${m.key}-${side}`}>
                        <td><span className={side === "a" ? styles.swA : styles.swB} />{e.name}</td>
                        {cells.map((v, ci) => (
                          <td key={buckets[ci].id} className={buckets[ci].cur ? styles.cur : undefined}>
                            {v === 0 ? <span className={styles.zero}>0</span> : fmtVal(m.key, v)}
                          </td>
                        ))}
                        <td className={styles.tot}>{fmtVal(m.key, t)}{t != null && unitTag(m.key)}</td>
                        <td className={styles.chg}><ChangeCell c={changeOf(m.key, cells)} /></td>
                      </tr>
                    ))}
                    <tr className={styles.gap} data-testid={`pa-cmp-${m.key}-gap`}>
                      <td>{cmpA} vs {cmpB}</td>
                      {buckets.map((b, ci) => <td key={b.id}>{gap(m.key, ca[ci], cb[ci])}</td>)}
                      <td className={styles.tot}>{gap(m.key, ta, tb)}</td>
                      <td />
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  /* ── CONTROLS ────────────────────────────────────────────────────────────────────────────────*/
  const compareOptions = [...allCities.active, ...allCities.outside];
  const onGroup = (gp: Group) => {
    setGroup(gp);
    // FIELDS CANNOT SHOW REGISTRATIONS, so a selection carried in from Cities is filtered, and the
    // "at least one" rule is restored rather than leaving an empty view.
    if (gp === "fields") setMetrics((ms) => { const f = ms.filter((x) => M[x].field); return f.length ? f : ["spots"]; });
  };
  const onMetricChip = (k: PaKey) =>
    setMetrics((ms) => ms.includes(k)
      // AT LEAST ONE IS ALWAYS SELECTED. The last chip does not turn off.
      ? (ms.length > 1 ? ms.filter((x) => x !== k) : ms)
      // KEPT IN THE FIXED DISPLAY ORDER, so the sections do not reorder by click order.
      : METRICS.map((m) => m.key).filter((x) => x === k || ms.includes(x)));

  return (
    <>
      <MonthRangeBar
        range={range} min={first} max={last}
        onStart={setFrom} onEnd={setTo}
        testId="pa-range" startTestId="pa-range-from" endTestId="pa-range-to" echoTestId="pa-range-label"
        startDisabled={grain === "daily"}
        echoOverride={grain === "daily" ? `${mLabel(effRange.end)}, by day` : undefined}
        note={grain === "daily"
          ? <span className={styles.clamp} data-testid="pa-daily-note">Daily shows one month: the To month.</span>
          : undefined}
      />

      <div className={styles.card} data-testid="pa-card">
        <div className={styles.toolbar}>
          <div className={styles.ctl}>
            <span className={styles.cl}>View by</span>
            <div className={styles.seg} role="group" aria-label="View by">
              {(["monthly", "weekly", "daily"] as Granularity[]).map((gr) => (
                <button key={gr} data-testid={`pa-grain-${gr}`} aria-pressed={grain === gr} onClick={() => setGrain(gr)}>
                  {gr[0].toUpperCase() + gr.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className={styles.ctl}>
            <span className={styles.cl}>Group by</span>
            <div className={styles.seg} role="group" aria-label="Group by">
              {(["overall", "cities", "fields", "compare"] as Group[]).map((gp) => (
                <button key={gp} data-testid={`pa-group-${gp}`} aria-pressed={group === gp} onClick={() => onGroup(gp)}>
                  {gp[0].toUpperCase() + gp.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <span className={styles.spacer} />
          <button className={styles.btn} data-testid="pa-export" onClick={onExport}>Export</button>
        </div>

        {(group === "cities" || group === "fields") && (
          <>
            <div className={styles.sub2} data-testid="pa-metric-chips">
              <span className={styles.cl}>Metrics</span>
              {METRICS.map((m) => {
                const dis = group === "fields" && !m.field;
                return (
                  <button
                    key={m.key} className={styles.chip} data-metric={m.key}
                    data-testid={`pa-metric-chip-${m.key}`} aria-pressed={metrics.includes(m.key)}
                    disabled={dis}
                    title={dis ? "Registrations have no field: a player registers before choosing a pitch." : m.desc}
                    onClick={() => onMetricChip(m.key)}
                  >{m.label}</button>
                );
              })}
            </div>
            {group === "fields" ? (
              <div className={styles.sub2} data-testid="pa-field-filters">
                <span className={styles.cl}>City</span>
                <button className={styles.chip} data-city="all" data-testid="pa-field-city-all"
                  aria-pressed={cityFilter === "all"} onClick={() => setCityFilter("all")}>All cities</button>
                {fieldCities.map((c) => (
                  <button key={c} className={styles.chip} data-city={c} data-testid={`pa-field-city-${slug(c)}`}
                    aria-pressed={cityFilter === c} onClick={() => setCityFilter(c)}>{c}</button>
                ))}
                <span className={styles.divider} />
                <label className={styles.toggle}>
                  <input type="checkbox" data-testid="pa-show-inactive"
                    checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
                  {" "}Show fields with no activity
                </label>
              </div>
            ) : (
              <div className={styles.sub2}>
                <label className={styles.toggle}>
                  <input type="checkbox" data-testid="pa-show-outside"
                    checked={showOutside} onChange={(e) => setShowOutside(e.target.checked)} />
                  {" "}Include cities outside active operations ({allCities.outside.join(", ") || "none"})
                </label>
              </div>
            )}
          </>
        )}

        {group === "compare" && (
          <div className={styles.sub2}>
            <span className={styles.cl}>Compare</span>
            <div className={styles.vs}>
              <span className={styles.dotA} />
              <select data-testid="pa-compare-a" value={cmpA} onChange={(e) => setCmpA(e.target.value)} aria-label="First city">
                {/* A CITY CANNOT BE COMPARED WITH ITSELF. The other side's choice is disabled
                    rather than removed, so the list does not reshuffle under the cursor. */}
                {compareOptions.map((c) => <option key={c} value={c} disabled={c === cmpB}>{c}</option>)}
              </select>
              <button className={styles.swap} data-testid="pa-compare-swap" title="Swap" aria-label="Swap the two cities"
                onClick={() => { setCmpA(cmpB); setCmpB(cmpA); }}>⇄</button>
              <span className={styles.dotB} />
              <select data-testid="pa-compare-b" value={cmpB} onChange={(e) => setCmpB(e.target.value)} aria-label="Second city">
                {compareOptions.map((c) => <option key={c} value={c} disabled={c === cmpA}>{c}</option>)}
              </select>
            </div>
          </div>
        )}

        {weeklyErr && <div className={styles.err}>Could not load {grain} data: {weeklyErr}</div>}
        {grain !== "monthly" && !weekly && !weeklyErr && <div className={styles.loading}>Loading {grain} buckets…</div>}
        {(grain === "monthly" || weekly) && (
          group === "overall" ? renderOverall()
            : group === "compare" ? renderCompare()
              : metrics.map((k) => renderEntitySection(k))
        )}
      </div>

      {tip && (
        <div className={styles.tip} role="tooltip" data-testid="pa-tip"
          style={{ left: tip.x, top: tip.y }}>{tip.text}</div>
      )}
    </>
  );
}
