"use client";

/* 2027 OPERATIONS PLAN — the 2026 Daily Matches page, one year on, grouped by region.
 *
 * Ryan, 2026-10-02: "It is the 2027 version of that page, grouped by region, and it must have the
 * same working functionality" — add and remove fields and cities, edit the estimates, and show
 * estimate against actual, and fields / anchors / satellites as actual against plan.
 *
 * ONE SYSTEM, NOT TWO. The fields are field_goal_rows, the estimates field_goal_targets (in spots),
 * the actuals the 2026 route's own pipeline; the controls are the 2026 page's (Big, GoalInput, the
 * grain and history toggles). What is new is the plan's own vocabulary — regions, plan cities, a
 * field's planned type and opening month — in 0199's tables.
 *
 * EVERY TOTAL IS THE SUM OF ITS PARTS, IN SPOTS. A city is the sum of its rows, a region of its
 * cities, All MatchDay of its regions — lib/opsPlan.rollFields / sumRollups, which the guard suite
 * asserts. Daily and weekly are each level's own spots ÷ 18 ÷ the real days of the month; the
 * Spots unit is the one where every column adds up to the tenth on screen.
 *
 * WRITES go straight to PostgREST with the operator's token under 0199's growth policies, exactly as
 * the 2026 page's do. Any write that touches two tables is one of 0199's functions, so it lands
 * whole or not at all. Removal is a status, never a DELETE — except a hire, which feeds nothing.
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { errorText } from "@/lib/errorText";
import { MONTH_LABELS, SPOTS_PER_MATCH, baselineMonth, roundTo, type CompareFrom } from "@/lib/fieldGoals";
import {
  ANCHOR_SETTING_KEY, FORECAST_DEC_2026_SPOTS, PLAN_YEAR, START_MONTH, addMonths, daysInMonthOf,
  estimateAt, fieldFlags, fmtPlan, inPlan, isActualAnchor, isActuallyLive, isDefaultEstimate, planMonthKeys,
  rollFields, shortMonth, sortCities, spotsToUnit, sumRollups, sumSpots, unitToSpots,
  type Counts, type PlanField, type PlanSort, type PlanType, type Rollup, type Unit,
} from "@/lib/opsPlan";
import { BaselineTag, Big, CompareSeg, DaysTag, GoalInput, GrainSeg, HistorySeg, type Grain } from "@/components/FieldGoals2026";

async function authFetch(path: string): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(path, { cache: "no-store", headers: token ? { Authorization: `Bearer ${token}` } : {} });
}

type City = { id: string; name: string; regionKey: string; launchMonth: string | null; anchorSlots: number; mature: number;
  status: "active" | "removed"; sortOrder: number; venueAliases: string[]; cityIds: string[] };
type Region = { key: string; name: string; shortName: string; note: string | null; sortOrder: number };
type Hire = { id: string; hireMonth: string; runningMonth: string | null; role: string; kind: "regional_manager" | "hq" | "other";
  regionKey: string | null; notes: string | null; sortOrder: number };
type Payload = {
  setup: "ready" | "unseeded" | "missing"; message?: string;
  year: number; today: string; yesterday: string; currentMonth: string; windowStart: string; threshold: number;
  regions: Region[]; cities: City[]; hires: Hire[]; fields: PlanField[];
  venues: { id: number; name: string | null; city: string | null }[];
};

const INK = "#003326", MUTED = "#5C6F66", FAINT = "#9AA8A1", LINE = "#D3DCD8", HAIR = "#EDF2EF", HEAD = "#F2F4F3";
const CHART_HUE = "#0E8A54", RED = "#A8341F", AMBER = "#8A5A12";
const DASH = "–";
/* THE FORECAST GIVES NO FIELD COUNT FOR PHILADELPHIA (Ryan, 2026-10-02: "leave it empty and flag
 * it"). Its plan count is whatever rows it holds; the flag says the forecast did not supply one. */
const FORECAST_FIELDS_UNKNOWN = new Set(["Philadelphia"]);


export default function OpsPlan2027() {
  const [data, setData] = useState<Payload | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [writeErr, setWriteErr] = useState<{ key: string; message: string } | null>(null);
  const [revert, setRevert] = useState(0);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [unit, setUnit] = useState<Unit>("day");
  const [grain, setGrain] = useState<Grain>("city");
  const [sort, setSort] = useState<PlanSort>("city");
  const [showHistory, setShowHistory] = useState(false);
  const [openCities, setOpenCities] = useState<Set<string>>(() => new Set());
  const [showRemoved, setShowRemoved] = useState(false);
  const [asOfPick, setAsOfPick] = useState<string | null>(null);
  /* COMPARE FROM — the 2026 page's control and lib/fieldGoals.baselineMonth's rule; null follows
   * the rule, a press overrides it for this visit. There is no second copy of the rule here. */
  const [compareOverride, setCompareOverride] = useState<CompareFrom | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await authFetch("/api/growth/ops-plan");
        const j = await res.json();
        if (!live) return;
        if (!res.ok) { setLoadErr(j?.error ?? `Load failed (${res.status})`); return; }
        setData(j as Payload); setLoadErr(null);
      } catch (e) { if (live) setLoadErr(errorText(e, "Failed to load the plan.")); }
    })();
    return () => { live = false; };
  }, [nonce]);

  /* THE 2026 PAGE'S WRITE SHAPE. A refused write keeps its message beside the control, puts the
   * control back, and does NOT reload (the reload is what used to wipe the message). */
  const failed = useCallback((key: string, e: unknown) => {
    setWriteErr({ key, message: errorText(e, "That did not save.") });
    setRevert((n) => n + 1);
  }, []);
  const saved = useCallback(() => { setWriteErr(null); setNonce((n) => n + 1); }, []);
  const run = useCallback(async (key: string, fn: () => PromiseLike<{ error: unknown }>) => {
    setBusy(true);
    try {
      const { error } = await fn();
      if (error) { failed(key, error); return false; }
      saved(); return true;
    } catch (e) { failed(key, e); return false; } finally { setBusy(false); }
  }, [failed, saved]);
  const whoAmI = useCallback(async () => (await supabase.auth.getUser()).data.user?.email ?? null, []);

  // ── writes ──────────────────────────────────────────────────────────────────────────────────
  /* THE DIFF IS THE WRITE. An estimate cell writes one (row, month) and nothing else; clearing it
   * deletes that one target and hands the month back to the default ramp. goal_daily is sent as
   * null so 0199's one-unit check holds on an upsert over any row. */
  const setEstimate = useCallback((f: PlanField, month: string, spots: number | null) => run(f.key, () => (
    spots == null
      ? supabase.from("field_goal_targets").delete().eq("row_id", f.rowId as string).eq("month", month)
      : supabase.from("field_goal_targets").upsert({ row_id: f.rowId, month, goal_spots: spots, goal_daily: null }, { onConflict: "row_id,month" })
  )), [run]);

  const setPlan = useCallback((f: PlanField, patch: Record<string, unknown>) => run(f.key, () =>
    supabase.from("field_goal_plan").update(patch).eq("row_id", f.rowId as string).eq("plan_year", PLAN_YEAR)), [run]);

  const removeField = useCallback(async (f: PlanField) => {
    const by = await whoAmI();
    return setPlan(f, { status: "removed", removed_at: new Date().toISOString(), removed_by: by });
  }, [setPlan, whoAmI]);
  const restoreField = useCallback((f: PlanField) =>
    setPlan(f, { status: f.kind === "slot" ? "planned" : "live", removed_at: null, removed_by: null }), [setPlan]);

  const renameField = useCallback((f: PlanField, name: string) => run(f.key, () =>
    supabase.from("field_goal_rows").update({ slot_name: name.trim() }).eq("id", f.rowId as string)), [run]);

  const addField = useCallback((c: City, open: string, type: PlanType) => run(`add-${c.id}`, () =>
    supabase.rpc("ops_plan_add_field", { p_year: PLAN_YEAR, p_city: c.id, p_name: "New field", p_open: open, p_type: type })), [run]);

  const linkVenue = useCallback((f: PlanField, venueId: number) => run(f.key, () =>
    supabase.rpc("ops_plan_link_venue", { p_year: PLAN_YEAR, p_row: f.rowId, p_venue: venueId })), [run]);

  /* ADD TO PLAN: a field playing in a plan city with no 2027 entry. Its row may not be stored yet
   * (the 2026 route creates them lazily too); a stored venue row with nothing on it is the same
   * state the 2026 page leaves, so the two steps cannot strand anything. Its planned type starts as
   * what it IS — at or above the threshold, anchor. */
  const addToPlan = useCallback(async (f: PlanField, cityId: string, threshold: number) => {
    setBusy(true);
    try {
      let rowId = f.rowId;
      if (!rowId) {
        const ident = f.venueId != null ? { venue_id: f.venueId } : { field_id: f.fieldId };
        const { data: made, error } = await supabase.from("field_goal_rows").insert(ident).select("id").single();
        if (error) { failed(f.key, error); return; }
        rowId = made?.id as string;
      }
      const { error } = await supabase.from("field_goal_plan").insert({
        row_id: rowId, plan_year: PLAN_YEAR, plan_city_id: cityId, role: "field", status: "live",
        planned_type: isActualAnchor(f, threshold) ? "anchor" : "satellite",
      });
      if (error) { failed(f.key, error); return; }
      saved();
    } finally { setBusy(false); }
  }, [failed, saved]);

  const removeCity = useCallback(async (c: City) => {
    const by = await whoAmI();
    return run(`city-${c.id}`, () => supabase.from("plan_cities")
      .update({ status: "removed", removed_at: new Date().toISOString(), removed_by: by }).eq("id", c.id));
  }, [run, whoAmI]);
  const restoreCity = useCallback((c: City) => run(`city-${c.id}`, () => supabase.from("plan_cities")
    .update({ status: "active", removed_at: null, removed_by: null }).eq("id", c.id)), [run]);

  const setThreshold = useCallback((v: number) => run("threshold", () =>
    supabase.from("app_settings").update({ value: String(v) }).eq("key", ANCHOR_SETTING_KEY).select("key")
      .then((r) => ({ error: r.error ?? (r.data?.length ? null : "The threshold setting was not updated — is migration 0199 applied?") }))), [run]);

  // ── derived ─────────────────────────────────────────────────────────────────────────────────
  const KEYS = useMemo(() => planMonthKeys(PLAN_YEAR), []);
  const view = useMemo(() => {
    if (!data || data.setup !== "ready") return null;
    const cur = data.currentMonth;
    const asOf = asOfPick ?? (cur < KEYS[0] ? cur : cur > KEYS[11] ? KEYS[11] : cur);
    const bl = baselineMonth(data.today, compareOverride);
    const liveDays = bl.completedDays;
    const baseKey = bl.baseKey, baseIsLive = bl.baseIsLive;
    const baseDays = baseIsLive ? liveDays : daysInMonthOf(baseKey);
    /* THE LEAD COLUMNS: the history months when history is open (the baseline is always the last
     * of them), else the baseline alone when it is the last full month — the gap is measured from
     * it, so it is on screen either way. The live month always follows. */
    const histKeys = showHistory ? [3, 2, 1].map((n) => addMonths(cur, -n)) : baseIsLive ? [] : [baseKey];
    const cityById = new Map(data.cities.map((c) => [c.id, c]));
    const fieldsOf = new Map<string, PlanField[]>();
    for (const f of data.fields) fieldsOf.set(f.cityId, [...(fieldsOf.get(f.cityId) ?? []), f]);

    type Line = { roll: Rollup; live: number | null; base: number | null; hist: (number | null)[]; trailing: number };
    const lineOf = (fields: PlanField[], mature: number): Line => {
      const roll = rollFields(fields, { mature }, KEYS, asOf, data.threshold);
      const sumAct = (k: string) => {
        let m = 0, s = 0;
        for (const f of fields) { const a = f.actual[k]; if (a) { m += a.matches; s += a.spots; } }
        return m > 0 ? s : null;
      };
      return { roll, live: sumAct(cur), base: sumAct(baseKey), hist: histKeys.map(sumAct), trailing: fields.reduce((a, f) => a + f.trailing.spots, 0) };
    };
    const sumLines = (ls: Line[]): Line => ({
      roll: sumRollups(ls.map((l) => l.roll), 12),
      live: sumSpots(ls.map((l) => l.live)),
      base: sumSpots(ls.map((l) => l.base)),
      hist: histKeys.map((_, i) => sumSpots(ls.map((l) => l.hist[i]))),
      trailing: ls.reduce((a, l) => a + l.trailing, 0),
    });
    /* THE GAP, ON ONE BASIS: what December 2027 needs over what the BASELINE month ran at, in
     * December's spots. Month to date on the 1st has no completed day, so no rate and no gap. A city
     * that has never played has a baseline of nothing, and its gap is the whole December goal. */
    const gapOf = (l: Line): number | null => {
      const dec = l.roll.est[11];
      if (dec == null || baseDays <= 0) return null;
      const baseDaily = (l.base ?? 0) / SPOTS_PER_MATCH / baseDays;
      return dec - baseDaily * SPOTS_PER_MATCH * daysInMonthOf(KEYS[11]);
    };

    const regions = data.regions.map((r) => {
      const cities = data.cities.filter((c) => c.regionKey === r.key && c.status === "active").map((c) => {
        const fields = fieldsOf.get(c.id) ?? [];
        const line = lineOf(fields, c.mature);
        const plannedAnchors = fields.filter((f) => inPlan(f) && f.role === "field" && f.plannedType === "anchor").length;
        return { city: c, name: c.name, sortOrder: c.sortOrder, fields, line, gap: gapOf(line), plannedAnchors };
      });
      const line = sumLines(cities.map((c) => c.line));
      const rm = data.hires.find((h) => h.kind === "regional_manager" && h.regionKey === r.key) ?? null;
      return { region: r, cities: sortCities(cities, sort), line, gap: gapOf(line), rm };
    });
    const all = sumLines(regions.map((r) => r.line));
    const removedCities = data.cities.filter((c) => c.status === "removed");
    /* DEC 2026 START: the forecast until December 2026 has completed, then what actually happened
     * — over the plan's active cities, through the same rows. */
    const decDone = cur > START_MONTH;
    const decActual = sumSpots(regions.flatMap((r) => r.cities.flatMap((c) => c.fields.map((f) => f.actual[START_MONTH]?.spots ?? null))));
    const start = decDone ? { spots: decActual ?? 0, label: "actual" } : { spots: FORECAST_DEC_2026_SPOTS, label: "forecast" };
    const liveCities = regions.reduce((a, r) => a + r.cities.filter((c) => c.line.roll.actual.fields > 0).length, 0);
    return { cur, asOf, liveDays, histKeys, baseKey, baseIsLive, baseDays, compareFrom: bl.compareFrom,
      regions, all, allGap: gapOf(all), removedCities, start, liveCities, cityById };
  }, [data, KEYS, asOfPick, showHistory, sort, compareOverride]);

  if (loadErr) return <p className="p-6 text-[13px] text-red-700" data-testid="op-error">{loadErr}</p>;
  if (!data) return <p className="p-8 text-center text-[13px]" style={{ color: "#8C9E93" }}>Loading…</p>;
  if (data.setup !== "ready" || !view) {
    return (
      <div className="px-4 pb-16 pt-3" data-testid="op-page">
        <h1 className="mb-3 text-[27px] font-black uppercase tracking-tight" style={{ color: INK }}>2027 Operations Plan</h1>
        <p className="text-[13px]" style={{ color: MUTED }} data-testid="op-setup">
          {data.setup === "missing"
            ? "The plan tables are not in the database yet. Migration 0199 has not been applied."
            : "The plan tables exist but hold no 2027 cities yet. The seed (0200) has not been applied."}
        </p>
      </div>
    );
  }

  const u = unit === "spots" ? "spots a month" : unit === "day" ? "matches a day" : "matches a week";
  const DEC_KEY = KEYS[11];
  const show = (spots: number | null, key: string, days?: number) =>
    spots == null ? DASH : fmtPlan(spotsToUnit(spots, days ?? daysInMonthOf(key), unit), unit);
  const fmtCounts = (a: Counts, p: Counts, k: keyof Counts) => `${a[k]} / ${p[k]}`;
  const toFind = view.all.roll.est[11] == null ? null : (view.all.roll.est[11] as number) - view.start.spots;
  const asOfOptions = (() => {
    const out: string[] = []; let k = view.cur < KEYS[0] ? view.cur : KEYS[0];
    while (k <= KEYS[11]) { out.push(k); k = addMonths(k, 1); }
    return out;
  })();
  const ctx: Ctx = {
    unit, keys: KEYS, cur: view.cur, liveDays: view.liveDays, histKeys: view.histKeys, threshold: data.threshold, busy, revert,
    baseKey: view.baseKey, baseIsLive: view.baseIsLive, baseDays: view.baseDays,
    writeErr, show, setEstimate, setPlan, removeField, restoreField, renameField, linkVenue, addToPlan, venues: data.venues,
    cityById: view.cityById, showRemoved, asOf: view.asOf,
  };

  return (
    <div className="px-4 pb-16 pt-3" data-testid="op-page">
      <h1 className="mb-1 text-[27px] font-black uppercase tracking-tight" style={{ color: INK }}>2027 Operations Plan</h1>
      <p className="mb-3 text-[12px]" style={{ color: MUTED }}>Built from MatchDay Forecast, Sep 2026.</p>

      {/* ── 1. STAT TILES ─────────────────────────────────────────────────────────────────────── */}
      <div className="mb-3 flex flex-wrap items-stretch gap-3">
        <Big k={`Dec 2026 start · ${view.start.label}`} v={show(view.start.spots, START_MONTH)} u={u} testId="op-start" />
        <Big k="Dec 2027 goal" v={show(view.all.roll.est[11], DEC_KEY)} u={u} tone="#12694A" testId="op-goal" />
        <Big k="To find" v={toFind == null ? DASH : show(toFind, DEC_KEY)} u={u} tone={RED} testId="op-find" />
        <Big k="Fields · actual / plan" v={fmtCounts(view.all.roll.actual, view.all.roll.plan, "fields")}
          u={`anchors ${fmtCounts(view.all.roll.actual, view.all.roll.plan, "anchors")} · satellites ${fmtCounts(view.all.roll.actual, view.all.roll.plan, "satellites")}`}
          testId="op-fields" />
        <Big k="Cities" v={String(view.regions.reduce((a, r) => a + r.cities.length, 0))}
          u={`${view.liveCities} playing now, across ${view.regions.filter((r) => r.cities.length).length} regions`} testId="op-cities" />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="inline-flex overflow-hidden rounded-[9px] border bg-white" style={{ borderColor: LINE }}>
          {([["day", "Daily"], ["week", "Weekly"], ["spots", "Spots"]] as const).map(([x, label]) => (
            <button key={x} type="button" data-testid={`op-unit-${x}`} aria-pressed={unit === x} onClick={() => setUnit(x)}
              className="px-3.5 py-1.5 text-[12.5px] font-bold"
              style={unit === x ? { background: INK, color: "#fff" } : { background: "#fff", color: "#3C4F44" }}>{label}</button>
          ))}
        </span>
        <CompareSeg value={view.compareFrom} set={setCompareOverride}
          lastFull={MONTH_LABELS[Number(addMonths(view.cur, -1).slice(5, 7)) - 1]} live={MONTH_LABELS[Number(view.cur.slice(5, 7)) - 1]} />
        <span className="text-[11.5px]" style={{ color: MUTED }} data-testid="op-formula">
          18 spots = 1 match · real days in each month (the forecast quotes its headline on a 30-day month)
        </span>
        <label className="ml-auto flex items-center gap-1.5 text-[11.5px] font-bold" style={{ color: MUTED }}>
          Plan as of
          <select data-testid="op-asof" value={view.asOf} onChange={(e) => setAsOfPick(e.target.value)}
            className="rounded-md border bg-white px-1.5 py-1 text-[12px]" style={{ borderColor: LINE, color: INK }}>
            {asOfOptions.map((k) => <option key={k} value={k}>{shortMonth(k)}</option>)}
          </select>
        </label>
      </div>

      {/* ── 2. REGION CHART ───────────────────────────────────────────────────────────────────── */}
      <RegionChart regions={view.regions.filter((r) => r.cities.length)} unit={unit} decKey={DEC_KEY} />

      {/* ── 3. MONTH BY MONTH ─────────────────────────────────────────────────────────────────── */}
      <MonthStrip data={data} keys={KEYS} all={view.all.roll} unit={unit} cur={view.cur}
        fields={view.regions.flatMap((r) => r.cities.flatMap((c) => c.fields))}
        cities={view.regions.flatMap((r) => r.cities.map((c) => c.city))} regions={data.regions} />

      {/* ── 4. HIRES ──────────────────────────────────────────────────────────────────────────── */}
      <HiresTable hires={data.hires} regions={data.regions} busy={busy} revert={revert} writeErr={writeErr} run={run} />

      {/* ── 5–8. REGIONS AND CITIES ───────────────────────────────────────────────────────────── */}
      <h2 className="mb-1 mt-7 flex flex-wrap items-baseline gap-2 text-[17px] font-extrabold" style={{ color: INK }}>
        Regions and cities
        <GrainSeg grain={grain} setGrain={setGrain} />
        <HistorySeg on={showHistory} set={setShowHistory} />
        <span className="inline-flex overflow-hidden rounded-lg border" style={{ borderColor: LINE }} data-testid="op-sort">
          {([["gap", "By gap"], ["city", "By city"], ["name", "A–Z"]] as const).map(([k, label]) => (
            <button key={k} type="button" data-testid={`op-sort-${k}`} aria-pressed={sort === k} onClick={() => setSort(k)}
              className="px-2.5 py-1 text-[11.5px] font-bold"
              style={{ minHeight: 32, ...(sort === k ? { background: INK, color: "#fff" } : { background: "#fff", color: "#3C4F44" }) }}>{label}</button>
          ))}
        </span>
        <button type="button" data-testid="op-show-removed" aria-pressed={showRemoved} onClick={() => setShowRemoved(!showRemoved)}
          className="rounded-lg border px-2.5 py-1 text-[11.5px] font-bold"
          style={{ minHeight: 32, borderColor: LINE, ...(showRemoved ? { background: INK, color: "#fff" } : { background: "#fff", color: "#3C4F44" }) }}>
          Show removed
        </button>
      </h2>
      <p className="mb-3 flex flex-wrap items-center gap-1.5 text-[11.5px]" style={{ color: MUTED }}>
        Fields, anchors and satellites read actual / plan. Actual is the last 30 completed days; an anchor runs at or above
        <ThresholdInput value={data.threshold} busy={busy} revert={revert} onCommit={setThreshold} />
        spots in them. Plan counts fields open by {shortMonth(view.asOf)}.
        {writeErr?.key === "threshold" && <span style={{ color: RED }}>{writeErr.message}</span>}
      </p>

      {view.regions.map((r) => (
        <RegionCard key={r.region.key} r={r} grain={grain} ctx={ctx} openCities={openCities}
          toggleCity={(id) => setOpenCities((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
          addField={addField} removeCity={removeCity} />
      ))}

      {/* THE FOOTER IS THE SUM OF THE REGION SUBTOTALS ABOVE IT — sumRollups over the same lines. */}
      <div className="mt-4 overflow-x-auto rounded-xl border-[1.5px]" style={{ borderColor: LINE }}>
        <table className="w-full border-collapse bg-white" style={{ tableLayout: "fixed", minWidth: tableMin(view.histKeys.length) }} data-testid="op-all">
          <Cols n={view.histKeys.length} />
          <tbody>
            <TotalRow label="All MatchDay" line={view.all} gap={view.allGap} ctx={ctx} strong testId="op-total" />
          </tbody>
        </table>
      </div>

      {view.removedCities.length > 0 && (
        <p className="mt-3 text-[11.5px]" style={{ color: MUTED }} data-testid="op-removed-cities">
          Removed cities:{" "}
          {view.removedCities.map((c) => (
            <button key={c.id} type="button" disabled={busy} onClick={() => restoreCity(c)}
              className="mr-2 underline underline-offset-2">{c.name} (restore)</button>
          ))}
        </p>
      )}

      <AddCity regions={data.regions} busy={busy} writeErr={writeErr} run={run} />
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════════════════════════ */

type Ctx = {
  unit: Unit; keys: string[]; cur: string; liveDays: number; histKeys: string[]; threshold: number;
  /** The baseline month (lib/fieldGoals.baselineMonth) and its days: full days for the last full
   *  month, completed days for the live month. */
  baseKey: string; baseIsLive: boolean; baseDays: number;
  busy: boolean; revert: number; writeErr: { key: string; message: string } | null;
  show: (spots: number | null, key: string, days?: number) => string;
  setEstimate: (f: PlanField, month: string, spots: number | null) => unknown;
  setPlan: (f: PlanField, patch: Record<string, unknown>) => unknown;
  removeField: (f: PlanField) => unknown; restoreField: (f: PlanField) => unknown;
  renameField: (f: PlanField, name: string) => unknown;
  linkVenue: (f: PlanField, venueId: number) => unknown;
  addToPlan: (f: PlanField, cityId: string, threshold: number) => unknown;
  venues: { id: number; name: string | null; city: string | null }[];
  cityById: Map<string, City>;
  showRemoved: boolean; asOf: string;
};
type Line = { roll: Rollup; live: number | null; base: number | null; hist: (number | null)[]; trailing: number };
type CityView = { city: City; name: string; fields: PlanField[]; line: Line; gap: number | null; plannedAnchors: number };
type RegionView = { region: Region; cities: CityView[]; line: Line; gap: number | null; rm: Hire | null };

/* ── ONE GRID FOR EVERY TABLE ON THE PAGE ─────────────────────────────────────────────────────────
 * Fixed layout and one column set, so a region's subtotal, the next region's rows and the All
 * MatchDay footer line up month under month — the footer is checked by eye against what is above. */
const W = { name: 250, prog: 96, hist: 64, live: 72, month: 66, gap: 70, cnt: 78 };
const tableMin = (h: number) => W.name + W.prog + h * W.hist + W.live + 12 * W.month + W.gap + 3 * W.cnt;
function Cols({ n }: { n: number }) {
  return (
    <colgroup>
      <col style={{ width: W.name }} /><col style={{ width: W.prog }} />
      {Array.from({ length: n }, (_, i) => <col key={`h${i}`} style={{ width: W.hist }} />)}
      <col style={{ width: W.live }} />
      {Array.from({ length: 12 }, (_, i) => <col key={`m${i}`} style={{ width: W.month }} />)}
      <col style={{ width: W.gap }} /><col style={{ width: W.cnt }} /><col style={{ width: W.cnt }} /><col style={{ width: W.cnt }} />
    </colgroup>
  );
}
const COLS = (n: number) => 2 + n + 1 + 12 + 4;

/* A MONTH CELL. A finished month with matches shows ACTUAL beside the estimate, with the gap in
 * the month's spots (shown in the unit on screen); the live month shows its to-date rate; a future
 * month shows the estimate. Nothing estimated and nothing played is a dash, never 0.0. */
function MonthCell({ est, act, k, ctx, bold }: { est: number | null; act: number | null; k: string; ctx: Ctx; bold?: boolean }) {
  const done = k < ctx.cur, live = k === ctx.cur;
  const actDays = live ? ctx.liveDays : daysInMonthOf(k);
  if ((done || live) && act != null && actDays > 0) {
    const gap = done && est != null ? act - est : null;
    return (
      <td className="border-t px-1.5 py-1.5 text-right text-[12.5px] tabular-nums" style={{ borderColor: HAIR }} data-testid="op-mcell" data-m={k} data-state="actual">
        <b style={{ color: INK }}>{ctx.show(act, k, actDays)}</b>
        <div className="text-[10px]" style={{ color: FAINT }}>
          {est == null ? "no est." : `est ${ctx.show(est, k)}`}
          {gap != null && <span style={{ color: gap >= 0 ? "#12694A" : RED }}> {gap >= 0 ? "+" : ""}{ctx.show(gap, k)}</span>}
        </div>
      </td>
    );
  }
  return (
    <td className="border-t px-1.5 py-1.5 text-right text-[12.5px] tabular-nums" style={{ borderColor: HAIR, color: est == null ? "#C3CEC8" : k === ctx.keys[11] ? INK : "#3A4D44", fontWeight: bold || k === ctx.keys[11] ? 700 : 500 }}
      data-testid="op-mcell" data-m={k} data-state="estimate" data-v={est ?? ""}>
      {ctx.show(est, k)}
    </td>
  );
}

function LeadCells({ line, ctx }: { line: Line; ctx: Ctx }) {
  return (
    <>
      {ctx.histKeys.map((k, i) => (
        <td key={k} className={`border-t px-1.5 py-1.5 text-right text-[12px] tabular-nums ${k === ctx.baseKey ? "font-bold" : ""}`} style={{ borderColor: HAIR, color: line.hist[i] == null ? "#C3CEC8" : k === ctx.baseKey ? INK : "#3A4D44" }} data-testid="op-hist">
          {ctx.show(line.hist[i], k)}
        </td>
      ))}
      <td className={`border-t px-1.5 py-1.5 text-right text-[12.5px] tabular-nums ${ctx.baseIsLive ? "font-bold" : "font-semibold"}`} style={{ borderColor: HAIR, color: ctx.baseIsLive ? INK : "#5C6F66" }} data-testid="op-live">
        {ctx.liveDays <= 0 ? DASH : ctx.show(line.live, ctx.cur, ctx.liveDays)}
      </td>
    </>
  );
}

function GapCell({ gap, ctx }: { gap: number | null; ctx: Ctx }) {
  return (
    <td className="border-t px-1.5 py-1.5 text-right text-[12.5px] font-extrabold tabular-nums" style={{ borderColor: HAIR, color: gap == null ? "#C3CEC8" : gap <= 0 ? "#12694A" : RED }} data-testid="op-gap">
      {gap == null ? DASH : `${gap > 0 ? "+" : ""}${ctx.show(gap, ctx.keys[11])}`}
    </td>
  );
}

function CountCells({ line }: { line: Line }) {
  const c = (k: keyof Counts) => (
    <td key={k} className="border-t px-1.5 py-1.5 text-right text-[12px] tabular-nums" style={{ borderColor: HAIR, color: "#3A4D44" }} data-testid={`op-${k}`}>
      {line.roll.actual[k]} / {line.roll.plan[k]}
    </td>
  );
  return <>{c("fields")}{c("anchors")}{c("satellites")}</>;
}

function HeadRow({ ctx, first }: { ctx: Ctx; first: string }) {
  const th = "whitespace-nowrap border-b px-1.5 py-2 text-[10px] font-extrabold uppercase tracking-wider";
  const st = { color: MUTED, background: HEAD, borderColor: LINE };
  return (
    <tr>
      <th className={`${th} text-left`} style={st}>{first}</th>
      <th className={`${th} text-left`} style={st}>Progress</th>
      {ctx.histKeys.map((k) => <th key={k} className={`${th} text-right`} style={st}>{shortMonth(k)}{k === ctx.baseKey && <BaselineTag />}</th>)}
      <th className={`${th} text-right`} style={st}>{shortMonth(ctx.cur)}
        <span className="ml-1 rounded px-1 text-[8.5px] font-bold tracking-normal" style={{ background: "#FFF3E0", color: AMBER }}>live</span>
        {ctx.baseIsLive ? <BaselineTag /> : <DaysTag days={ctx.liveDays} />}</th>
      {ctx.keys.map((k, i) => <th key={k} className={`${th} text-right`} style={st}>{MONTH_LABELS[i]}</th>)}
      <th className={`${th} text-right`} style={st}>Gap</th>
      <th className={`${th} text-right`} style={st}>Fields</th>
      <th className={`${th} text-right`} style={st}>Anchors</th>
      <th className={`${th} text-right`} style={st}>Satellites</th>
    </tr>
  );
}

function TotalRow({ label, line, gap, ctx, strong, testId }: { label: string; line: Line; gap: number | null; ctx: Ctx; strong?: boolean; testId: string }) {
  return (
    <tr data-testid={testId} style={{ background: "#F7FAF8" }}>
      <td className="border-t-2 px-3 py-2 text-[13px] font-extrabold" style={{ borderColor: LINE, color: INK }}>{label}</td>
      <td className="border-t-2" style={{ borderColor: LINE }}><Progress line={line} ctx={ctx} /></td>
      <LeadCells line={line} ctx={ctx} />
      {ctx.keys.map((k, i) => <MonthCell key={k} est={line.roll.est[i]} act={line.roll.act[i]} k={k} ctx={ctx} bold={strong} />)}
      <GapCell gap={gap} ctx={ctx} />
      <CountCells line={line} />
    </tr>
  );
}

/* PROGRESS: the live month's rate against the December 2027 estimate, on real days both sides. */
function Progress({ line, ctx }: { line: Line; ctx: Ctx }) {
  const dec = line.roll.est[11];
  if (dec == null || dec <= 0 || ctx.baseDays <= 0) return null;
  const baseDaily = (line.base ?? 0) / SPOTS_PER_MATCH / ctx.baseDays;
  const decDaily = dec / SPOTS_PER_MATCH / daysInMonthOf(ctx.keys[11]);
  const pct = Math.max(0, Math.min(100, (baseDaily / decDaily) * 100));
  return (
    <span className="relative mx-2 inline-block h-[7px] w-16 overflow-hidden rounded-full border align-middle" style={{ background: HEAD, borderColor: LINE }} title={`${Math.round(pct)}%`}>
      <i className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${pct}%`, background: "#2CDB87" }} />
    </span>
  );
}

/* ── A REGION ─────────────────────────────────────────────────────────────────────────────────── */
function RegionCard({ r, grain, ctx, openCities, toggleCity, addField, removeCity }: {
  r: RegionView; grain: Grain; ctx: Ctx; openCities: Set<string>; toggleCity: (id: string) => void;
  addField: (c: City, open: string, type: PlanType) => unknown; removeCity: (c: City) => unknown;
}) {
  if (!r.cities.length) return null;
  const rmLine = r.rm
    ? `Regional manager hired ${shortMonth(r.rm.hireMonth)}${r.rm.runningMonth ? `, running ${shortMonth(r.rm.runningMonth)}` : ""}`
    : r.region.note ?? "No regional manager in the plan";
  const span = COLS(ctx.histKeys.length);
  const fieldRows = grain === "field"
    ? [...r.cities.flatMap((c) => c.fields.filter((f) => ctx.showRemoved || f.status !== "removed").map((f) => ({ f, c })))]
        .sort((a, b) => a.f.name.localeCompare(b.f.name))
    : [];
  return (
    <section className="mb-4 overflow-hidden rounded-2xl border-[1.5px] bg-white" style={{ borderColor: LINE }} data-testid="op-region" data-r={r.region.key}>
      <div className="flex flex-wrap items-end justify-between gap-3 border-b px-4 py-3" style={{ background: "#F7FAF8", borderColor: LINE }}>
        <div>
          <div className="text-[16px] font-black uppercase tracking-tight" style={{ color: INK }}>{r.region.name}</div>
          <div className="text-[12px]" style={{ color: MUTED }} data-testid="op-rm">{rmLine}</div>
        </div>
        <div className="flex flex-wrap gap-6 text-[11.5px]" style={{ color: MUTED }}>
          <div><b className="block text-[17px] tabular-nums" style={{ color: INK }}>
            {ctx.baseDays <= 0 ? DASH : ctx.show(r.line.base, ctx.baseKey, ctx.baseDays)} → {ctx.show(r.line.roll.est[11], ctx.keys[11])}</b>
            {shortMonth(ctx.baseKey)}{ctx.baseIsLive ? " to date" : ""} to Dec 27</div>
          <div><b className="block text-[17px] tabular-nums" style={{ color: INK }}>{r.line.roll.actual.fields} / {r.line.roll.plan.fields}</b>fields</div>
          <div><b className="block text-[17px] tabular-nums" style={{ color: INK }}>{r.line.roll.actual.anchors} / {r.line.roll.plan.anchors}</b>anchors</div>
          <div><b className="block text-[17px] tabular-nums" style={{ color: INK }}>{r.line.roll.actual.satellites} / {r.line.roll.plan.satellites}</b>satellites</div>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse" style={{ tableLayout: "fixed", minWidth: tableMin(ctx.histKeys.length) }}>
          <Cols n={ctx.histKeys.length} />
          <thead><HeadRow ctx={ctx} first={grain === "city" ? "City" : "Field"} /></thead>
          <tbody>
            {grain === "city" && r.cities.map((c) => {
              const open = openCities.has(c.city.id);
              const over = c.plannedAnchors > c.city.anchorSlots;
              return (
                <Fragment key={c.city.id}>
                  <tr data-testid="op-crow" data-c={c.name} className="cursor-pointer hover:bg-[#FAFCFB]" aria-expanded={open}
                    onClick={() => toggleCity(c.city.id)} tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleCity(c.city.id); } }}>
                    <td className="border-t px-3 py-2 text-[13px]" style={{ borderColor: HAIR }}>
                      <span aria-hidden className="mr-1.5 inline-block text-[8px] align-middle" style={{ color: FAINT, transform: open ? "rotate(90deg)" : "none" }}>▶</span>
                      <b>{c.name}</b>
                      {c.city.launchMonth && <span className="ml-1.5 rounded px-1 text-[10px] font-bold" style={{ background: "#EAF4EE", color: "#12694A" }}>launch {shortMonth(c.city.launchMonth)}</span>}
                      {over && <span data-testid="op-anchor-warn" className="ml-1.5 rounded px-1 text-[10px] font-bold" style={{ background: "#FFF3E0", color: AMBER }}
                        title="More planned anchors than the city has anchor slots">{c.plannedAnchors} anchors / {c.city.anchorSlots} slots</span>}
                      {FORECAST_FIELDS_UNKNOWN.has(c.name) && <span data-testid="op-no-count" className="ml-1.5 rounded px-1 text-[10px] font-bold" style={{ background: "#FFF3E0", color: AMBER }}
                        title="The forecast gives no field count for this city">no forecast field count</span>}
                    </td>
                    <td className="border-t" style={{ borderColor: HAIR }}><Progress line={c.line} ctx={ctx} /></td>
                    <LeadCells line={c.line} ctx={ctx} />
                    {ctx.keys.map((k, i) => <MonthCell key={k} est={c.line.roll.est[i]} act={c.line.roll.act[i]} k={k} ctx={ctx} />)}
                    <GapCell gap={c.gap} ctx={ctx} />
                    <CountCells line={c.line} />
                  </tr>
                  {open && <CityDrawer c={c} ctx={ctx} span={span} addField={addField} removeCity={removeCity} />}
                </Fragment>
              );
            })}
            {grain === "field" && fieldRows.map(({ f, c }) => <FieldRow key={f.key} f={f} city={c.city} ctx={ctx} span={span} showCity />)}
          </tbody>
          <tfoot>
            <TotalRow label={`${r.region.shortName} subtotal`} line={r.line} gap={r.gap} ctx={ctx} testId="op-subtotal" />
          </tfoot>
        </table>
      </div>
    </section>
  );
}

/* ── A CITY'S FIELDS ──────────────────────────────────────────────────────────────────────────── */
function CityDrawer({ c, ctx, span, addField, removeCity }: {
  c: CityView; ctx: Ctx; span: number; addField: (c: City, open: string, type: PlanType) => unknown; removeCity: (c: City) => unknown;
}) {
  /* LIVE, THEN PLANNED BY OPENING MONTH, THEN THE FORECAST BASE, THEN WHAT IS PLAYING UNPLANNED.
   * Removed rows only when asked for — they are kept, and do not count. */
  const rank = (f: PlanField) => (f.role === "unplanned" ? 3 : f.role === "forecast_base" ? 2 : f.status === "live" ? 0 : 1);
  const rows = c.fields.filter((f) => ctx.showRemoved || f.status !== "removed")
    .sort((a, b) => rank(a) - rank(b) || (a.openMonth ?? "").localeCompare(b.openMonth ?? "") || a.name.localeCompare(b.name));
  const firstOpen = c.city.launchMonth && c.city.launchMonth > ctx.cur ? c.city.launchMonth
    : ctx.cur < ctx.keys[0] ? ctx.keys[0] : ctx.cur > ctx.keys[11] ? ctx.keys[11] : ctx.cur;
  const nextType: PlanType = c.plannedAnchors < c.city.anchorSlots ? "anchor" : "satellite";
  return (
    <>
      {rows.map((f) => <FieldRow key={f.key} f={f} city={c.city} ctx={ctx} span={span} />)}
      <tr><td colSpan={span} className="px-3 pb-3 pl-9 pt-1.5" style={{ background: "#FAFCFB" }}>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" data-testid="op-add-field" disabled={ctx.busy} onClick={() => addField(c.city, firstOpen, nextType)}
            className="rounded-lg border border-dashed px-3 py-1.5 text-[12px] font-bold" style={{ borderColor: CHART_HUE, color: "#12694A", background: "#fff" }}>
            + Add field
          </button>
          <span className="text-[11px]" style={{ color: FAINT }}>
            opens {shortMonth(firstOpen)} as {nextType}, on the forecast ramp then {c.city.mature} spots a month · edit it below once added
          </span>
          <button type="button" data-testid="op-remove-city" disabled={ctx.busy} onClick={() => removeCity(c.city)}
            className="ml-auto px-2 text-[12px] font-semibold" style={{ color: RED }}>Remove {c.name} from the plan</button>
        </div>
        {(ctx.writeErr?.key === `add-${c.city.id}` || ctx.writeErr?.key === `city-${c.city.id}`) &&
          <p className="mt-1 text-[12px]" style={{ color: RED }} data-testid="op-write-error">{ctx.writeErr.message}</p>}
      </td></tr>
    </>
  );
}

/* ONE FIELD. Used in a city's drawer and in the Fields grain, so a field edits identically in both
 * — the 2026 page's GoalCells rule. Planned type and actual status are separate cells and both are
 * kept; where they disagree, the row says so. */
function FieldRow({ f, city, ctx, span, showCity }: { f: PlanField; city: City; ctx: Ctx; span: number; showCity?: boolean }) {
  const removed = f.status === "removed";
  const planned = inPlan(f);
  const isField = f.role === "field";
  const editable = planned && f.rowId != null;
  const flags = fieldFlags(f, ctx.threshold, ctx.cur);
  const live = isActuallyLive(f);
  const anchorNow = isActualAnchor(f, ctx.threshold);
  const td = "border-t px-1.5 py-1 text-[12px]";
  const st = { borderColor: HAIR, background: "#FAFCFB" };
  /* ONLY A ROW CREATED FOR 2027 CAN BE LINKED. ops_plan_link_venue refuses a 2026 slot (so this page
   * never changes the 2026 one); offering the picker there would be a control that can only fail. */
  const linkable = f.kind === "slot" && f.role === "field" && f.createdForPlan === true && !removed;
  const venueChoices = linkable
    ? ctx.venues.filter((v) => city.venueAliases.some((a) => a.trim().toLowerCase() === (v.city ?? "").trim().toLowerCase()))
    : [];
  const openChoices = (() => { const out: string[] = []; let k = "2026-09-01"; while (k <= ctx.keys[11]) { out.push(k); k = addMonths(k, 1); } return out; })();
  return (
    <>
      <tr data-testid="op-frow" data-f={f.name} data-role={f.role} data-status={f.status ?? "unplanned"} style={removed ? { opacity: 0.5 } : undefined}>
        <td className={`${td} pl-9`} style={{ ...st, color: MUTED }}>
          {f.kind === "slot" && editable && f.role === "field"
            ? <input key={`${f.key}-${ctx.revert}`} data-testid="op-fname" defaultValue={f.name} disabled={ctx.busy} aria-label="Field name"
                onBlur={(e) => { if (e.target.value.trim() && e.target.value.trim() !== f.name) ctx.renameField(f, e.target.value); }}
                className="w-[150px] rounded-md border border-transparent px-1 py-0.5 text-[12px] font-bold hover:border-[#D3DCD8] focus:border-[#2CDB87] focus:outline-none" style={{ color: INK }} />
            : <b style={{ color: f.role === "forecast_base" ? MUTED : INK, fontStyle: f.role === "forecast_base" ? "italic" : undefined }}>{f.name}</b>}
          {showCity && <span className="ml-1 text-[10.5px]" style={{ color: FAINT }}>{city.name}</span>}
          {flags.map((fl) => (
            <span key={fl} data-testid="op-flag" data-flag={fl} className="ml-1 rounded px-1 text-[9.5px] font-bold" style={{ background: fl === "late" ? "#FDF3EF" : "#FFF3E0", color: fl === "late" ? RED : AMBER }}
              title={fl === "late" ? "Past its opening month with nothing played" : fl === "anchor-below" ? "Planned as an anchor, running below the threshold" : "Planned as a satellite, running at anchor volume"}>
              {fl === "late" ? "late" : fl === "anchor-below" ? "anchor below threshold" : "satellite at anchor volume"}
            </span>
          ))}
          {venueChoices.length > 0 && (
            <select data-testid="op-link" disabled={ctx.busy} value="" aria-label="Link to a real venue"
              onChange={(e) => { if (e.target.value) ctx.linkVenue(f, Number(e.target.value)); }}
              className="ml-1 max-w-[90px] rounded border bg-white text-[10.5px]" style={{ borderColor: LINE, color: MUTED }}>
              <option value="">link venue…</option>
              {venueChoices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          )}
          {editable && f.role !== "forecast_base" && (
            <button type="button" data-testid="op-fremove" disabled={ctx.busy} onClick={() => ctx.removeField(f)} aria-label={`Remove ${f.name}`}
              className="ml-1 px-1 text-[14px]" style={{ color: FAINT }}>×</button>
          )}
          {removed && (
            <button type="button" data-testid="op-frestore" disabled={ctx.busy} onClick={() => ctx.restoreField(f)}
              className="ml-1 text-[11px] underline" style={{ color: MUTED }}>restore</button>
          )}
          {f.role === "unplanned" && (
            <button type="button" data-testid="op-fadd" disabled={ctx.busy} onClick={() => ctx.addToPlan(f, city.id, ctx.threshold)}
              className="ml-1 rounded border px-1.5 text-[10.5px] font-bold" style={{ borderColor: CHART_HUE, color: "#12694A" }}>playing, not in plan · add</button>
          )}
        </td>
        {/* PROGRESS COLUMN → THE OPENING MONTH. Empty (open) for a field that is already running. */}
        <td className={td} style={st}>
          {editable && isField ? (
            <select data-testid="op-fopen" disabled={ctx.busy} value={f.openMonth ?? ""} aria-label="Opening month"
              onChange={(e) => ctx.setPlan(f, { planned_open_month: e.target.value || null })}
              className="w-full rounded border bg-white text-[11px]" style={{ borderColor: LINE, color: INK }}>
              <option value="">{f.status === "live" ? "open" : "no date"}</option>
              {openChoices.map((k) => <option key={k} value={k}>{shortMonth(k)}</option>)}
            </select>
          ) : null}
        </td>
        {ctx.histKeys.map((k) => (
          <td key={k} className={`${td} text-right tabular-nums`} style={{ ...st, color: f.actual[k]?.matches ? "#3A4D44" : "#C3CEC8" }}>
            {f.actual[k]?.matches ? ctx.show(f.actual[k].spots, k) : DASH}
          </td>
        ))}
        <td className={`${td} text-right tabular-nums`} style={{ ...st, color: ctx.baseIsLive ? "#3A4D44" : "#5C6F66" }}>
          {ctx.liveDays > 0 && f.actual[ctx.cur]?.matches ? ctx.show(f.actual[ctx.cur].spots, ctx.cur, ctx.liveDays) : DASH}
        </td>
        {ctx.keys.map((k) => {
          const est = estimateAt(f, k, city.mature);
          const act = f.actual[k]?.matches ? f.actual[k].spots : null;
          const done = k < ctx.cur && act != null;
          const days = daysInMonthOf(k);
          return (
            <td key={k} className={`${td} text-right tabular-nums`} style={st} data-testid="op-fcell" data-m={k} data-v={est ?? ""}>
              {done && <div className="text-[11px] font-bold" style={{ color: INK }}>{ctx.show(act, k)}</div>}
              {editable ? (
                <GoalInput widthClass="w-full" value={est == null ? "" : inputFmt(spotsToUnit(est, days, ctx.unit), ctx.unit)}
                  suggested={isDefaultEstimate(f, k)} revert={ctx.revert} testId="op-est" disabled={ctx.busy}
                  title={isDefaultEstimate(f, k) ? "default: the forecast ramp from the opening month" : est == null ? "no estimate" : "set"}
                  onCommit={(v) => ctx.setEstimate(f, k, v == null ? null : unitToSpots(v, days, ctx.unit))} />
              ) : <span style={{ color: est == null ? "#C3CEC8" : "#3A4D44" }}>{ctx.show(est, k)}</span>}
            </td>
          );
        })}
        <td className={td} style={st} />
        {/* FIELDS COLUMN → PLAN STATUS. ANCHORS → PLANNED TYPE. SATELLITES → WHAT IT IS RUNNING AS. */}
        <td className={`${td} text-right`} style={{ ...st, color: MUTED }} data-testid="op-fstatus">
          {f.role === "forecast_base" ? "forecast" : f.role === "unplanned" ? "unplanned" : f.status}
        </td>
        <td className={`${td} text-right`} style={st}>
          {editable && isField ? (
            <select data-testid="op-ftype" disabled={ctx.busy} value={f.plannedType ?? ""} aria-label="Planned type"
              onChange={(e) => ctx.setPlan(f, { planned_type: e.target.value || null })}
              className="rounded border bg-white text-[11px]" style={{ borderColor: LINE, color: INK }}>
              <option value="">—</option><option value="anchor">anchor</option><option value="satellite">satellite</option>
            </select>
          ) : <span style={{ color: FAINT }}>{f.plannedType ?? ""}</span>}
        </td>
        <td className={`${td} text-right`} style={{ ...st, color: live ? INK : FAINT }} data-testid="op-factual"
          title={live ? `${Math.round(f.trailing.spots)} spots, ${f.trailing.matches} matches in the last 30 days` : "nothing played in the last 30 days"}>
          {f.role === "forecast_base" ? "" : live ? `${anchorNow ? "anchor" : "satellite"} · ${Math.round(f.trailing.spots)}` : "not playing"}
        </td>
      </tr>
      {ctx.writeErr?.key === f.key && (
        <tr data-testid="op-write-error"><td colSpan={span} className="px-3 pb-2 pl-9 text-[12px]" style={{ color: RED, background: "#FDF3EF" }}>{ctx.writeErr.message}</td></tr>
      )}
    </>
  );
}

/** What an estimate input shows: plain digits (no thousands separator — the input parses it). A
 *  launch field's 14.3 spots is 0.02 a day, so a daily figure under 1 keeps two decimals. */
function inputFmt(v: number, unit: Unit): string {
  if (unit === "spots") return String(roundTo(v, 1));
  if (unit === "day") return Math.abs(v) < 1 ? roundTo(v, 2).toFixed(2) : roundTo(v, 1).toFixed(1);
  return roundTo(v, 1).toFixed(1);
}

/* ── THE THRESHOLD, EDITABLE ──────────────────────────────────────────────────────────────────── */
function ThresholdInput({ value, busy, revert, onCommit }: { value: number; busy: boolean; revert: number; onCommit: (v: number) => unknown }) {
  const [local, setLocal] = useState(String(value));
  useEffect(() => { setLocal(String(value)); }, [value, revert]);
  return (
    <input data-testid="op-threshold" value={local} disabled={busy} inputMode="numeric" aria-label="Anchor threshold, spots in 30 days"
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => { const n = Number(local); if (!Number.isFinite(n) || n <= 0) { setLocal(String(value)); return; } if (n !== value) onCommit(n); }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      className="w-14 rounded-md border px-1.5 py-0.5 text-right text-[12px] font-bold tabular-nums" style={{ borderColor: LINE, color: INK }} />
  );
}

/* ── REGION CHART: the last 30 days against the December 2027 estimate ─────────────────────────────
 * "Latest actual" is the trailing 30 completed days — the same window the field counts use, and it
 * has a value on the 1st of a month, when the live month does not. One scale across regions. */
function RegionChart({ regions, unit, decKey }: { regions: RegionView[]; unit: Unit; decKey: string }) {
  const val = (spots: number, days: number) => spotsToUnit(spots, days, unit);
  const pairs = regions.map((r) => ({ name: r.region.shortName, act: val(r.line.trailing, 30), goal: val(r.line.roll.est[11] ?? 0, daysInMonthOf(decKey)) }));
  const Wd = 920, H = 240, L = 44, R = 8, T = 18, B = 30;
  const peak = Math.max(1, ...pairs.flatMap((p) => [p.act, p.goal]));
  const max = Math.ceil(peak / 4) * 4 || 4;
  const ih = H - T - B, step = (Wd - L - R) / Math.max(1, pairs.length), bw = Math.min(30, (step - 16) / 2);
  return (
    <div className="mb-4 rounded-2xl border-[1.5px] bg-white px-4 pb-2 pt-3" style={{ borderColor: LINE }} data-testid="op-chart">
      <div className="mb-1 flex flex-wrap items-start justify-between gap-3">
        <div className="text-[13px] font-extrabold">Last 30 days against the Dec 2027 goal, by region</div>
        <div className="flex gap-3 text-[11.5px]" style={{ color: MUTED }}>
          <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-[3px]" style={{ background: CHART_HUE }} />last 30 days</span>
          <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-[3px] border-2" style={{ borderColor: CHART_HUE, background: "#fff" }} />Dec 2027 goal</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${Wd} ${H}`} className="block w-full" role="img" aria-label="Last 30 days against the December 2027 goal, by region">
        {[0, 1, 2, 3, 4].map((g) => {
          const v = (max / 4) * g, y = T + ih - (v / max) * ih;
          return <g key={g}><line x1={L} x2={Wd - R} y1={y} y2={y} stroke="#E8EEEA" /><text x={L - 8} y={y + 3.5} textAnchor="end" fontSize={10} fill="#8FA096">{fmtPlan(v, unit)}</text></g>;
        })}
        {pairs.map((p, i) => {
          const cx = L + i * step + step / 2;
          const ha = Math.max(1.5, (p.act / max) * ih), hg = Math.max(1.5, (p.goal / max) * ih);
          return (
            <g key={p.name}>
              <rect data-testid="op-bact" x={cx - bw - 2} y={T + ih - ha} width={bw} height={ha} rx={3} fill={CHART_HUE}><title>{`${p.name} · last 30 days ${fmtPlan(p.act, unit)}`}</title></rect>
              <rect data-testid="op-bgoal" x={cx + 2} y={T + ih - hg} width={bw} height={hg} rx={3} fill="#fff" stroke={CHART_HUE} strokeWidth={2}><title>{`${p.name} · Dec 2027 ${fmtPlan(p.goal, unit)}`}</title></rect>
              <text x={cx + 2 + bw / 2} y={T + ih - hg - 5} textAnchor="middle" fontSize={10} fontWeight={700} fill="#12694A">{fmtPlan(p.goal, unit)}</text>
              <text x={cx} y={H - 10} textAnchor="middle" fontSize={10} fontWeight={600} fill="#54655C">{p.name}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ── 2027 MONTH BY MONTH ──────────────────────────────────────────────────────────────────────── */
function MonthStrip({ data, keys, all, unit, cur, fields, cities, regions }: {
  data: Payload; keys: string[]; all: Rollup; unit: Unit; cur: string; fields: PlanField[]; cities: City[]; regions: Region[];
}) {
  const regionName = new Map(regions.map((r) => [r.key, r.shortName]));
  return (
    <div className="mb-4 rounded-2xl border-[1.5px] bg-white px-4 py-3" style={{ borderColor: LINE }} data-testid="op-months">
      <div className="mb-2 text-[13px] font-extrabold">2027 month by month</div>
      <div className="overflow-x-auto">
        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(12, minmax(84px, 1fr))", minWidth: 1050 }}>
          {keys.map((k, i) => {
            const opening = fields.filter((f) => inPlan(f) && f.role === "field" && f.openMonth === k).length;
            const launches = cities.filter((c) => c.launchMonth === k);
            const hires = data.hires.filter((h) => h.hireMonth === k);
            const done = k < cur && all.act[i] != null;
            return (
              <div key={k} className="flex flex-col gap-1.5 rounded-xl border p-2" style={{ borderColor: HAIR, background: "#FAFCFB" }} data-testid="op-month" data-m={k}>
                <div className="text-[10px] font-extrabold uppercase tracking-widest" style={{ color: MUTED }}>{MONTH_LABELS[i]}</div>
                <div className="text-[19px] font-black leading-none tabular-nums" style={{ color: INK }}>
                  {done ? fmtPlan(spotsToUnit(all.act[i] as number, daysInMonthOf(k), unit), unit)
                    : all.est[i] == null ? DASH : fmtPlan(spotsToUnit(all.est[i] as number, daysInMonthOf(k), unit), unit)}
                </div>
                <div className="text-[10.5px]" style={{ color: FAINT }}>{done ? "actual" : "estimate"}</div>
                <div className="text-[11.5px]" style={{ color: "#3A4D44" }}><b>{opening}</b> field{opening === 1 ? "" : "s"} open</div>
                {launches.map((c) => <div key={c.id} className="rounded px-1.5 py-0.5 text-[10.5px] font-semibold" style={{ background: "#DFF3E6", color: INK }}>{c.name}</div>)}
                {hires.map((h) => (
                  <div key={h.id} className="rounded px-1.5 py-0.5 text-[10.5px] font-semibold text-white" style={{ background: INK }}>
                    {h.kind === "regional_manager" && h.regionKey ? `${regionName.get(h.regionKey) ?? h.regionKey} RM` : h.role}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      <p className="mt-2 text-[11px]" style={{ color: FAINT }}>Light tag = city launch. Dark tag = hire. Hires before January 2027 show only in the table below.</p>
    </div>
  );
}

/* ── WHO WE HIRE, WHEN ────────────────────────────────────────────────────────────────────────────
 * Edited in place. A regional manager row IS the region card's line — there is no second copy. */
type Run = (key: string, fn: () => PromiseLike<{ error: unknown }>) => Promise<boolean>;
function HiresTable({ hires, regions, busy, revert, writeErr, run }: {
  hires: Hire[]; regions: Region[]; busy: boolean; revert: number; writeErr: { key: string; message: string } | null; run: Run;
}) {
  const upd = (h: Hire, patch: Record<string, unknown>) => run(`hire-${h.id}`, () => supabase.from("plan_hires").update(patch).eq("id", h.id));
  const months = (() => { const out: string[] = []; let k = "2026-06-01"; while (k <= "2027-12-01") { out.push(k); k = addMonths(k, 1); } return out; })();
  const sel = "rounded border bg-white px-1 py-0.5 text-[12px]";
  return (
    <div className="mb-4 rounded-2xl border-[1.5px] bg-white px-4 py-3" style={{ borderColor: LINE }} data-testid="op-hires">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[13px] font-extrabold">Who we hire, when</div>
        <button type="button" data-testid="op-hire-add" disabled={busy}
          onClick={() => run("hire-new", () => supabase.from("plan_hires").insert({ plan_year: PLAN_YEAR, hire_month: "2027-01-01", role: "New hire", kind: "other", sort_order: Date.now() % 1e6 }))}
          className="rounded-lg px-3 py-1.5 text-[12px] font-bold text-white" style={{ background: INK }}>+ Add hire</button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] border-collapse text-[12.5px]">
          <thead><tr>{["Hire", "Role", "Kind", "Region", "Running", "Notes", ""].map((h) => (
            <th key={h} className="border-b px-2 py-1.5 text-left text-[10px] font-extrabold uppercase tracking-wider" style={{ color: MUTED, background: HEAD, borderColor: LINE }}>{h}</th>
          ))}</tr></thead>
          <tbody>
            {hires.map((h) => (
              <Fragment key={`${h.id}-${revert}`}>
                <tr data-testid="op-hire">
                  <td className="border-t px-2 py-1" style={{ borderColor: HAIR }}>
                    <select className={sel} style={{ borderColor: LINE }} disabled={busy} defaultValue={h.hireMonth} aria-label="Hire month"
                      onChange={(e) => upd(h, { hire_month: e.target.value })}>{months.map((k) => <option key={k} value={k}>{shortMonth(k)}</option>)}</select>
                  </td>
                  <td className="border-t px-2 py-1" style={{ borderColor: HAIR }}>
                    <input className="w-full rounded border border-transparent px-1 py-0.5 font-semibold hover:border-[#D3DCD8]" disabled={busy} defaultValue={h.role} aria-label="Role"
                      onBlur={(e) => { if (e.target.value.trim() && e.target.value.trim() !== h.role) upd(h, { role: e.target.value.trim() }); }} />
                  </td>
                  <td className="border-t px-2 py-1" style={{ borderColor: HAIR }}>
                    <select className={sel} style={{ borderColor: LINE }} disabled={busy} defaultValue={h.kind} aria-label="Kind"
                      onChange={(e) => upd(h, { kind: e.target.value })}>
                      <option value="regional_manager">Regional manager</option><option value="hq">HQ</option><option value="other">Other</option>
                    </select>
                  </td>
                  <td className="border-t px-2 py-1" style={{ borderColor: HAIR }}>
                    <select className={sel} style={{ borderColor: LINE }} disabled={busy} defaultValue={h.regionKey ?? ""} aria-label="Region"
                      onChange={(e) => upd(h, { region_key: e.target.value || null })}>
                      <option value="">—</option>{regions.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
                    </select>
                  </td>
                  <td className="border-t px-2 py-1" style={{ borderColor: HAIR }}>
                    <select className={sel} style={{ borderColor: LINE }} disabled={busy} defaultValue={h.runningMonth ?? ""} aria-label="Running month"
                      onChange={(e) => upd(h, { running_month: e.target.value || null })}>
                      <option value="">—</option>{months.map((k) => <option key={k} value={k}>{shortMonth(k)}</option>)}
                    </select>
                  </td>
                  <td className="border-t px-2 py-1" style={{ borderColor: HAIR }}>
                    <input className="w-full rounded border border-transparent px-1 py-0.5 hover:border-[#D3DCD8]" disabled={busy} defaultValue={h.notes ?? ""} placeholder="notes" aria-label="Notes"
                      onBlur={(e) => { if (e.target.value !== (h.notes ?? "")) upd(h, { notes: e.target.value.trim() || null }); }} />
                  </td>
                  <td className="border-t px-2 py-1 text-right" style={{ borderColor: HAIR }}>
                    <button type="button" disabled={busy} aria-label={`Remove ${h.role}`} onClick={() => run(`hire-${h.id}`, () => supabase.from("plan_hires").delete().eq("id", h.id))}
                      className="px-1 text-[14px]" style={{ color: FAINT }}>×</button>
                  </td>
                </tr>
                {writeErr?.key === `hire-${h.id}` && <tr><td colSpan={7} className="px-2 pb-1.5 text-[12px]" style={{ color: RED }}>{writeErr.message}</td></tr>}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {writeErr?.key === "hire-new" && <p className="mt-1 text-[12px]" style={{ color: RED }}>{writeErr.message}</p>}
    </div>
  );
}

/* ── ADD A CITY ───────────────────────────────────────────────────────────────────────────────────
 * Region, launch month and starting fields, as Ryan specified; anchor slots and the mature rate
 * because a field's default ramp needs them. Aliases are what tie a city to real venues; they can be
 * left empty for a city with none yet. One function call (0199), so a city never lands without its
 * starting fields. */
function AddCity({ regions, busy, writeErr, run }: { regions: Region[]; busy: boolean; writeErr: { key: string; message: string } | null; run: Run }) {
  const [f, setF] = useState({ name: "", region: regions[0]?.key ?? "", launch: "2027-01-01", slots: "1", mature: "201.2", fields: "2", aliases: "" });
  const months = planMonthKeys(PLAN_YEAR);
  const inp = "rounded-md border bg-white px-2 py-1 text-[12.5px]";
  const submit = async () => {
    const slots = Number(f.slots), mature = Number(f.mature), fields = Number(f.fields);
    if (!f.name.trim() || !Number.isInteger(slots) || slots < 0 || !(mature >= 0) || !Number.isInteger(fields) || fields < 0 || fields > 50) {
      await run("add-city", async () => ({ error: "Name, a whole number of anchor slots, a mature rate and 0–50 starting fields are all needed." }));
      return;
    }
    const aliases = f.aliases.split(",").map((s) => s.trim()).filter(Boolean);
    const ok = await run("add-city", () => supabase.rpc("ops_plan_add_city", {
      p_year: PLAN_YEAR, p_name: f.name.trim(), p_region: f.region, p_launch: f.launch, p_anchor_slots: slots,
      p_mature: mature, p_fields: fields, p_venue_aliases: [f.name.trim(), ...aliases], p_city_ids: aliases.filter((a) => /^[A-Z]{2,5}$/.test(a)),
    }));
    if (ok) setF((x) => ({ ...x, name: "", aliases: "" }));
  };
  return (
    <div className="mt-6 rounded-2xl border-[1.5px] bg-white px-4 py-3" style={{ borderColor: LINE }} data-testid="op-add-city">
      <div className="mb-2 text-[13px] font-extrabold">Add a city</div>
      <div className="flex flex-wrap items-end gap-2 text-[11px]" style={{ color: MUTED }}>
        <label className="flex flex-col gap-0.5">City<input className={inp} style={{ borderColor: LINE }} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} data-testid="op-ac-name" /></label>
        <label className="flex flex-col gap-0.5">Region<select className={inp} style={{ borderColor: LINE }} value={f.region} onChange={(e) => setF({ ...f, region: e.target.value })}>
          {regions.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}</select></label>
        <label className="flex flex-col gap-0.5">Launch<select className={inp} style={{ borderColor: LINE }} value={f.launch} onChange={(e) => setF({ ...f, launch: e.target.value })}>
          {months.map((k) => <option key={k} value={k}>{shortMonth(k)}</option>)}</select></label>
        <label className="flex flex-col gap-0.5">Starting fields<input className={`${inp} w-16`} style={{ borderColor: LINE }} value={f.fields} inputMode="numeric" onChange={(e) => setF({ ...f, fields: e.target.value })} /></label>
        <label className="flex flex-col gap-0.5">Anchor slots<input className={`${inp} w-16`} style={{ borderColor: LINE }} value={f.slots} inputMode="numeric" onChange={(e) => setF({ ...f, slots: e.target.value })} /></label>
        <label className="flex flex-col gap-0.5">Mature spots / field / month<input className={`${inp} w-24`} style={{ borderColor: LINE }} value={f.mature} inputMode="decimal" onChange={(e) => setF({ ...f, mature: e.target.value })} /></label>
        <label className="flex flex-col gap-0.5">Other names / mdapi code (optional)<input className={`${inp} w-48`} style={{ borderColor: LINE }} value={f.aliases} placeholder="e.g. PHX" onChange={(e) => setF({ ...f, aliases: e.target.value })} /></label>
        <button type="button" data-testid="op-ac-submit" disabled={busy} onClick={submit}
          className="rounded-lg px-3 py-1.5 text-[12px] font-bold text-white" style={{ background: INK }}>Add city</button>
      </div>
      {writeErr?.key === "add-city" && <p className="mt-1.5 text-[12px]" style={{ color: RED }} data-testid="op-write-error">{writeErr.message}</p>}
    </div>
  );
}
