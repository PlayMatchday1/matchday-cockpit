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
import { useAuth } from "@/lib/useAuth";
import { isConfined, confinedCityName } from "@/lib/cityConfinement";
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
  /** growth_cities.id — every row on this page has one since 0253. */
  cityId?: string;
  /** A new field's Field Pipeline card (field_goal_rows.kanban_card_id). */
  kanbanCardId?: string | null;
  notCounted: boolean;
  matches: number; monthly: MonthCell[]; targets: Record<string, number>; actions: Action[];
};
/** A growth_cities row as the route sends it. `hasMatches`: its fields have recorded matches, so
 *  it can be hidden but not removed. */
type City = { id: string; name: string; shortCode: string | null; decGoal: number; hidden: boolean; sortOrder: number; hasMatches: boolean };
type Payload = { year: number; today: string; currentMonth: number; months: MonthCell[]; rows: Row[]; slots: Row[]; cities: City[]; hiddenCities: City[] };
type PipelineCard = { id: string; title: string; stage: string };
/** The one dialog open at a time. */
type DialogState =
  | { kind: "add" }
  | { kind: "goal"; city: City }
  | { kind: "rename"; city: City }
  | { kind: "remove"; city: City; newFields: number };

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
  /* READ ONLY INSIDE A CITY BOUNDARY (Ryan, 2026-10-31). The route sends only the account's own city
   * and 0170's policy refuses its writes; this disables every control so none is offered. Every
   * input on the page is already disabled by `busy`, so `locked` stands in for it below. */
  const { appUser } = useAuth();
  const readOnly = isConfined(appUser);
  const locked = busy || readOnly;
  const [nonce, setNonce] = useState(0);
  const [draft, setDraft] = useState<Record<string, string>>({});
  /* BY GAP, DESCENDING, BY DEFAULT. The sheet was already in that order and for the same reason: the
   * top of the list is where the work is. It also makes the band rule self-evident — in gap order
   * the dots run red, amber, green, dark in sequence, which alphabetical order scrambles. */
  const [sort, setSort] = useState<GoalSort>("gap");
  /* DORMANT FOLDS PER CITY now that the field table is gone: the toggle lives inside each open city. */
  const [showDormantIn, setShowDormantIn] = useState<Set<string>>(() => new Set());
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [dialogErr, setDialogErr] = useState<string | null>(null);
  /** The city whose "+ Add field" input is open, if any. */
  const [addingIn, setAddingIn] = useState<string | null>(null);
  const [cards, setCards] = useState<PipelineCard[]>([]);
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

  /* ── A NEW FIELD IS ALWAYS CREATED INSIDE A CITY (2026-11-04) ─────────────────────────────────
   * The global "+ Add a new field" inserted a row named "New Field - " with no city; five of those
   * from one afternoon had to be deleted by hand. Now the only way in is "+ Add field to <City>",
   * which asks for the name first and writes the city with it — there is no city-less insert left. */
  const addFieldToCity = useCallback(async (city: City, name: string): Promise<boolean> => {
    const n = name.trim();
    if (!n) return false;
    setBusy(true);
    try {
      const { error } = await supabase.from("field_goal_rows")
        .insert({ slot_name: n, city: city.name, growth_city_id: city.id, sort_order: Date.now() % 1e6 });
      if (error) { failed(`city:${city.id}`, error); return false; }
      saved();
      return true;
    } finally { setBusy(false); }
  }, [failed, saved]);

  /** Link (or unlink, with null) a new field's Field Pipeline card. */
  const linkCard = useCallback(async (r: Row, cardId: string | null) => {
    if (!r.rowId) return;
    const { error } = await supabase.from("field_goal_rows").update({ kanban_card_id: cardId }).eq("id", r.rowId);
    if (error) { failed(r.key, error); return; }
    saved();
  }, [failed, saved]);

  /* ── THE CITY WRITES. Each one is a single statement against growth_cities, under the same 0170
   * policy as the goal tables (growth_pages_readable), and a refusal is shown in the dialog that
   * asked for it rather than closing it. */
  const cityWrite = useCallback(async (run: () => PromiseLike<{ error: unknown }>): Promise<boolean> => {
    setBusy(true); setDialogErr(null);
    try {
      const { error } = await run();
      if (error) { setDialogErr(errorText(error, "That did not save.")); return false; }
      setDialog(null); saved();
      return true;
    } finally { setBusy(false); }
  }, [saved]);
  const addCity = useCallback((name: string, code: string, goal: number) => cityWrite(() =>
    supabase.from("growth_cities").insert({ name: name.trim(), short_code: code.trim().toUpperCase() || null,
      dec_goal_daily: goal, sort_order: Date.now() % 1e6 })), [cityWrite]);
  const setCityGoal = useCallback((c: City, goal: number) => cityWrite(() =>
    supabase.from("growth_cities").update({ dec_goal_daily: goal }).eq("id", c.id)), [cityWrite]);
  /* A RENAME MOVES THE LABEL, NOT THE LINKS: existing fields find the city by short code and new
   * fields by id. The new fields' legacy `city` text is kept in step so nothing reading it drifts. */
  const renameCity = useCallback((c: City, name: string) => cityWrite(async () => {
    const r1 = await supabase.from("growth_cities").update({ name: name.trim() }).eq("id", c.id);
    if (r1.error) return r1;
    return supabase.from("field_goal_rows").update({ city: name.trim() }).eq("growth_city_id", c.id);
  }), [cityWrite]);
  /* REMOVE ONLY WHAT HAS NO HISTORY. The route says whether a city's fields have recorded matches;
   * one that does is HIDDEN (nothing deleted, back from the Cities header), one that does not is
   * deleted, and its new fields and their goals go with it (ON DELETE CASCADE, 0253). */
  const removeCity = useCallback((c: City) => cityWrite(() =>
    c.hasMatches
      ? supabase.from("growth_cities").update({ hidden: true, hidden_at: new Date().toISOString(), hidden_by: appUser?.email ?? null }).eq("id", c.id)
      : supabase.from("growth_cities").delete().eq("id", c.id)), [cityWrite, appUser]);
  const unhideCity = useCallback((c: City) => cityWrite(() =>
    supabase.from("growth_cities").update({ hidden: false, hidden_at: null, hidden_by: null }).eq("id", c.id)), [cityWrite]);

  /* THE PIPELINE CARDS a new field can link to. Read once; a failure leaves the picker empty and
   * says nothing louder, because the link is optional and the page's numbers do not depend on it. */
  useEffect(() => {
    void supabase.from("kanban_cards").select("id, title, stage").eq("board_type", "field_pipeline").neq("stage", "archived")
      .order("title").then(({ data: d }) => setCards((d ?? []) as PipelineCard[]));
  }, []);

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
  /* THE STORED CITIES DRIVE THE ROWS AND THEIR DECEMBER (Ryan, 2026-11-04): every city in
   * growth_cities is a row even with no fields yet, and its December is the goal stored on it. */
  const storedCities = useMemo(() => (data?.cities ?? []).map((c) => ({ id: c.id, name: c.name, decGoal: c.decGoal })), [data]);
  const cityByName = useMemo(() => new Map((data?.cities ?? []).map((c) => [c.name, c])), [data]);
  const cities = useMemo(
    () => cityRollup(all, data?.year ?? 2026, cur, sort, baseIdx, unit, { cities: storedCities }),
    [all, data?.year, cur, sort, baseIdx, unit, storedCities]);
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


  /* THE EARLY RETURN IS FOR A LOAD FAILURE AND NOTHING ELSE. A page that cannot read its data must
   * not pretend to render; a page whose last write was refused must not blank itself. */
  if (loadErr) return <p className="p-6 text-[13px] text-red-700" data-testid="fg-error">{loadErr}</p>;
  if (!data) return <p className="p-8 text-center text-[13px]" style={{ color: "#8C9E93" }}>Loading…</p>;

  const u = unit === "day" ? "matches a day" : "matches a week";
  const pct = totals.goal > 0 ? Math.min(100, (totals.now / totals.goal) * 100) : 0;

  return (
    <div className="px-4 pb-16 pt-3" data-testid="fg-page">
      <h1 className="mb-3 text-[27px] font-black uppercase tracking-tight" style={{ color: "#003326" }}>{data.year} Daily Matches</h1>
      {readOnly && (
        <p className="mb-3 text-[12.5px]" data-testid="fg-scope" style={{ color: "#5C6F66" }}>
          {confinedCityName(appUser) ?? "Your city"} only, read only. Goals are set from an account without a city boundary.
        </p>
      )}

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

      <CityChart cities={cities} unit={unit} baseIdx={baseIdx} noCompletedDay={noBase} />

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

      <CityTable
        cities={cities} totals={cityTot} unit={unit} cur={cur} noCompletedDay={noCompletedDay}
        baseIdx={baseIdx} noBase={noBase} liveDays={liveDays}
        sort={sort} setSort={setSort}
        openCities={openCities} toggleCity={toggleCity}
        rowByKey={rowByKey} year={data.year} busy={locked} revert={revert}
        onTarget={setTarget} open={open} setOpen={setOpen} draft={draft} setDraft={setDraft}
        onAddAction={addAction} onToggleAction={toggleAction} onRemoveAction={removeAction}
        onNotCounted={setNotCounted} writeErr={writeErr}
        showHistory={showHistory} setShowHistory={setShowHistory}
        cityByName={cityByName} hiddenCities={data.hiddenCities ?? []} readOnly={readOnly}
        onOpenDialog={(d) => { setDialogErr(null); setDialog(d); }} onUnhide={unhideCity}
        showDormantIn={showDormantIn} setShowDormantIn={setShowDormantIn}
        addingIn={addingIn} setAddingIn={setAddingIn} onAddField={addFieldToCity}
        onRemoveSlot={removeSlot} onLinkCard={linkCard} cards={cards}
      />
      {dialog && (
        <CityDialog d={dialog} busy={busy} err={dialogErr} totalDec={cityTot.dec}
          onClose={() => { setDialog(null); setDialogErr(null); }}
          onAdd={addCity} onGoal={setCityGoal} onRename={renameCity} onRemove={removeCity} />
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
  cities, totals, unit, cur, noCompletedDay, sort, setSort, openCities, toggleCity,
  rowByKey, year, busy, revert, onTarget, open, setOpen, draft, setDraft,
  onAddAction, onToggleAction, onRemoveAction, onNotCounted, writeErr,
  showHistory, setShowHistory, baseIdx, noBase, liveDays,
  cityByName, hiddenCities, readOnly, onOpenDialog, onUnhide, showDormantIn, setShowDormantIn,
  addingIn, setAddingIn, onAddField, onRemoveSlot, onLinkCard, cards,
}: {
  cityByName: Map<string, City>; hiddenCities: City[]; readOnly: boolean;
  onOpenDialog: (d: DialogState) => void; onUnhide: (c: City) => void;
  showDormantIn: Set<string>; setShowDormantIn: React.Dispatch<React.SetStateAction<Set<string>>>;
  addingIn: string | null; setAddingIn: (k: string | null) => void;
  onAddField: (c: City, name: string) => Promise<boolean>;
  onRemoveSlot: (r: Row) => void; onLinkCard: (r: Row, cardId: string | null) => void; cards: PipelineCard[];
  cities: CityRow[];
  totals: ReturnType<typeof cityTotals>;
  unit: "day" | "week"; cur: number;
  /** The baseline month index, whether it has no figure (month to date on the 1st), and the live
   *  month's completed days for its tag. */
  baseIdx: number; noBase: boolean; liveDays: number;
  /** The 1st of a month: no completed day, so every current-month figure is a dash. */
  noCompletedDay?: boolean;
  sort: GoalSort; setSort: (s: GoalSort) => void;
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
  /** Every column a field line spans: City, Progress, history, baseline, live, Oct, Nov, Dec, trend, Gap, Fields, menu. */
  const span = 9 + histIdx.length + (showHistory ? 1 : 0) + (extraBase ? 1 : 0);
  /** The columns between the name and the Dec column (Progress, history, baseline, live, Oct, Nov). */
  const lead = 4 + histIdx.length + (extraBase ? 1 : 0);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  return (
    <>
      <h2 className="mb-2 mt-6 flex flex-wrap items-center gap-2 text-[15px] font-extrabold">
        Cities <span className="rounded-full border px-2 text-[11.5px] font-semibold" style={{ color: "#5C6F66", borderColor: "#D3DCD8" }} data-testid="fg-city-count">{cities.length}</span>
        <span className="ml-1 inline-flex overflow-hidden rounded-lg border" style={{ borderColor: "#D3DCD8" }} data-testid="fg-sort">
          {([["gap", "By gap"], ["city", "By city"], ["name", "A–Z"]] as const).map(([k, label]) => (
            <button key={k} type="button" data-testid={`fg-sort-${k}`} aria-pressed={sort === k}
              onClick={() => setSort(k)} className="px-2.5 py-1 text-[11.5px] font-bold"
              style={{ minHeight: 32, ...(sort === k ? { background: "#003326", color: "#fff" } : { background: "#fff", color: "#3C4F44" }) }}>
              {label}
            </button>
          ))}
        </span>
        <HistorySeg on={showHistory} set={setShowHistory} />
        <span className="ml-auto flex items-center gap-2">
          {/* A HIDDEN CITY COMES BACK FROM HERE. Its row is off the page, so its own ••• menu is not
              reachable; this is the city menu for the cities that are not on screen. */}
          {hiddenCities.length > 0 && (
            <span className="relative">
              <button type="button" data-testid="fg-hidden-cities" onClick={() => setHiddenOpen(!hiddenOpen)}
                className="rounded-lg border px-2.5 py-1 text-[11.5px] font-bold" style={{ minHeight: 32, borderColor: "#D3DCD8", background: "#fff", color: "#3C4F44" }}>
                {hiddenCities.length} hidden
              </button>
              {hiddenOpen && (
                <span className="absolute right-0 top-full z-20 mt-1 flex w-56 flex-col rounded-xl border bg-white py-1 shadow-lg" style={{ borderColor: "#D3DCD8" }}>
                  {hiddenCities.map((c) => (
                    <button key={c.id} type="button" disabled={busy || readOnly} data-testid="fg-unhide"
                      onClick={() => { setHiddenOpen(false); onUnhide(c); }}
                      className="px-3 py-2 text-left text-[12.5px] font-semibold hover:bg-[#F2F4F3]" style={{ color: "#003326" }}>
                      Show {c.name} again
                    </button>
                  ))}
                </span>
              )}
            </span>
          )}
          {!readOnly && (
            <button type="button" data-testid="fg-add-city" disabled={busy} onClick={() => onOpenDialog({ kind: "add" })}
              className="rounded-lg px-3.5 py-1.5 text-[12.5px] font-bold text-white" style={{ minHeight: 32, background: "#003326" }}>
              + Add city
            </button>
          )}
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
                <td /><td /><td /><td />
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
              {["Gap", "Fields"].map((h) => (
                <th key={h} className="whitespace-nowrap border-b px-3 py-2 text-right text-[10px] font-extrabold uppercase tracking-wider"
                  style={{ color: "#5C6F66", background: "#F2F4F3", borderColor: "#D3DCD8" }}>{h}</th>
              ))}
              <th className="border-b" style={{ background: "#F2F4F3", borderColor: "#D3DCD8", width: 40 }} aria-label="City menu" />
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
                    {/* "N fields" AND A "+N new" PILL (2026-11-04). The "· N no goal" note is gone: an empty
                        goal now shows on the field itself as an amber "Set". */}
                    <td className="whitespace-nowrap border-t px-3 py-2 text-right text-[11.5px]" style={{ borderColor: "#EDF2EF", color: "#5C6F66" }} data-testid="fields">
                      {(() => { const n = c.fields.filter((f) => f.kind === "existing").length; return `${n} ${n === 1 ? "field" : "fields"}`; })()}
                      {c.fields.some((f) => f.kind === "slot") && (
                        <span data-testid="fg-newpill" className="ml-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-bold" style={{ background: "#E3F5EA", color: "#12694A" }}>
                          +{c.fields.filter((f) => f.kind === "slot").length} new
                        </span>
                      )}
                    </td>
                    <td className="relative border-t px-2 py-2 text-center" style={{ borderColor: "#EDF2EF" }} onClick={(e) => e.stopPropagation()}>
                      {!readOnly && cityByName.get(c.city) && (
                        <CityMenu open={menuFor === c.city} setOpen={(v) => setMenuFor(v ? c.city : null)} busy={busy}
                          onGoal={() => onOpenDialog({ kind: "goal", city: cityByName.get(c.city)! })}
                          onAddField={() => { if (!isOpen) toggleCity(c.city); setAddingIn(cityByName.get(c.city)!.id); }}
                          onRename={() => onOpenDialog({ kind: "rename", city: cityByName.get(c.city)! })}
                          onRemove={() => onOpenDialog({ kind: "remove", city: cityByName.get(c.city)!, newFields: c.fields.filter((f) => f.kind === "slot").length })} />
                      )}
                    </td>
                  </tr>
                  {isOpen && (() => {
                    const city = cityByName.get(c.city);
                    const fieldTr = (f: CityFieldRow) => (
                      <CityFieldTr key={f.key} f={f} city={c.city} row={rowByKey.get(f.key)}
                        unit={unit} cur={cur} year={year} busy={busy} revert={revert}
                        noCompletedDay={noCompletedDay} onTarget={onTarget}
                        open={open} setOpen={setOpen} draft={draft} setDraft={setDraft}
                        onAddAction={onAddAction} onToggleAction={onToggleAction}
                        onRemoveAction={onRemoveAction} onNotCounted={onNotCounted} writeErr={writeErr}
                        histIdx={histIdx} showHistory={showHistory} rule={rule}
                        baseIdx={baseIdx} noBase={noBase} extraBase={extraBase} baseHistAt={baseHistAt} />
                    );
                    const existing = c.fields.filter((f) => f.kind === "existing");
                    const newFields = c.fields.filter((f) => f.kind === "slot");
                    /* DORMANT FOLDS INSIDE THE CITY: no match in the baseline month nor the live one so
                       far (isDormantFor). It changes the list's length and nothing else — those rows
                       still count toward the city above them. */
                    const dormant = existing.filter((f) => { const r = rowByKey.get(f.key); return !!r && isDormantFor(r, baseIdx, cur); });
                    const awake = existing.filter((f) => !dormant.includes(f));
                    const showD = showDormantIn.has(c.city);
                    return (
                      <>
                        <SubHead label="Existing fields" span={span} testId="fg-sub-existing" />
                        {(showD ? [...awake, ...dormant] : awake).map(fieldTr)}
                        {dormant.length > 0 && (
                          <tr><td colSpan={span} className="border-t py-1.5 pl-9" style={{ borderColor: "#EDF2EF", background: "#FAFCFB" }}>
                            <button type="button" data-testid="fg-dormant-toggle" data-count={dormant.length}
                              onClick={() => setShowDormantIn((prev) => { const n = new Set(prev); if (n.has(c.city)) n.delete(c.city); else n.add(c.city); return n; })}
                              className="text-[11.5px] font-bold" style={{ color: "#5C6F66" }}>
                              {showD ? "Hide" : "Show"} {dormant.length} dormant — no match {baseIdx === cur ? `this ${MONTH_LABELS[cur]}` : `in ${MONTH_LABELS[baseIdx]} or ${MONTH_LABELS[cur]} so far`}
                            </button>
                          </td></tr>
                        )}
                        <SubHead label={`New fields \u00b7 ${newFields.length}`} span={span} testId="fg-sub-new" />
                        {newFields.map((f) => {
                          const r = rowByKey.get(f.key);
                          return r ? (
                            <NewFieldTr key={f.key} r={r} lead={lead} showHistory={showHistory} unit={unit} year={year}
                              busy={busy || readOnly} revert={revert} onTarget={onTarget} onRemove={onRemoveSlot}
                              onLinkCard={onLinkCard} cards={cards} writeErr={writeErr} span={span} />
                          ) : null;
                        })}
                        {c.unassigned != null && Math.abs(c.unassigned) >= 0.05 && (
                          <UnassignedTr amount={c.unassigned} fieldsDec={c.fieldsDec ?? 0} cityDec={c.dec} lead={lead} showHistory={showHistory} unit={unit} />
                        )}
                        {!readOnly && city && (
                          <AddFieldTr city={city} span={span} busy={busy} adding={addingIn === city.id}
                            setAdding={(v) => setAddingIn(v ? city.id : null)} onAdd={onAddField}
                            err={writeErr?.key === `city:${city.id}` ? writeErr.message : null} />
                        )}
                      </>
                    );
                  })()}
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
              <td className="whitespace-nowrap border-t-2 px-3 py-2 text-right text-[11.5px]" style={{ borderColor: "#D3DCD8", color: "#5C6F66" }}>
                {(() => { const ex = cities.reduce((n, c) => n + c.fields.filter((f) => f.kind === "existing").length, 0);
                  const nw = cities.reduce((n, c) => n + c.fields.filter((f) => f.kind === "slot").length, 0);
                  return <>{ex} fields{nw > 0 && <span className="ml-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-bold" style={{ background: "#E3F5EA", color: "#12694A" }}>+{nw} new</span>}</>; })()}
              </td>
              <td className="border-t-2" style={{ borderColor: "#D3DCD8" }} />
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
        <td className="border-t" style={tdStyle} />
      </tr>
      {/* IN PLACE, NOT INSTEAD OF THE PAGE, exactly as the field table does it. */}
      {row && writeErr?.key === row.key && (
        <tr data-testid="fg-write-error" data-key={row.key}>
          <td colSpan={9 + histIdx.length + (showHistory ? 1 : 0) + (extraBase ? 1 : 0)} className="px-3 pb-2 text-[12px]" style={{ color: "#A8341F", background: "#FDF3EF" }}>
            {writeErr.message}
          </td>
        </tr>
      )}
      {row && isOpen && (
        <tr data-testid="fg-actions-row"><td colSpan={9 + histIdx.length + (showHistory ? 1 : 0) + (extraBase ? 1 : 0)} className="px-3 pb-3 pl-9" style={{ background: TONE.bg }}>
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


/* ── INSIDE AN OPEN CITY (2026-11-04) ─────────────────────────────────────────────────────────
 * "Existing fields", then "New fields · N", then the Unassigned line when the fields do not add up
 * to the city's stored goal, then "+ Add field to <City>". */
function SubHead({ label, span, testId }: { label: string; span: number; testId: string }) {
  return (
    <tr data-testid={testId}>
      <td colSpan={span} className="border-t py-1.5 pl-9 text-[10px] font-extrabold uppercase tracking-[0.12em]"
        style={{ borderColor: "#DCEFE3", background: "#EAF6EE", color: "#12694A" }}>{label}</td>
    </tr>
  );
}

/* A NEW FIELD: no history, so every actual column is a dash; the December goal is typed inline (an
 * empty one is an amber "Set", not "no goal"); the gap is that goal against nothing yet; then its
 * Field Pipeline card and a remove ×. Its Oct/Nov targets are not shown on the row — they are still
 * stored, and still summed into the city's Oct/Nov columns. */
function NewFieldTr({ r, lead, showHistory, unit, year, busy, revert, onTarget, onRemove, onLinkCard, cards, writeErr, span }: {
  r: Row; lead: number; showHistory: boolean; unit: "day" | "week"; year: number; busy: boolean; revert: number;
  onTarget: (r: Row, month: string, v: number | null) => void; onRemove: (r: Row) => void;
  onLinkCard: (r: Row, cardId: string | null) => void; cards: PipelineCard[];
  writeErr: { key: string; message: string } | null; span: number;
}) {
  const [confirm, setConfirm] = useState(false);
  const decKey = monthKey(year, DEC);
  const dec = r.targets[decKey] ?? null;
  const out = r.notCounted === true;
  const st = { borderColor: "#EDF2EF", background: "#fff" };
  const dash = <span style={{ color: "#C3CEC8" }}>{"–"}</span>;
  const card = r.kanbanCardId ? cards.find((c) => c.id === r.kanbanCardId) : undefined;
  return (
    <>
      <tr data-testid="fg-newrow" data-f={r.name} style={out ? { opacity: 0.55 } : undefined}>
        <td className="sticky left-0 z-[1] border-t py-2 pl-9 pr-3 text-[12.5px]" style={{ ...st, color: "#003326" }}>
          {r.name}
          <span className="ml-1.5 rounded-full px-1.5 py-0.5 text-[9.5px] font-extrabold tracking-wide" style={{ background: "#E3F5EA", color: "#12694A" }}>NEW</span>
          {out && <span className="ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-bold" style={{ background: "#EEF3F0", color: "#5C6F66" }}>not counted</span>}
        </td>
        {Array.from({ length: lead }, (_, i) => (
          <td key={i} className="border-t px-3 py-2 text-right text-[12px]" style={st}>{i === 0 ? null : dash}</td>
        ))}
        <td data-m="dec" className="border-t px-3 py-1.5 text-right" style={st}>
          <GoalInput value={dec == null ? "" : fmtUnit(dec, unit)} suggested={false} placeholder="Set" amberEmpty
            revert={revert} testId="fg-goal-Dec" disabled={busy} title="December goal for this field"
            onCommit={(v) => onTarget(r, decKey, v == null ? null : unit === "day" ? v : v / 7)} />
        </td>
        {showHistory && <td className="border-t px-3 py-2 text-right" style={st}>{dash}</td>}
        <td className="border-t px-3 py-2 text-right text-[13px] font-extrabold tabular-nums" style={st} data-testid="fg-gap-cell">
          {dec == null ? dash : <span style={{ color: "#A8341F" }}>{fmtShownSigned(shownGap(dailyIn(dec, unit), 0, unit) as number, unit)}</span>}
        </td>
        <td className="whitespace-nowrap border-t px-3 py-2 text-right text-[11.5px]" style={st}>
          {r.kanbanCardId
            ? <a href={`/growth/field-pipeline?card=${r.kanbanCardId}`} data-testid="fg-pipeline" title={card?.title ?? "Field Pipeline card"}
                className="font-bold" style={{ color: "#12694A" }}>Pipeline →</a>
            /* NO CARD LINKED YET: a picker, because nothing links a new field to a card otherwise and
               guessing one from the name would link the wrong card. */
            : <select data-testid="fg-link-card" disabled={busy || cards.length === 0} value=""
                onChange={(e) => { if (e.target.value) onLinkCard(r, e.target.value); }}
                className="max-w-[120px] rounded-md border bg-white px-1 py-0.5 text-[11px]" style={{ borderColor: "#D3DCD8", color: "#5C6F66" }}>
                <option value="">Link card…</option>
                {cards.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>}
        </td>
        <td className="border-t px-2 py-2 text-center" style={st}>
          {/* TWO PRESSES, because this deletes the field and every goal typed against it. */}
          <button type="button" data-testid="fg-remove-new" disabled={busy}
            aria-label={confirm ? `Confirm removing ${r.name}` : `Remove ${r.name}`}
            onClick={() => { if (confirm) { setConfirm(false); onRemove(r); } else setConfirm(true); }}
            onBlur={() => setConfirm(false)}
            className="rounded px-1 text-[12px] font-bold" style={{ color: confirm ? "#C0392B" : "#9AA8A1" }}>
            {confirm ? "Remove?" : "×"}
          </button>
        </td>
      </tr>
      {writeErr?.key === r.key && (
        <tr data-testid="fg-write-error"><td colSpan={span} className="px-3 pb-2 pl-9 text-[12px]" style={{ color: "#A8341F", background: "#FDF3EF" }}>{writeErr.message}</td></tr>
      )}
    </>
  );
}

/* THE PART OF THE CITY'S GOAL NO FIELD CARRIES — or, negative, how far the fields run past it. */
function UnassignedTr({ amount, fieldsDec, cityDec, lead, showHistory, unit }: {
  amount: number; fieldsDec: number; cityDec: number; lead: number; showHistory: boolean; unit: "day" | "week";
}) {
  const over = amount < 0;
  const st = { borderColor: "#EDF2EF", background: over ? "#FDF3EF" : "#FFFBF0" };
  return (
    <tr data-testid="fg-unassigned" data-over={over ? "1" : "0"}>
      <td className="sticky left-0 z-[1] border-t py-2 pl-9 pr-3 text-[12.5px] italic" style={{ ...st, color: over ? "#A8341F" : "#8A5A12" }}>
        {over ? "Over the city goal" : "Unassigned"}
      </td>
      {Array.from({ length: lead }, (_, i) => <td key={i} className="border-t" style={st} />)}
      <td className="border-t px-3 py-2 text-right text-[13px] font-bold tabular-nums" style={{ ...st, color: over ? "#A8341F" : "#8A5A12" }} data-testid="fg-unassigned-v">
        {over ? fmtShownSigned(dailyIn(amount, unit), unit) : fmtUnit(amount, unit)}
      </td>
      {showHistory && <td className="border-t" style={st} />}
      <td className="border-t" style={st} />
      <td colSpan={2} className="border-t px-3 py-2 text-right text-[11px]" style={{ ...st, color: over ? "#A8341F" : "#8A5A12" }}>
        {over
          ? `Fields add up to ${fmtUnit(fieldsDec, unit)}, over the ${fmtUnit(cityDec, unit)} city goal`
          : `Fields add up to ${fmtUnit(fieldsDec, unit)} of ${fmtUnit(cityDec, unit)}`}
      </td>
    </tr>
  );
}

function AddFieldTr({ city, span, busy, adding, setAdding, onAdd, err }: {
  city: City; span: number; busy: boolean; adding: boolean; setAdding: (v: boolean) => void;
  onAdd: (c: City, name: string) => Promise<boolean>; err: string | null;
}) {
  const [name, setName] = useState("");
  const submit = async () => { if (await onAdd(city, name)) { setName(""); setAdding(false); } };
  return (
    <tr data-testid="fg-addfield-row">
      <td colSpan={span} className="border-t py-2.5 pl-9" style={{ borderColor: "#EDF2EF", background: "#fff" }}>
        {adding ? (
          <span className="flex flex-wrap items-center gap-2">
            <input autoFocus data-testid="fg-addfield-name" value={name} disabled={busy} placeholder="Field name"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void submit(); if (e.key === "Escape") setAdding(false); }}
              className="w-56 rounded-md border px-2 py-1 text-[12.5px]" style={{ borderColor: "#D3DCD8" }} />
            <button type="button" data-testid="fg-addfield-save" disabled={busy || !name.trim()} onClick={() => void submit()}
              className="rounded-md px-3 py-1 text-[12px] font-bold text-white" style={{ background: "#003326", opacity: name.trim() ? 1 : 0.5 }}>Add</button>
            <button type="button" onClick={() => { setName(""); setAdding(false); }} className="px-2 text-[12px] font-bold" style={{ color: "#5C6F66" }}>Cancel</button>
            {err && <span className="text-[12px]" style={{ color: "#A8341F" }}>{err}</span>}
          </span>
        ) : (
          <button type="button" data-testid="fg-addfield" disabled={busy} onClick={() => setAdding(true)}
            className="rounded-lg border border-dashed px-3 py-1.5 text-[12px] font-bold" style={{ borderColor: "#12694A", color: "#12694A" }}>
            + Add field to {city.name}
          </button>
        )}
      </td>
    </tr>
  );
}

function CityMenu({ open, setOpen, busy, onGoal, onAddField, onRename, onRemove }: {
  open: boolean; setOpen: (v: boolean) => void; busy: boolean;
  onGoal: () => void; onAddField: () => void; onRename: () => void; onRemove: () => void;
}) {
  const item = (label: string, fn: () => void, danger = false, testId = "") => (
    <button type="button" data-testid={testId} disabled={busy} onClick={() => { setOpen(false); fn(); }}
      className="block w-full px-4 py-2 text-left text-[12.5px] font-semibold hover:bg-[#F2F4F3]" style={{ color: danger ? "#C0392B" : "#003326" }}>
      {label}
    </button>
  );
  return (
    <span className="relative inline-block">
      <button type="button" data-testid="fg-city-menu" aria-label="City menu" aria-expanded={open} onClick={() => setOpen(!open)}
        className="rounded px-1.5 text-[14px] font-black leading-none" style={{ color: "#9AA8A1" }}>•••</button>
      {open && (
        <span className="absolute right-0 top-full z-20 mt-1 block w-48 rounded-xl border bg-white py-1 text-left shadow-lg" style={{ borderColor: "#D3DCD8" }}>
          {item("Edit December goal", onGoal, false, "fg-menu-goal")}
          {item("Add field", onAddField, false, "fg-menu-addfield")}
          {item("Rename city", onRename, false, "fg-menu-rename")}
          {item("Remove city", onRemove, true, "fg-menu-remove")}
        </span>
      )}
    </span>
  );
}

/* ── THE CITY DIALOGS ─────────────────────────────────────────────────────────────────────────
 * Add, edit goal, rename, and remove — which becomes HIDE for a city whose fields have recorded
 * matches, and says so, because deleting it would orphan history. */
function CityDialog({ d, busy, err, totalDec, onClose, onAdd, onGoal, onRename, onRemove }: {
  d: DialogState; busy: boolean; err: string | null; totalDec: number; onClose: () => void;
  onAdd: (name: string, code: string, goal: number) => Promise<boolean>;
  onGoal: (c: City, goal: number) => Promise<boolean>;
  onRename: (c: City, name: string) => Promise<boolean>;
  onRemove: (c: City) => Promise<boolean>;
}) {
  const [name, setName] = useState(d.kind === "rename" ? d.city.name : "");
  const [code, setCode] = useState("");
  const [goal, setGoal] = useState(d.kind === "goal" ? String(d.city.decGoal) : "");
  const goalN = Number(goal);
  const goalOk = goal.trim() !== "" && Number.isFinite(goalN) && goalN >= 0;
  const codeOk = /^[A-Za-z]{2,5}$/.test(code.trim());
  const label = "text-[10.5px] font-extrabold uppercase tracking-widest";
  const input = "w-full rounded-xl border px-3 py-2.5 text-[14px]";
  const btn = "rounded-xl px-4 py-2.5 text-[13px] font-bold";
  const r1 = (v: number) => roundTo(v, 1).toFixed(1);
  let title = "", body: ReactNode = null, action: ReactNode = null;
  if (d.kind === "add") {
    title = "Add a city";
    body = (<>
      <p className="mb-4 text-[12.5px]" style={{ color: "#6B7C73" }}>It shows up in the chart and table right away.</p>
      <div className="mb-4 flex gap-3">
        <label className="flex-1"><span className={label} style={{ color: "#5C6F66" }}>City name</span>
          <input autoFocus data-testid="fg-dlg-name" className={`mt-1.5 ${input}`} style={{ borderColor: "#D3DCD8" }} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="w-[110px]"><span className={label} style={{ color: "#5C6F66" }}>Short code</span>
          <input data-testid="fg-dlg-code" className={`mt-1.5 ${input} uppercase`} style={{ borderColor: "#D3DCD8" }} maxLength={5} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} /></label>
      </div>
      <label className="block"><span className={label} style={{ color: "#5C6F66" }}>December goal (matches a day)</span>
        <input data-testid="fg-dlg-goal" inputMode="decimal" placeholder="e.g. 1.0" className={`mt-1.5 ${input}`} style={{ borderColor: "#D3DCD8" }} value={goal} onChange={(e) => setGoal(e.target.value)} /></label>
      <p className="mt-3 text-[12px]" style={{ color: "#6B7C73" }}>
        The short code is the city&apos;s MatchDay code (ATX, DFW…); its fields join it by that code. You can add fields to it from the table after it is created.
      </p>
    </>);
    action = <button type="button" data-testid="fg-dlg-ok" disabled={busy || !name.trim() || !codeOk || !goalOk}
      onClick={() => void onAdd(name, code, goalN)} className={`${btn} text-white`} style={{ background: "#003326", opacity: name.trim() && codeOk && goalOk ? 1 : 0.5 }}>Add city</button>;
  } else if (d.kind === "goal") {
    title = `${d.city.name} December goal`;
    body = (<label className="block"><span className={label} style={{ color: "#5C6F66" }}>Matches a day</span>
      <input autoFocus data-testid="fg-dlg-goal" inputMode="decimal" className={`mt-1.5 ${input}`} style={{ borderColor: "#D3DCD8" }} value={goal} onChange={(e) => setGoal(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && goalOk) void onGoal(d.city, goalN); }} />
      <p className="mt-3 text-[12px]" style={{ color: "#6B7C73" }}>The December total goes from {r1(totalDec)} to {goalOk ? r1(totalDec - d.city.decGoal + goalN) : "—"}.</p></label>);
    action = <button type="button" data-testid="fg-dlg-ok" disabled={busy || !goalOk} onClick={() => void onGoal(d.city, goalN)}
      className={`${btn} text-white`} style={{ background: "#003326", opacity: goalOk ? 1 : 0.5 }}>Save goal</button>;
  } else if (d.kind === "rename") {
    title = `Rename ${d.city.name}`;
    body = (<label className="block"><span className={label} style={{ color: "#5C6F66" }}>City name</span>
      <input autoFocus data-testid="fg-dlg-name" className={`mt-1.5 ${input}`} style={{ borderColor: "#D3DCD8" }} value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) void onRename(d.city, name); }} /></label>);
    action = <button type="button" data-testid="fg-dlg-ok" disabled={busy || !name.trim() || name.trim() === d.city.name} onClick={() => void onRename(d.city, name)}
      className={`${btn} text-white`} style={{ background: "#003326" }}>Rename</button>;
  } else {
    const c = d.city;
    if (c.hasMatches) {
      title = `Hide ${c.name}?`;
      body = <p className="text-[13px]" style={{ color: "#6B7C73" }}>{c.name} has fields with recorded matches, so it is hidden from this page instead of deleted. History stays intact, and you can bring it back from &ldquo;hidden&rdquo; beside the Cities heading. The December total drops from {r1(totalDec)} to {r1(totalDec - c.decGoal)} while it is hidden.</p>;
      action = <button type="button" data-testid="fg-dlg-ok" disabled={busy} onClick={() => void onRemove(c)} className={`${btn} text-white`} style={{ background: "#D9483B" }}>Hide city</button>;
    } else {
      title = `Remove ${c.name}?`;
      body = <p className="text-[13px]" style={{ color: "#6B7C73" }}>
        {d.newFields > 0 ? `Its ${d.newFields} new ${d.newFields === 1 ? "field" : "fields"} and its` : "Its"} {r1(c.decGoal)} a day December goal come off the page. The December total drops from {r1(totalDec)} to {r1(totalDec - c.decGoal)}.
      </p>;
      action = <button type="button" data-testid="fg-dlg-ok" disabled={busy} onClick={() => void onRemove(c)} className={`${btn} text-white`} style={{ background: "#D9483B" }}>Remove city</button>;
    }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: "rgba(0,26,19,0.35)" }} onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} data-testid="fg-dialog" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
        className="w-full max-w-[420px] rounded-2xl bg-white p-6 shadow-xl">
        <h3 className="mb-1 text-[19px] font-black" style={{ color: "#003326" }}>{title}</h3>
        {body}
        {err && <p className="mt-3 text-[12.5px]" style={{ color: "#A8341F" }} data-testid="fg-dlg-err">{err}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={`${btn} border`} style={{ borderColor: "#D3DCD8", color: "#003326" }}>Cancel</button>
          {action}
        </div>
      </div>
    </div>
  );
}

/* A SUGGESTED GOAL IS NOT A SET ONE, and it says so by being grey and italic. Typing over it stores
 * a number and it stops being a suggestion; clearing it hands the cell back to the ramp. */
export function GoalInput({ value, suggested, onCommit, testId, disabled, title, placeholder, revert, widthClass = "w-14", amberEmpty = false }: {
  value: string; suggested: boolean; onCommit: (v: number | null) => void;
  testId: string; disabled: boolean; title: string; placeholder?: string; revert: number;
  /** The 2027 plan edits monthly spots, which need more room than a one-decimal daily figure. */
  widthClass?: string;
  /** An empty goal reads as an amber "Set" box rather than a quiet dash (new fields, 2026-11-04). */
  amberEmpty?: boolean;
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
      className={`${amberEmpty ? "w-16 border-[1.5px] placeholder:text-center placeholder:font-semibold placeholder:text-[#D08A1E]" : `${widthClass} border border-transparent hover:border-[#D3DCD8]`} rounded-md px-1.5 py-0.5 text-right text-[13px] tabular-nums hover:bg-white focus:border-[#2CDB87] focus:bg-white focus:outline-none ${suggested ? "italic" : "font-semibold"}`}
      style={{ color: suggested ? "#9AA8A1" : "#003326",
               ...(amberEmpty ? { borderColor: local.trim() === "" ? "#E8A33F" : "#D3DCD8", background: local.trim() === "" ? "#FFFBF0" : "#fff" } : {}) }}
    />
  );
}

// A table row and its action drawer are siblings, so they cannot be wrapped in a div.
function Fragmentish({ children }: { children: React.ReactNode }) { return <>{children}</>; }
