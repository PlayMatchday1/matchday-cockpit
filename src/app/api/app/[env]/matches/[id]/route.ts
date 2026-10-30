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
// THE MATCH SCREEN reads this one route: header, status, roster, ladder timeline and details.
//
// NOT HERE: the member badge. The only membership read the desktop roster has is the
// mdapi_subscriptions mirror, and the payload's own user.isMember was measured wrong on 39 of 120
// rows. A live membership read per player is a Milestone 2 decision, not a quiet fallback.

import { authenticateApp, readRefusal } from "@/lib/appAuth";
import { cityAllowed } from "@/lib/appModel";
import { checkinFor, countedPlayers, fetchMarks, fetchPlayersLive, isEnv, rosterOut, todayRow } from "@/lib/appLive";
import { trimMatch, type Raw } from "@/lib/gamedayApiShape";
import { rosterRowIsFake } from "@/lib/gamedayModel";
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
    /* THE SAME ROW SHAPE AS TODAY, from the board's own trim and model. The detail endpoint's _count
     * has no fakePlayers, so the fake count is taken from the live roster read in this request
     * (the counted, fake rows), which is the number the board's realCount then subtracts. */
    const fakesOnRoster = countedPlayers(players).filter((p) => rosterRowIsFake(p)).length;
    const counted = { ...match, _count: { ...((match._count as Row | undefined) ?? {}), fakePlayers: fakesOnRoster } } as Raw;
    const now = Date.now();
    const myMarks = marks ? marks.get(Number(id)) ?? [] : null;
    const checkin = myMarks ? checkinFor(players, myMarks, Date.parse(String(match.startDateUtc))) : null;
    const row = todayRow(trimMatch(counted), counted, checkin, now);
    return Response.json({
      env, fetchedAt: new Date(now).toISOString(),
      match: {
        ...row,
        address: typeof field.address === "string" ? field.address.trim() || null : null,
        type: typeof match.type === "string" ? match.type : null,
        secondManager: (() => { const s = match.secondManager as Row | null | undefined; return s ? [s.firstName, s.lastName].filter(Boolean).join(" ").trim() || null : null; })(),
        description: typeof match.description === "string" ? match.description.trim() || null : null,
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
