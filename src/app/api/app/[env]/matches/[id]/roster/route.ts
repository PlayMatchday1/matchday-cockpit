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
//   teams    2 -> 4        POST /api/matchday/{env}/matches/{id}/convert-4?perTeam=N  (fakes off first,
//                          the shape, the deal, then the fakes for the spots left, all inside it)
//            3 or 4 -> 2   POST /api/matchday/{env}/matches/{id}/reduce-2?perTeam=N, then the fakes
//            otherwise     POST roster { kind: "shape", fields: { teamNumbers } }, then
//                          PUT  /api/matchday/{env}/matches/{id}  { changes: target x perTeam }, then the fakes
//                          (the desktop Save's own order: the shape first, the fields after)
//            EVERY PATH OFFERS 6 TO 12 A SIDE (Ryan, 2026-11-05: teamChangeSizes) and the capacity is
//            target x perTeam; without perTeam (an older app build) the current size carries over.
//   size     POST /api/matchday/{env}/roster/{id}            { kind: "remove" }  each fake past the new size
//            PUT  /api/matchday/{env}/matches/{id}            { changes: teamCountWrites(...) }
//            POST /api/matchday/{env}/matches/{id}/fakes      { followSpotsLeft }  (Ryan, 2026-11-02:
//                          spots left stays as stored, so the fake count follows the new capacity;
//                          the desktop Save sends the same call after a size change)
//
// GET ?preview=teams&target=N describes a team count change for the confirm sheet and writes nothing.
//
// ONE MOVE IS ONE SAVE. A swap, or a host with their guests, is several, sent in order; the first
// that does not land stops the rest, and the response names what changed and what did not. Writes
// never retry: a retry is a new tap.
//
// AFTER EVERY WRITE, A LIVE READ-BACK of the match and roster, compared with what was asked for.

import { randomUUID } from "node:crypto";
import { clearToday } from "@/lib/appTodayCache";
import { authenticateApp, readRefusal } from "@/lib/appAuth";
import { cityAllowed } from "@/lib/appModel";
import { countedPlayers, fetchPlayersLive, isEnv } from "@/lib/appLive";
import { apiGet, StageConfigError, StageHostGuardError, type MatchdayEnv } from "@/lib/matchdayStageApi";
import { CONFINED_CITY_ERROR } from "@/lib/cityConfinement";
import { rosterRowIsFake } from "@/lib/gamedayModel";
import { moneyLine, overflowFakes, pickerCapacityWrites, sizeRefusal, sizeWrites, teamChangeSizes, teamsPath } from "@/lib/appMatchV2";
import { fakesFollowingSpotsLeft } from "@/lib/fakeLadder";
import { teamShapeError } from "@/lib/rosterEditModel";
import { POST as desktopRosterPost } from "@/app/api/matchday/[env]/roster/[matchId]/route";
import { PUT as desktopMatchPut } from "@/app/api/matchday/[env]/matches/[id]/route";
import { POST as desktopFakesPost } from "@/app/api/matchday/[env]/matches/[id]/fakes/route";
import { GET as convertGet, POST as convertPost } from "@/app/api/matchday/[env]/matches/[id]/convert-4/route";
import { GET as reduceGet, POST as reducePost } from "@/app/api/matchday/[env]/matches/[id]/reduce-2/route";
import { reviewMasked } from "@/lib/reviewAccount";
import { forwardedAuth } from "@/lib/viewAs";

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
const realFills = (l: Live) => l.teams.map((t) => l.players.filter((p) => p.team === t.teamNumber && !p.fake).length);
const teamReals = (l: Live) => l.teams.map((t) => ({ teamNumber: t.teamNumber, real: l.players.filter((p) => p.team === t.teamNumber && !p.fake).length }));
const realCount = (l: Live) => l.players.filter((p) => !p.fake).length;
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
async function getRoute(req: Request, ctx: { params: Promise<{ env: string; id: string }> }) {
  try {
    const g = await gate(req, ctx);
    if ("error" in g) return g.error;
    const { env, id, before } = g;
    const url = new URL(req.url);
    const target = Number(url.searchParams.get("target"));
    const path = teamsPath(before.teamCount, target);
    if (!path) return Response.json({ error: `This match already has ${before.teamCount} teams.` }, { status: 400 });
    const headers = forwardedAuth(req);
    const origin = url.origin;
    const params = { params: Promise.resolve({ env, id }) };
    /* EVERY TEAM COUNT CHANGE ASKS FOR A SIZE FIRST, 6 TO 12 A SIDE (Ryan, 2026-10-31 for Reduce to 2,
     * 2026-11-05 for every path): the sizes teamChangeSizes offers this roster, each described at that
     * size. Reduce to 2 and Convert to 4 are planned by the desktop's own GET at that size (it writes
     * nothing), so the spots and the refusal are the desktop's figures, not a second count made here;
     * the picker has no desktop plan, so its spots are target x size. The fakes after are what
     * followSpotsLeft will bring the roster to at that capacity, the stored spots left kept. */
    const real = realCount(before);
    const offer = teamChangeSizes(path, target, real, teamReals(before));
    const fakesAt = (cap: number) => fakesFollowingSpotsLeft({ ...before.match, maxPlayerCount: cap }, real, Date.now()).target;
    const sizes: { perTeam: number; spots: number; open: number; fakesAfter: number; refusal: string | null }[] = [];
    for (const n of offer.sizes) {
      let spots = target * n, why: string | null = null;
      if (path === "picker") {
        why = teamShapeError(spots, target);
      } else {
        const get = path === "reduce-2" ? reduceGet : convertGet;
        const res = await get(new Request(`${origin}/api/matchday/${env}/matches/${id}/${path}?perTeam=${n}`, { headers }), params);
        const j = (await res.json().catch(() => null)) as Row | null;
        why = !res.ok ? String(j?.error ?? `HTTP ${res.status}`) : ((j?.refusal ?? j?.capacityRefusal ?? j?.shapeError ?? j?.sizeRefusal ?? null) as string | null);
        spots = Number(j?.total ?? j?.spotsAfter ?? spots) || spots;
      }
      const fakesAfter = fakesAt(spots);
      sizes.push({ perTeam: n, spots, open: Math.max(0, spots - real - fakesAfter), fakesAfter, refusal: why });
    }
    const first = sizes.find((x) => !x.refusal);
    const spotsAfter = first?.spots ?? null;
    const refusal = first ? null : (offer.reason ?? sizes[0]?.refusal ?? `No ${target}-team size fits the real players.`);
    return Response.json({
      path, teamsBefore: before.teamCount, teamsAfter: target, spotsBefore: before.capacity,
      spotsAfter, players: before.players.length, refusal,
      real, fakes: before.players.filter((p) => p.fake).length, sizes, sizeReason: offer.reason,
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
    const headers = { ...forwardedAuth(req), "content-type": "application/json" };
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
    /* THE FAKES FOLLOW THE NEW CAPACITY, through the same route and rule the desktop Save uses
     * (followSpotsLeft): the stored spots left stays, the fake count follows. Returns the target it
     * brought the roster to, for the read-back check. */
    const followSpotsLeft = async (): Promise<number | null> => {
      const res = await desktopFakesPost(new Request(`${origin}/api/matchday/${env}/matches/${id}/fakes`, { method: "POST", headers, body: JSON.stringify({ followSpotsLeft: true, matchName: before.match.name ?? null, source: SOURCE, saveId }) }), params);
      const j = (await res.json().catch(() => null)) as Row | null;
      if (!j?.noop) steps.push({ what: "fakes", label: `Fakes ${j?.fakesBefore ?? "?"} to ${j?.target ?? "?"} (spots left ${j?.spotsLeft ?? "?"})`, status: res.status, outcome: String(j?.outcome ?? (res.ok ? "unknown" : "failed")).toLowerCase(), error: (j?.error as string) ?? null });
      return Number.isFinite(Number(j?.target)) ? Number(j?.target) : null;
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
      /* THE SIZE CHOSEN ON THE CONFIRM SHEET, 6 TO 12 A SIDE, one the rule offers this roster; the
       * capacity after is target x perTeam. Reduce to 2 has always needed one. Absent on the other
       * paths (an app build from before 2026-11-05), the current size carries over as it did. */
      const offer = teamChangeSizes(path, target, realCount(before), teamReals(before));
      const perTeam = body?.perTeam == null ? null : Number(body.perTeam);
      if (perTeam != null && !offer.sizes.includes(perTeam)) {
        return Response.json({ error: offer.reason ?? `Choose a team size of ${offer.sizes.join(", ")}.` }, { status: 400 });
      }
      if (path === "reduce-2" && perTeam == null) return Response.json({ error: "perTeam required: the team size to reduce to." }, { status: 400 });
      let expectCap: number | null = perTeam != null ? target * perTeam : null;
      let targetFakes: number | null = null;
      if (path === "picker") {
        const w = perTeam != null ? sizeWrites(before.match, target, perTeam) : pickerCapacityWrites(before.match, before.teamCount, target);
        let ok = await roster("shape", `Set ${target} teams`, { kind: "shape", fields: { teamNumbers: target } });
        if (ok && Object.keys(w).length > 0) ok = await matchPut("capacity", `Spots ${before.capacity} to ${w.maxPlayerCount ?? before.capacity}`, w);
        if (expectCap == null) expectCap = w.maxPlayerCount ?? before.capacity;
        // THE FAKES FOLLOW THE NEW CAPACITY, as after a size write.
        if (ok) targetFakes = await followSpotsLeft();
      } else {
        const q = perTeam != null ? `?perTeam=${perTeam}` : "";
        const handler = path === "convert-4" ? convertPost : reducePost;
        const res = await handler(new Request(`${origin}/api/matchday/${env}/matches/${id}/${path}${q}`, { method: "POST", headers, body: "{}" }), params);
        const j = (await res.json().catch(() => null)) as Row | null;
        const results = (j?.results as Row[] | undefined) ?? [];
        for (const r of results) {
          const v = String(r.verdict ?? "").toUpperCase();
          steps.push({ what: String(r.kind), label: String(r.label), status: res.status, outcome: v === "LANDED" ? "landed" : v === "NOT APPLIED" ? "notapplied" : "failed", error: (r.detail as string) ?? null });
        }
        if (results.length === 0) steps.push({ what: path, label: path === "convert-4" ? "Convert to 4 teams" : "Reduce to 2 teams", status: res.status, outcome: "failed", error: String(j?.error ?? `HTTP ${res.status}`) });
        extra = { message: j?.message ?? j?.error ?? null };
        if (expectCap == null && Number.isFinite(Number(j?.spotsAfter))) expectCap = Number(j?.spotsAfter);
        if (path === "convert-4") {
          // Convert to 4 brings the fakes to the spots left itself; its target is the read-back check's.
          const t = Number((j?.fakes as Row | undefined)?.target);
          targetFakes = Number.isFinite(t) ? t : null;
        } else if (res.ok) {
          // Reduce to 2 keeps the fakes its ladder rung calls for but never adds; the follow does.
          targetFakes = await followSpotsLeft();
        }
      }
      check = (after) => {
        if (after.teamCount !== target) disagreements.push(`The match reads back with ${after.teamCount} teams, not ${target}.`);
        if (expectCap != null && after.capacity !== expectCap) disagreements.push(`Spots read back as ${after.capacity}, not ${expectCap}.`);
        const fakes = after.players.filter((p) => p.fake).length;
        if (targetFakes != null && steps.every((s) => s.outcome === "landed") && fakes !== targetFakes) disagreements.push(`The roster holds ${fakes} fake players, not ${targetFakes}.`);
      };
    } else if (op === "size") {
      const perTeam = Number(body?.perTeam);
      const why = sizeRefusal(before.teamCount, perTeam, realFills(before), before.players.filter((p) => !p.fake).length);
      if (why) return Response.json({ error: why }, { status: 400 });
      const w = sizeWrites(before.match, before.teamCount, perTeam);
      if (Object.keys(w).length === 0) return Response.json({ error: "Nothing to change." }, { status: 400 });
      const drop = overflowFakes(before.players, perTeam);
      if (drop == null) return Response.json({ error: `A team's real players do not fit ${perTeam} a side.` }, { status: 400 });
      // FAKES FIRST, then the size, then the fake count spots left implies at the new capacity.
      let ok = true;
      for (const um of drop) {
        const p = before.players.find((x) => x.userMatchId === um);
        ok = await roster("remove", `Remove a fake player from ${teamName(p?.team ?? 0)}`, { kind: "remove", userMatchId: um });
        if (!ok) break;
      }
      const cap = before.teamCount * perTeam;
      if (ok) ok = await matchPut("size", `Team size ${before.teamCount} x ${perTeam}`, w);
      // THE FAKES FOLLOW THE NEW CAPACITY, through the same route and rule the desktop Save uses.
      let targetFakes: number | null = null;
      if (ok) targetFakes = await followSpotsLeft();
      check = (after) => {
        if (after.capacity !== cap) disagreements.push(`Spots read back as ${after.capacity}, not ${cap}.`);
        const fakes = after.players.filter((p) => p.fake).length;
        if (targetFakes != null && steps.every((s) => s.outcome === "landed") && fakes !== targetFakes) disagreements.push(`The roster holds ${fakes} fake players, not ${targetFakes}.`);
      };
    } else {
      return Response.json({ error: "op must be move, add, remove, teams or size" }, { status: 400 });
    }

    // REFUSED BEFORE ANYTHING WAS WRITTEN: the desktop handler's own status and sentence.
    const first = steps[0];
    if (first && (first.status === 401 || first.status === 403) && steps.length === 1) {
      return Response.json({ error: first.error ?? "Refused.", steps }, { status: first.status });
    }

    if (steps.length) clearToday(env);
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

export const GET = reviewMasked(getRoute);
