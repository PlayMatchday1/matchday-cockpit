import "server-only"; // no-op under --conditions=react-server
// FIELD GOALS, THE YEAR'S ROLLUP (Ryan, 2026-11-02): spots and matches per row (a venue, or a field
// with no venue) per month, and the month totals, from every 2026 match. The same for every account;
// the route filters it to the caller's city afterwards. Cached ten minutes per business day and kept
// warm by /api/app/cron/warm, so the Field Goals page and the staff app's Goals read it, not the year.
// Moved here unchanged from src/app/api/growth/field-goals/route.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import { unstable_cache } from "next/cache";
import { selectAllParallel } from "./supabasePagination";
import { countsTowardGoals, matchMonthIndex, playedByYesterday, rowKeyForField, type GoalMatch } from "./fieldGoals";

type VenueRow = { id: number; venue_name: string | null; city: string | null };
export type RollupRow = { key: string; name: string; city: string | null; /** The MatchDay city_identifier of the row's first match (ATX, DFW, WAW…). The 2026 Daily Matches page places a row in a city by this. */ cityCode: string | null; venueId: number | null; fieldId: number | null; spots: number[]; perMonth: number[]; matches: number };

export function fieldGoalsRollup(sb: SupabaseClient, year: number, yesterday: string): Promise<{ rows: RollupRow[]; monthSpots: number[]; matchCount: number }> {
  return unstable_cache(async () => {
    /* CACHED TEN MINUTES PER BUSINESS DAY, READ IN PARALLEL (2026-11-02): every 2026 match, about
     * 5,400 rows in 6 pages one after another, 0.9 s, on every load of this page and of the staff
     * app's Goals tab. The rows are the same for every account (the city filter is applied below,
     * after this) and the mirror they come from syncs a few times a day. */
    type YearRow = GoalMatch & { field_title: string | null; city_identifier: string | null };
    const yearQuery = () => sb
      .from("mdapi_matches")
      .select("field_id, field_title, city_identifier, start_date, player_count, is_cancelled")
      .gte("start_date", `${year}-01-01T00:00:00`)
      .lt("start_date", `${year + 1}-01-01T00:00:00`)
      .is("deleted_at", null)
      .order("api_id");
    const raw = await unstable_cache(
      () => selectAllParallel<YearRow>(yearQuery, () => sb.from("mdapi_matches").select("api_id", { count: "exact", head: true })
        .gte("start_date", `${year}-01-01T00:00:00`).lt("start_date", `${year + 1}-01-01T00:00:00`).is("deleted_at", null)),
      ["field-goals-year-v1", String(year), yesterday], { revalidate: 600, tags: ["field-goals"] })();
    /* THE ROW SET COMES FROM EVERY COUNTED MATCH; ONLY THE SPOTS ARE FILTERED. Filtering here
     * instead deleted two whole fields from the page: Turf On (Houston, 14 matches) and One Touch
     * (Atlanta, 13), both signed and both starting 1 October, so every match they have is still
     * ahead. They are precisely what this page exists to surface — "every venue with a 2026 match
     * is a row, whether or not anybody has given it a goal" — and they would have gone silently.
     * They now render with a zero actual and fold under the dormant line, which is what a field
     * that has not played this month is. */
    const matches = raw.filter(countsTowardGoals);

    // ── field → venue, an ID join the estate already keeps ──────────────────────────────────────
    const [{ data: links }, { data: venues }] = await Promise.all([
      sb.from("fin_venue_fields").select("fin_venue_id, mdapi_field_id"),
      sb.from("fin_venues").select("id, venue_name, city"),
    ]);
    const venueOf = new Map<number, number>((links ?? []).map((l) => [l.mdapi_field_id as number, l.fin_venue_id as number]));
    const venueById = new Map<number, VenueRow>((venues ?? []).map((v) => [v.id as number, v as VenueRow]));

    /* ── SPOTS PER ROW PER MONTH, and the row's identity comes with them ──────────────────────
     * A venue's several mdapi fields collapse into one row here, which is the whole reason the key
     * is the venue: keyed on field_id, Soccer Central would be two rows reading 1.1 and 3.3 rather
     * than one reading 4.4. */
    type Acc = { key: string; name: string; city: string | null; cityCode: string | null; venueId: number | null; fieldId: number | null; spots: number[]; perMonth: number[]; matches: number };
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
        cityCode: m.city_identifier ?? null,
        venueId: vid, fieldId: vid == null ? fieldId : null,
        spots: new Array(12).fill(0), perMonth: new Array(12).fill(0), matches: 0,
      };
      /* THE ROW EXISTS EITHER WAY. Only a PLAYED match adds spots — a match later today or later
       * this month brings its bookings-so-far into a numerator whose divisor covers completed days
       * only, which is what made the figure drift all afternoon. */
      acc.set(key, a);
      if (!playedByYesterday(m.start_date, yesterday)) continue;
      const s = m.player_count ?? 0;
      /* MATCHES PER MONTH, not just spots: DORMANT is "no match played in the month on screen",
       * which a zero average cannot tell you — a month with one empty match is not a quiet month. */
      a.spots[mi] += s; a.perMonth[mi] += 1; a.matches += 1;
      acc.set(key, a);
      monthSpots[mi] += s;
    }


    return { rows: [...acc.values()], monthSpots, matchCount: matches.length };
  }, ["field-goals-rollup-v2", String(year), yesterday], { revalidate: 600, tags: ["field-goals"] })();
}
