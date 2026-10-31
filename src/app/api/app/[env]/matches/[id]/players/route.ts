// Staff app MATCH v2: the player popup and the add player search. Read only, live.
//
//   GET ?id=<playerId>   the popup for a player ON THIS MATCH'S LIVE ROSTER: matches played, credit
//                        and active strikes (Ryan: "Popup stats are matches, credit and strikes"),
//                        member, city, joined, phone last four. A player not on the roster is
//                        refused, so the match's city boundary is the player's boundary here.
//   GET ?q=<term>        search to add, by phone, email or player ID, for accounts that may edit
//                        matches. Each hit says whether they are already on this match.
//
// LIVE ONLY. /admin/players and /admin/players/{id}; the profile mapping is Player Lookup's own
// (playerProfile.ts) with no mirror rows passed, so the match count is the API's played history.

import { authenticateApp, readRefusal } from "@/lib/appAuth";
import { cityAllowed } from "@/lib/appModel";
import { countedPlayers, fetchPlayersLive, isEnv } from "@/lib/appLive";
import { apiGet, StageConfigError, StageHostGuardError, type MatchdayEnv } from "@/lib/matchdayStageApi";
import { CONFINED_CITY_ERROR } from "@/lib/cityConfinement";
import { can } from "@/lib/capabilities";
import { buildProfile } from "@/lib/playerProfile";
import { phoneLast4, searchTerm } from "@/lib/appMatchV2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Row = Record<string, unknown>;
const listOf = (r: unknown) => (Array.isArray(r) ? r : ((r as { data?: unknown[] })?.data ?? [])) as Row[];
const MEMBER = new Set(["ACTIVE", "ADDED_FROM_ADMIN", "TRIALING", "PAST_DUE"]);

async function profileOf(env: MatchdayEnv, playerId: number) {
  const [raw, listRow] = await Promise.all([
    apiGet<Row>(env, `/admin/players/${playerId}`),
    apiGet<unknown>(env, `/admin/players`, { id: playerId, limit: 1, page: 1 }).then((r) => listOf(r)[0] ?? null).catch(() => null),
  ]);
  const p = await buildProfile({ raw, listRow, resolveActor: async () => null, mirrorRows: [], charges: null });
  const status = String(p.membership?.statusRaw ?? "").toUpperCase();
  return {
    id: p.player.id, name: p.player.name, city: p.player.city,
    member: p.membership != null && !p.membership.canceledAt && (status === "" || MEMBER.has(status)),
    matches: p.player.matchesPlayed, credit: p.player.credits, strikes: p.strikes.activeCount,
    joined: p.player.registered, phoneLast4: phoneLast4(p.player.phone),
  };
}

export async function GET(req: Request, ctx: { params: Promise<{ env: string; id: string }> }) {
  const auth = await authenticateApp(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const refused = readRefusal(auth);
  if (refused) return Response.json({ error: refused.error }, { status: refused.status });
  const { env, id } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  if (!/^\d+$/.test(id)) return Response.json({ error: "match id must be numeric" }, { status: 400 });
  const url = new URL(req.url);
  try {
    const [match, roster] = await Promise.all([apiGet<Row>(env, `/admin/matches/${id}`), fetchPlayersLive(env, id)]);
    const city = ((match.field as Row | undefined)?.city as Row | undefined)?.name;
    if (!cityAllowed(auth, auth.scopeCityName, typeof city === "string" ? city : null)) {
      return Response.json({ error: CONFINED_CITY_ERROR }, { status: 403 });
    }
    const onRoster = new Set(countedPlayers(roster).map((p) => Number(p.userId)));

    const pid = url.searchParams.get("id");
    if (pid != null) {
      if (!/^\d+$/.test(pid)) return Response.json({ error: "id must be numeric" }, { status: 400 });
      if (!onRoster.has(Number(pid))) return Response.json({ error: "That player is not on this match's roster." }, { status: 404 });
      return Response.json({ player: await profileOf(env, Number(pid)), readAt: new Date().toISOString() });
    }

    const q = url.searchParams.get("q");
    if (q != null) {
      if (!can(auth.row, "editMatches", auth.email)) return Response.json({ error: "Adding players needs EDIT MATCHES." }, { status: 403 });
      const t = searchTerm(q);
      if (!t) return Response.json({ results: [], hint: "Type a mobile number, an email or a player ID." });
      const r = await apiGet<unknown>(env, `/admin/players`, t.kind === "id"
        ? { id: t.id, limit: 5, page: 1 }
        : { email: t.kind === "phone" ? t.digits : t.text, limit: 5, page: 1, sortColumn: "createdAt", sortDirection: "desc" });
      const hits = listOf(r).filter((u) => u.isFakePlayer !== true).slice(0, 5);
      const results = await Promise.all(hits.map(async (u) => {
        const p = await profileOf(env, Number(u.id)).catch(() => null);
        return {
          id: Number(u.id),
          name: [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || `Player ${u.id}`,
          firstName: typeof u.firstName === "string" ? u.firstName : null,
          city: p?.city ?? null, member: p?.member ?? false, matches: p?.matches ?? null,
          inThisMatch: onRoster.has(Number(u.id)),
        };
      }));
      return Response.json({ results });
    }
    return Response.json({ error: "id or q required" }, { status: 400 });
  } catch (e) {
    if (e instanceof StageHostGuardError || e instanceof StageConfigError) return Response.json({ error: e.message }, { status: 500 });
    const msg = e instanceof Error ? e.message : String(e);
    if (/HTTP 404/.test(msg)) return Response.json({ error: "Not found." }, { status: 404 });
    return Response.json({ error: msg }, { status: 502 });
  }
}
