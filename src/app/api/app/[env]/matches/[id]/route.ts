// Staff app: ONE MATCH, its teams and its roster. Read only.
//
// THE CITY CHECK READS THE LIVE MATCH. The desktop routes check a match id against the mdapi_matches
// mirror, which a daily cron fills, so a match created after that run is refused to a confined
// account until the next morning. Here the city comes from GET /admin/matches/{id} in this request:
// a match created five minutes ago answers exactly like one created last year.
//
// The match and its players are fetched together; if the city check fails the players are dropped
// in this handler and never serialised.
//
// NOT HERE: the member badge. The only membership read the desktop roster has is the
// mdapi_subscriptions mirror, and the payload's own user.isMember was measured wrong on 39 of 120
// rows. A live membership read per player is a Milestone 2 decision, not a quiet fallback.

import { authenticateApp, readRefusal } from "@/lib/appAuth";
import { cityAllowed } from "@/lib/appModel";
import { fetchMarks, fetchPlayersLive, isEnv, rosterOut } from "@/lib/appLive";
import { apiGet, StageConfigError, StageHostGuardError } from "@/lib/matchdayStageApi";
import { CONFINED_CITY_ERROR } from "@/lib/cityConfinement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Row = Record<string, unknown>;

export async function GET(req: Request, ctx: { params: Promise<{ env: string; id: string }> }) {
  const auth = await authenticateApp(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const refused = readRefusal(auth);
  if (refused) return Response.json({ error: refused.error }, { status: refused.status });
  const { env, id } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  if (!/^\d+$/.test(id)) return Response.json({ error: "match id must be numeric" }, { status: 400 });

  try {
    const [match, players] = await Promise.all([
      apiGet<Row>(env, `/admin/matches/${id}`),
      fetchPlayersLive(env, id),
    ]);
    const field = (match.field as Row | undefined) ?? {};
    const city = (field.city as Row | undefined) ?? {};
    const cityName = typeof city.name === "string" ? city.name : null;
    if (!cityAllowed(auth, auth.scopeCityName, cityName)) {
      return Response.json({ error: CONFINED_CITY_ERROR }, { status: 403 });
    }
    const marks = await fetchMarks(auth.supabase, env, [Number(id)]);
    const teams = ((match.teams as Row[]) ?? [])
      .map((t) => ({ id: Number(t.id), teamNumber: Number(t.teamNumber), name: (t.name as string) ?? `Team ${t.teamNumber}` }))
      .sort((a, b) => a.teamNumber - b.teamNumber);
    const mgr = match.manager as Row | null | undefined;
    const tz = (city.timeZone as Row | undefined) ?? {};
    return Response.json({
      env, fetchedAt: new Date().toISOString(),
      match: {
        id: Number(id), name: (match.name as string) ?? "",
        startDate: (match.startDate as string) ?? null, startDateUtc: (match.startDateUtc as string) ?? null,
        fieldTitle: typeof field.title === "string" ? field.title.trim() : null, cityName,
        tzAbbr: typeof tz.abbr === "string" ? tz.abbr.trim() || null : null,
        isCancelled: match.isCancelled === true,
        manager: mgr ? [mgr.firstName, mgr.lastName].filter(Boolean).join(" ").trim() || null : null,
        capacity: Number(match.maxPlayerCount) || null,
        occupancy: Number((match._count as Row | undefined)?.players ?? 0),
      },
      teams,
      players: rosterOut(players, marks ? marks.get(Number(id)) ?? [] : null),
      checkinAvailable: marks !== null,
    });
  } catch (e) {
    if (e instanceof StageHostGuardError || e instanceof StageConfigError) return Response.json({ error: e.message }, { status: 500 });
    const msg = e instanceof Error ? e.message : String(e);
    // A match id the API does not know is a 404 upstream; say so rather than 502.
    if (/HTTP 404/.test(msg)) return Response.json({ error: "No match with that id." }, { status: 404 });
    return Response.json({ error: msg }, { status: 502 });
  }
}
