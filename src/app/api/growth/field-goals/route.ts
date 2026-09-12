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
 * WRITES DO NOT COME THROUGH HERE. The page writes targets, slots and actions straight to
 * PostgREST with the operator's own token, where 0170's growth policy governs them — the same
 * arrangement the kanban boards use.
 */

import { authenticateCapability } from "@/lib/capabilityAuth";
import { selectAll } from "@/lib/supabasePagination";
import {
  GOAL_YEAR, MONTH_LABELS, countsTowardGoals, dailyAverage, daysElapsed,
  matchMonthIndex, monthKey, rowKeyForField, type GoalMatch,
} from "@/lib/fieldGoals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type VenueRow = { id: number; venue_name: string | null; city: string | null };

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "growth");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  try {
    const year = GOAL_YEAR;
    const now = new Date();

    // ── every match the year counts, through the one filter ────────────────────────────────────
    const raw = await selectAll<GoalMatch & { field_title: string | null; city_identifier: string | null }>(() =>
      auth.supabase
        .from("mdapi_matches")
        .select("field_id, field_title, city_identifier, start_date, player_count, is_cancelled")
        .gte("start_date", `${year}-01-01T00:00:00`)
        .lt("start_date", `${year + 1}-01-01T00:00:00`)
        .is("deleted_at", null)
        .order("api_id"));
    const matches = raw.filter(countsTowardGoals);

    // ── field → venue, an ID join the estate already keeps ──────────────────────────────────────
    const [{ data: links }, { data: venues }] = await Promise.all([
      auth.supabase.from("fin_venue_fields").select("fin_venue_id, mdapi_field_id"),
      auth.supabase.from("fin_venues").select("id, venue_name, city"),
    ]);
    const venueOf = new Map<number, number>((links ?? []).map((l) => [l.mdapi_field_id as number, l.fin_venue_id as number]));
    const venueById = new Map<number, VenueRow>((venues ?? []).map((v) => [v.id as number, v as VenueRow]));

    /* ── SPOTS PER ROW PER MONTH, and the row's identity comes with them ──────────────────────
     * A venue's several mdapi fields collapse into one row here, which is the whole reason the key
     * is the venue: keyed on field_id, Soccer Central would be two rows reading 1.1 and 3.3 rather
     * than one reading 4.4. */
    type Acc = { key: string; name: string; city: string | null; venueId: number | null; fieldId: number | null; spots: number[]; matches: number };
    const acc = new Map<string, Acc>();
    const monthSpots = new Array(12).fill(0);
    for (const m of matches) {
      const mi = matchMonthIndex(m.start_date, year);
      if (mi == null) continue;
      const fieldId = m.field_id as number;
      const key = rowKeyForField(fieldId, venueOf);
      const vid = venueOf.get(fieldId) ?? null;
      const a = acc.get(key) ?? {
        key,
        name: vid != null ? (venueById.get(vid)?.venue_name ?? `Venue ${vid}`) : (m.field_title ?? `Field ${fieldId}`),
        city: vid != null ? (venueById.get(vid)?.city ?? null) : (m.city_identifier ?? null),
        venueId: vid, fieldId: vid == null ? fieldId : null,
        spots: new Array(12).fill(0), matches: 0,
      };
      const s = m.player_count ?? 0;
      a.spots[mi] += s; a.matches += 1;
      acc.set(key, a);
      monthSpots[mi] += s;
    }

    // ── the stored half ────────────────────────────────────────────────────────────────────────
    const [{ data: goalRows, error: rowsErr }, { data: targets }, { data: actions }] = await Promise.all([
      auth.supabase.from("field_goal_rows").select("id, venue_id, field_id, slot_name, city, sort_order"),
      auth.supabase.from("field_goal_targets").select("row_id, month, goal_daily"),
      auth.supabase.from("field_goal_actions").select("id, row_id, text, done, sort_order").order("sort_order"),
    ]);
    if (rowsErr) throw new Error(`field_goal_rows: ${rowsErr.message}`);

    /* A STORED ROW IS MATCHED TO A COMPUTED ONE BY IDENTITY, never by name. A slot has neither a
     * venue nor a field, so it stands alone until somebody points it at a venue — which is how a
     * slot graduates without losing the goals and actions typed against it. */
    const storedByKey = new Map<string, { id: string }>();
    for (const r of goalRows ?? []) {
      const k = r.venue_id != null ? `v${r.venue_id}` : r.field_id != null ? `f${r.field_id}` : null;
      if (k) storedByKey.set(k, { id: r.id as string });
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
    const computed = [...acc.values()].map((a) => {
      const stored = storedByKey.get(a.key);
      const monthly = a.spots.map((spots, i) => {
        const { days, of, partial } = daysElapsed(i, year, now);
        return { month: monthKey(year, i), label: MONTH_LABELS[i], spots, days, daysInMonth: of, partial, daily: dailyAverage(spots, days) };
      });
      return {
        key: a.key, rowId: stored?.id ?? null, kind: "existing" as const,
        name: a.name, city: a.city, venueId: a.venueId, fieldId: a.fieldId,
        matches: a.matches, monthly,
        targets: monthsOf(stored?.id ?? null),
        actions: actionsOf(stored?.id ?? null),
      };
    }).sort((x, y) => x.name.localeCompare(y.name));

    // ── the slots: typed rows for fields that do not exist yet ─────────────────────────────────
    const slots = (goalRows ?? []).filter((r) => r.slot_name != null && String(r.slot_name).trim() !== "").map((r) => ({
      key: `s${r.id}`, rowId: r.id as string, kind: "slot" as const,
      name: r.slot_name as string, city: (r.city as string | null) ?? null, venueId: null, fieldId: null,
      matches: 0,
      monthly: MONTH_LABELS.map((label, i) => {
        const { days, of, partial } = daysElapsed(i, year, now);
        return { month: monthKey(year, i), label, spots: 0, days, daysInMonth: of, partial, daily: 0 };
      }),
      targets: monthsOf(r.id as string),
      actions: actionsOf(r.id as string),
      sortOrder: Number(r.sort_order),
    })).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

    /* THE YEAR'S TWELVE BUCKETS, off the SAME matches the rows came from — so the chart and the
     * table cannot disagree. Recorded months are computed; October to December have no elapsed days
     * and carry no average, only whatever targets the rows hold. */
    const months = MONTH_LABELS.map((label, i) => {
      const { days, of, partial } = daysElapsed(i, year, now);
      return { month: monthKey(year, i), label, spots: monthSpots[i], days, daysInMonth: of, partial, daily: dailyAverage(monthSpots[i], days) };
    });

    return Response.json({
      year,
      today: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
      currentMonth: now.getMonth(),
      months,
      rows: computed,
      slots,
      counts: { matches: matches.length, rows: computed.length, unmappedFields: computed.filter((r) => r.fieldId != null).length },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[growth:field-goals]", e);
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
