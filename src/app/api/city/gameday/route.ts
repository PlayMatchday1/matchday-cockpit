// City manager — GAMEDAY OPS, READ ONLY (Phase 29b; rebuilt Phase 29c).
//
// THE REAL BOARD, SCOPED. This used to read the synced Supabase mirror and return a thin,
// bespoke row shape, which is why the city page could only ever be a stripped-down rebuild: the
// mirror does not carry _count.fakePlayers, the fakeSpotLeft* ladder, autoCanceled or the team
// list, so the real board's colour rails, fake-spot countdown and decide-by deadline had nothing
// to render from. It now reads the SAME live MatchDay API the admin board reads, through the same
// trimMatch, and returns the same rows — filtered to one city.
//
// LIVE, NOT THE MIRROR — the same reason the admin route gives: a stale board on a match night is
// worse than none.
//
// SCOPE COMES FROM THE SESSION, NEVER THE REQUEST. city_identifier is read fresh from the caller's
// app_users row on every call (authenticateCityManager → cityManagerGate, no JWT claim, no cache).
// A caller naming another city with ?city= is REFUSED with a 403 that names their scope — not
// silently corrected, which would look like it worked and show them the wrong city, and not a
// fallback to "all", which is the leak this phase exists to close.
//
// THE FILTER IS APPLIED HERE, IN THIS PROCESS, BEFORE THE RESPONSE IS BUILT. The upstream API has
// no city parameter worth using, so the day's rows for every city do arrive in this handler — and
// they must never leave it. Everything derived (the summary) is computed from the ALREADY-SCOPED
// array: a count taken before scoping leaks the shape of data the caller cannot see.
//
// READ ONLY, DELIBERATELY. No match panel, no roster, no cancel preview. Each is something this
// tier must not reach: a roster read is player names and phone numbers for every match in the
// city, and the cancel preview is one confirm from crediting and texting every signed-up player.
// The ONE write a city manager gets is the manager assignment, and it stays on /city/manager-pay
// where it is scoped, logged and read back. This route is GET only and grants nothing else.
import { authenticateCityManager } from "@/lib/cityManagerAuth";
import { cityNameFor } from "@/lib/cityScope";
import { apiGet, StageHostGuardError, StageConfigError } from "@/lib/matchdayStageApi";
import { trimMatch, apiCityNameOf, type Raw } from "@/lib/gamedayApiShape";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// PRODUCTION ONLY. The admin route takes the environment in its path because Match Ops edits both;
// this tier reads its own city's real matches and nothing else, so there is no env to choose and
// no way to ask for staging.
const ENV = "production" as const;
const PAGE_LIMIT = 100;

export async function GET(req: Request) {
  const auth = await authenticateCityManager(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const url = new URL(req.url);
  const asked = url.searchParams.get("city");
  // REFUSED, not corrected. Naming another city is an attempt to read outside the scope, and the
  // honest answer says what the scope is rather than quietly serving something else.
  if (asked != null && asked !== "" && asked !== auth.cityIdentifier) {
    return Response.json({
      error: `You are scoped to ${auth.cityIdentifier}. This account cannot read ${JSON.stringify(asked)}.`,
      scope: auth.cityIdentifier,
    }, { status: 403 });
  }

  const date = (url.searchParams.get("date") || "").trim() || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });

  // A scope the code does not recognise is refused rather than compared. cityNameFor returns null
  // for a hand-typed identifier, and `name === null` would match every row whose city is missing —
  // an unknown scope must be an error, never a filter that quietly passes things.
  const cityName = cityNameFor(auth.cityIdentifier);
  if (!cityName) {
    return Response.json({
      error: `This account is scoped to ${JSON.stringify(auth.cityIdentifier)}, which is not a known city.`,
      scope: auth.cityIdentifier,
    }, { status: 409 });
  }

  try {
    const out: Raw[] = [];
    for (let page = 1; page <= 20; page++) { // 20*100 = 2000 hard ceiling; a single day is never near it
      const res = await apiGet<{ data?: Raw[]; totalItems?: number }>(ENV, `/admin/matches`, {
        fromDate: date, toDate: date, page, limit: PAGE_LIMIT, sortColumn: "startDate", sortDirection: "asc",
      });
      const rows = Array.isArray(res) ? (res as Raw[]) : (res.data ?? []);
      out.push(...rows);
      const total = Array.isArray(res) ? rows.length : (res.totalItems ?? rows.length);
      if (rows.length < PAGE_LIMIT || out.length >= total) break;
    }

    // SCOPE, then derive. Nothing below this line sees another city's rows.
    const matches = out.map(trimMatch).filter((m) => apiCityNameOf(m) === cityName);

    return Response.json({
      date,
      env: ENV,
      scope: auth.cityIdentifier,
      cityName,
      readOnly: true,
      matches,
    });
  } catch (e) {
    if (e instanceof StageHostGuardError) return Response.json({ error: e.message }, { status: 500 });
    if (e instanceof StageConfigError) return Response.json({ error: e.message }, { status: 500 });
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
