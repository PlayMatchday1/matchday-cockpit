// Staff app: TODAY. One call returns the day's matches for the cities this account may see, each
// with its check-in summary, so the list never makes a request per row.
//
// LIVE, ALL OF IT. The matches are the MatchDay admin list for the wall-clock day, the same call the
// Gameday Ops board makes. The summaries read each open match's roster live. The only Supabase
// reads are Clubhouse-owned: check-in marks, and the field capacity join the board also uses.
//
// THE SCOPE IS APPLIED HERE, BEFORE ANYTHING IS DERIVED. The API has no city parameter, so other
// cities' rows arrive in this handler; they are dropped before a summary is computed or a byte is
// serialised. Nothing in the response counts a row the caller cannot see.

import { authenticateApp, readRefusal } from "@/lib/appAuth";
import { cityAllowed, CHECKIN_OPENS_MINUTES, LATE_AFTER_MINUTES } from "@/lib/appModel";
import { fetchDayLive, isEnv, summariesLive, todayRow } from "@/lib/appLive";
import { fetchVenueMaxPlayers, trimMatch, withVenueMaxPlayers } from "@/lib/gamedayApiShape";
import { StageConfigError, StageHostGuardError } from "@/lib/matchdayStageApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request, ctx: { params: Promise<{ env: string }> }) {
  const auth = await authenticateApp(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const refused = readRefusal(auth);
  if (refused) return Response.json({ error: refused.error }, { status: refused.status });
  const { env } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  const date = new URL(req.url).searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ error: "date=YYYY-MM-DD required" }, { status: 400 });

  try {
    const raw = await fetchDayLive(env, date);
    const scoped = raw.map(trimMatch).filter((m) => cityAllowed(auth, auth.scopeCityName, m.field.city.name));
    const decorated = withVenueMaxPlayers(scoped, await fetchVenueMaxPlayers(auth.supabase));
    const now = Date.now();
    const summaries = await summariesLive(env, auth.supabase, decorated, now);
    // The untrimmed rows, by id, for the cover photo and manager avatar trimMatch leaves out. Only
    // rows that survived the scope above are ever looked up here.
    const rawById = new Map(raw.map((r) => [Number(r.id), r]));
    const matches = decorated
      .slice()
      .sort((a, b) => Date.parse(a.startDateUtc) - Date.parse(b.startDateUtc))
      .map((m) => todayRow(m, rawById.get(m.id), summaries.get(m.id) ?? null, now));
    return Response.json({
      date, env, fetchedAt: new Date(now).toISOString(),
      scope: { confined: auth.confined, city: auth.scopeCity, cityName: auth.scopeCityName },
      checkinOpensMinutes: CHECKIN_OPENS_MINUTES, lateAfterMinutes: LATE_AFTER_MINUTES,
      checkinAvailable: env === "production",
      matches,
    });
  } catch (e) {
    if (e instanceof StageHostGuardError || e instanceof StageConfigError) return Response.json({ error: e.message }, { status: 500 });
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
