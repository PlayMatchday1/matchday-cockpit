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
import { randomUUID } from "node:crypto";
import { apiGet, apiWrite } from "@/lib/matchdayStageApi";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import {
  foldToPeople, counts, neverRan, cityLabel, scopeOfCityId, addBody, removePath, normalizeId,
  CAN_ADD_MATCH_MANAGER, CAN_REMOVE_MATCH_MANAGER, SEARCH_NOTE,
  type ApiAssignment, type ApiCity,
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
    // Production, GET. The roster is 107 rows and pages nowhere; /cities is 10.
    const [rows, cityRows] = await Promise.all([
      apiGet<ApiAssignment[]>("production", "/city-managers"),
      apiGet<ApiCity[]>("production", "/cities").catch(() => [] as ApiCity[]),
    ]);

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
      searchNote: SEARCH_NOTE,
      /* THE CITY LIST IS THE API'S OWN, BY ID. Ten cities — NYC and ELP are in it and in neither
       * CITY_SCOPES nor the finance estate — so it is fetched rather than derived from anything of
       * ours, and the client keys on the numeric id. A confined account gets only its own city,
       * so its picker has one option and the ROUTE refuses the rest anyway. */
      cities: cityRows
        .filter((c) => !scopeCity || cityLabel(c) === scopeCity)
        .map((c) => ({ id: Number(c.id), label: cityLabel(c) })),
      scope: scopeCity, confined: auth.confinedCity !== null,
    });
  } catch (e) {
    // Never the roster's contents: these are real names, emails and phones.
    return Response.json({ error: e instanceof Error ? e.message.slice(0, 160) : "read failed" }, { status: 500 });
  }
}

/* ── THE WRITES ────────────────────────────────────────────────────────────────────────────────
 *
 * POST   /api/match-managers  { userId, cityId }   -> POST   /city-managers {userId, cityId}
 * DELETE /api/match-managers?userId=&cityId=       -> DELETE /city-managers?userId=&cityId=
 *
 * WHO. authenticateMatchOpsRead — anyone with Match Ops access, NOT admins only. That deliberately
 * includes the confined city-manager accounts, which is exactly why the confinement rule below is
 * enforced on the route rather than by hiding a picker: a hidden control is a UI convenience and
 * this is an authorisation boundary.
 *
 * THE CITY IS RESOLVED FROM GET /cities BY NUMERIC ID, never from a name and never from our own
 * CITY_SCOPES list — the API has ten cities (NYC and ELP among them) against our eight, so a
 * mapping written from our list would silently lose two of them.
 *
 * VERIFIED BY READING THE LIST BACK. A 2xx is not proof: recordWrite's before/after both come from
 * GET /city-managers and `applied` asks whether the (userId, cityId) PAIR is present or absent —
 * not whether the status code was cheerful. Verdict is LANDED / FAILED / NOT APPLIED / UNKNOWN.
 *
 * NEVER RETRIES. One apiWrite, one outcome. A duplicate add is a duplicate roster row.
 *
 * NO PII IN THE LOG LINE. The change_log body carries userId and cityId — two integers. The
 * person's name, email and phone are never in it; change_log has different access rules from the
 * roster and must not become a second copy of player contact details. */

export async function POST(req: Request) {
  return roster(req, "add");
}

export async function DELETE(req: Request) {
  return roster(req, "remove");
}

async function roster(req: Request, op: "add" | "remove") {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  // The pair. POST takes a body, DELETE takes a query string — the shapes the API itself uses.
  const url = new URL(req.url);
  const body = op === "add"
    ? ((await req.json().catch(() => null)) as { userId?: unknown; cityId?: unknown } | null)
    : null;
  const userId = normalizeId(op === "add" ? body?.userId : url.searchParams.get("userId"));
  const cityId = normalizeId(op === "add" ? body?.cityId : url.searchParams.get("cityId"));
  if (userId === null) return Response.json({ error: "userId must be a positive integer" }, { status: 400 });
  if (cityId === null) return Response.json({ error: "cityId must be a positive integer" }, { status: 400 });

  try {
    const cityRows = await apiGet<ApiCity[]>("production", "/cities");
    /* THE CITY MUST EXIST IN THE API'S OWN LIST. An id nobody serves is refused here rather than
     * posted and left to whatever the API does with it. */
    const scope = scopeOfCityId(cityRows, cityId);
    if (!scope) return Response.json({ error: `cityId ${cityId} is not a city the API knows` }, { status: 400 });

    /* CONFINEMENT, ON THE PARSED IDENTITY. auth.confinedCity comes from the app_users row read
     * fresh on this request — never from the body, never from a header, never from what the picker
     * happened to show. A confined account naming another city is REFUSED, not re-pointed. */
    const sc = assertScope(auth.confinedCity, scope, auth.confinedCity !== null);
    if (!sc.ok) return Response.json({ error: sc.error }, { status: sc.status });

    const listing = async (): Promise<Record<string, unknown>> => {
      const r = await apiGet<ApiAssignment[]>("production", "/city-managers");
      const rows = Array.isArray(r) ? r : [];
      return { present: rows.some((x) => Number(x.userId) === userId && Number(x.cityId) === cityId), n: rows.length };
    };

    const saveId = randomUUID();
    const path = op === "add" ? "/city-managers" : removePath(userId, cityId);
    const sent = op === "add" ? addBody(userId, cityId) : {};

    const { outcome, error, logged } = await recordWrite(
      {
        env: "production",
        source: op === "add" ? "Match managers · add" : "Match managers · remove",
        actorName: auth.email, actorEmail: auth.email, saveId,
        // Not a match write. change_log's match columns are genuinely empty here and saying so is
        // better than inventing an id to fill them.
        matchId: null, matchName: null,
        method: op === "add" ? "POST" : "DELETE", path,
        // TWO INTEGERS. No name, no email, no phone — see the header.
        body: sent, keys: ["userId", "cityId"], label: (k) => k,
        // THE READ-BACK IS THE VERDICT. Present after an add, absent after a remove.
        applied: (_before, after) => (after.present === true) === (op === "add"),
        changes: [{
          key: op === "add" ? "add" : "remove", field: `${scope} match-manager roster`,
          before: op === "add" ? null : `userId ${userId}`,
          after: op === "add" ? `userId ${userId}` : null,
        }],
      },
      {
        readResource: listing,
        write: () => apiWrite("production", op === "add" ? "POST" : "DELETE", path,
          op === "add" ? sent : undefined, { canEditMatches: true, email: auth.email, userId: auth.appUserId }),
        now: () => new Date().toISOString(),
      },
      supabaseLogStore(),
    );

    // READ IT BACK ONCE MORE, OURSELVES, and answer from that rather than from `outcome` alone —
    // the client renders this verdict and it must be the state of the roster, not of the request.
    const after = await listing().catch(() => null);
    /* A THROW IS NOT AUTOMATICALLY A FAILURE. recordWrite maps an AmbiguousWriteError to
     * "unknown" — the request may have reached MatchDay and landed. Reporting that as FAILED would
     * invite a retry, and this write never retries. */
    const verdict = error
      ? (outcome === "unknown" ? "UNKNOWN" : "FAILED")
      : after === null ? "UNKNOWN"
      : (after.present === true) === (op === "add") ? "LANDED" : "NOT APPLIED";

    return Response.json({
      verdict, outcome, logRecorded: logged, userId, cityId, city: scope,
      error: error ? error.message.slice(0, 200) : undefined,
    }, { status: verdict === "LANDED" ? 200 : verdict === "FAILED" ? 502 : 200 });
  } catch (e) {
    return Response.json({ verdict: "UNKNOWN", error: e instanceof Error ? e.message.slice(0, 200) : "write failed" }, { status: 500 });
  }
}
