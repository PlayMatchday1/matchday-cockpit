"use client";

/* 2026 DAILY MATCHES — the goal sheet, computing itself.
 *
 * Ryan: "it's taking all of september so far to see the daily average games" / "the team for some
 * reason likes to think of it as daily matches for 2026".
 *
 * WHAT IS TYPED AND WHAT IS NOT. Every number on the left is computed from mdapi_matches on every
 * load — the September column, the twelve bars, the weekly equivalents, the gaps, the bands, the
 * totals, and October/November's ramp. The only things a person types are the monthly targets, the
 * not-yet-existing field names, and the actions. The spreadsheet this replaces stores a total of
 * 16.7 while its own rows sum to 16.6, which is what a typed derived number looks like.
 *
 * AND EVERY TOTAL HERE IS THE SUM OF ITS PARTS AS DISPLAYED. A row is its own spots/18/days at full
 * precision and is rounded once to show it; anything that AGGREGATES rows — the three tiles, the
 * twelve bars, a city row, the city chart, the footer — sums those displayed values. It costs up to
 * a tenth against the full-precision figure and it buys the thing this page is for: a column a
 * reader can add up, that adds up. See cityRollup in lib/fieldGoals for the measurement.
 *
 * NO BANNERS, NO EXPLAINER COPY. Ryan: "i dont want any of the extra bullshit banners and warnings
 * and stuff". One line of prose survives — "18 spots = 1 match" beside the unit toggle — because
 * without it "18.5 daily matches" reads as 18.5 matches and it is not. A state that belongs on a
 * row goes on the row: a field with no goal says "no goal" in its own gap cell and is counted
 * nowhere. There is no sentence anywhere telling you how many of those there are.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { supabase } from "@/lib/supabase";
import { errorText } from "@/lib/errorText";
import {
  MONTH_LABELS, bandForDisplay, baselineMonth, cityRollup, dailyIn, fmtShownSigned, shownGap, shownTrend, hasNoCompletedDay, cityTotals, fmtSigned, fmtUnit, isDormantFor,
  historyIndexes, monthIndexIn, monthKey, ramp, rowCountsTowardTotals, roundTo, sortGoalRows, trendKind, weekly,
  type Band, type CityFieldRow, type CityRow, type CompareFrom, type GoalSort,
} from "@/lib/fieldGoals";

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(path, { ...init, cache: "no-store",
    headers: { ...(init?.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
}

type MonthCell = { month: string; label: string; spots: number; matches: number; days: number; daysInMonth: number; partial: boolean; daily: number };
type Action = { id: string; text: string; done: boolean; sortOrder: number };
type Row = {
  key: string; rowId: string | null; kind: "existing" | "slot";
  name: string; city: string | null; venueId: number | null; fieldId: number | null;
  notCounted: boolean;
  matches: number; monthly: MonthCell[]; targets: Record<string, number>; actions: Action[];
};
type Payload = { year: number; today: string; currentMonth: number; months: MonthCell[]; rows: Row[]; slots: Row[] };

const BAND_HUE: Record<Band, string> = { behind: "#E8553F", warn: "#E8A33F", near: "#8FBF6A", over: "#12694A" };
/* THE CHART'S HUE IS NOT THE BRAND MINT. #2CDB87 fails contrast against this surface at 1.77:1 and
 * sits outside the lightness band; mint is a UI accent, not a chart fill. #0E8A54 passes. */
const CHART_HUE = "#0E8A54";

const RAMP_MONTHS = [9, 10] as const; // October, November — the two the ramp fills
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
const DEC = 11;

/* ── THE GRAIN ─────────────────────────────────────────────────────────────────────────────────
 * Ryan: "I want to add a city view so I can see the gap per city too for each month."
 *
 * IT MOVES THE CHART AND THE TABLE AND NOTHING ELSE. The three tiles are estate-level in both
 * grains, because they are the number the company is held to and seven per-city tiles answer a
 * question nobody asked. Field mode is what it was. */
export type Grain = "field" | "city";

export default function FieldGoals2026() {
  const [data, setData] = useState<Payload | null>(null);
  /* TWO ERROR STATES, BECAUSE THEY MEAN DIFFERENT THINGS. A LOAD failure blanks the page: a table
   * that could not read its data should not pretend to render. A WRITE failure must not — the table
   * is fine, one button did not work, and blanking the screen is not how to say so.
   *
   * THE BUG THIS FIXES: every write did `if (error) setErr(...)` and then called reload()
   * unconditionally. reload() bumped the nonce, the effect refetched, succeeded, and ran
   * setErr(null) — wiping the message microseconds after it was set. So a refused write looked
   * EXACTLY like a successful one. Ryan pressed "Do not count this field", PostgREST answered
   * PGRST204 because migration 0171 was not applied, and the page said nothing at all. */
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [writeErr, setWriteErr] = useState<{ key: string; message: string } | null>(null);
  /* A FAILED WRITE PUTS THE CONTROL BACK. Bumping this re-syncs every input from the stored value,
   * so a number that was refused does not sit on screen looking saved. */
  const [revert, setRevert] = useState(0);
  const [unit, setUnit] = useState<"day" | "week">("day");
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [draft, setDraft] = useState<Record<string, string>>({});
  /* BY GAP, DESCENDING, BY DEFAULT. The sheet was already in that order and for the same reason: the
   * top of the list is where the work is. It also makes the band rule self-evident — in gap order
   * the dots run red, amber, green, dark in sequence, which alphabetical order scrambles. */
  const [sort, setSort] = useState<GoalSort>("gap");
  const [showDormant, setShowDormant] = useState(false);
  /* ── HISTORY IS OFF BY DEFAULT, AND THAT IS THE DECISION ─────────────────────────────────────
   * Ryan: "What's the best way to show historical months? I want it to be optional."
   *
   * This table's job is the climb to December. The two numbers people read are the live month and
   * the goal, and four extra columns push them apart. History is CONTEXT for that climb, not a
   * second subject — so it is a thing you ask for, and the table you get without asking is exactly
   * the table that was there before. Not persisted: every load opens on the question the page is
   * for. */
  const [showHistory, setShowHistory] = useState(false);
  /* COMPARE FROM — null follows the rule (baselineMonth): the last full month until the live month
   * has seven completed days, then the live month to date. A press overrides it for this visit
   * only; it is not persisted, so every load opens on the rule. */
  const [compareOverride, setCompareOverride] = useState<CompareFrom | null>(null);
  /* CITIES ON LOAD. The sort default is untouched and still per the sort control — "by gap",
     descending — which means the page opens on the city with the most to find. */
  const [grain, setGrain] = useState<Grain>("city");
  /* SHUT AT REST. Seven cities open at once is the field table with extra steps. A Set rather than
   * one open key: opening Austin does not close Houston, and opening one opens nobody else. */
  const [openCities, setOpenCities] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await authFetch("/api/growth/field-goals");
        const j = await res.json();
        if (!live) return;
        if (!res.ok) { setLoadErr(j?.error ?? `Load failed (${res.status})`); return; }
        // A SUCCESSFUL LOAD CLEARS ONLY THE LOAD ERROR. It must never clear a write error — that is
        // precisely how the message used to disappear.
        setData(j as Payload); setLoadErr(null);
      } catch (e) { if (live) setLoadErr(errorText(e, "Failed to load the goals.")); }
    })();
    return () => { live = false; };
  }, [nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  /* ONE SHAPE FOR EVERY WRITE ON THIS PAGE. On failure: keep the message, put the control back, and
   * DO NOT reload — there is nothing to reload and the refetch is what destroyed the message. */
  const failed = useCallback((key: string, e: unknown) => {
    setWriteErr({ key, message: errorText(e, "That did not save.") });
    setRevert((n) => n + 1);
  }, []);
  const saved = useCallback(() => { setWriteErr(null); reload(); }, [reload]);

  /* A ROW HAS TO EXIST BEFORE A TARGET OR AN ACTION CAN HANG OFF IT. A computed row is not stored
   * until somebody gives it something to store — which is why 35 venues render against however few
   * rows the table holds. */
  const ensureRow = useCallback(async (r: Row): Promise<string | null> => {
    if (r.rowId) return r.rowId;
    const ident = r.venueId != null ? { venue_id: r.venueId } : r.fieldId != null ? { field_id: r.fieldId } : null;
    /* UNREACHABLE TODAY, AND IT SAYS SO RATHER THAN SHRUGGING. A row with no venue and no field is a
     * slot, and a slot always came FROM field_goal_rows, so it always has a rowId and returns above.
     * If that ever stops being true, a control that cannot work should say so — it used to return
     * null and every caller did `if (!rowId) return`, a silent no-op with no message at all. */
    if (!ident) { failed(r.key, "This row has nothing to attach a goal to."); return null; }
    const { data: made, error } = await supabase.from("field_goal_rows").insert({ ...ident, city: r.city }).select("id").single();
    if (error) { failed(r.key, error); return null; }
    return (made?.id as string) ?? null;
  }, [failed]);

  const setTarget = useCallback(async (r: Row, month: string, value: number | null) => {
    setBusy(true);
    try {
      const rowId = await ensureRow(r);
      if (!rowId) return;
      const { error } = value == null
        ? await supabase.from("field_goal_targets").delete().eq("row_id", rowId).eq("month", month)
        : await supabase.from("field_goal_targets").upsert({ row_id: rowId, month, goal_daily: value }, { onConflict: "row_id,month" });
      if (error) { failed(r.key, error); return; }
      saved();
    } finally { setBusy(false); }
  }, [ensureRow, reload]);

  const addAction = useCallback(async (r: Row, text: string) => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const rowId = await ensureRow(r);
      if (!rowId) return;
      const { error } = await supabase.from("field_goal_actions")
        .insert({ row_id: rowId, text: text.trim(), sort_order: (r.actions.at(-1)?.sortOrder ?? 0) + 1 });
      if (error) { failed(r.key, error); return; }
      saved();
    } finally { setBusy(false); }
  }, [ensureRow, reload]);

  const toggleAction = useCallback(async (a: Action, rowKey: string) => {
    const { error } = await supabase.from("field_goal_actions").update({ done: !a.done }).eq("id", a.id);
    if (error) { failed(rowKey, error); return; }
    saved();
  }, [failed, saved]);

  const removeAction = useCallback(async (a: Action, rowKey: string) => {
    const { error } = await supabase.from("field_goal_actions").delete().eq("id", a.id);
    if (error) { failed(rowKey, error); return; }
    saved();
  }, [failed, saved]);

  /* NOT COUNTED — deliberate, stored on the row, and reversible from the same panel that holds the
   * actions. Dormant is computed and needs no control at all. */
  const setNotCounted = useCallback(async (r: Row, value: boolean) => {
    setBusy(true);
    try {
      const rowId = await ensureRow(r);
      if (!rowId) return;
      const { error } = await supabase.from("field_goal_rows")
        .update({ not_counted: value }).eq("id", rowId);
      if (error) { failed(r.key, error); return; }
      saved();
    } finally { setBusy(false); }
  }, [ensureRow, reload]);

  const addSlot = useCallback(async () => {
    const { error } = await supabase.from("field_goal_rows").insert({ slot_name: "New Field - ", sort_order: Date.now() % 1e6 });
    if (error) { failed("fg-new", error); return; }
    saved();
  }, [failed, saved]);

  const renameSlot = useCallback(async (r: Row, name: string) => {
    if (!name.trim() || !r.rowId) return;
    const { error } = await supabase.from("field_goal_rows").update({ slot_name: name.trim() }).eq("id", r.rowId);
    if (error) { failed(r.key, error); return; }
    saved();
  }, [failed, saved]);

  /* A SLOT'S CITY IS TYPED, because a slot has no venue to read one from. MEASURED on production
   * 2026-09-23: all nine slots carry a null city and five of them hold 3.5 of the 28.2 December
   * goal, so without this control 12.4% of the goal sits in a bucket with no way to move it and the
   * city grain is a view the operator cannot finish. The city is NOT parsed out of the slot's name:
   * "New Field - Oklahoma" against a venue city of "OKC" would silently invent an eighth city. */
  const setSlotCity = useCallback(async (r: Row, city: string) => {
    if (!r.rowId) return;
    const v = city.trim();
    const { error } = await supabase.from("field_goal_rows")
      .update({ city: v === "" ? null : v }).eq("id", r.rowId);
    if (error) { failed(r.key, error); return; }
    saved();
  }, [failed, saved]);

  const removeSlot = useCallback(async (r: Row) => {
    if (!r.rowId) return;
    const { error } = await supabase.from("field_goal_rows").delete().eq("id", r.rowId);
    if (error) { failed(r.key, error); return; }
    saved();
  }, [failed, saved]);

  const cur = data?.currentMonth ?? 8;
  /* ── THE 1st OF A MONTH ───────────────────────────────────────────────────────────────────────
   * The current month's average covers COMPLETED days, so on the 1st there is nothing to average.
   * That is not zero and it is not "one day in": dividing by one would publish whatever happened
   * to be booked overnight as a daily rate. Every figure derived from the current month's actual —
   * the headline, each row's actual, its gap, its ramp, the city column — reads as a dash for that
   * one day, and the tile says why. A typed December goal still shows; it was typed, not derived. */
  const noCompletedDay = data ? hasNoCompletedDay(data.months[cur]) : false;
  /* ── THE BASELINE: the month every gap, trend, progress bar and the first two tiles read ─────
   * lib/fieldGoals.baselineMonth is the one copy of the rule. Month to date is the live month and
   * the page reads exactly as it did before the baseline existed; the last full month is the month
   * before. A baseline outside this page's year (January's "last full month" is last December,
   * which this page does not hold) falls back to the live month. */
  const bl = data ? baselineMonth(data.today, compareOverride) : null;
  const baseIdx = bl ? (monthIndexIn(bl.baseKey, data!.year) ?? cur) : cur;
  const baseIsLive = baseIdx === cur;
  const compareFrom: CompareFrom = baseIsLive ? "to-date" : "last-full";
  /** No baseline figure at all: only month to date, on the 1st. A full month always has one. */
  const noBase = baseIsLive && noCompletedDay;
  const liveDays = data?.months[cur]?.days ?? 0;
  const DASH = "\u2014";
  const rows = useMemo(() => [...(data?.rows ?? [])], [data]);
  const slots = useMemo(() => [...(data?.slots ?? [])], [data]);
  const all = useMemo(() => [...rows, ...slots], [rows, slots]);

  /* ── A TOTAL IS THE SUM OF ITS PARTS AS DISPLAYED. ONE RULE, THE WHOLE PAGE. ─────────────────
   * These three tiles USED TO SUM AT FULL PRECISION and round once at render, which is the purer
   * arithmetic and was deliberate: a one-decimal sum of one-decimal rows is how the spreadsheet
   * this page replaced ends up claiming 16.7 for rows that add to 16.6.
   *
   * IT STOPPED BEING TENABLE WHEN THE CITY ROWS STARTED FOOTING TO THEIR FIELDS. The city column
   * now sums the field values AS DISPLAYED, so the "All MatchDay" footer read 16.7 while the tile
   * directly above it read 16.5 — the same 0.2 disagreement the spreadsheet has, printed twice on
   * one screen, which is precisely the fault this page exists to end. Purity in the tile bought a
   * visible contradiction, and a reader adds up the column in front of them.
   *
   * SO EVERY TOTAL ON THIS PAGE IS NOW A SUM OF ROUNDED PARTS: these tiles, the year chart's bars,
   * the city rows, the city chart and the footer. They agree with each other and with the rows
   * beneath them by construction. The ROWS themselves are unchanged — each is still its own
   * spots/18/days at full precision, rounded once for display. Only the aggregation moved.
   *
   * THE HEADLINE MOVES BY UP TO A TENTH as a result (measured 16.5 to 16.7 on 2026-09-29). That is
   * the number the rows have always added up to. */

  /* ONE ROLLUP, OVER THE SAME `all` THE TOTALS AND THE CHART USE, through the same predicate. A
   * city sum built on its own filter would miss the headline above it by a rounding amount nobody
   * could find. Existing fields and slots go in together: a city's December goal spans both tables
   * and this is the only place they meet. */
  const cities = useMemo(
    () => cityRollup(all, data?.year ?? 2026, cur, sort, baseIdx, unit),
    [all, data?.year, cur, sort, baseIdx, unit]);
  const cityTot = useMemo(() => cityTotals(cities), [cities]);
  /* THE TILES READ THE FOOTER. They used to sum the rows separately — the same figures by a second
   * path — and "To find" was its own subtraction, which is how the tile read 11.1 under a footer
   * of +11.2. Now the tile's baseline, goal and gap ARE the footer's, through shownGap. */
  const totals = useMemo(() => ({
    now: cityTot.base, goal: cityTot.dec,
    gap: shownGap(dailyIn(cityTot.dec, unit), dailyIn(cityTot.base, unit), unit) as number,
  }), [cityTot, unit]);
  /* THE ROLLUP KEEPS ONLY WHAT IT NEEDS TO ADD UP — a CityFieldRow, not a page Row — so the drawer
   * needs a way back to the row the write handlers take. `key` is the same string on both sides
   * (cityRollup copies `r.key` straight onto the field line), which is what makes this a lookup and
   * not a match. */
  const rowByKey = useMemo(() => new Map(all.map((r) => [r.key, r])), [all]);

  const toggleCity = useCallback((city: string) => {
    setOpenCities((prev) => {
      const next = new Set(prev);
      if (next.has(city)) next.delete(city); else next.add(city);
      return next;
    });
  }, []);

  const decOf = (r: Row) => r.targets[monthKey(data?.year ?? 2026, DEC)] ?? null;
  /** The baseline month's figure for a row — what its gap and its ramp run from. */
  const baseOf = (r: Row) => r.monthly[baseIdx]?.daily ?? 0;
  const rampOf = (r: Row) => ramp(baseOf(r), decOf(r));

  /* THE TWELVE BARS AND THE TABLE ARE ONE NUMBER. Recorded months come from the months array the
   * route computed off the same filtered matches; October to December are the SUM OF THE ROWS'
   * targets, ramp included, so editing a December goal moves the bar and the headline together. */
  const chart = useMemo(() => {
    if (!data) return [];
    /* THE RECORDED BARS ARE SUMMED FROM THE COUNTED ROWS ON SCREEN, not from a separate aggregate.
     * Measured: with the exclusion applied to the rows only, the table dropped 0.4 and the
     * September bar did not move — bars above the sum of the rows beneath them, which is the
     * spreadsheet's own fault and the thing this page exists to end. One predicate, applied once,
     * governs the table, the headline and every bar. The route still supplies the calendar facts
     * (how many days elapsed) because those are not row data. */
    const counted = all.filter(rowCountsTowardTotals);
    const r1 = (v: number) => roundTo(v, 1);
    /* SUMMED FROM THE ROWS AS DISPLAYED, the same rule the tiles and the city column now use, so a
     * bar and the tile beside it cannot disagree. This was `sum(spots)/18/days`, which is the same
     * quantity at full precision and therefore 0.2 away from a tile that rounds its parts. */
    const dailyFromRows = (i: number) =>
      r1(counted.reduce((sum, r) => sum + r1(r.monthly[i]?.daily ?? 0), 0));
    return MONTH_LABELS.map((label, i) => {
      if (i < cur) return { label, value: dailyFromRows(i), state: "done" as const, days: data.months[i].days, of: data.months[i].daysInMonth };
      if (i === cur) return { label, value: dailyFromRows(i), state: "partial" as const, days: data.months[i].days, of: data.months[i].daysInMonth };
      const k = monthKey(data.year, i);
      const value = r1(all.filter(rowCountsTowardTotals).reduce((s, r) => {
        const typed = r.targets[k];
        if (typed != null) return s + r1(typed);
        if (i === DEC) return s;
        const idx = RAMP_MONTHS.indexOf(i as 9 | 10);
        const v = idx >= 0 ? rampOf(r)[idx] : null;
        return s + r1(v ?? 0);
      }, 0));
      /* ON THE 1st A RAMP MONTH IS UNKNOWN, NOT LOW. The ramp is a straight line FROM the current
       * month's actual, and on day one there is no actual, so it would run from zero: measured on
       * the day-one render, October drew 9.5 and November 18.5 against the ~21 and ~25 they carry
       * the rest of the month. A third of the December goal is not a suggestion anybody made.
       * December is untouched — it is a number a person typed, not a line drawn from anything. */
      const unknown = noBase && i !== DEC && RAMP_MONTHS.indexOf(i as 9 | 10) >= 0;
      return { label, value: unknown ? 0 : value, state: "goal" as const, unknown, days: 0, of: data.months[i].daysInMonth };
    });
    // rampOf/decOf are derived from `all` and `data`, which are the dependencies that matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, all, cur, noBase, baseIdx]);

  /* THE EARLY RETURN IS FOR A LOAD FAILURE AND NOTHING ELSE. A page that cannot read its data must
   * not pretend to render; a page whose last write was refused must not blank itself. */
  if (loadErr) return <p className="p-6 text-[13px] text-red-700" data-testid="fg-error">{loadErr}</p>;
  if (!data) return <p className="p-8 text-center text-[13px]" style={{ color: "#8C9E93" }}>Loading…</p>;

  const u = unit === "day" ? "matches a day" : "matches a week";
  const pct = totals.goal > 0 ? Math.min(100, (totals.now / totals.goal) * 100) : 0;

  return (
    <div className="px-4 pb-16 pt-3" data-testid="fg-page">
      <h1 className="mb-3 text-[27px] font-black uppercase tracking-tight" style={{ color: "#003326" }}>{data.year} Daily Matches</h1>

      {/* ── THE ONE NUMBER, AND IT IS A MONTH RATHER THAN A DAY. Labelled "Today" it read as today's
             count, which is not what a month-to-date average is. ────────────────────────────── */}
      <div className="mb-4 flex flex-wrap items-stretch gap-3">
        <Big k={baseIsLive ? `${MONTH_LABELS[cur]} so far` : `${MONTH_NAMES[baseIdx]}, last full month`}
          v={noBase ? DASH : fmtUnit(totals.now, unit)}
          u={noBase ? "no completed days yet" : u} testId="fg-now" />
        <Big k={`Dec ${data.year} goal`} v={fmtUnit(totals.goal, unit)} u={u} tone="#12694A" testId="fg-goal" />
        <Big k="To find" v={noBase ? DASH : (unit === "day" ? totals.gap.toFixed(1) : totals.gap.toFixed(0))}
          u={noBase ? "needs a completed day" : u} tone="#A8341F" testId="fg-gap" />
        {!noBase && (
        <div className="flex min-w-[240px] flex-1 flex-col justify-center rounded-2xl border-[1.5px] bg-white px-4 py-3" style={{ borderColor: "#D3DCD8" }}>
          <div className="relative h-3 overflow-hidden rounded-full border" style={{ background: "#F2F4F3", borderColor: "#D3DCD8" }}>
            <i data-testid="fg-bar" className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${pct}%`, background: "linear-gradient(90deg,#2CDB87,#12694A)" }} />
          </div>
          <div className="mt-2 flex justify-between text-[11.5px]" style={{ color: "#5C6F66" }}>
            <b data-testid="fg-pct" style={{ color: "#003326" }}>{Math.round(pct)}%</b>
            <span data-testid="fg-alt">
              {unit === "day"
                ? `${weekly(totals.now).toFixed(0)} → ${weekly(totals.goal).toFixed(0)} a week`
                : `${totals.now.toFixed(1)} → ${totals.goal.toFixed(1)} a day`}
            </span>
          </div>
        </div>
        )}
      </div>

      {grain === "city"
        ? <CityChart cities={cities} unit={unit} baseIdx={baseIdx} noCompletedDay={noBase} />
        : <YearChart months={chart} unit={unit} noCompletedDay={noCompletedDay} />}

      <div className="mb-3 mt-3 flex flex-wrap items-center gap-2">
        <span className="inline-flex overflow-hidden rounded-[9px] border bg-white" style={{ borderColor: "#D3DCD8" }}>
          {(["day", "week"] as const).map((x) => (
            <button key={x} type="button" data-testid={`fg-unit-${x}`} aria-pressed={unit === x}
              onClick={() => setUnit(x)}
              className="px-3.5 py-1.5 text-[12.5px] font-bold"
              style={unit === x ? { background: "#003326", color: "#fff" } : { background: "#fff", color: "#3C4F44" }}>
              {x === "day" ? "Daily" : "Weekly"}
            </button>
          ))}
        </span>
        {/* THE DEFINITION, NOT AN EXPLANATION. Eight characters, and the page needs them. */}
        <span className="text-[11.5px]" data-testid="fg-formula" style={{ color: "#5C6F66" }}>
          {unit === "day" ? "18 spots = 1 match" : "daily × 7"}
        </span>
        <CompareSeg value={compareFrom} lastFull={MONTH_LABELS[Math.max(0, cur - 1)]} live={MONTH_LABELS[cur]}
          set={(v) => setCompareOverride(v)} />
      </div>

      {grain === "city" ? (
        <CityTable
          cities={cities} totals={cityTot} unit={unit} cur={cur} noCompletedDay={noCompletedDay}
          baseIdx={baseIdx} noBase={noBase} liveDays={liveDays}
          sort={sort} setSort={setSort} grain={grain} setGrain={setGrain}
          openCities={openCities} toggleCity={toggleCity}
          rowByKey={rowByKey} year={data.year} busy={busy} revert={revert}
          onTarget={setTarget} open={open} setOpen={setOpen} draft={draft} setDraft={setDraft}
          onAddAction={addAction} onToggleAction={toggleAction} onRemoveAction={removeAction}
          onNotCounted={setNotCounted} writeErr={writeErr}
          showHistory={showHistory} setShowHistory={setShowHistory}
        />
      ) : (
        <>
          <GoalTable
            title="Existing fields" rows={rows} unit={unit} year={data.year} cur={cur} busy={busy}
            open={open} setOpen={setOpen} draft={draft} setDraft={setDraft}
            onTarget={setTarget} onAddAction={addAction} onToggleAction={toggleAction} onRemoveAction={removeAction}
            onNotCounted={setNotCounted} writeErr={writeErr} revert={revert}
            sort={sort} setSort={setSort} grain={grain} setGrain={setGrain}
            showDormant={showDormant} setShowDormant={setShowDormant} noCompletedDay={noCompletedDay}
            baseIdx={baseIdx} noBase={noBase} liveDays={liveDays}
            testId="fg-existing"
          />
          <GoalTable
            title="New fields" rows={slots} unit={unit} year={data.year} cur={cur} busy={busy}
            open={open} setOpen={setOpen} draft={draft} setDraft={setDraft}
            onTarget={setTarget} onAddAction={addAction} onToggleAction={toggleAction} onRemoveAction={removeAction}
            onNotCounted={setNotCounted} writeErr={writeErr} revert={revert} sort={sort}
            onAddRow={addSlot} onRename={renameSlot} onRemoveRow={removeSlot}
            onCity={setSlotCity} noCompletedDay={noCompletedDay}
            baseIdx={baseIdx} noBase={noBase} liveDays={liveDays}
            testId="fg-new"
          />
        </>
      )}
    </div>
  );
}

export function Big({ k, v, u, tone, testId }: { k: string; v: string; u: ReactNode; tone?: string; testId: string }) {
  return (
    <div className="min-w-[170px] rounded-2xl border-[1.5px] bg-white px-4 py-3" style={{ borderColor: "#D3DCD8" }} data-testid={testId}>
      <div className="text-[10.5px] font-extrabold uppercase tracking-widest" style={{ color: "#5C6F66" }}>{k}</div>
      <div className="mt-0.5 text-[34px] font-black leading-none tracking-tight tabular-nums" style={{ color: tone ?? "#003326" }} data-testid={`${testId}-v`}>{v}</div>
      <div className="mt-0.5 text-[11.5px]" style={{ color: "#5C6F66" }} data-testid={`${testId}-u`}>{u}</div>
    </div>
  );
}

/* ── THE YEAR, ONE MEASURE, ONE AXIS ───────────────────────────────────────────────────────────
 * Recorded months are solid. The CURRENT month is hatched, because eleven days beside eleven whole
 * months is a lie by omission, and it is direct-labelled with its own value. The remaining months
 * are the same hue OUTLINED — the same measure in a different state, not a second series in a
 * second colour. Three marks, three legend entries, and a tooltip on every bar. */
function YearChart({ months, unit, noCompletedDay }: { months: { label: string; value: number; state: "done" | "partial" | "goal"; unknown?: boolean; days: number; of: number }[]; unit: "day" | "week"; noCompletedDay?: boolean }) {
  const [tip, setTip] = useState<{ x: number; y: number; html: string } | null>(null);
  const W = 920, H = 250, L = 38, R = 8, T = 16, B = 26;
  const shown = months.map((m) => (unit === "day" ? m.value : weekly(m.value)));
  const max = Math.max(5, Math.ceil(Math.max(...shown, 1) / 5) * 5);
  const iw = W - L - R, ih = H - T - B;
  const step = iw / months.length, bw = Math.min(44, step - 10);
  const y = (v: number) => T + ih - (v / max) * ih;

  return (
    <div className="relative rounded-2xl border-[1.5px] bg-white px-4 pb-2 pt-3" style={{ borderColor: "#D3DCD8" }} data-testid="fg-chart">
      <div className="mb-1 flex flex-wrap items-start justify-between gap-3">
        <div className="text-[13px] font-extrabold">Daily matches by month</div>
        <div className="flex flex-wrap items-center gap-3 text-[11.5px]" style={{ color: "#5C6F66" }} data-testid="fg-legend">
          <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-[3px]" style={{ background: CHART_HUE }} />recorded</span>
          <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-[3px]" style={{ background: CHART_HUE, opacity: 0.45 }} />month to date</span>
          <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-[3px] border-2" style={{ borderColor: CHART_HUE, background: "#fff" }} />goal</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full overflow-visible" role="img" aria-label={`Daily matches by month, ${new Date().getFullYear()}`}>
        <defs>
          <pattern id="fg-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="#fff" /><rect width="3" height="6" fill={CHART_HUE} />
          </pattern>
        </defs>
        {Array.from({ length: 5 }, (_, g) => (max / 4) * g).map((g) => (
          <g key={g}>
            <line x1={L} x2={W - R} y1={y(g)} y2={y(g)} stroke="#E8EEEA" strokeWidth={1} />
            <text x={L - 8} y={y(g) + 3.5} textAnchor="end" fontSize={10} fill="#8FA096">{Math.round(g)}</text>
          </g>
        ))}
        {months.map((m, i) => {
          const v = shown[i];
          const x = L + i * step + (step - bw) / 2;
          const yy = y(v), h = Math.max(2, T + ih - yy), r = Math.min(4, h / 2);
          const path = `M${x},${T + ih} L${x},${yy + r} Q${x},${yy} ${x + r},${yy} L${x + bw - r},${yy} Q${x + bw},${yy} ${x + bw},${yy + r} L${x + bw},${T + ih} Z`;
          const fill = m.state === "goal" ? "#fff" : m.state === "partial" ? "url(#fg-hatch)" : CHART_HUE;
          return (
            <g key={m.label}>
              <path d={path} fill={fill} stroke={m.state === "done" ? "none" : CHART_HUE} strokeWidth={m.state === "goal" ? 2 : 1.5}
                data-testid={`fg-bar-${m.label}`} data-state={m.state} data-value={v.toFixed(1)} data-fill={fill} />
              <rect x={x - 4} y={T} width={bw + 8} height={ih} fill="transparent"
                onMouseMove={(e) => {
                  const box = (e.currentTarget.ownerSVGElement?.parentElement as HTMLElement)?.getBoundingClientRect();
                  setTip({ x: e.clientX - (box?.left ?? 0) + 12, y: e.clientY - (box?.top ?? 0) - 10,
                    html: m.unknown
                      ? `${m.label} · no suggestion yet · the ramp needs a completed day to run from`
                      : `${m.label} · ${v.toFixed(1)} a ${unit === "day" ? "day" : "week"}` +
                      (m.state === "partial" ? ` · ${m.days} of ${m.of} days so far` : m.state === "goal" ? " · goal" : "") +
                      (unit === "day" ? ` · ${weekly(m.value).toFixed(0)} a week` : "") });
                }}
                onMouseLeave={() => setTip(null)} />
              {/* THE 1st: the month-to-date bar has no value to label. A "0.0" over a flat bar
                  reads as a month that has started badly rather than one that has not started. */}
              {m.state !== "done" && (
                <text x={x + bw / 2} y={yy - 6} textAnchor="middle" fontSize={10.5} fontWeight={700} fill="#12694A">
                  {(noCompletedDay && m.state === "partial") || m.unknown ? "\u2014" : v.toFixed(1)}
                </text>
              )}
              <text x={x + bw / 2} y={H - 8} textAnchor="middle" fontSize={10.5}
                fill={m.state === "goal" ? "#8FA096" : "#54655C"} fontWeight={m.state === "partial" ? 800 : 400}>{m.label}</text>
            </g>
          );
        })}
      </svg>
      {tip && (
        <div className="pointer-events-none absolute z-10 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[11.5px] text-white"
          data-testid="fg-tip" style={{ left: tip.x, top: tip.y, background: "#0b2018" }}>{tip.html}</div>
      )}
    </div>
  );
}

/* ── COMPARE FROM ──────────────────────────────────────────────────────────────────────────────
 * Beside Daily / Weekly, because it is the same kind of control: what the numbers are measured
 * against. The default follows lib/fieldGoals.baselineMonth; pressing either overrides it for this
 * visit. Exported: the 2027 Operations Plan carries the same control. */
export function CompareSeg({ value, set, lastFull, live }: {
  value: CompareFrom; set: (v: CompareFrom) => void; lastFull: string; live: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] font-bold" style={{ color: "#5C6F66" }}>
      Compare from
      <span className="inline-flex overflow-hidden rounded-[9px] border bg-white" style={{ borderColor: "#D3DCD8" }} data-testid="compare">
        {([["last-full", `${lastFull}, last full month`], ["to-date", `${live} to date`]] as const).map(([k, label]) => (
          <button key={k} type="button" data-testid={`compare-${k}`} aria-pressed={value === k} onClick={() => set(k)}
            className="px-3 py-1.5 text-[12px] font-bold"
            style={value === k ? { background: "#003326", color: "#fff" } : { background: "#fff", color: "#3C4F44" }}>
            {label}
          </button>
        ))}
      </span>
    </span>
  );
}

/** The tag on the column the gap is measured from. */
export function BaselineTag() {
  return <span data-testid="basetag" className="ml-1 rounded px-1 text-[8.5px] font-bold tracking-normal" style={{ background: "#EAF4EE", color: "#12694A" }}>baseline</span>;
}
/** The live month's completed days, shown while the live month is NOT the baseline. */
export function DaysTag({ days }: { days: number }) {
  return <span data-testid="daystag" className="ml-1 rounded px-1 text-[8.5px] font-bold tracking-normal" style={{ background: "#F2F4F3", color: "#5C6F66" }}>{days} {days === 1 ? "day" : "days"}</span>;
}

/* ── THE HISTORY SWITCH ────────────────────────────────────────────────────────────────────────
 * WITH THE OTHER SWITCHES, NOT BESIDE THE DATA. Cities/Fields and the three sorts already say what
 * the rows are and in what order; this says how far back they reach. A control that changes the
 * shape of the table belongs with the other controls that change the shape of the table, and one
 * floating above a column would read as being about that column.
 *
 * 32px, which is the height every control on this page already is. */
export function HistorySeg({ on, set }: { on: boolean; set: (v: boolean) => void }) {
  return (
    <button type="button" data-testid="histtog" aria-pressed={on} onClick={() => set(!on)}
      className="ml-3 inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11.5px] font-bold"
      style={{ minHeight: 32, borderColor: on ? "#003326" : "#D3DCD8",
               ...(on ? { background: "#003326", color: "#fff" } : { background: "#fff", color: "#3C4F44" }) }}>
      <span aria-hidden style={{ fontSize: 9 }}>{on ? "\u25c0\u25c0" : "\u25c0"}</span>
      Show history
    </button>
  );
}

/* ── THE GRAIN TOGGLE ──────────────────────────────────────────────────────────────────────────
 * Beside the sort, because they are the same kind of control: what the rows are and in what order.
 * 32px tall, which is the height every control on this page already is. */
export function GrainSeg({ grain, setGrain }: { grain: Grain; setGrain: (g: Grain) => void }) {
  return (
    <span className="ml-3 inline-flex overflow-hidden rounded-lg border" style={{ borderColor: "#D3DCD8" }} data-testid="grain">
      {/* CITIES FIRST. Ryan: the toggle reads Cities, then Fields, and the page opens on Cities —
          the per-city gap is the question this page gets opened to answer, and the field list is
          where you go once you know which city to look at. */}
      {([["city", "Cities"], ["field", "Fields"]] as const).map(([k, label]) => (
        <button key={k} type="button" data-testid={`grain-${k}`} data-g={k} aria-pressed={grain === k}
          onClick={() => setGrain(k)} className="px-2.5 py-1 text-[11.5px] font-bold"
          style={{ minHeight: 32, ...(grain === k ? { background: "#003326", color: "#fff" } : { background: "#fff", color: "#3C4F44" }) }}>
          {label}
        </button>
      ))}
    </span>
  );
}

/* ── THE CHART FOLLOWS THE GRAIN ───────────────────────────────────────────────────────────────
 * In city mode the x axis is cities, not months: a FILLED bar for the current month's actual and an
 * OUTLINED bar for the December goal, which is the encoding the month chart already uses for
 * recorded against goal. The distance between the pair IS the gap, and a per-city gap is the one
 * thing a twelve-month chart cannot show you.
 *
 * ONE SCALE ACROSS EVERY CITY, never per column. Per column, OKC at 0.6 of 1.0 and Austin at 6.2 of
 * 9.9 would draw identically and the chart would say every city is equally far along, which is the
 * opposite of the point. The hue is CHART_HUE for the same reason it is everywhere else on this
 * page: the brand mint fails contrast on this surface at 1.77:1. */
function CityChart({ cities, unit, baseIdx, noCompletedDay }: { cities: CityRow[]; unit: "day" | "week"; baseIdx: number; noCompletedDay?: boolean }) {
  /* THE ACTUAL BAR IS THE BASELINE, and the title names the month it draws ("Sep against December
   * goal"). `noCompletedDay` here means no baseline figure: month to date on the 1st. */
  const cur = baseIdx;
  const [tip, setTip] = useState<{ x: number; y: number; html: string } | null>(null);
  const W = 920, H = 250, L = 38, R = 8, T = 16, B = 30;
  const val = (v: number) => (unit === "day" ? v : weekly(v));
  /* THE TOP OF THE AXIS IS A MULTIPLE OF FOUR, because there are four gaps between five
   * gridlines. Rounded to the nearest 2 it lands on 10, whose quarters are 2.5, and the labels
   * printed 0 / 3 / 5 / 8 / 10 against lines actually sitting at 2.5 and 7.5. A gridline labelled
   * 3 that is drawn at 2.5 makes every bar misreadable against it. */
  const peak = Math.max(...cities.map((c) => Math.max(val(c.base), val(c.dec))), 1);
  const max = Math.max(4, Math.ceil(peak / 4) * 4);
  const iw = W - L - R, ih = H - T - B;
  const step = iw / Math.max(1, cities.length);
  const bw = Math.min(20, (step - 14) / 2);
  const y = (v: number) => T + ih - (v / max) * ih;

  return (
    <div className="relative rounded-2xl border-[1.5px] bg-white px-4 pb-2 pt-3" style={{ borderColor: "#D3DCD8" }} data-testid="chart">
      <div className="mb-1 flex flex-wrap items-start justify-between gap-3">
        {/* ON THE 1st THERE IS NO ACTUAL TO COMPARE AGAINST, so the chart stops claiming to be a
            comparison and shows the goal alone rather than a row of empty bars. */}
        <div className="text-[13px] font-extrabold">{noCompletedDay ? "December goal by city" : `${MONTH_LABELS[cur]} against December goal`}</div>
        <div className="flex flex-wrap items-center gap-3 text-[11.5px]" style={{ color: "#5C6F66" }} data-testid="fg-legend">
          {!noCompletedDay && <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-[3px]" style={{ background: CHART_HUE }} />{MONTH_LABELS[cur]} actual</span>}
          <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-[3px] border-2" style={{ borderColor: CHART_HUE, background: "#fff" }} />Dec goal</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full overflow-visible" role="img"
        aria-label={`${MONTH_LABELS[cur]} actual against the December goal, by city`}>
        {Array.from({ length: 5 }, (_, g) => (max / 4) * g).map((g) => (
          <g key={g}>
            <line x1={L} x2={W - R} y1={y(g)} y2={y(g)} stroke="#E8EEEA" strokeWidth={1} />
            <text x={L - 8} y={y(g) + 3.5} textAnchor="end" fontSize={10} fill="#8FA096">{Math.round(g)}</text>
          </g>
        ))}
        {cities.map((c, i) => {
          const a = val(c.base), gl = val(c.dec);
          const cx = L + i * step + step / 2;
          const xa = cx - bw - 1.5, xg = cx + 1.5;
          const ha = Math.max(1.5, (a / max) * ih), hg = Math.max(1.5, (gl / max) * ih);
          return (
            <g key={c.city}>
              {!noCompletedDay && (
                <rect data-testid="bact" data-c={c.city} data-v={a.toFixed(2)}
                  x={xa} y={T + ih - ha} width={bw} height={ha} rx={3} fill={CHART_HUE} />
              )}
              <rect data-testid="bgoal" data-c={c.city} data-v={gl.toFixed(2)}
                x={xg} y={T + ih - hg} width={bw} height={hg} rx={3} fill="#fff" stroke={CHART_HUE} strokeWidth={2} />
              <text x={xg + bw / 2} y={T + ih - hg - 5} textAnchor="middle" fontSize={10} fontWeight={700} fill="#12694A">
                {unit === "day" ? gl.toFixed(1) : gl.toFixed(0)}
              </text>
              <rect data-testid="col" data-c={c.city} x={cx - step / 2} y={T} width={step} height={ih} fill="transparent"
                onMouseMove={(e) => {
                  const box = (e.currentTarget.ownerSVGElement?.parentElement as HTMLElement)?.getBoundingClientRect();
                  setTip({ x: e.clientX - (box?.left ?? 0) + 12, y: e.clientY - (box?.top ?? 0) - 10,
                    html: noCompletedDay
                      ? `${c.city} · Dec ${fmtUnit(c.dec, unit)} · no completed days yet this month`
                      : `${c.city} · ${MONTH_LABELS[cur]} ${fmtUnit(c.base, unit)} · Dec ${fmtUnit(c.dec, unit)} · gap ${fmtShownSigned(c.gapSort, unit)}` });
                }}
                onMouseLeave={() => setTip(null)} />
              <text x={cx} y={H - 10} textAnchor="middle" fontSize={9.5} fontWeight={600}
                fill={c.hasCity ? "#54655C" : "#9AA8A1"}>{c.city}</text>
            </g>
          );
        })}
      </svg>
      {tip && (
        <div className="pointer-events-none absolute z-10 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[11.5px] text-white"
          data-testid="fg-tip" style={{ left: tip.x, top: tip.y, background: "#0b2018" }}>{tip.html}</div>
      )}
    </div>
  );
}

/* ── THE CITY TABLE ───────────────────────────────────────────────────────────────────────────
 * Same columns as the field table, one level up. The footer is the SUM OF THE ROWS ON SCREEN, so it
 * cannot be a second source, and it ties to the three tiles above by construction.
 *
 * EACH CITY OPENS TO ITS FIELDS. Ryan: "should have drop down per city to see the fields under each
 * city if you want." "If you want" is the spec, so it is shut at rest. The field rows are the same
 * rows field mode shows for that city, existing AND unsigned, and they SUM to the row above them —
 * a drawer whose numbers do not add up to the row you opened is worse than no drawer on a page
 * whose entire job is a gap. */
function CityTable({
  cities, totals, unit, cur, noCompletedDay, sort, setSort, grain, setGrain, openCities, toggleCity,
  rowByKey, year, busy, revert, onTarget, open, setOpen, draft, setDraft,
  onAddAction, onToggleAction, onRemoveAction, onNotCounted, writeErr,
  showHistory, setShowHistory, baseIdx, noBase, liveDays,
}: {
  cities: CityRow[];
  totals: ReturnType<typeof cityTotals>;
  unit: "day" | "week"; cur: number;
  /** The baseline month index, whether it has no figure (month to date on the 1st), and the live
   *  month's completed days for its tag. */
  baseIdx: number; noBase: boolean; liveDays: number;
  /** The 1st of a month: no completed day, so every current-month figure is a dash. */
  noCompletedDay?: boolean;
  sort: GoalSort; setSort: (s: GoalSort) => void;
  grain: Grain; setGrain: (g: Grain) => void;
  openCities: Set<string>; toggleCity: (city: string) => void;
  /* ── EVERYTHING BELOW IS THE FIELD TABLE'S EDIT SURFACE, PASSED THROUGH UNCHANGED ───────────
   * The drawer edits through the SAME handlers the field table edits through, so there is one
   * save path on this page and a fix to it cannot reach one grain and miss the other.
   * `rowByKey` is what turns a rollup line back into the page row those handlers expect. */
  rowByKey: Map<string, Row>;
  year: number; busy: boolean; revert: number;
  onTarget: (r: Row, month: string, v: number | null) => void;
  open: string | null; setOpen: (k: string | null) => void;
  draft: Record<string, string>; setDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onAddAction: (r: Row, text: string) => void;
  onToggleAction: (a: Action, rowKey: string) => void;
  onRemoveAction: (a: Action, rowKey: string) => void;
  onNotCounted: (r: Row, value: boolean) => void;
  writeErr: { key: string; message: string } | null;
  showHistory: boolean; setShowHistory: (v: boolean) => void;
}) {
  /* THE MONTHS ON SCREEN, LEFT TO RIGHT. With history off this is exactly what it was: the live
   * month and the three targets. */
  const histIdx = showHistory ? historyIndexes(cur) : [];
  const COL = { past: "#3A4D44", live: "#003326", target: "#9AA8A1", goal: "#003326" };
  /* THE HAIRLINE, AND IT FALLS AFTER THE LIVE MONTH. Everything left of it happened; everything
   * right of it is a plan. Only drawn with history open — with one actual and three targets the
   * existing grey already carries the distinction, which is the same reason the caption band is
   * conditional. */
  const rule = showHistory ? { borderLeft: "1px solid #C3CEC8" } : {};
  /* ── THE BASELINE COLUMN ──────────────────────────────────────────────────────────────────────
   * With the last full month as baseline the gap is measured from it, so it is on screen whether or
   * not history is open: inside the history columns when they show (it is always the last of them),
   * as its own column when they do not. The live month stays visible in every mode, one step back
   * in ink and tagged with its completed days while it is not the baseline. */
  const baseIsLive = baseIdx === cur;
  const extraBase = !baseIsLive && !histIdx.includes(baseIdx);
  /* THE BASELINE CELL READS THE HISTORY VALUE, which knows "no pitch yet" from "a quiet month":
   * San Diego has never played, so its September is a dash, never 0.0. The last full month is
   * always one of historyIndexes(cur), so the value is there whether or not history is open. */
  const baseHistAt = historyIndexes(cur).indexOf(baseIdx);
  const trendLabel = `${MONTH_LABELS[historyIndexes(cur)[0] ?? 0]} \u2192 ${MONTH_LABELS[baseIdx]}`;
  const thCls = "whitespace-nowrap border-b px-3 py-2 text-right text-[10px] font-extrabold uppercase tracking-wider";
  const thSt = { color: "#5C6F66", background: "#F2F4F3", borderColor: "#D3DCD8" };
  return (
    <>
      <h2 className="mb-2 mt-6 flex items-baseline gap-2 text-[15px] font-extrabold">
        Cities <span className="text-[11.5px] font-semibold" style={{ color: "#5C6F66" }} data-testid="fg-city-count">{cities.length}</span>
        <GrainSeg grain={grain} setGrain={setGrain} />
        <HistorySeg on={showHistory} set={setShowHistory} />
        <span className="inline-flex overflow-hidden rounded-lg border" style={{ borderColor: "#D3DCD8" }} data-testid="fg-sort">
          {([["gap", "By gap"], ["city", "By city"], ["name", "A–Z"]] as const).map(([k, label]) => (
            <button key={k} type="button" data-testid={`fg-sort-${k}`} aria-pressed={sort === k}
              onClick={() => setSort(k)} className="px-2.5 py-1 text-[11.5px] font-bold"
              style={{ minHeight: 32, ...(sort === k ? { background: "#003326", color: "#fff" } : { background: "#fff", color: "#3C4F44" }) }}>
              {label}
            </button>
          ))}
        </span>
      </h2>
      <div className="overflow-x-auto rounded-xl border-[1.5px] scroll" style={{ borderColor: "#D3DCD8" }}>
        <table className="w-full min-w-[620px] border-collapse bg-white" data-testid="fg-cities">
          <thead>
            {/* ── THE CAPTION BAND, ONLY WITH HISTORY OPEN ──────────────────────────────────
                Without past columns there is one actual against three targets and the grey
                already carries it. With FOUR actuals the reader has to be told once, at the top,
                which side of the line they are on — the same solid-versus-outlined distinction
                the chart above this table already teaches, said in words because a table cell
                cannot be outlined. */}
            {showHistory && (
              <tr data-testid="capband" style={{ background: "#F2F4F3" }}>
                <td style={{ background: "#F2F4F3" }} /><td />
                <td colSpan={histIdx.length + (extraBase ? 1 : 0) + 1} data-testid="cap-actual"
                  className="border-b px-3 text-[9.5px] font-extrabold uppercase tracking-[0.13em]"
                  style={{ height: 24, color: "#5C6F66", borderColor: "#D3DCD8" }}>Actual</td>
                <td colSpan={3} data-testid="cap-goal"
                  className="border-b px-3 text-[9.5px] font-extrabold uppercase tracking-[0.13em]"
                  style={{ height: 24, color: "#5C6F66", borderColor: "#D3DCD8", ...rule }}>Goal</td>
                <td /><td /><td />
              </tr>
            )}
            <tr>
              <th className="sticky left-0 z-[2] whitespace-nowrap border-b px-3 py-2 text-left text-[10px] font-extrabold uppercase tracking-wider"
                style={{ color: "#5C6F66", background: "#F2F4F3", borderColor: "#D3DCD8" }}>City</th>
              <th className="whitespace-nowrap border-b px-3 py-2 text-left text-[10px] font-extrabold uppercase tracking-wider"
                style={{ color: "#5C6F66", background: "#F2F4F3", borderColor: "#D3DCD8" }}>Progress</th>
              {histIdx.map((i) => (
                <th key={i} data-testid="mh" data-m={MONTH_LABELS[i].toLowerCase()} data-base={i === baseIdx ? "1" : undefined}
                  className={thCls} style={thSt}>{MONTH_LABELS[i]}{i === baseIdx && <BaselineTag />}</th>
              ))}
              {extraBase && (
                <th data-testid="mh" data-m={MONTH_LABELS[baseIdx].toLowerCase()} data-base="1" className={thCls} style={thSt}>
                  {MONTH_LABELS[baseIdx]}<BaselineTag />
                </th>
              )}
              <th data-testid="mh" data-m={MONTH_LABELS[cur].toLowerCase()} data-base={baseIsLive ? "1" : undefined}
                className={thCls} style={thSt}>
                {MONTH_LABELS[cur]}
                {/* THE LIVE MONTH SAYS SO. Among three complete months it is the one still
                    running, and a reader comparing it to them has to know that. */}
                <span data-testid="inprog" className="ml-1 rounded px-1 text-[8.5px] font-bold tracking-normal"
                  style={{ background: "#FFF3E0", color: "#8A5A12" }}>live</span>
                {baseIsLive ? <BaselineTag /> : <DaysTag days={liveDays} />}
              </th>
              {([9, 10, 11] as const).map((i, k) => (
                <th key={i} data-testid="mh" data-m={MONTH_LABELS[i].toLowerCase()}
                  data-boundary={showHistory && k === 0 ? "1" : undefined}
                  className="whitespace-nowrap border-b px-3 py-2 text-right text-[10px] font-extrabold uppercase tracking-wider"
                  style={{ color: "#5C6F66", background: "#F2F4F3", borderColor: "#D3DCD8", ...(k === 0 ? rule : {}) }}>
                  {MONTH_LABELS[i]}
                </th>
              ))}
              {showHistory && (
                <th data-testid="trendhead"
                  className="whitespace-nowrap border-b px-3 py-2 text-right text-[10px] font-extrabold uppercase tracking-wider"
                  style={{ color: "#5C6F66", background: "#F2F4F3", borderColor: "#D3DCD8" }}>Trend <span className="normal-case tracking-normal">{trendLabel}</span></th>
              )}
              {["Gap", "Fields"].map((h, i) => (
                <th key={h} className={`whitespace-nowrap border-b px-3 py-2 text-[10px] font-extrabold uppercase tracking-wider ${i === 0 ? "text-right" : "text-left"}`}
                  style={{ color: "#5C6F66", background: "#F2F4F3", borderColor: "#D3DCD8" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cities.map((c) => {
              const isOpen = openCities.has(c.city);
              const band = bandForDisplay(c.gapDaily);
              return (
                <Fragmentish key={c.city}>
                  <tr data-testid="crow" data-c={c.city} data-band={band} data-open={isOpen ? "1" : "0"}
                    role="button" tabIndex={0} aria-expanded={isOpen}
                    aria-label={`${c.city}, ${c.fields.length} fields`}
                    onClick={() => toggleCity(c.city)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleCity(c.city); } }}
                    className="cursor-pointer hover:bg-[#FAFCFB] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#0E8A54]">
                    {/* ── THE NAME STAYS PUT WHILE THE MONTHS SCROLL ──────────────────────────
                        With history open the table is twelve columns and scrolls in its own
                        container on a narrow screen. A row of figures whose city has scrolled off
                        the left is a row you cannot read, so the first column is pinned. Opaque
                        background, or the scrolling cells show through it. */}
                    <td className="sticky left-0 z-[1] border-t px-3 py-2 text-[13px]" style={{ borderColor: "#EDF2EF", background: "#fff" }}>
                      <span data-testid="chev" aria-hidden className="mr-1.5 inline-block text-[8px] align-middle"
                        style={{ color: "#9AA8A1", transform: isOpen ? "rotate(90deg)" : "none", transformOrigin: "50% 50%", transition: "transform .12s" }}>▶</span>
                      <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full align-middle" data-testid="dot" data-b={noBase ? "none" : band}
                        style={{ background: noBase ? "#C3CEC8" : BAND_HUE[band] }} />
                      {/* NO CITY SET IS A BUCKET, NOT A CITY, and the row says so by being the only
                          italic label in the column. Its figures are real and stay on screen. */}
                      <b className={`font-bold ${c.hasCity ? "" : "italic"}`} style={c.hasCity ? undefined : { color: "#5C6F66" }}>{c.city}</b>
                    </td>
                    <td className="border-t px-3 py-2" style={{ borderColor: "#EDF2EF" }}>
                      {c.dec > 0 && !noBase && (
                        <span className="relative inline-block h-[7px] w-24 overflow-hidden rounded-full border align-middle prog" style={{ background: "#F2F4F3", borderColor: "#D3DCD8" }}>
                          <i className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.min(100, (c.base / c.dec) * 100)}%`, background: c.gapDaily < 0 ? "#12694A" : "#2CDB87" }} />
                        </span>
                      )}
                    </td>
                    {/* ── HISTORY: A DASH IS NOT A ZERO ──────────────────────────────────────
                        A market with no pitch open that month renders a dash. 0.0 beside a
                        December target reads as a city that collapsed; the truth is that it had
                        not opened yet, and once a zero is printed the two are indistinguishable.
                        Past months are INK — one step back from the live month, which stays the
                        anchor — against the grey the targets already wear. */}
                    {histIdx.map((mi, k) => (
                      <td key={mi} data-testid="hcell" data-m={MONTH_LABELS[mi].toLowerCase()}
                        data-none={c.hist[k] == null ? "1" : undefined}
                        data-v={c.hist[k] == null ? "" : (c.hist[k] as number).toFixed(4)}
                        className="border-t px-3 py-2 text-right text-[13px] tabular-nums"
                        style={{ borderColor: "#EDF2EF", color: c.hist[k] == null ? "#C3CEC8" : COL.past, fontWeight: 600 }}>
                        {c.hist[k] == null ? "\u2013" : fmtUnit(c.hist[k] as number, unit)}
                      </td>
                    ))}
                    {extraBase && (
                      <td className="border-t px-3 py-2 text-right text-[13px] font-bold tabular-nums" style={{ borderColor: "#EDF2EF", color: c.hist[baseHistAt] == null ? "#C3CEC8" : COL.live }}
                        data-v={c.base.toFixed(4)} data-testid="base" data-m={MONTH_LABELS[baseIdx].toLowerCase()}>{c.hist[baseHistAt] == null ? "\u2013" : fmtUnit(c.base, unit)}</td>
                    )}
                    {/* THE LIVE MONTH, ALWAYS ON SCREEN. While it is not the baseline it is one step
                        back in ink: it is context for the month, not the number the gap reads. */}
                    <td className={`border-t px-3 py-2 text-right text-[13px] tabular-nums ${baseIsLive ? "font-bold" : "font-semibold"}`} style={{ borderColor: "#EDF2EF", color: baseIsLive ? COL.live : COL.past }} data-v={c.live.toFixed(4)} data-testid="sep" data-m={MONTH_LABELS[cur].toLowerCase()}>{noCompletedDay ? <span style={{ color: "#C3CEC8" }}>{"\u2014"}</span> : fmtUnit(c.live, unit)}</td>
                    {/* OCT AND NOV ARE DERIVED AND LOOK DERIVED: lighter ink and a lighter weight
                        than both the actual beside them and the December a person typed. */}
                    <td className="border-t px-3 py-2 text-right text-[13px] tabular-nums" style={{ borderColor: "#EDF2EF", color: COL.target, fontWeight: 500, ...rule }} data-v={c.oct.toFixed(4)} data-testid="oct" data-m="oct">{noBase ? <span style={{ color: "#C3CEC8" }}>{"\u2014"}</span> : fmtUnit(c.oct, unit)}</td>
                    <td className="border-t px-3 py-2 text-right text-[13px] tabular-nums" style={{ borderColor: "#EDF2EF", color: COL.target, fontWeight: 500 }} data-v={c.nov.toFixed(4)} data-testid="nov" data-m="nov">{noBase ? <span style={{ color: "#C3CEC8" }}>{"\u2014"}</span> : fmtUnit(c.nov, unit)}</td>
                    <td className="border-t px-3 py-2 text-right text-[13px] font-bold tabular-nums" style={{ borderColor: "#EDF2EF", color: COL.goal }} data-v={c.dec.toFixed(4)} data-testid="dec" data-m="dec">{fmtUnit(c.dec, unit)}</td>
                    {/* ── TREND IS WHY HISTORY EARNS ITS COLUMNS ─────────────────────────────
                        A gap alone does not say whether it is closing. NEVER FABRICATED: a market
                        with no June has no trend, and is labelled new so the absence reads as
                        specific rather than as missing data. */}
                    {showHistory && (
                      <td className="border-t px-3 py-2 text-right text-[13px] tabular-nums" style={{ borderColor: "#EDF2EF" }}>
                        {c.trend == null
                          ? <>
                              <span data-testid="trend" data-none="1" style={{ color: "#C3CEC8" }}>{"\u2013"}</span>
                              <span data-testid="newnote" className="ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-bold"
                                style={{ background: "#EAF4EE", color: "#12694A" }}>new</span>
                            </>
                          : <span data-testid="trend" data-t={trendKind(c.trend)!} className="font-extrabold"
                              style={{ color: trendKind(c.trend) === "up" ? "#12694A" : trendKind(c.trend) === "dn" ? "#A8341F" : "#8C9E93" }}>
                              <span aria-hidden className="mr-1 text-[10px]">
                                {trendKind(c.trend) === "up" ? "\u25b2" : trendKind(c.trend) === "dn" ? "\u25bc" : "\u2013"}
                              </span>
                              {/* WEEKLY SUBTRACTS THE TWO WEEKLY FIGURES SHOWN; the arrow and its dead
                                  band stay on the daily trend, so a unit press never flips it. */}
                              {fmtShownSigned(shownTrend(dailyIn(c.base, unit), c.hist[0] == null ? null : dailyIn(c.hist[0], unit), unit) as number, unit)}
                            </span>}
                      </td>
                    )}
                    <td className="border-t px-3 py-2 text-right text-[13px] font-extrabold tabular-nums" style={{ borderColor: "#EDF2EF", color: BAND_HUE[band] }} data-v={c.gapDaily.toFixed(4)} data-testid="gap">{noBase ? <span style={{ color: "#C3CEC8" }}>{"\u2014"}</span> : fmtShownSigned(c.gapSort, unit)}</td>
                    {/* "9 +2 new · 2 no goal". A city with no unsigned fields says nothing rather than
                        "+0 new", and a December figure carrying absent targets says so here rather
                        than reading as low. */}
                    <td className="border-t px-3 py-2 text-[11px]" style={{ borderColor: "#EDF2EF", color: "#9AA8A1" }} data-testid="fields">
                      {c.existing}
                      {c.slots > 0 && <>{" "}<span className="font-bold" style={{ color: CHART_HUE }}>+{c.slots} new</span></>}
                      {c.noGoal > 0 && <>{" \u00b7 "}{c.noGoal} no goal</>}
                    </td>
                  </tr>
                  {isOpen && c.fields.map((f) => (
                    <CityFieldTr key={f.key} f={f} city={c.city} row={rowByKey.get(f.key)}
                      unit={unit} cur={cur} year={year} busy={busy} revert={revert}
                      noCompletedDay={noCompletedDay} onTarget={onTarget}
                      open={open} setOpen={setOpen} draft={draft} setDraft={setDraft}
                      onAddAction={onAddAction} onToggleAction={onToggleAction}
                      onRemoveAction={onRemoveAction} onNotCounted={onNotCounted} writeErr={writeErr}
                      histIdx={histIdx} showHistory={showHistory} rule={rule}
                      baseIdx={baseIdx} noBase={noBase} extraBase={extraBase} baseHistAt={baseHistAt} />
                  ))}
                </Fragmentish>
              );
            })}
          </tbody>
          <tfoot>
            <tr data-testid="tot" style={{ background: "#F7FAF8" }}>
              <td className="sticky left-0 z-[1] border-t-2 px-3 py-2 text-[13px] font-extrabold" style={{ borderColor: "#D3DCD8", background: "#F7FAF8" }}>All MatchDay</td>
              <td className="border-t-2" style={{ borderColor: "#D3DCD8" }} />
              {/* ── THE FOOTER SPANS THE HISTORY COLUMNS WITHOUT TOTALLING THEM ──────────────
                  An estate figure for June would be a fourth number nobody asked for, in a row
                  whose job is the climb to December. The cells exist so the columns line up and
                  say nothing, which is the honest thing for them to say. */}
              {histIdx.map((mi) => <td key={mi} className="border-t-2" style={{ borderColor: "#D3DCD8" }} />)}
              {extraBase && (
                <td className="border-t-2 px-3 py-2 text-right text-[13px] font-extrabold tabular-nums" style={{ borderColor: "#D3DCD8", color: "#003326" }}
                  data-v={totals.base.toFixed(4)} data-testid="tbase">{fmtUnit(totals.base, unit)}</td>
              )}
              <td className="border-t-2 px-3 py-2 text-right text-[13px] font-extrabold tabular-nums" style={{ borderColor: "#D3DCD8", color: baseIsLive ? "#003326" : "#3A4D44" }} data-v={totals.live.toFixed(4)} data-testid="tsep">{noCompletedDay ? <span style={{ color: "#C3CEC8" }}>{"\u2014"}</span> : fmtUnit(totals.live, unit)}</td>
              <td className="border-t-2 px-3 py-2 text-right text-[13px] tabular-nums" style={{ borderColor: "#D3DCD8", color: "#9AA8A1", fontWeight: 500, ...rule }} data-v={totals.oct.toFixed(4)} data-testid="toct">{noBase ? <span style={{ color: "#C3CEC8" }}>{"\u2014"}</span> : fmtUnit(totals.oct, unit)}</td>
              <td className="border-t-2 px-3 py-2 text-right text-[13px] tabular-nums" style={{ borderColor: "#D3DCD8", color: "#9AA8A1", fontWeight: 500 }} data-v={totals.nov.toFixed(4)} data-testid="tnov">{noBase ? <span style={{ color: "#C3CEC8" }}>{"\u2014"}</span> : fmtUnit(totals.nov, unit)}</td>
              <td className="border-t-2 px-3 py-2 text-right text-[13px] font-extrabold tabular-nums" style={{ borderColor: "#D3DCD8", color: "#003326" }} data-v={totals.dec.toFixed(4)} data-testid="tdec">{fmtUnit(totals.dec, unit)}</td>
              {showHistory && <td className="border-t-2" style={{ borderColor: "#D3DCD8" }} />}
              <td className="border-t-2 px-3 py-2 text-right text-[13px] font-extrabold tabular-nums" style={{ borderColor: "#D3DCD8", color: "#A8341F" }} data-v={totals.gapDaily.toFixed(4)} data-testid="tgap">{noBase ? <span style={{ color: "#C3CEC8" }}>{"\u2014"}</span> : fmtShownSigned(shownGap(dailyIn(totals.dec, unit), dailyIn(totals.base, unit), unit) as number, unit)}</td>
              <td className="border-t-2 px-3 py-2 text-[11px]" style={{ borderColor: "#D3DCD8", color: "#9AA8A1" }}>
                {totals.existing}{totals.slots > 0 && <>{" "}<span className="font-bold" style={{ color: CHART_HUE }}>+{totals.slots} new</span></>}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}

/* A FIELD INSIDE A CITY. Subordinate, not a second table: indented and lighter, keeping the same
 * columns, so a number under a city reads against the same header it would in field mode.
 * A NULL IS A DASH, NEVER A ZERO. A new field has no September because it does not exist, which is
 * not the same statement as a field that ran no matches; and a field with no December target reads
 * "no goal" in its own gap cell, which is the rule the field table already follows. */
/* A FIELD INSIDE A CITY, AND IT IS EDITABLE — the same inputs, the same save path, the same
 * validation and the same drawer as the field table, because they are literally the same two
 * components. Ryan: the drawer should edit "exactly the same way field rows are editable in the
 * Fields view today".
 *
 * WHAT STAYS DIFFERENT IS STYLE ONLY: indented, lighter ink, a paler background, so a number under
 * a city still reads as subordinate to it. The COLUMNS are the field table's columns, which is what
 * lets a reader check the drawer against the row above it.
 *
 * A SAVE HERE REFRESHES THE WHOLE PAGE'S DATA through the same `saved()` → `reload()` the field
 * table uses, so the city row and its GAP move the moment a field goal changes. There is no second
 * write path and no local mutation to keep in step.
 *
 * A NULL IS A DASH, NEVER A ZERO. A new field has no September because it does not exist, which is
 * not the same statement as a field that ran no matches. September is COMPUTED and stays read-only
 * in both grains — it is what happened, not a thing anyone types. */
function CityFieldTr({
  f, city, row, unit, cur, year, busy, revert, noCompletedDay,
  onTarget, open, setOpen, draft, setDraft,
  onAddAction, onToggleAction, onRemoveAction, onNotCounted, writeErr,
  histIdx, showHistory, rule, baseIdx, noBase, extraBase, baseHistAt,
}: {
  f: CityFieldRow; city: string;
  /** The history month indexes on screen, and the hairline. Empty when history is shut. */
  histIdx: number[]; showHistory: boolean; rule: React.CSSProperties;
  /** The baseline month, whether it has no figure, and whether it has its own column here. */
  baseIdx: number; noBase: boolean; extraBase: boolean; baseHistAt: number;
  /** The page row behind this drawer line. Absent only if the rollup outran the page's own rows,
   *  in which case the line stays read-only rather than rendering inputs that cannot save. */
  row: Row | undefined;
  unit: "day" | "week"; cur: number; year: number; busy: boolean; revert: number;
  noCompletedDay?: boolean;
  onTarget: (r: Row, month: string, v: number | null) => void;
  open: string | null; setOpen: (k: string | null) => void;
  draft: Record<string, string>; setDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onAddAction: (r: Row, text: string) => void;
  onToggleAction: (a: Action, rowKey: string) => void;
  onRemoveAction: (a: Action, rowKey: string) => void;
  onNotCounted: (r: Row, value: boolean) => void;
  writeErr: { key: string; message: string } | null;
}) {
  const dash = <span style={{ color: "#C3CEC8" }}>—</span>;
  const TONE = { bg: "#FAFCFB", pad: "px-3 py-1.5" };
  const tdStyle = { borderColor: "#EDF2EF", background: TONE.bg };
  const out = row?.notCounted === true;
  const openN = row ? row.actions.filter((a) => !a.done).length : 0;
  const isOpen = row != null && open === row.key;
  /* A FIELD TRENDS ON THE SAME RULE AS ITS CITY: earliest history month to the live one, and
   * nothing at all when that month is a dash. Built here and INJECTED into GoalCells so it lands
   * between Dec and the gap, where the header puts it. */
  /* THE SAME shownTrend AS THE CITY ROW: daily for the arrow, the unit on screen for the number. */
  const fTrend = shownTrend(f.base, f.hist[0], "day");
  const fTrendShown = f.base == null || f.hist[0] == null ? null
    : shownTrend(dailyIn(f.base, unit), dailyIn(f.hist[0] as number, unit), unit);
  const fk = trendKind(fTrend);
  const trendCell = showHistory ? (
    <td className="border-t px-3 py-1.5 text-right text-[12px] tabular-nums" style={{ borderColor: "#EDF2EF", background: "#FAFCFB" }}>
      {fTrend == null
        ? <span data-testid="trend" data-none="1" style={{ color: "#C3CEC8" }}>{"\u2013"}</span>
        : <span data-testid="trend" data-t={fk!} className="font-bold"
            style={{ color: fk === "up" ? "#12694A" : fk === "dn" ? "#A8341F" : "#8C9E93" }}>
            <span aria-hidden className="mr-1 text-[9px]">{fk === "up" ? "\u25b2" : fk === "dn" ? "\u25bc" : "\u2013"}</span>
            {fmtShownSigned(fTrendShown as number, unit)}
          </span>}
    </td>
  ) : undefined;
  return (
    <>
      <tr data-testid="frow" data-c={city} data-f={f.name} data-kind={f.kind}
        data-editable={row ? "1" : "0"} style={out ? { opacity: 0.55 } : undefined}>
        <td className="sticky left-0 z-[1] border-t py-1.5 pl-9 pr-3 text-[12px]" style={{ ...tdStyle, color: "#5C6F66" }}>
          {f.name}
          {f.kind === "slot" && (
            <span data-testid="newtag" className="ml-1.5 rounded border px-1 text-[9px] font-extrabold tracking-wide"
              style={{ borderColor: CHART_HUE, color: CHART_HUE }}>NEW</span>
          )}
          {/* THE MARK STAYS VISIBLE HERE TOO. An excluded field nobody can see is a decision nobody
              reviews, and this drawer is now a place the decision can be made. */}
          {out && <span className="ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-bold" data-testid="fg-notcounted"
            style={{ background: "#EEF3F0", color: "#5C6F66" }}>not counted</span>}
        </td>
        {/* THE PROGRESS COLUMN STAYS EMPTY in the drawer: the city row above already carries one,
            and a second bar at a second scale in the same column reads as the same measure. */}
        <td className="border-t" style={tdStyle} />
        {/* THE SAME DASH RULE, ONE LEVEL DOWN. A pitch that did not exist in June dashes there
            too — the city row above it is the sum of exactly these cells. */}
        {histIdx.map((mi, k) => (
          <td key={mi} data-testid="hcell" data-m={MONTH_LABELS[mi].toLowerCase()}
            data-none={f.hist[k] == null ? "1" : undefined}
            data-v={f.hist[k] == null ? "" : (f.hist[k] as number).toFixed(4)}
            className="border-t px-3 py-1.5 text-right text-[12px] tabular-nums"
            style={{ ...tdStyle, color: f.hist[k] == null ? "#C3CEC8" : "#5C6F66", fontWeight: 600 }}>
            {f.hist[k] == null ? "\u2013" : fmtUnit(f.hist[k] as number, unit)}
          </td>
        ))}
        {extraBase && (
          <td className="border-t px-3 py-1.5 text-right text-[12px] tabular-nums" data-testid="fbase"
            data-v={f.base == null ? "" : f.base.toFixed(4)} data-m={MONTH_LABELS[baseIdx].toLowerCase()}
            style={{ ...tdStyle, color: "#3A4D44", fontWeight: 600 }}>
            {f.base == null || f.hist[baseHistAt] == null ? dash : fmtUnit(f.base, unit)}
          </td>
        )}
        <td className="border-t px-3 py-1.5 text-right text-[12px] tabular-nums" data-testid="fsep"
          data-v={f.live == null ? "" : f.live.toFixed(4)} data-m={MONTH_LABELS[cur].toLowerCase()}
          style={{ ...tdStyle, color: baseIdx === cur ? "#3A4D44" : "#5C6F66", fontWeight: baseIdx === cur ? 600 : 500 }}>
          {f.live == null || noCompletedDay ? dash : fmtUnit(f.live, unit)}
        </td>
        {row
          ? <GoalCells r={row} year={year} baseIdx={baseIdx} unit={unit} busy={busy} revert={revert}
              noCompletedDay={noBase} onTarget={onTarget} tone={TONE} rule={rule}
              trendCell={trendCell} />
          : <>
              {/* NO PAGE ROW BEHIND THIS LINE, so it shows its numbers and no inputs rather than
                  controls that would look live and save nothing. */}
              <td className="border-t px-3 py-1.5 text-right text-[12px] tabular-nums" data-testid="foct"
                data-v={f.oct == null ? "" : f.oct.toFixed(4)} style={{ ...tdStyle, color: "#9AA8A1", fontWeight: 500 }}>
                {f.oct == null || noBase ? dash : fmtUnit(f.oct, unit)}</td>
              <td className="border-t px-3 py-1.5 text-right text-[12px] tabular-nums" data-testid="fnov"
                data-v={f.nov == null ? "" : f.nov.toFixed(4)} style={{ ...tdStyle, color: "#9AA8A1", fontWeight: 500 }}>
                {f.nov == null || noBase ? dash : fmtUnit(f.nov, unit)}</td>
              <td className="border-t px-3 py-1.5 text-right text-[12px] tabular-nums" data-testid="fdec"
                data-v={f.dec == null ? "" : f.dec.toFixed(4)} style={{ ...tdStyle, color: "#3A4D44", fontWeight: 600 }}>
                {f.dec == null ? dash : fmtUnit(f.dec, unit)}</td>
              {trendCell}
              <td className="border-t px-3 py-1.5 text-right text-[12px] font-bold tabular-nums" data-testid="fgap" style={tdStyle}>
                {f.gapDaily == null
                  ? <span data-testid="nogoal" className="text-[11px] font-normal italic" style={{ color: "#9AA8A1" }}>no goal</span>
                  : noBase ? dash
                  : <span style={{ color: f.gapDaily < 0 ? "#12694A" : "#003326" }}>{fmtShownSigned(f.gapSort as number, unit)}</span>}
              </td>
            </>}
        {/* THE LAST COLUMN IS "FIELDS" ON A CITY ROW AND ACTIONS ON A FIELD ROW, which is what it
            already is in the field table. Clicking it opens the same drawer. */}
        <td className="border-t px-3 py-1.5 text-[11px]" style={tdStyle} data-testid="fg-action-count">
          {row
            ? <button type="button" data-testid="frow-open" aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : row.key)}
                className="rounded-full px-2 py-0.5 font-bold"
                style={{ background: "#EEF3F0", color: "#5C6F66" }}>
                {row.actions.length ? `${openN} open` : "edit"}
              </button>
            : <span style={{ color: "#9AA8A1" }}>—</span>}
        </td>
      </tr>
      {/* IN PLACE, NOT INSTEAD OF THE PAGE, exactly as the field table does it. */}
      {row && writeErr?.key === row.key && (
        <tr data-testid="fg-write-error" data-key={row.key}>
          <td colSpan={8 + histIdx.length + (showHistory ? 1 : 0) + (extraBase ? 1 : 0)} className="px-3 pb-2 text-[12px]" style={{ color: "#A8341F", background: "#FDF3EF" }}>
            {writeErr.message}
          </td>
        </tr>
      )}
      {row && isOpen && (
        <tr data-testid="fg-actions-row"><td colSpan={8 + histIdx.length + (showHistory ? 1 : 0) + (extraBase ? 1 : 0)} className="px-3 pb-3 pl-9" style={{ background: TONE.bg }}>
          <ActionsDrawer r={row} busy={busy} draft={draft} setDraft={setDraft}
            onAddAction={onAddAction} onToggleAction={onToggleAction}
            onRemoveAction={onRemoveAction} onNotCounted={onNotCounted} />
        </td></tr>
      )}
    </>
  );
}

/* ── THE EDITABLE GOAL CELLS, SHARED BY BOTH GRAINS ───────────────────────────────────────────
 * Oct, Nov, Dec and the gap that falls out of them. EXTRACTED rather than reimplemented: the city
 * drawer used to render four read-only <td>s that happened to look like these, so a field was
 * editable in one view and dead in the other, and any fix to validation or to the suggested-goal
 * rule had to be made twice or silently made once. One component, one `onTarget`, one GoalInput.
 *
 * IT RENDERS <td>s AND NOTHING ELSE, so the caller owns the <tr> and its own padding. The city
 * drawer is indented and lighter; the field table is not. That is a style the row decides, which
 * is why `tone` is a prop rather than a second copy of the markup. */
function GoalCells({
  r, year, baseIdx, unit, busy, revert, noCompletedDay, onTarget, tone, rule, trendCell,
}: {
  r: Row; year: number; unit: "day" | "week"; busy: boolean; revert: number;
  /** The baseline month: the gap and the October / November ramp run from it. */
  baseIdx: number;
  /** No baseline figure (month to date on the 1st): no gap and no ramp to suggest. */
  noCompletedDay?: boolean;
  onTarget: (r: Row, month: string, v: number | null) => void;
  /** The city drawer's subordinate styling. Undefined in the field table. */
  tone?: { bg: string; pad: string };
  /** The actual/goal hairline, drawn on the first future month. Empty when history is shut. */
  rule?: React.CSSProperties;
  /* ── THE TREND CELL IS INJECTED, NOT APPENDED AFTER THIS COMPONENT ────────────────────────
   * GoalCells emits Oct, Nov, Dec AND the gap, so a trend rendered after it lands to the RIGHT of
   * the gap — while a city row puts trend to its LEFT. The drawer's columns then disagree with the
   * row they hang under and with the header above both, which is exactly what shipped in the first
   * cut of this: Houston's slots showed their gap under TREND and a dash under GAP. */
  trendCell?: ReactNode;
}) {
  const decKey = monthKey(year, DEC);
  const base = r.monthly[baseIdx]?.daily ?? 0;
  const dec = r.targets[decKey] ?? null;
  const noGoal = dec == null;
  /* THE GAP IS lib/fieldGoals.shownGap: the displayed December minus the displayed baseline. Daily
   * for the colour (a unit press never recolours), the unit on screen for the printed number. */
  const gap = noGoal ? 0 : shownGap(dec, base, "day") as number;
  const gapShown = noGoal ? 0 : shownGap(dailyIn(dec, unit), dailyIn(base, unit), unit) as number;
  /* No baseline figure means nothing to ramp FROM, so there is no suggestion to make. With the
   * last full month as baseline, a target month that is also the live month (October, on the 2nd)
   * gets the baseline-to-December line, never one starting from its own partial actual. */
  const suggestions = noCompletedDay ? [null, null, null] : ramp(base, dec);
  const cls = `border-t text-right ${tone ? `${tone.pad}` : "px-3 py-2"}`;
  const st = { borderColor: "#EDF2EF", ...(tone ? { background: tone.bg } : {}) };
  return (
    <>
      {RAMP_MONTHS.map((mi, idx) => {
        const k = monthKey(year, mi);
        const typed = r.targets[k];
        const shown = typed ?? suggestions[idx];
        return (
          <td key={k} data-m={MONTH_LABELS[mi].toLowerCase()} className={cls} style={idx === 0 ? { ...st, ...(rule ?? {}) } : st}>
            <GoalInput value={shown == null ? "" : fmtUnit(shown, unit)} suggested={typed == null}
              revert={revert} testId={`fg-goal-${MONTH_LABELS[mi]}`} disabled={busy}
              title={typed != null ? "set" : noGoal ? "no December goal to ramp to" : "suggested by the ramp from the baseline month to December"}
              onCommit={(v) => onTarget(r, k, v == null ? null : unit === "day" ? v : v / 7)} />
          </td>
        );
      })}
      <td data-m="dec" className={cls} style={st}>
        <GoalInput value={dec == null ? "" : fmtUnit(dec, unit)} suggested={false} placeholder="set"
          revert={revert} testId="fg-goal-Dec" disabled={busy} title="set"
          onCommit={(v) => onTarget(r, decKey, v == null ? null : unit === "day" ? v : v / 7)} />
      </td>
      {trendCell}
      <td className={`${cls} text-[13px] font-extrabold tabular-nums`} style={st} data-testid="fg-gap-cell">
        {noGoal
          ? <span className="text-[11px] italic font-normal" style={{ color: "#9AA8A1" }}>no goal</span>
          : noCompletedDay
          /* A GAP IS A GOAL MINUS AN ACTUAL. With no actual there is no gap, and printing the whole
             December goal as though it were one would read as the worst day of the year, every
             month, on the 1st. */
          ? <span style={{ color: "#C3CEC8" }}>{"\u2014"}</span>
          : /* SIGN-SAFE. ATH Pearland sits 0.004 above goal, which rounded to one decimal and
               printed with its sign came out "-0.0". fmtSigned normalises the rounded value, so the
               number and the dot agree. */
            <span style={{ color: gap < 0 ? "#12694A" : "#003326" }}>{fmtShownSigned(gapShown, unit)}</span>}
      </td>
    </>
  );
}

/* ── THE DRAWER, LIKEWISE SHARED ──────────────────────────────────────────────────────────────
 * "Do not count this field" and the action list. Same component in both grains, so the city view
 * is not a second, quietly diverging copy of the one control that removes a field from every
 * total on the page. */
function ActionsDrawer({
  r, busy, draft, setDraft, onAddAction, onToggleAction, onRemoveAction, onNotCounted,
}: {
  r: Row; busy: boolean;
  draft: Record<string, string>; setDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onAddAction: (r: Row, text: string) => void;
  onToggleAction: (a: Action, rowKey: string) => void;
  onRemoveAction: (a: Action, rowKey: string) => void;
  onNotCounted: (r: Row, value: boolean) => void;
}) {
  const out = r.notCounted === true;
  return (
    <div className="flex flex-col gap-1.5 pt-1">
      {/* REVERSIBLE IN PLACE, from the same panel that holds the actions. */}
      <button type="button" data-testid="fg-notcounted-toggle" disabled={busy}
        onClick={() => onNotCounted(r, !out)}
        className="self-start rounded-md border px-2.5 py-1 text-[11.5px] font-bold"
        style={{ borderColor: "#D3DCD8", background: "#fff", color: out ? "#12694A" : "#8A5A12" }}>
        {out ? "Count this field again" : "Do not count this field"}
      </button>
      {r.actions.map((a) => (
        <div key={a.id} className="flex items-center gap-2 text-[12.5px]" style={{ color: "#3A4D44" }} data-testid="fg-action">
          <input type="checkbox" checked={a.done} disabled={busy} onChange={() => onToggleAction(a, r.key)}
            className="h-3.5 w-3.5 accent-[#12694A]" aria-label={a.text} />
          <span className={`min-w-0 flex-1 ${a.done ? "line-through opacity-60" : ""}`}>{a.text}</span>
          <button type="button" aria-label="Remove action" disabled={busy} onClick={() => onRemoveAction(a, r.key)}
            className="px-1 text-[14px]" style={{ color: "#9AA8A1" }}>×</button>
        </div>
      ))}
      <div className="mt-0.5 flex gap-2">
        <input data-testid="fg-action-input" placeholder="Add an action" disabled={busy}
          value={draft[r.key] ?? ""} onChange={(e) => setDraft((d) => ({ ...d, [r.key]: e.target.value }))}
          onKeyDown={(e) => { if (e.key === "Enter") { onAddAction(r, draft[r.key] ?? ""); setDraft((d) => ({ ...d, [r.key]: "" })); } }}
          className="max-w-[460px] flex-1 rounded-md border border-dashed bg-white px-2 py-1.5 text-[12.5px]" style={{ borderColor: "#D3DCD8" }} />
        <button type="button" data-testid="fg-action-add" disabled={busy}
          onClick={() => { onAddAction(r, draft[r.key] ?? ""); setDraft((d) => ({ ...d, [r.key]: "" })); }}
          className="rounded-md px-3 text-[12px] font-bold text-white" style={{ background: "#003326" }}>Add</button>
      </div>
    </div>
  );
}

function GoalTable({
  title, rows, unit, year, cur, busy, open, setOpen, draft, setDraft,
  onTarget, onAddAction, onToggleAction, onRemoveAction, onNotCounted, writeErr, revert,
  sort, setSort, grain, setGrain, showDormant, setShowDormant,
  onAddRow, onRename, onRemoveRow, onCity, noCompletedDay, testId, baseIdx, noBase, liveDays,
}: {
  title: string; rows: Row[]; unit: "day" | "week"; year: number; cur: number; busy: boolean;
  open: string | null; setOpen: (k: string | null) => void;
  draft: Record<string, string>; setDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onTarget: (r: Row, month: string, v: number | null) => void;
  onAddAction: (r: Row, text: string) => void;
  onToggleAction: (a: Action, rowKey: string) => void;
  onRemoveAction: (a: Action, rowKey: string) => void;
  onNotCounted: (r: Row, value: boolean) => void;
  /* THE WRITE ERROR RENDERS BESIDE THE CONTROL THAT FAILED, keyed on the row. `revert` re-syncs the
   * inputs from the stored values so a refused number does not sit there looking saved. */
  writeErr: { key: string; message: string } | null;
  revert: number;
  sort: GoalSort; setSort?: (s: GoalSort) => void;
  grain?: Grain; setGrain?: (g: Grain) => void;
  showDormant?: boolean; setShowDormant?: (v: boolean) => void;
  onAddRow?: () => void; onRename?: (r: Row, name: string) => void; onRemoveRow?: (r: Row) => void;
  onCity?: (r: Row, city: string) => void;
  /** The 1st of a month: no completed day, so every current-month figure is a dash. */
  noCompletedDay?: boolean;
  testId: string;
  /** The baseline month, whether it has no figure, and the live month's completed days. */
  baseIdx: number; noBase: boolean; liveDays: number;
}) {
  const decKey = monthKey(year, DEC);
  const baseIsLive = baseIdx === cur;
  /* THE ORDER, AND THE FOLD. Sorting is on the GAP the row shows, so a no-goal row (no gap) falls
   * last under every order rather than sitting in the middle of the work as a pretend zero.
   * DORMANT is computed — no match in the BASELINE month and none in the live month so far
   * (isDormantFor) — and folds into one line at the foot. A field that played all September is not
   * dormant on 2 October. It changes the table's LENGTH and nothing else: those rows still count.
   * The gap, and so the gap sort, is measured from the baseline. */
  const withGap = rows.map((r) => {
    const dec = r.targets[decKey] ?? null;
    const base = r.monthly[baseIdx]?.daily ?? 0;
    return { r, name: r.name, city: r.city,
      gapDaily: shownGap(dec, base, "day"),
      gapSort: dec == null ? null : shownGap(dailyIn(dec, unit), dailyIn(base, unit), unit) };
  });
  const ordered = sortGoalRows(withGap, sort);
  const live = ordered.filter((x) => x.r.kind === "slot" || !isDormantFor(x.r, baseIdx, cur));
  const dormant = ordered.filter((x) => x.r.kind !== "slot" && isDormantFor(x.r, baseIdx, cur));
  const shown = showDormant ? [...live, ...dormant] : live;
  return (
    <>
      <h2 className="mb-2 mt-6 flex items-baseline gap-2 text-[15px] font-extrabold">
        {title} <span className="text-[11.5px] font-semibold" style={{ color: "#5C6F66" }} data-testid={`${testId}-count`}>{rows.length}</span>
        {setGrain && grain && <GrainSeg grain={grain} setGrain={setGrain} />}
        {setSort && (
          <span className="inline-flex overflow-hidden rounded-lg border" style={{ borderColor: "#D3DCD8" }} data-testid="fg-sort">
            {([["gap", "By gap"], ["city", "By city"], ["name", "A–Z"]] as const).map(([k, label]) => (
              <button key={k} type="button" data-testid={`fg-sort-${k}`} aria-pressed={sort === k}
                onClick={() => setSort(k)} className="px-2.5 py-1 text-[11.5px] font-bold"
                style={sort === k ? { background: "#003326", color: "#fff" } : { background: "#fff", color: "#3C4F44" }}>
                {label}
              </button>
            ))}
          </span>
        )}
        {onAddRow && (
          <button type="button" data-testid="fg-add-row" onClick={onAddRow} disabled={busy}
            className="ml-auto rounded-lg border px-3 py-1.5 text-[12px] font-bold"
            style={{ background: "#003326", borderColor: "#003326", color: "#fff" }}>+ Add a new field</button>
        )}
      </h2>
      {/* THE TABLE SCROLLS IN ITS OWN CONTAINER, so a narrow screen never scrolls the page. */}
      <div className="overflow-x-auto rounded-xl border-[1.5px]" style={{ borderColor: "#D3DCD8" }}>
        <table className="w-full min-w-[620px] border-collapse bg-white" data-testid={testId}>
          <thead>
            <tr>
              {/* KEYED BY POSITION: on 2 October the live month and the first target are both "Oct". */}
              {([
                ["Field", "left"], ["Progress", "left"],
                ...(baseIsLive ? [] : [[MONTH_LABELS[baseIdx], "right", "base"]]),
                [MONTH_LABELS[cur], "right", "live"], ["Oct", "right"], ["Nov", "right"], ["Dec", "right"], ["Gap", "right"], ["Actions", "left"],
              ] as [string, string, string?][]).map(([h, align, tag], i) => (
                <th key={i} className={`whitespace-nowrap border-b px-3 py-2 text-[10px] font-extrabold uppercase tracking-wider text-${align}`}
                  style={{ color: "#5C6F66", background: "#F2F4F3", borderColor: "#D3DCD8" }}>
                  {h}
                  {tag === "base" && <BaselineTag />}
                  {tag === "live" && (baseIsLive ? <BaselineTag /> : <DaysTag days={liveDays} />)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map(({ r }) => {
              const liveV = r.monthly[cur]?.daily ?? 0;
              const base = r.monthly[baseIdx]?.daily ?? 0;
              const dec = r.targets[decKey] ?? null;
              const noGoal = dec == null;
              const gap = noGoal ? 0 : shownGap(dec, base, "day") as number;   // daily: the dot's colour
              const over = !noGoal && gap < 0;
              const openN = r.actions.filter((a) => !a.done).length;
              const out = r.notCounted === true;   // deliberate, stored, and out of every total
              const dormantHere = r.kind !== "slot" && isDormantFor(r, baseIdx, cur);
              return (
                <Fragmentish key={r.key}>
                  <tr data-testid="fg-row" data-key={r.key} data-band={out ? "out" : noGoal ? "none" : bandForDisplay(gap)}
                    data-counted={out ? "0" : "1"} data-dormant={dormantHere ? "1" : "0"}
                    style={out ? { opacity: 0.55 } : undefined}
                    className="cursor-pointer hover:bg-[#FAFCFB]"
                    onClick={(e) => { if ((e.target as HTMLElement).closest("input,button")) return; setOpen(open === r.key ? null : r.key); }}>
                    <td className="border-t px-3 py-2 text-[13px]" style={{ borderColor: "#EDF2EF" }}>
                      <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full align-middle" data-testid="fg-dot"
                        style={{ background: out || noGoal || noBase ? "#C3CEC8" : BAND_HUE[bandForDisplay(gap)] }} />
                      {r.kind === "slot" && onRename ? (
                        <input key={`${r.key}-${revert}`} data-testid="fg-slot-name" defaultValue={r.name} disabled={busy}
                          onBlur={(e) => { if (e.target.value.trim() !== r.name) onRename(r, e.target.value); }}
                          className="w-[210px] rounded-md border border-transparent px-1.5 py-0.5 text-[13px] font-bold hover:border-[#D3DCD8] focus:border-[#2CDB87] focus:outline-none" />
                      ) : (
                        <><b className="font-bold">{r.name}</b>{r.city && <span className="ml-1.5 text-[11px]" style={{ color: "#9AA8A1" }}>{r.city}</span>}
                          {/* THE MARK STAYS VISIBLE. Hiding an excluded field would mean nobody
                              ever reviews the decision. */}
                          {out && <span className="ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-bold" data-testid="fg-notcounted"
                            style={{ background: "#EEF3F0", color: "#5C6F66" }}>not counted</span>}</>
                      )}
                      {/* THE CITY, TYPED, and it is what puts this row in a city row rather than in
                          the "No city set" bucket. Placeholder rather than a label: a state that
                          belongs on a row goes on the row. */}
                      {r.kind === "slot" && onCity && (
                        <input key={`${r.key}-city-${revert}`} data-testid="fg-slot-city" defaultValue={r.city ?? ""}
                          disabled={busy} placeholder="city" aria-label={`City for ${r.name}`}
                          onBlur={(e) => { if (e.target.value.trim() !== (r.city ?? "")) onCity(r, e.target.value); }}
                          className="ml-1 w-[110px] rounded-md border border-transparent px-1.5 py-0.5 text-[11.5px] hover:border-[#D3DCD8] focus:border-[#2CDB87] focus:outline-none"
                          style={{ color: r.city ? "#5C6F66" : "#9AA8A1" }} />
                      )}
                      {r.kind === "slot" && onRemoveRow && (
                        <button type="button" data-testid="fg-slot-remove" aria-label={`Remove ${r.name}`} disabled={busy}
                          onClick={() => onRemoveRow(r)} className="ml-1 px-1 text-[15px]" style={{ color: "#9AA8A1" }}>×</button>
                      )}
                    </td>
                    <td className="border-t px-3 py-2" style={{ borderColor: "#EDF2EF" }}>
                      {!noGoal && !noBase && (
                        <span className="relative inline-block h-[7px] w-24 overflow-hidden rounded-full border align-middle" style={{ background: "#F2F4F3", borderColor: "#D3DCD8" }}>
                          <i className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${dec > 0 ? Math.min(100, (base / dec) * 100) : 100}%`, background: over ? "#12694A" : "#2CDB87" }} />
                        </span>
                      )}
                    </td>
                    {!baseIsLive && (
                      <td className="border-t px-3 py-2 text-right text-[13px] tabular-nums" style={{ borderColor: "#EDF2EF" }} data-testid="fg-base">
                        {r.kind === "slot" ? <span style={{ color: "#C3CEC8" }}>{"\u2014"}</span> : fmtUnit(base, unit)}</td>
                    )}
                    <td className="border-t px-3 py-2 text-right text-[13px] tabular-nums" style={{ borderColor: "#EDF2EF", color: baseIsLive ? undefined : "#5C6F66" }} data-testid="fg-actual">
                      {noCompletedDay ? <span style={{ color: "#C3CEC8" }}>{"\u2014"}</span> : fmtUnit(liveV, unit)}</td>
                    {/* THE SAME FOUR CELLS THE CITY DRAWER RENDERS. One component, so a field is
                        editable identically in both grains. */}
                    <GoalCells r={r} year={year} baseIdx={baseIdx} unit={unit} busy={busy} revert={revert}
                      noCompletedDay={noBase} onTarget={onTarget} />
                    <td className="border-t px-3 py-2 text-[11px]" style={{ borderColor: "#EDF2EF" }} data-testid="fg-action-count">
                      {r.actions.length
                        ? <span className="rounded-full px-2 py-0.5 font-bold" style={{ background: "#EEF3F0", color: "#5C6F66" }}>{openN} open</span>
                        : <span style={{ color: "#9AA8A1" }}>—</span>}
                    </td>
                  </tr>
                  {/* IN PLACE, NOT INSTEAD OF THE PAGE. The table is fine; one control was refused. */}
                  {writeErr?.key === r.key && (
                    <tr data-testid="fg-write-error" data-key={r.key}>
                      <td colSpan={8 + (baseIsLive ? 0 : 1)} className="px-3 pb-2 text-[12px]" style={{ color: "#A8341F", background: "#FDF3EF" }}>
                        {writeErr.message}
                      </td>
                    </tr>
                  )}
                  {open === r.key && (
                    <tr data-testid="fg-actions-row"><td colSpan={8 + (baseIsLive ? 0 : 1)} className="px-3 pb-3" style={{ background: "#FAFCFB" }}>
                      <ActionsDrawer r={r} busy={busy} draft={draft} setDraft={setDraft}
                        onAddAction={onAddAction} onToggleAction={onToggleAction}
                        onRemoveAction={onRemoveAction} onNotCounted={onNotCounted} />
                    </td></tr>
                  )}
                </Fragmentish>
              );
            })}
          </tbody>
        </table>
      </div>
      {writeErr?.key === testId && (
        <p data-testid="fg-write-error" data-key={testId} className="mt-1.5 rounded-md px-2.5 py-1.5 text-[12px]"
          style={{ color: "#A8341F", background: "#FDF3EF" }}>{writeErr.message}</p>
      )}
      {/* ONE LINE, FOLDED AWAY AND NOT DELETED: the rows are one press from view and their goals and
          actions survive. They still count in every total and in the year chart — dormancy is about
          the table's length, not the arithmetic. */}
      {setShowDormant && dormant.length > 0 && (
        <button type="button" data-testid="fg-dormant-toggle" data-count={dormant.length}
          onClick={() => setShowDormant(!showDormant)}
          className="mt-1.5 text-[11.5px] font-semibold underline underline-offset-2"
          style={{ color: "#5C6F66" }}>
          {showDormant ? "Hide" : "Show"} {dormant.length} dormant — no match {baseIsLive ? `this ${MONTH_LABELS[cur]}` : `in ${MONTH_LABELS[baseIdx]} or ${MONTH_LABELS[cur]} so far`}
        </button>
      )}
    </>
  );
}

/* A SUGGESTED GOAL IS NOT A SET ONE, and it says so by being grey and italic. Typing over it stores
 * a number and it stops being a suggestion; clearing it hands the cell back to the ramp. */
export function GoalInput({ value, suggested, onCommit, testId, disabled, title, placeholder, revert, widthClass = "w-14" }: {
  value: string; suggested: boolean; onCommit: (v: number | null) => void;
  testId: string; disabled: boolean; title: string; placeholder?: string; revert: number;
  /** The 2027 plan edits monthly spots, which need more room than a one-decimal daily figure. */
  widthClass?: string;
}) {
  const [local, setLocal] = useState(value);
  // `revert` is in the deps on purpose: a refused write bumps it, and the cell goes back to the
  // stored value rather than sitting there showing a number the database never took.
  useEffect(() => { setLocal(value); }, [value, revert]);
  return (
    <input
      data-testid={testId} data-suggested={suggested ? "1" : "0"} title={title} disabled={disabled}
      value={local} placeholder={placeholder ?? "—"} inputMode="decimal"
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => {
        if (local.trim() === "") { if (value !== "") onCommit(null); return; }
        const n = Number(local);
        if (!Number.isFinite(n) || n < 0) { setLocal(value); return; }
        if (local !== value) onCommit(n);
      }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      className={`${widthClass} rounded-md border border-transparent px-1.5 py-0.5 text-right text-[13px] tabular-nums hover:border-[#D3DCD8] hover:bg-white focus:border-[#2CDB87] focus:bg-white focus:outline-none ${suggested ? "italic" : "font-semibold"}`}
      style={{ color: suggested ? "#9AA8A1" : "#003326" }}
    />
  );
}

// A table row and its action drawer are siblings, so they cannot be wrapped in a div.
function Fragmentish({ children }: { children: React.ReactNode }) { return <>{children}</>; }
