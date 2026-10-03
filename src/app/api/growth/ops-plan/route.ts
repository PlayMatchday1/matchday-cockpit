/* GET /api/growth/ops-plan — the 2027 Operations Plan, assembled. READ ONLY.
 *
 * THE SAME ACTUALS AS THE 2026 DAILY MATCHES PAGE, from the same table through the same filter:
 * mdapi_matches, countsTowardGoals(), filled spots, only matches played by yesterday (Chicago), the
 * start date sliced and never parsed. A venue's several mdapi fields collapse to one row through
 * fin_venue_fields, keyed exactly as the 2026 route keys them (rowKeyForField).
 *
 * WHAT THIS ROUTE DOES NOT DO IS ADD THINGS UP. It returns each field with its estimates and its
 * actuals by month; the page rolls them up with lib/opsPlan, the same functions the guard suite
 * exercises, so the arithmetic on screen is the arithmetic under test.
 *
 * WHICH ROWS ARE IN IT. Every row with a 2027 plan entry, plus every counted field PLAYING in a plan
 * city without one ("unplanned") — the 2026 rule that rows are pulled, not typed: a venue that starts
 * playing in Tampa must show up in Tampa whether or not anyone planned it. Rows marked not counted
 * on the 2026 page and with no 2027 entry stay out, as do fields in no plan city (Warsaw).
 *
 * WRITES DO NOT COME THROUGH HERE. The page writes straight to PostgREST with the operator's own
 * token, under 0199's growth policies — the arrangement the 2026 page uses.
 */

import { authenticateCapability } from "@/lib/capabilityAuth";
import { selectAll } from "@/lib/supabasePagination";
import { businessYesterday, countsTowardGoals, playedByYesterday, rowCountsTowardTotals, rowKeyForField, type GoalMatch } from "@/lib/fieldGoals";
import { todayBusinessDate } from "@/lib/goalPace";
import {
  ANCHOR_SETTING_KEY, DEFAULT_ANCHOR_THRESHOLD, PLAN_YEAR, START_MONTH, TRAILING_DAYS, addMonths, normAlias,
  type PlanField, type PlanRole, type PlanStatus, type PlanType,
} from "@/lib/opsPlan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Row = Record<string, unknown>;
const HISTORY_MONTHS = 3;

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "growth");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const sb = auth.supabase;

  try {
    // ── ONE CLOCK, CHICAGO'S, READ ONCE ──────────────────────────────────────────────────────
    const now = new Date();
    const today = todayBusinessDate(now);
    const yesterday = businessYesterday(now);
    const currentMonth = `${today.slice(0, 7)}-01`;
    const [yy, ym, yd] = yesterday.split("-").map(Number);
    const windowStart = new Date(Date.UTC(yy, ym - 1, yd - (TRAILING_DAYS - 1))).toISOString().slice(0, 10);
    const historyStart = addMonths(currentMonth, -HISTORY_MONTHS);
    const from = [windowStart, historyStart, START_MONTH].sort()[0].slice(0, 10);

    // ── the plan tables. Missing = 0199 not applied, which is a state, not a crash ───────────
    const { data: cities, error: citiesErr } = await sb.from("plan_cities").select("*").eq("plan_year", PLAN_YEAR).order("sort_order");
    if (citiesErr) {
      return Response.json({ setup: "missing", message: `plan_cities: ${citiesErr.message}` }, { headers: { "Cache-Control": "no-store" } });
    }
    const [regions, hires, plans, rows, targets, setting, links, venues] = await Promise.all([
      sb.from("plan_regions").select("*").order("sort_order"),
      sb.from("plan_hires").select("*").eq("plan_year", PLAN_YEAR).order("hire_month").order("sort_order"),
      selectAll<Row>(() => sb.from("field_goal_plan").select("*").eq("plan_year", PLAN_YEAR).order("row_id") as never),
      selectAll<Row>(() => sb.from("field_goal_rows").select("*").order("id") as never),
      selectAll<{ row_id: string; month: string; goal_spots: number | string }>(() => sb.from("field_goal_targets")
        .select("row_id, month, goal_spots").not("goal_spots", "is", null)
        .gte("month", `${PLAN_YEAR}-01-01`).lt("month", `${PLAN_YEAR + 1}-01-01`)
        .order("row_id").order("month") as never),
      sb.from("app_settings").select("value").eq("key", ANCHOR_SETTING_KEY).maybeSingle(),
      sb.from("fin_venue_fields").select("fin_venue_id, mdapi_field_id"),
      sb.from("fin_venues").select("id, venue_name, city"),
    ]);
    for (const [name, r] of [["plan_regions", regions], ["plan_hires", hires], ["fin_venue_fields", links], ["fin_venues", venues]] as const) {
      if (r.error) throw new Error(`${name}: ${r.error.message}`);
    }
    const thresholdRaw = Number(setting.data?.value);
    const threshold = Number.isFinite(thresholdRaw) && thresholdRaw > 0 ? thresholdRaw : DEFAULT_ANCHOR_THRESHOLD;

    // ── matches, through the 2026 page's filter ─────────────────────────────────────────────
    /* EVERY MATCH ON RECORD, not just the months the page shows: a city's "to launch" state is "has
     * never played", which a window cannot answer (8,423 counted matches all-time on 2026-10-02).
     * Only the months from `from` on become actuals, exactly as before. */
    const matches = (await selectAll<GoalMatch & { field_title: string | null; city_identifier: string | null }>(() =>
      sb.from("mdapi_matches")
        .select("field_id, field_title, city_identifier, start_date, player_count, is_cancelled")
        .lt("start_date", `${PLAN_YEAR + 1}-01-01T00:00:00`)
        .is("deleted_at", null).order("api_id") as never)).filter(countsTowardGoals);

    const venueOf = new Map<number, number>((links.data ?? []).map((l) => [Number(l.mdapi_field_id), Number(l.fin_venue_id)]));
    const venueById = new Map<number, { venue_name: string | null; city: string | null }>(
      (venues.data ?? []).map((v) => [Number(v.id), { venue_name: v.venue_name as string | null, city: v.city as string | null }]));

    type Acc = { fieldId: number | null; venueId: number | null; title: string | null; cityId: string | null;
      actual: Record<string, { spots: number; matches: number }>; trailing: { spots: number; matches: number };
      /** Any counted match played, ever. */ everPlayed: boolean;
      /** Any match on or after `from` — what made an entry before the read went all-time. An entry
       *  without one is used for nothing but everPlayed, so names, city codes and actuals are exactly
       *  what they were. */ inRange: boolean };
    const acc = new Map<string, Acc>();
    for (const m of matches) {
      const fid = m.field_id as number;
      const key = rowKeyForField(fid, venueOf);
      const vid = venueOf.get(fid) ?? null;
      const a = acc.get(key) ?? { fieldId: vid == null ? fid : null, venueId: vid, title: m.field_title, cityId: m.city_identifier,
        actual: {}, trailing: { spots: 0, matches: 0 }, everPlayed: false, inRange: false };
      acc.set(key, a);
      const day = String(m.start_date).slice(0, 10);
      if (day >= from && !a.inRange) { a.inRange = true; a.title = m.field_title; a.cityId = m.city_identifier; }
      if (!playedByYesterday(m.start_date, yesterday)) continue;   // the row exists; only played matches count
      a.everPlayed = true;
      if (day < from) continue;   // played, but before any month the page shows
      const mk = `${day.slice(0, 7)}-01`;
      const s = m.player_count ?? 0;
      const cell = (a.actual[mk] ??= { spots: 0, matches: 0 });
      cell.spots += s; cell.matches += 1;
      if (day >= windowStart) { a.trailing.spots += s; a.trailing.matches += 1; }
    }

    // ── which plan city a row belongs to ────────────────────────────────────────────────────
    const active = (cities ?? []).filter((c) => c.status === "active");
    const byVenueAlias = new Map<string, string>(), byIdAlias = new Map<string, string>();
    const warnings: string[] = [];
    for (const c of active) {
      for (const a of (c.venue_city_aliases as string[]) ?? []) {
        const k = normAlias(a);
        if (byVenueAlias.has(k) && byVenueAlias.get(k) !== c.id) warnings.push(`The alias "${a}" belongs to two cities.`);
        byVenueAlias.set(k, c.id as string);
      }
      for (const a of (c.city_identifiers as string[]) ?? []) {
        const k = normAlias(a);
        if (byIdAlias.has(k) && byIdAlias.get(k) !== c.id) warnings.push(`The code "${a}" belongs to two cities.`);
        byIdAlias.set(k, c.id as string);
      }
    }
    if (warnings.length) {
      /* AN OVERLAP IS REFUSED, NOT RESOLVED. Whichever city won the map would quietly take the other's
       * venues, and every total below would be wrong by an amount nobody could find. */
      return Response.json({ error: `City aliases overlap: ${warnings.join(" ")}` }, { status: 500 });
    }

    const planByRow = new Map<string, Row>(plans.map((p) => [p.row_id as string, p]));
    const targetsByRow = new Map<string, Record<string, number>>();
    for (const t of targets) {
      const m = (targetsByRow.get(t.row_id) ?? {});
      m[String(t.month).slice(0, 10)] = Number(t.goal_spots);
      targetsByRow.set(t.row_id, m);
    }

    const keyOfRow = (r: Row): string =>
      r.venue_id != null ? `v${r.venue_id}` : r.field_id != null ? `f${r.field_id}` : `s${r.id}`;
    const storedByKey = new Map<string, Row>(rows.map((r) => [keyOfRow(r), r]));
    const keys = new Set<string>([...storedByKey.keys(), ...acc.keys()]);

    const fields: PlanField[] = [];
    /** Plan cities with at least one counted match played, ever, through the same row-to-city rule. */
    const playedCities = new Set<string>();
    for (const key of keys) {
      const r = storedByKey.get(key) ?? null;
      const all = acc.get(key) ?? null;
      /* `a` is the entry as it was before the read went all-time; `all` adds fields that only played
       * earlier, which can only resolve a city for playedCities and then drop out as not playing. */
      const a = all?.inRange ? all : null;
      const plan = r ? planByRow.get(r.id as string) : undefined;
      const venueId = r?.venue_id != null ? Number(r.venue_id) : all?.venueId ?? null;
      const fieldId = r?.field_id != null ? Number(r.field_id) : all?.fieldId ?? null;
      const kind: PlanField["kind"] = venueId != null ? "venue" : fieldId != null ? "field" : "slot";

      let cityId: string | null = (plan?.plan_city_id as string | undefined) ?? null;
      if (!cityId) {
        if (r && !rowCountsTowardTotals({ notCounted: r.not_counted === true })) continue;   // stays out
        if (kind === "venue") cityId = byVenueAlias.get(normAlias(venueById.get(venueId as number)?.city)) ?? null;
        else if (kind === "field") cityId = byIdAlias.get(normAlias((r ? a : all)?.cityId ?? (r?.city as string | null))) ?? null;
        else if (r && r.plan_year == null) cityId = byVenueAlias.get(normAlias(r.city as string | null)) ?? null;
      }
      if (!cityId) continue;
      if (all?.everPlayed) playedCities.add(cityId);

      const role: PlanRole = plan ? (plan.role as PlanRole) : "unplanned";
      const actual = a?.actual ?? {};
      const trailing = a?.trailing ?? { spots: 0, matches: 0 };
      /* AN UNPLANNED ROW IS ONLY WORTH A LINE IF IT IS PLAYING — in the window, or in any month the
       * page shows. A venue that stopped in March 2025 is not a field in this plan. */
      if (role === "unplanned" && trailing.matches === 0 && !Object.values(actual).some((x) => x.matches > 0)) continue;

      const name = kind === "venue" ? (venueById.get(venueId as number)?.venue_name ?? `Venue ${venueId}`)
        : kind === "field" ? (a?.title ?? `Field ${fieldId}`)
        : String(r?.slot_name ?? "Unnamed field");
      fields.push({
        key, rowId: (r?.id as string | undefined) ?? null, name, kind, venueId, fieldId, cityId, role,
        createdForPlan: r != null && Number(r.plan_year) === PLAN_YEAR,
        status: plan ? (plan.status as PlanStatus) : null,
        plannedType: (plan?.planned_type as PlanType | null | undefined) ?? null,
        openMonth: plan?.planned_open_month ? String(plan.planned_open_month).slice(0, 10) : null,
        targets: r ? (targetsByRow.get(r.id as string) ?? {}) : {},
        actual, trailing,
      });
    }

    return Response.json({
      setup: (cities ?? []).length ? "ready" : "unseeded",
      year: PLAN_YEAR, today, yesterday, currentMonth, windowStart, threshold,
      regions: (regions.data ?? []).map((r) => ({ key: r.key, name: r.name, shortName: r.short_name, note: r.note, sortOrder: Number(r.sort_order) })),
      cities: (cities ?? []).map((c) => ({
        id: c.id, name: c.name, regionKey: c.region_key,
        launchMonth: c.launch_month ? String(c.launch_month).slice(0, 10) : null,
        anchorSlots: Number(c.anchor_slots), mature: Number(c.mature_spots_per_field),
        status: c.status, sortOrder: Number(c.sort_order), everPlayed: playedCities.has(c.id as string),
        venueAliases: c.venue_city_aliases ?? [], cityIds: c.city_identifiers ?? [],
      })),
      hires: (hires.data ?? []).map((h) => ({
        id: h.id, hireMonth: String(h.hire_month).slice(0, 10), runningMonth: h.running_month ? String(h.running_month).slice(0, 10) : null,
        role: h.role, kind: h.kind, regionKey: h.region_key, notes: h.notes, sortOrder: Number(h.sort_order),
      })),
      fields,
      venues: (venues.data ?? []).map((v) => ({ id: Number(v.id), name: v.venue_name, city: v.city })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[growth:ops-plan]", e);
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
