// Staff app MATCH v2: every roster and team write. Ryan, 2026-10-30.
//
// THIS ROUTE WRITES NOTHING ITSELF, the same rule as Adjust. It calls the desktop Gameday Ops
// handlers in process with the caller's own request headers, so each write keeps the EDIT MATCHES
// grant, the city boundary on the match id, the guarded write client, recordWrite into change_log
// with the caller as the actor, and the handler's own read-back verdict.
//
//   move     POST /api/matchday/{env}/roster/{id}            { kind: "move" }   one per player
//   add      POST /api/matchday/{env}/roster/{id}            { kind: "add" }
//   remove   POST /api/matchday/{env}/roster/{id}            { kind: "remove" }
//   teams    2 -> 4        POST /api/matchday/{env}/matches/{id}/convert-4
//            3 or 4 -> 2   POST /api/matchday/{env}/matches/{id}/reduce-2
//            otherwise     POST roster { kind: "shape", fields: { teamNumbers } }, then
//                          PUT  /api/matchday/{env}/matches/{id}  { changes: capacity }
//                          (the desktop Save's own order: the shape first, the fields after)
//   size     PUT  /api/matchday/{env}/matches/{id}            { changes: teamCountWrites(...) }
//
// GET ?preview=teams&target=N describes a team count change for the confirm sheet and writes nothing.
//
// ONE MOVE IS ONE SAVE. A swap, or a host with their guests, is several, sent in order; the first
// that does not land stops the rest, and the response names what changed and what did not. Writes
// never retry: a retry is a new tap.
//
// AFTER EVERY WRITE, A LIVE READ-BACK of the match and roster, compared with what was asked for.

import { randomUUID } from "node:crypto";
import { authenticateApp, readRefusal } from "@/lib/appAuth";
import { cityAllowed } from "@/lib/appModel";
import { countedPlayers, fetchPlayersLive, isEnv } from "@/lib/appLive";
import { apiGet, StageConfigError, StageHostGuardError, type MatchdayEnv } from "@/lib/matchdayStageApi";
import { CONFINED_CITY_ERROR } from "@/lib/cityConfinement";
import { rosterRowIsFake } from "@/lib/gamedayModel";
import { moneyLine, pickerCapacityWrites, sizeRefusal, sizeWrites, teamsPath } from "@/lib/appMatchV2";
import { POST as desktopRosterPost } from "@/app/api/matchday/[env]/roster/[matchId]/route";
import { PUT as desktopMatchPut } from "@/app/api/matchday/[env]/matches/[id]/route";
import { GET as convertGet, POST as convertPost } from "@/app/api/matchday/[env]/matches/[id]/convert-4/route";
import { GET as reduceGet, POST as reducePost } from "@/app/api/matchday/[env]/matches/[id]/reduce-2/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Row = Record<string, unknown>;
type Step = { what: string; label: string; status: number; outcome: string; error: string | null };
type Move = { userMatchId: number; team: number; playerNumber: number };

const SOURCE = "Staff app · Match";
const int = (v: unknown) => (Number.isInteger(Number(v)) && v !== null && v !== "" ? Number(v) : null);

/** The live match and its counted roster, in the shape the app's roster draws. */
async function readLive(env: MatchdayEnv, id: string) {
  const [match, raw] = await Promise.all([apiGet<Row>(env, `/admin/matches/${id}`), fetchPlayersLive(env, id)]);
  const teams = ((match.teams as Row[]) ?? [])
    .map((t) => ({ id: Number(t.id), teamNumber: Number(t.teamNumber), name: (t.name as string) ?? `Team ${t.teamNumber}` }))
    .sort((a, b) => a.teamNumber - b.teamNumber);
  const players = countedPlayers(raw).map((p) => {
    const r = p as Row & { user?: Row };
    return {
      userMatchId: int(r.id), playerId: int(r.userId), team: int(r.team), bib: int(r.playerNumber),
      name: [r.user?.firstName, r.user?.lastName].filter(Boolean).join(" ").trim() || `Player ${r.userId}`,
      fake: rosterRowIsFake(p),
      paidStatus: typeof r.paidStatus === "string" ? r.paidStatus : null,
      amount: Number(r.amount) || 0, totalAmount: Number(r.totalAmount) || 0, creditAmount: Number(r.creditAmount) || 0,
    };
  });
  const capacity = Number(match.maxPlayerCount) || 0;
  return { match, teams, players, capacity, teamCount: teams.length };
}
type Live = Awaited<ReturnType<typeof readLive>>;
const fills = (l: Live) => l.teams.map((t) => l.players.filter((p) => p.team === t.teamNumber).length);
const cityOf = (m: Row) => ((m.field as Row | undefined)?.city as Row | undefined)?.name;
const view = (l: Live) => ({
  teams: l.teams, players: l.players.map(({ amount: _a, totalAmount: _t, creditAmount: _c, ...p }) => p),
  capacity: l.capacity, teamCount: l.teamCount, perTeam: l.teamCount > 0 && l.capacity % l.teamCount === 0 ? l.capacity / l.teamCount : null,
  isAutoBump: l.match.isAutoBump === true, readAt: new Date().toISOString(),
});

async function gate(req: Request, ctx: { params: Promise<{ env: string; id: string }> }) {
  const auth = await authenticateApp(req);
  if (!auth.ok) return { error: Response.json({ error: auth.error }, { status: auth.status }) };
  const refused = readRefusal(auth);
  if (refused) return { error: Response.json({ error: refused.error }, { status: refused.status }) };
  const { env, id } = await ctx.params;
  if (!isEnv(env)) return { error: Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 }) };
  if (!/^\d+$/.test(id)) return { error: Response.json({ error: "match id must be numeric" }, { status: 400 }) };
  const before = await readLive(env, id);
  // The live boundary first. The desktop handlers check scope again on their own terms.
  const city = cityOf(before.match);
  if (!cityAllowed(auth, auth.scopeCityName, typeof city === "string" ? city : null)) {
    return { error: Response.json({ error: CONFINED_CITY_ERROR }, { status: 403 }) };
  }
  return { env, id, before };
}

/** GET ?preview=teams&target=N: spots before and after and the path, for the confirm sheet. */
export async function GET(req: Request, ctx: { params: Promise<{ env: string; id: string }> }) {
  try {
    const g = await gate(req, ctx);
    if ("error" in g) return g.error;
    const { env, id, before } = g;
    const url = new URL(req.url);
    const target = Number(url.searchParams.get("target"));
    const path = teamsPath(before.teamCount, target);
    if (!path) return Response.json({ error: `This match already has ${before.teamCount} teams.` }, { status: 400 });
    const headers = { authorization: req.headers.get("authorization") ?? "" };
    const origin = url.origin;
    const params = { params: Promise.resolve({ env, id }) };
    let spotsAfter: number | null = null, refusal: string | null = null;
    if (path === "picker") {
      const w = pickerCapacityWrites(before.match, before.teamCount, target);
      spotsAfter = w.maxPlayerCount ?? before.capacity;
    } else {
      const handler = path === "convert-4" ? convertGet : reduceGet;
      const res = await handler(new Request(`${origin}/api/matchday/${env}/matches/${id}/${path}`, { headers }), params);
      const j = (await res.json().catch(() => null)) as Row | null;
      if (!res.ok) refusal = String(j?.error ?? `HTTP ${res.status}`);
      else {
        refusal = (j?.refusal as string | null) ?? (j?.capacityRefusal as string | null) ?? (j?.shapeError as string | null) ?? null;
        spotsAfter = path === "convert-4" ? Number(j?.spotsAfter) : Number(j?.total);
      }
    }
    return Response.json({
      path, teamsBefore: before.teamCount, teamsAfter: target, spotsBefore: before.capacity,
      spotsAfter: Number.isFinite(spotsAfter) ? spotsAfter : null, players: before.players.length, refusal,
    });
  } catch (e) { return fail(e); }
}

export async function POST(req: Request, ctx: { params: Promise<{ env: string; id: string }> }) {
  try {
    const g = await gate(req, ctx);
    if ("error" in g) return g.error;
    const { env, id, before } = g;
    const body = (await req.json().catch(() => null)) as Row | null;
    const op = body?.op;

    const saveId = randomUUID();
    const headers = { authorization: req.headers.get("authorization") ?? "", "content-type": "application/json" };
    const origin = new URL(req.url).origin;
    const params = { params: Promise.resolve({ env, id }) };
    const rosterParams = { params: Promise.resolve({ env, matchId: id }) };
    const steps: Step[] = [];
    const roster = async (what: string, label: string, sent: Row) => {
      const res = await desktopRosterPost(new Request(`${origin}/api/matchday/${env}/roster/${id}`, { method: "POST", headers, body: JSON.stringify({ ...sent, source: SOURCE, saveId }) }), rosterParams);
      const j = (await res.json().catch(() => null)) as Row | null;
      const s: Step = { what, label, status: res.status, outcome: String(j?.outcome ?? (res.ok ? "unknown" : "failed")).toLowerCase(), error: (j?.error as string) ?? null };
      steps.push(s);
      return res.ok && s.outcome === "landed";
    };
    const matchPut = async (what: string, label: string, changes: Row) => {
      const res = await desktopMatchPut(new Request(`${origin}/api/matchday/${env}/matches/${id}`, { method: "PUT", headers, body: JSON.stringify({ changes, source: SOURCE, saveId }) }), params);
      const j = (await res.json().catch(() => null)) as Row | null;
      const s: Step = { what, label, status: res.status, outcome: String(j?.outcome ?? (res.ok ? "unknown" : "failed")).toLowerCase(), error: (j?.error as string) ?? null };
      steps.push(s);
      return res.ok && s.outcome === "landed";
    };
    const teamName = (n: number) => before.teams.find((t) => t.teamNumber === n)?.name ?? `Team ${n}`;
    const nameOf = (um: number) => before.players.find((p) => p.userMatchId === um)?.name ?? `user-match ${um}`;
    const disagreements: string[] = [];
    let check: (after: Live) => void = () => {};
    let extra: Row = {};

    if (op === "move") {
      const moves = (Array.isArray(body?.moves) ? body.moves : []) as Move[];
      if (moves.length === 0 || moves.some((m) => int(m.userMatchId) == null || int(m.team) == null || int(m.playerNumber) == null)) {
        return Response.json({ error: "moves [{userMatchId, team, playerNumber}] required" }, { status: 400 });
      }
      for (const m of moves) {
        const okMove = await roster("move", `${nameOf(m.userMatchId)} to ${teamName(m.team)} bib ${m.playerNumber}`, { kind: "move", userMatchId: m.userMatchId, team: m.team, playerNumber: m.playerNumber });
        if (!okMove) break;
      }
      check = (after) => {
        moves.forEach((m, i) => {
          const r = after.players.find((p) => p.userMatchId === m.userMatchId);
          const landed = r && r.team === m.team && r.bib === m.playerNumber;
          if (!landed) disagreements.push(`${nameOf(m.userMatchId)} reads back on ${r ? `${teamName(r.team ?? 0)} bib ${r.bib}` : "no team"}, not ${teamName(m.team)} bib ${m.playerNumber}${i >= steps.length ? " (not sent)" : ""}.`);
        });
      };
      extra = { pending: moves.slice(steps.filter((s) => s.outcome === "landed").length) };
    } else if (op === "add") {
      const playerId = int(body?.playerId), team = int(body?.team), playerNumber = int(body?.playerNumber);
      if (playerId == null || team == null || playerNumber == null) return Response.json({ error: "playerId, team and playerNumber required" }, { status: 400 });
      if (before.players.some((p) => p.playerId === playerId)) {
        return Response.json({ error: "This player is already in this match." }, { status: 409 });
      }
      await roster("add", `Add player ${playerId} to ${teamName(team)} bib ${playerNumber}`, { kind: "add", playerId, team, playerNumber });
      check = (after) => {
        const r = after.players.find((p) => p.playerId === playerId);
        if (!r) disagreements.push(`Player ${playerId} is not on the roster when read back.`);
        else if (r.team !== team || r.bib !== playerNumber) disagreements.push(`Player ${playerId} reads back on ${teamName(r.team ?? 0)} bib ${r.bib}, not ${teamName(team)} bib ${playerNumber}.`);
        extra = { money: moneyLine(r ?? null), row: r ? { paidStatus: r.paidStatus, amount: r.amount, totalAmount: r.totalAmount, creditAmount: r.creditAmount } : null };
      };
    } else if (op === "remove") {
      const um = int(body?.userMatchId);
      if (um == null) return Response.json({ error: "userMatchId required" }, { status: 400 });
      if (!before.players.some((p) => p.userMatchId === um)) return Response.json({ error: "That player is no longer on this roster." }, { status: 409 });
      await roster("remove", `Remove ${nameOf(um)}`, { kind: "remove", userMatchId: um });
      check = (after) => { if (after.players.some((p) => p.userMatchId === um)) disagreements.push(`${nameOf(um)} is still on the roster when read back.`); };
    } else if (op === "teams") {
      const target = Number(body?.target);
      const path = teamsPath(before.teamCount, target);
      if (!path) return Response.json({ error: `This match already has ${before.teamCount} teams.` }, { status: 400 });
      let expectCap: number | null = null;
      if (path === "picker") {
        const w = pickerCapacityWrites(before.match, before.teamCount, target);
        if (await roster("shape", `Set ${target} teams`, { kind: "shape", fields: { teamNumbers: target } }) && Object.keys(w).length > 0) {
          await matchPut("capacity", `Spots ${before.capacity} to ${w.maxPlayerCount ?? before.capacity}`, w);
        }
        expectCap = w.maxPlayerCount ?? before.capacity;
      } else {
        const handler = path === "convert-4" ? convertPost : reducePost;
        const res = await handler(new Request(`${origin}/api/matchday/${env}/matches/${id}/${path}`, { method: "POST", headers, body: "{}" }), params);
        const j = (await res.json().catch(() => null)) as Row | null;
        const results = (j?.results as Row[] | undefined) ?? [];
        for (const r of results) {
          const v = String(r.verdict ?? "").toUpperCase();
          steps.push({ what: String(r.kind), label: String(r.label), status: res.status, outcome: v === "LANDED" ? "landed" : v === "NOT APPLIED" ? "notapplied" : "failed", error: (r.detail as string) ?? null });
        }
        if (results.length === 0) steps.push({ what: path, label: path === "convert-4" ? "Convert to 4 teams" : "Reduce to 2 teams", status: res.status, outcome: "failed", error: String(j?.error ?? `HTTP ${res.status}`) });
        extra = { message: j?.message ?? j?.error ?? null };
      }
      check = (after) => {
        if (after.teamCount !== target) disagreements.push(`The match reads back with ${after.teamCount} teams, not ${target}.`);
        if (expectCap != null && after.capacity !== expectCap) disagreements.push(`Spots read back as ${after.capacity}, not ${expectCap}.`);
      };
    } else if (op === "size") {
      const perTeam = Number(body?.perTeam);
      const why = sizeRefusal(before.teamCount, perTeam, fills(before));
      if (why) return Response.json({ error: why }, { status: 400 });
      const w = sizeWrites(before.match, before.teamCount, perTeam);
      if (Object.keys(w).length === 0) return Response.json({ error: "Nothing to change." }, { status: 400 });
      await matchPut("size", `Team size ${before.teamCount} x ${perTeam}`, w);
      check = (after) => { if (after.capacity !== before.teamCount * perTeam) disagreements.push(`Spots read back as ${after.capacity}, not ${before.teamCount * perTeam}.`); };
    } else {
      return Response.json({ error: "op must be move, add, remove, teams or size" }, { status: 400 });
    }

    // REFUSED BEFORE ANYTHING WAS WRITTEN: the desktop handler's own status and sentence.
    const first = steps[0];
    if (first && (first.status === 401 || first.status === 403) && steps.length === 1) {
      return Response.json({ error: first.error ?? "Refused.", steps }, { status: first.status });
    }

    const after = await readLive(env, id);
    check(after);
    return Response.json({
      saveId, op, steps,
      landed: steps.length > 0 && steps.every((s) => s.outcome === "landed"),
      readBack: view(after), disagreements, ...extra,
    });
  } catch (e) { return fail(e); }
}

function fail(e: unknown) {
  if (e instanceof StageHostGuardError || e instanceof StageConfigError) return Response.json({ error: e.message }, { status: 500 });
  const msg = e instanceof Error ? e.message : String(e);
  if (/HTTP 404/.test(msg)) return Response.json({ error: "No match with that id." }, { status: 404 });
  return Response.json({ error: msg }, { status: 502 });
}
