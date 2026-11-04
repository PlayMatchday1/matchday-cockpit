/* GET /api/growth/field-goals — the 2026 Daily Matches page, computed. READ ONLY.
 *
 * EVERYTHING DERIVABLE IS DERIVED HERE, on every load: each month's daily average for the whole
 * year, every venue's September column, and the row set itself. The only things read from a table
 * are the ones that cannot be computed — the monthly targets, the not-yet-existing field slots, and
 * the actions. The sheet this replaces stores a total of 16.7 while its own rows sum to 16.6; that
 * is what storing a derived number looks like.
 *
 * THE ROWS ARE PULLED, NOT TYPED. Every venue with a 2026 match is a row, whether or not anybody
 * has given it a goal — which is how the page surfaces what the sheet left out (Warsaw's Bemowo has
 * eight September matches and is on no sheet at all). A hand-kept list of fields goes stale exactly
 * the way a hand-kept average does.
 *
 * ONE MATCH FILTER, countsTowardGoals(), shared with the chart. See fieldGoals.ts.
 *
 * A CITY-CONFINED ACCOUNT (Ryan, 2026-10-31) gets its own city's rows and slots and nothing else:
 * a row stays when its city label resolves to the session's city (cityIdentifierForLabel), and the
 * month totals and counts are recomputed from those rows, so no estate figure reaches it. The city
 * comes from the session, never from the request.
 *
 * WRITES DO NOT COME THROUGH HERE. The page writes targets, slots and actions straight to
 * PostgREST with the operator's own token, where 0170's growth policy governs them — the same
 * arrangement the kanban boards use.
 */

import { authenticateCapability } from "@/lib/capabilityAuth";
import { fieldGoalsRollup } from "@/lib/fieldGoalsRollup";
import {
  GOAL_YEAR, MONTH_LABELS, businessMonthIndex, businessYesterday, countsTowardGoals, dailyAverage,
  daysElapsed, matchMonthIndex, monthKey, playedByYesterday, rowBelongsToGoalYear, rowCountsTowardTotals, rowKeyForField,
  targetBelongsToGoalYear,
  type GoalMatch,
} from "@/lib/fieldGoals";
import { todayBusinessDate } from "@/lib/goalPace";
import { cityIdentifierForLabel } from "@/lib/cityScope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type VenueRow = { id: number; venue_name: string | null; city: string | null };

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "growth");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  try {
    const year = GOAL_YEAR;
    /* ONE CLOCK, READ ONCE, AND IT IS CHICAGO'S. Every derived date below comes off `now` through
     * the business-calendar helpers; nothing calls a raw getter on it. Read once so the three
     * daysElapsed call sites and the numerator filter cannot straddle a midnight mid-request. */
    const now = new Date();
    const yesterday = businessYesterday(now);

    // ── every match the year counts, through the one filter ────────────────────────────────────
    /* THE YEAR'S ROLLUP, precomputed (src/lib/fieldGoalsRollup.ts, warmed by /api/app/cron/warm):
     * spots and matches per row per month. This route reads it and adds the stored half. */
    const rollup = await fieldGoalsRollup(auth.supabase, year, yesterday);
    const acc = new Map(rollup.rows.map((r) => [r.key, r]));
    const monthSpots = rollup.monthSpots;

    // ── the stored half ────────────────────────────────────────────────────────────────────────
    const [{ data: allGoalRows, error: rowsErr }, { data: allTargets }, { data: actions }] = await Promise.all([
      /* SELECT * DELIBERATELY, and not_counted is read defensively below. adminAuth does the same
       * with app_users and for the same reason: code deploys before a migration is applied, and a
       * named column that does not exist yet 500s the whole route. Before 0171 lands every row
       * simply counts, which is today's behaviour. */
      auth.supabase.from("field_goal_rows").select("*"),
      /* FILTERED IN SQL, NOT ONLY BELOW. The 2027 seed adds ~1,050 goal_spots rows to this table,
       * and an unfiltered read is capped at 1,000 by PostgREST — it would silently drop 2026 goals.
       * goal_daily has existed since 0170, so naming it is safe whatever has been applied. */
      auth.supabase.from("field_goal_targets").select("row_id, month, goal_daily")
        .not("goal_daily", "is", null).gte("month", `${year}-01-01`).lt("month", `${year + 1}-01-01`),
      auth.supabase.from("field_goal_actions").select("id, row_id, text, done, sort_order").order("sort_order"),
    ]);
    if (rowsErr) throw new Error(`field_goal_rows: ${rowsErr.message}`);

    /* ── THE CITIES ARE A LIST NOW (0253 growth_cities), not whatever label a field carries ──────
     * An existing field lands in the city whose short_code is its MatchDay city code; a new field
     * points at its city by id. A row with no city row is NOT on this page, and that is the
     * mechanism, not a side effect: it is how WAW stays off whatever a sync or a new field brings.
     * WAW is also refused by name below, so even a growth_cities row for it could not bring it back.
     * (Warsaw is untouched everywhere else in Clubhouse — this filter lives in this route only.) */
    const { data: cityRows, error: cityErr } = await auth.supabase.from("growth_cities").select("*").order("sort_order");
    if (cityErr) throw new Error(`growth_cities: ${cityErr.message}`);
    const EXCLUDED_CODES = new Set(["WAW"]);
    type City = { id: string; name: string; shortCode: string | null; decGoal: number; hidden: boolean; sortOrder: number };
    const cityList: City[] = (cityRows ?? [])
      .filter((c) => !EXCLUDED_CODES.has(String(c.short_code ?? "").toUpperCase()) && !/^(waw|warsaw)$/i.test(String(c.name ?? "").trim()))
      .map((c) => ({ id: c.id as string, name: String(c.name).trim(), shortCode: (c.short_code as string | null) ?? null,
        decGoal: Number(c.dec_goal_daily ?? 0), hidden: c.hidden === true, sortOrder: Number(c.sort_order ?? 0) }));
    const cityByCode = new Map(cityList.filter((c) => c.shortCode).map((c) => [String(c.shortCode).toUpperCase(), c]));
    const cityById = new Map(cityList.map((c) => [c.id, c]));
    /* THE 2027 PLAN SHARES THESE TABLES (0199). Its rows and its spot estimates are filtered here,
     * once, before anything below reads them — see rowBelongsToGoalYear. */
    const goalRows = (allGoalRows ?? []).filter((r) => rowBelongsToGoalYear(r as Record<string, unknown>, year));
    const targets = (allTargets ?? []).filter((t) => targetBelongsToGoalYear(t, year));

    /* A STORED ROW IS MATCHED TO A COMPUTED ONE BY IDENTITY, never by name. A slot has neither a
     * venue nor a field, so it stands alone until somebody points it at a venue — which is how a
     * slot graduates without losing the goals and actions typed against it. */
    const storedByKey = new Map<string, { id: string; notCounted: boolean }>();
    for (const r of goalRows ?? []) {
      const k = r.venue_id != null ? `v${r.venue_id}` : r.field_id != null ? `f${r.field_id}` : null;
      if (k) storedByKey.set(k, { id: r.id as string, notCounted: (r as Record<string, unknown>).not_counted === true });
    }

    const monthsOf = (rowId: string | null): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const t of targets ?? []) {
        if (rowId && t.row_id === rowId) out[String(t.month).slice(0, 10)] = Number(t.goal_daily);
      }
      return out;
    };
    const actionsOf = (rowId: string | null) =>
      (actions ?? []).filter((a) => rowId && a.row_id === rowId)
        .map((a) => ({ id: a.id as string, text: a.text as string, done: a.done === true, sortOrder: Number(a.sort_order) }));

    // ── the computed rows, one per venue (or unmapped field) with a 2026 match ──────────────────
    const computed = [...acc.values()].flatMap((a) => {
      const code = String(a.cityCode ?? "").toUpperCase();
      const home = EXCLUDED_CODES.has(code) ? undefined : cityByCode.get(code);
      if (!home) return [];
      const stored = storedByKey.get(a.key);
      const monthly = a.spots.map((spots, i) => {
        const { days, of, partial } = daysElapsed(i, year, now);
        return { month: monthKey(year, i), label: MONTH_LABELS[i], spots, matches: a.perMonth[i], days, daysInMonth: of, partial, daily: dailyAverage(spots, days) };
      });
      return [{
        key: a.key, rowId: stored?.id ?? null, kind: "existing" as const,
        name: a.name, city: home.name, cityId: home.id, cityCode: code, cityHidden: home.hidden,
        venueId: a.venueId, fieldId: a.fieldId,
        notCounted: stored?.notCounted === true,
        matches: a.matches, monthly,
        targets: monthsOf(stored?.id ?? null),
        actions: actionsOf(stored?.id ?? null),
      }];
    }).sort((x, y) => x.name.localeCompare(y.name));

    /* ── THE CITY BOUNDARY ── applied before anything below sums a row. By the city's SHORT CODE
     * (cityIdentifierForLabel accepts an identifier), so renaming a city cannot move it out of a
     * confined account's scope. A city with no code falls back to its name. */
    const scope = auth.confinedCity;
    const inScope = (c: { shortCode: string | null; name: string } | undefined) =>
      !!c && (!scope || cityIdentifierForLabel(c.shortCode ?? c.name) === scope);
    /* A HIDDEN CITY IS OFF THE PAGE — its rows leave the table, the chart and every total — but
     * nothing is deleted, and the city itself is still returned (hiddenCities) so it can be shown again. */
    const rows = computed.filter((r) => inScope(cityById.get(r.cityId)) && !r.cityHidden);

    // ── the slots: typed rows for fields that do not exist yet ─────────────────────────────────
    /* A NEW FIELD BELONGS TO A CITY BY ID (growth_city_id). One with no city is not on this page —
     * since 0253 the page cannot create one, and the last five were deleted with it. */
    const allSlots = (goalRows ?? []).filter((r) => r.slot_name != null && String(r.slot_name).trim() !== ""
        && (r as Record<string, unknown>).growth_city_id != null && cityById.has(String((r as Record<string, unknown>).growth_city_id)))
      .map((r) => {
      const home = cityById.get(String((r as Record<string, unknown>).growth_city_id))!;
      return {
      key: `s${r.id}`, rowId: r.id as string, kind: "slot" as const,
      name: r.slot_name as string, city: home.name, cityId: home.id, cityCode: home.shortCode, cityHidden: home.hidden,
      kanbanCardId: ((r as Record<string, unknown>).kanban_card_id as string | null) ?? null,
      venueId: null, fieldId: null,
      notCounted: (r as Record<string, unknown>).not_counted === true,
      matches: 0,
      monthly: MONTH_LABELS.map((label, i) => {
        const { days, of, partial } = daysElapsed(i, year, now);
        return { month: monthKey(year, i), label, spots: 0, matches: 0, days, daysInMonth: of, partial, daily: 0 };
      }),
      targets: monthsOf(r.id as string),
      actions: actionsOf(r.id as string),
      sortOrder: Number(r.sort_order),
    }; }).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    const slots = allSlots.filter((r) => inScope(cityById.get(r.cityId)) && !r.cityHidden);

    /* THE CITIES THIS ACCOUNT SEES, with what the remove/hide decision needs: a city whose fields
     * have recorded matches can only be HIDDEN; one with none can be removed. Every existing row
     * comes from a counted 2026 match, so "has an existing row" is "has recorded matches". */
    const withMatches = new Set(computed.filter((r) => r.matches > 0).map((r) => r.cityId));
    const shape = (c: City) => ({ ...c, hasMatches: withMatches.has(c.id) });
    const cities = cityList.filter((c) => inScope(c) && !c.hidden).map(shape);
    const hiddenCities = cityList.filter((c) => inScope(c) && c.hidden).map(shape);

    /* THE YEAR'S TWELVE BUCKETS, off the SAME matches the rows came from — so the chart and the
     * table cannot disagree. Recorded months are computed; October to December have no elapsed days
     * and carry no average, only whatever targets the rows hold. */
    /* THE BARS ARE SUMMED OVER THE COUNTED ROWS, not over every match — one predicate, read here
     * and by the table, so a not-counted field leaves the chart and the totals together. Summing
     * all matches here while the table excluded a row is exactly the spreadsheet's fault: bars
     * sitting above the sum of the rows beneath them. Dormant rows DO count: they are folded in the
     * table, not removed from the year. */
    const countedSpots = new Array(12).fill(0);
    for (const r of rows) {
      if (!rowCountsTowardTotals(r)) continue;
      r.monthly.forEach((m, i) => { countedSpots[i] += m.spots; });
    }
    const months = MONTH_LABELS.map((label, i) => {
      const { days, of, partial } = daysElapsed(i, year, now);
      return { month: monthKey(year, i), label, spots: countedSpots[i], days, daysInMonth: of, partial, daily: dailyAverage(countedSpots[i], days) };
    });
    void monthSpots;   // kept as the unfiltered figure; nothing renders it

    return Response.json({
      year,
      today: todayBusinessDate(now),
      /* THE PAGE'S CURRENT MONTH, CHICAGO'S. This read now.getMonth() off a UTC runtime, so for the
       * five hours between 7pm and midnight on the 30th the page relabelled to the next month,
       * closed the current one as finished and opened the new one with one elapsed day. Everything
       * derived from `cur` moved with it. */
      currentMonth: businessMonthIndex(now).monthIndex0,
      months,
      rows,
      slots,
      cities,
      hiddenCities,
      scopeCity: scope,
      counts: { matches: scope ? rows.reduce((n, r) => n + r.matches, 0) : rollup.matchCount, rows: rows.length, unmappedFields: rows.filter((r) => r.fieldId != null).length },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[growth:field-goals]", e);
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
