// GET /api/match-managers — the match-manager roster for Player Lookup.
//
// READ ONLY. This route issues exactly one GET to the MatchDay API and writes nothing anywhere.
//
// IT IS READ-ONLY BY CHOICE, NOT BY LIMITATION. An earlier version of this comment said the API had
// no add and no remove. That was wrong: Retool's ADD CITY MANAGER button fires POST /city-managers
// {userId, cityId} and its DELETE button fires DELETE /city-managers?userId=&cityId=, both proven
// on staging by reading the list back. Clubhouse has not built either write yet — see
// NO_MUTATION_REASON, which now says that rather than blaming the API.
//
// THESE ARE NOT CLUBHOUSE CITY MANAGERS. The API calls them "city managers"; app_users
// .is_city_manager is a login with city confinement and is a different population entirely —
// measured, 6 of 87 hold an app_users row and 3 of those carry the flag. The word appears in this
// file only where it names the API's own route, which cannot be renamed from here.

import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { assertScope } from "@/lib/cityConfinement";
import { makeServerClient } from "@/lib/supabaseServer";
import { apiGet } from "@/lib/matchdayStageApi";
import {
  foldToPeople, counts, neverRan,
  CAN_ADD_MATCH_MANAGER, CAN_REMOVE_MATCH_MANAGER, NO_MUTATION_REASON,
  type ApiAssignment,
} from "@/lib/matchManagers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  /* CONFINEMENT. A confined account naming another city is REFUSED rather than re-pointed, and its
   * own default scope is its city — the roster is people who can be put on a match roster, so it
   * is exactly as scoped as the matches are. */
  const url = new URL(req.url);
  const asked = url.searchParams.get("city");
  const sc = assertScope(auth.confinedCity, asked === "all" ? null : asked, auth.confinedCity !== null);
  if (!sc.ok) return Response.json({ error: sc.error }, { status: sc.status });
  const scopeCity = auth.confinedCity ?? (asked && asked !== "all" ? asked : null);

  try {
    // THE ONE CALL. Production, GET, no query — the collection is 107 rows and pages nowhere.
    const rows = await apiGet<ApiAssignment[]>("production", "/city-managers");

    /* MATCHES RUN comes from OUR mirror, not from the API — mdapi_matches.manager_id is the
     * per-MATCH attachment, which is a SECOND mechanism from the city roster this route lists.
     * Being on a city's roster makes someone eligible; the attachment is what Manager Pay pays on.
     * 100 distinct manager_ids appear on matches against 87 people on the roster, so the two sets
     * genuinely differ and neither is a subset of the other. */
    const sb = makeServerClient();
    const runs = new Map<number, { matchesRun: number; lastMatch: string | null }>();

    /* WALL CLOCK, COMPARED AS A STRING. mdapi_matches.start_date carries a `Z` it does not mean —
     * it is LOCAL time at the pitch. `new Date(str)` re-shifts it and lands hours off, which near
     * midnight moves a match across the boundary this filter is drawing. So both sides stay
     * YYYY-MM-DD text and the comparison is lexicographic, which for that format is chronological.
     *
     * THE FILTER MATTERS. Without it the column lies: a manager attached to next Sunday's fixture
     * counted as having RUN it, and the probe that caught this printed "last match 2026-09-06" on
     * 2026-08-26. "Matches run" means matches that HAPPENED. Today itself is excluded — a match
     * this evening has not been run yet. */
    const todayYmd = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

    for (let off = 0; ; off += 1000) {
      const { data, error } = await sb.from("mdapi_matches")
        .select("manager_id,start_date,deleted_at,is_cancelled").not("manager_id", "is", null)
        .order("api_id").range(off, off + 999);
      if (error) throw new Error(`mdapi_matches read failed: ${error.message}`);
      for (const m of data ?? []) {
        if (m.deleted_at) continue;
        // A CANCELLED MATCH WAS NOT RUN. is_cancelled is the flag that says whether it happened —
        // auto_canceled is a POLICY flag and means something else entirely.
        if (m.is_cancelled) continue;
        const d = String(m.start_date ?? "").slice(0, 10);
        if (!d || d >= todayYmd) continue;
        const id = Number(m.manager_id);
        const cur = runs.get(id) ?? { matchesRun: 0, lastMatch: null };
        cur.matchesRun++;
        if (!cur.lastMatch || d > cur.lastMatch) cur.lastMatch = d;
        runs.set(id, cur);
      }
      if ((data ?? []).length < 1000) break;
    }

    const all = foldToPeople(rows, runs);
    const scoped = scopeCity
      ? all.filter((p) => p.cities.some((c) => c.label === scopeCity))
      : all;

    return Response.json({
      people: scoped,
      counts: counts(scoped),
      neverRan: neverRan(scoped),
      canAdd: CAN_ADD_MATCH_MANAGER,
      canRemove: CAN_REMOVE_MATCH_MANAGER,
      mutationReason: NO_MUTATION_REASON,
      scope: scopeCity, confined: auth.confinedCity !== null,
    });
  } catch (e) {
    // Never the roster's contents: these are real names, emails and phones.
    return Response.json({ error: e instanceof Error ? e.message.slice(0, 160) : "read failed" }, { status: 500 });
  }
}
