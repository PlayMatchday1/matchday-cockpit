/* POST /api/matchday/{env}/matches/{id}/reduce-2: 4 teams becomes 2. The fakes that are not
 * staying come out FIRST, every real player is then moved onto teams 1 and 2, the staying fakes
 * that need a new spot follow, and the shape is written last.
 *
 * GET returns the PLAN and writes nothing, so the confirmation shows figures computed at click time
 * rather than a guess made at render time. Both take `?perTeam=N` (6 to 12); without it the size
 * is the match's own "Max spots, 2 teams" halved, or 11.
 *
 * THE ORDER IS THE REVERSE OF convert-4's, AND THAT IS THE WHOLE POINT
 * convert-4 writes the shape first because a move to team 3 is rejected while the match has two
 * teams. Growing is safe that way: the new teams are empty.
 *
 * SHRINKING IS NOT. Teams 3 and 4 have people standing on them, and `teamNumbers: 2` while they do
 * is the one write here that cannot be undone. Where those players land is the API's decision, not
 * ours, and nobody has established that it is safe. So the writes go:
 *
 *   1. REMOVES, the fakes that are not staying, one at a time.  STOPS AT THE FIRST FAILURE.
 *   2. MOVES, one row at a time: real players off the doomed teams into the spots step 1 just
 *      freed, then the staying fakes that were on a doomed team.  ALSO STOPS AT A FAILURE.
 *   3. THE SHAPE, last, and only if everything above landed.
 *
 * THE REMOVALS USED TO COME SECOND, AND THAT WAS THE BUG (CORRECTED 2026-09-09)
 * With the moves first, the planner could only use spots that were ALREADY free of fakes, so a
 * crowded match refused with "remove those fakes first, then reduce", telling the operator to do
 * by hand the exact thing step 1 does, on a match that fits. Ryan hit it on ATH Katy 18555.
 *
 * Removing first does not mitigate the race the old comment worried about, it deletes it: each
 * removal is read back as gone before the next write, so no move is ever issued onto an occupied
 * spot and 403 PLAYER_NUMBER_ALREADY_TAKEN cannot arise. It is safe because a removal touches one
 * row: measured twice on staging with read-back, DELETE .../user-matches/{umId} takes out exactly
 * the row it names and nothing re-packs (docs/matchday-api-facts.md).
 *
 * A failure partway through step 1 leaves a four-team match with fewer fakes and every real player
 * standing where they started. A failure partway through step 2 leaves a four-team match with
 * everyone standing somewhere real. Neither is a match anybody has to repair.
 *
 * THE BEFORE-MAP IS ITS OWN ROW, WRITTEN BEFORE THE FIRST MOVE
 * convert-4 hangs its map on the shape write because that write happens first. Here the shape is
 * LAST and the first write is a REMOVAL, so the map goes into change_log on its own, ahead of
 * everything, including the fakes, whose positions it is the only record of, with method `PLAN`, a
 * method no MatchDay request uses, so this row can never be read as something that went to the API.
 * The shape is reversible; the arrangement is not.
 *
 * NO RETRIES
 * There is no Idempotency-Key, and a repeated move on a player someone else has moved puts them
 * somewhere nobody chose. One attempt per write, one verdict per write.
 */

import { randomUUID } from "node:crypto";
import { authenticateCapability } from "@/lib/capabilityAuth";
import { apiGet, apiWrite } from "@/lib/matchdayStageApi";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { refreshMatchMirror } from "@/lib/mirrorWriteThrough";
import { assertMatchInScope } from "@/lib/matchOpsAuth";
import { NO_EDIT_MATCHES } from "@/lib/matchEditAccess";
import { markInForce, rungKey } from "@/lib/fakeLadder";
import {
  buildReducePlan, reduceRefusal, capacityRefusal, capacityRefusalWhy,
  defaultPerTeam, perTeamError, REDUCE_MIN_PER_TEAM, REDUCE_MAX_PER_TEAM, type ReducePlayer,
} from "@/lib/reduceTwoTeams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const isEnv = (e: string): e is "production" | "staging" => e === "production" || e === "staging";

/** The operating timezone's today, as TEXT. Never touches a match's startDate: see reduceRefusal. */
const todayYmd = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());

type ApiMatch = {
  id: number; name?: string; startDate?: string | null; startDateUtc?: string | null; isCancelled?: unknown;
  maxPlayerCount?: unknown; maxTeamSize2Team?: unknown; teams?: unknown[]; players?: Record<string, unknown>[];
  field?: { recommendedPlayerCount?: unknown } | null;
  [rung: `fakeSpotLeft${number}h`]: unknown;
};

/* THE SAME MAPPING convert-4 USES, deliberately: a fake is `user.isFakePlayer` on the payload, and
 * the two operations must not disagree about who is padding. */
const toPlayers = (m: ApiMatch): ReducePlayer[] =>
  (m.players ?? []).map((p) => {
    const u = (p.user ?? {}) as Record<string, unknown>;
    const first = String(u.firstName ?? "").trim(), last = String(u.lastName ?? "").trim();
    return {
      userMatchId: Number(p.id),
      team: p.team == null ? null : Number(p.team),
      playerNumber: p.playerNumber == null ? null : Number(p.playerNumber),
      createdAt: typeof p.createdAt === "string" ? p.createdAt : null,
      name: [first, last].filter(Boolean).join(" ") || String(u.email ?? `user-match ${p.id}`),
      isCancelled: p.isCancelled,
      isFake: u.isFakePlayer,
    };
  });

/* THE RUNG IN FORCE. Hours to kickoff come from startDateUtc, which is TRUE UTC (startDate is wall
 * clock with a Z it does not mean, and is never parsed here). The mark is the same markInForce the
 * Gameday board's spots-left control reads; the value under it is the spots shown as left right
 * now. A missing or unreadable value means the match has no ladder setting. */
const ladderNow = (m: ApiMatch, nowMs: number) => {
  const kick = typeof m.startDateUtc === "string" ? Date.parse(m.startDateUtc) : NaN;
  const hours = Number.isFinite(kick) ? (kick - nowMs) / 3600000 : null;
  const mark = hours == null ? null : markInForce(hours);
  const raw = mark == null ? undefined : m[rungKey(mark) as `fakeSpotLeft${number}h`];
  const rung = raw == null || raw === "" || !Number.isFinite(Number(raw)) ? null : Number(raw);
  return { hours, mark, rung };
};

async function planFor(env: "production" | "staging", id: string, perTeamAsked: number | null) {
  const m = await apiGet<ApiMatch>(env, `/admin/matches/${id}`);
  const teamCount = (m.teams ?? []).length;
  const perTeam = perTeamAsked ?? defaultPerTeam(m.maxTeamSize2Team);
  const ladder = ladderNow(m, Date.now());
  const plan = buildReducePlan(
    { maxPlayerCount: m.maxPlayerCount, maxTeamSize2Team: m.maxTeamSize2Team, teamCount, rungInForce: ladder.rung },
    toPlayers(m), perTeam,
  );
  const refusal = reduceRefusal({ startDate: m.startDate ?? null, isCancelled: m.isCancelled, teamCount }, todayYmd());
  return { m, teamCount, plan, refusal, ladder };
}

/** `?perTeam=N`, or null when absent (the default applies). A value outside the picker is an error. */
const perTeamFrom = (url: string): { perTeam: number | null; error: string | null } => {
  const raw = new URL(url).searchParams.get("perTeam");
  if (raw == null || raw === "") return { perTeam: null, error: null };
  const err = perTeamError(raw);
  return err ? { perTeam: null, error: err } : { perTeam: Number(raw), error: null };
};

const planPayload = (id: string, m: ApiMatch, teamCount: number,
  plan: ReturnType<typeof buildReducePlan>, refusal: string | null, ladder: ReturnType<typeof ladderNow>) => {
  /* A REFUSED PLAN DESCRIBES NOTHING, because nothing is going to happen. Measured on staging with
   * 24 real players: the payload still carried "0 fakes come out, 0 real players move" and a fill
   * line reading "24 of 22 after", both computed correctly from a plan that has no writes in it,
   * and both false as sentences. The refusal is the only thing this payload has to say. */
  const noFit = capacityRefusal(plan);
  const saved2 = Number(m.maxTeamSize2Team);
  const written2 = plan.shape.maxTeamSize2Team;
  const fieldTotal = Number((m.field ?? {}).recommendedPlayerCount);
  return ({
  matchId: Number(id), matchName: m.name ?? null, teamCount, refusal,
  capacityRefusal: noFit, capacityWhy: capacityRefusalWhy(plan),
  shapeError: plan.shapeError,
  /* NO consequence / steps / fillLine. All three existed to fill the confirmation panel, which on
   * 2026-09-09 became one question and two buttons; shipping copy nothing renders is how a payload
   * grows a field that outlives its reader. The PLAN itself is still described below in full, that
   * is the point of a GET that writes nothing, and what actually happened is reported per write by
   * the POST. The panel builds its one roster sentence from the counts here. */
  perTeam: plan.perTeam, total: plan.total,
  defaultPerTeam: defaultPerTeam(m.maxTeamSize2Team), minPerTeam: REDUCE_MIN_PER_TEAM, maxPerTeam: REDUCE_MAX_PER_TEAM,
  realCount: plan.realCount, fakeCount: plan.fakeCount, stayerCount: plan.stayerCount,
  fakeKeepCount: plan.fakeKeepCount, fakeRemoveCount: plan.removes.length,
  realMoveCount: plan.realMoveCount, fakeMoveCount: plan.fakeMoveCount,
  fakePolicy: plan.fakePolicy, ladder: { mark: ladder.mark, hoursToKickoff: ladder.hours },
  shortfall: plan.shortfall,
  /* The 2-team max this write touches. `written` is set only when teamCountWrites raises it. */
  twoTeamMax: { saved: Number.isFinite(saved2) ? saved2 : null, written: written2 ?? null },
  /* The field's recommended format, a TOTAL (18 means 9 v 9). A default, not a cap. */
  fieldFormat: Number.isFinite(fieldTotal) && fieldTotal > 0 ? { total: fieldTotal, perSide: fieldTotal % 2 === 0 ? fieldTotal / 2 : null } : null,
  shownBefore: plan.shownBefore, capBefore: plan.capBefore, shownAfter: plan.shownAfter,
  moveCount: plan.moves.length, removeCount: plan.removes.length,
  writeCount: plan.moves.length + plan.removes.length + 1,
  moves: plan.moves.map((mv) => ({
    name: mv.fake ? "Fake player" : mv.name, fake: mv.fake, fromTeam: mv.fromTeam, toTeam: mv.toTeam, playerNumber: mv.playerNumber,
    reason: mv.reason,
  })),
  });
};

/** GET: the plan, for the confirmation. Writes nothing. */
export async function GET(req: Request, ctx: { params: Promise<{ env: string; id: string }> }) {
  const auth = await authenticateCapability(req, "editMatches");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env, id } = await ctx.params;
  const scope = await assertMatchInScope(auth.supabase, auth.confinedCity, id, env);
  if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status });
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  if (!/^\d+$/.test(id)) return Response.json({ error: "Match id must be numeric" }, { status: 400 });
  const asked = perTeamFrom(req.url);
  if (asked.error) return Response.json({ error: asked.error }, { status: 400 });
  try {
    const { m, teamCount, plan, refusal, ladder } = await planFor(env, id, asked.perTeam);
    return Response.json(planPayload(id, m, teamCount, plan, refusal, ladder), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ env: string; id: string }> }) {
  const auth = await authenticateCapability(req, "editMatches");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env, id } = await ctx.params;
  const scope = await assertMatchInScope(auth.supabase, auth.confinedCity, id, env);
  if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status });
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  if (!/^\d+$/.test(id)) return Response.json({ error: "Match id must be numeric" }, { status: 400 });
  if (!auth.canEditMatches) {
    console.warn(`[edit-matches] 403: ${auth.email} attempted reduce-2 on ${id}`);
    return Response.json({ error: NO_EDIT_MATCHES }, { status: 403 });
  }
  const asked = perTeamFrom(req.url);
  if (asked.error) return Response.json({ error: asked.error }, { status: 400 });

  let plan, m, teamCount, refusal;
  try { ({ m, teamCount, plan, refusal } = await planFor(env, id, asked.perTeam)); }
  catch (e) { return Response.json({ error: `Couldn't read the match: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 }); }

  // EVERY REFUSAL BEFORE ANY WRITE.
  if (refusal) return Response.json({ error: refusal }, { status: 400 });
  const capacity = capacityRefusal(plan);
  if (capacity) return Response.json({ error: capacity, why: capacityRefusalWhy(plan), wrote: 0 }, { status: 400 });
  if (plan.shapeError) return Response.json({ error: plan.shapeError }, { status: 400 });

  const actor = { canEditMatches: auth.canEditMatches, email: auth.email, userId: auth.appUserId };
  const saveId = randomUUID();
  const source = "Match panel · reduce to 2 teams";
  const store = supabaseLogStore();
  const results: { kind: "plan" | "move" | "remove" | "shape"; label: string; verdict: string; detail?: string }[] = [];

  /* 0. THE BEFORE-MAP, AHEAD OF EVERY WRITE
   * Its own row, because the first real write here is a REMOVAL and a map recorded after the first
   * removal is not a map back: it would already be missing every fake it had just deleted.
   * `PLAN` is not an HTTP method any MatchDay call uses, so this row cannot be mistaken for a
   * request. */
  let mapped = false;
  try {
    await store.insert({
      saveId, at: new Date().toISOString(), actorName: auth.email, actorEmail: auth.email,
      source, env, matchId: Number(id), matchName: String(m.name ?? ""),
      method: "PLAN", endpoint: `/admin/matches/${id}`, body: {}, outcome: "landed", serverSaid: null,
      changes: [{
        key: "reduce2:before", field: "Roster before the reduce",
        before: `${teamCount} teams, ${plan.capBefore} spots · positions: ${JSON.stringify(plan.beforeMap)}`,
        after: `${plan.removes.length} fake removal(s), then ${plan.moves.length} move(s), then ${plan.targetTeams} teams of ${plan.perTeam} · ${plan.fakeKeepCount} fake(s) stay (${plan.fakePolicy.mode}, rung ${plan.fakePolicy.rung ?? "none"})`,
      }],
    });
    mapped = true;
  } catch (e) {
    console.error("reduce-2: the before-map did not record:", e);
  }
  /* NO MAP, NO REDUCE. Every other write here is recoverable only by reading that map back, so
   * losing it is the one logging failure that must stop the operation rather than be reported
   * beside it. */
  if (!mapped) {
    return Response.json({
      ok: false, stoppedAt: "before-map", results, message:
        "The roster snapshot could not be written to the change log, so nothing was removed and nothing was moved. " +
        "That snapshot is the only way back from this operation, and it is not optional.",
    }, { status: 500 });
  }
  results.push({ kind: "plan", label: `Roster snapshot: ${plan.beforeMap.length} live rows recorded before anything was removed or moved`, verdict: "LANDED" });

  /* 1. THE FAKES THAT ARE NOT STAYING, FIRST, ONE AT A TIME, STOPPING AT THE FIRST FAILURE
   * DELETE /admin/matches/user-matches/{umId}: the same removal rosterModel builds, so there is
   * one remover in the estate and not two. Nobody is notified: this is padding, not a person.
   *
   * THEY GO BEFORE THE MOVES, AND THAT IS THE FIX (2026-09-09). While they went after, the planner
   * could only deal movers into spots that were already clean, so a crowded match refused and told
   * the operator to delete the fakes by hand first, the exact thing this loop does. The read-back
   * below is what turns "the spot will be free" into a guarantee: a removal is LANDED only once the
   * row is observed gone, so no move is ever issued against a spot somebody is still standing on.
   *
   * A FAILURE HERE IS THE CHEAPEST ONE IN THE OPERATION. Nothing has moved and nothing has been
   * reshaped, so every real player is standing exactly where they started and the match is the
   * shape it was. The only difference is fewer fakes. */
  const rowGone = async (userMatchId: number): Promise<boolean> => {
    const fresh = await apiGet<ApiMatch>(env, `/admin/matches/${id}`);
    return !(fresh.players ?? []).some((p) => Number(p.id) === userMatchId);
  };
  let removesLanded = 0;
  for (const rm of plan.removes) {
    const w = await recordWrite(
      {
        env, source, actorName: auth.email, actorEmail: auth.email, saveId,
        matchId: Number(id), matchName: String(m.name ?? ""),
        method: "DELETE", path: `/admin/matches/user-matches/${rm.userMatchId}`,
        body: {}, keys: [], label: (k) => k,
        changes: [{
          key: `reduce2:remove:${rm.userMatchId}`, field: "Fake player",
          before: rm.team == null ? "no team" : `team ${rm.team} #${rm.playerNumber ?? "none"}`,
          after: "removed from the match",
        }],
        applied: (_b, a) => (a as { gone: boolean }).gone === true,
      },
      {
        readResource: async () => ({ gone: await rowGone(rm.userMatchId) }),
        /* NO BODY, DELIBERATELY. apiWrite only declares Content-Type when a body is present, and
         * the API rejects an empty JSON body on a bodyless write with a 400. Passing `{}` here
         * would have made every fake removal fail. rosterModel's own `remove` sends undefined. */
        write: () => apiWrite(env, "DELETE", `/admin/matches/user-matches/${rm.userMatchId}`, undefined, actor),
        now: () => new Date().toISOString(),
      },
      store,
    );
    const verdict = w.error ? "FAILED" : w.outcome === "landed" ? "LANDED" : "NOT APPLIED";
    results.push({
      kind: "remove", label: `Remove fake: ${rm.team == null ? "no team" : `team ${rm.team} #${rm.playerNumber ?? "none"}`}`,
      verdict, detail: w.error?.message ?? (w.logged ? undefined : "the change-log write did not record"),
    });
    if (verdict !== "LANDED") {
      return Response.json({
        ok: false, stoppedAt: "remove", results,
        movesLanded: 0, removesLanded,
        message: `STOPPED: a fake would not come off (${plan.removes.length - removesLanded} of ${plan.removes.length} still on the match). ` +
          `NOBODY HAS MOVED and the shape was not written. This match is still a ${teamCount}-team match and every real player is ` +
          `standing exactly where they were. ${removesLanded} fake(s) did come out. Nothing retried.`,
      }, { status: 502 });
    }
    removesLanded += 1;
  }

  /* 2. THE MOVES, ONE AT A TIME, STOPPING AT THE FIRST FAILURE
   * Every destination below is a spot that is empty right now: either nobody was standing on it, or
   * a fake was and step 1 has already been read back as having removed them. That is why there is
   * no longer a plan that refuses because a fake is in the way.
   *
   * Real players come first in the list, then the staying fakes that were on a doomed team. A fake
   * move uses the same endpoint as a real one; it has not been measured on a fake row, so if the
   * API refuses one the run stops here, before the shape, with every real player already on team 1
   * or 2 and the match still four teams.
   *
   * The read-back checks that ROW is on the team we asked for, so LANDED means observed rather
   * than "did not throw". */
  const teamOf = async (userMatchId: number): Promise<number | null> => {
    const fresh = await apiGet<ApiMatch>(env, `/admin/matches/${id}`);
    const row = (fresh.players ?? []).find((p) => Number(p.id) === userMatchId);
    return row ? (row.team == null ? null : Number(row.team)) : null;
  };
  const stranded: string[] = [];
  let movesLanded = 0;
  for (const mv of plan.moves) {
    const who = mv.fake ? "Fake player" : mv.name;
    const w = await recordWrite(
      {
        env, source, actorName: auth.email, actorEmail: auth.email, saveId,
        matchId: Number(id), matchName: String(m.name ?? ""),
        method: "POST", path: "/admin/user-matches",
        // NEVER A PLAYER IDENTITY IN THE LOG BODY: the user-match id and the destination only.
        body: mv.body, keys: [], label: (k) => k,
        changes: [{
          key: `reduce2:move:${mv.userMatchId}`, field: mv.fake ? "Fake player" : "Team",
          before: mv.fromTeam == null ? "no team" : `team ${mv.fromTeam} #${mv.fromNumber ?? "none"}`,
          after: `team ${mv.toTeam} #${mv.playerNumber}`,
        }],
        applied: (_b, a) => (a as { team: number | null }).team === mv.toTeam,
      },
      {
        readResource: async () => ({ team: await teamOf(mv.userMatchId) }),
        write: () => apiWrite(env, "POST", "/admin/user-matches", mv.body, actor),
        now: () => new Date().toISOString(),
      },
      store,
    );
    const verdict = w.error ? "FAILED" : w.outcome === "landed" ? "LANDED" : "NOT APPLIED";
    results.push({
      kind: "move", label: `${who} to team ${mv.toTeam} #${mv.playerNumber} (${mv.reason})`,
      verdict, detail: w.error?.message ?? (w.logged ? undefined : "the change-log write did not record"),
    });
    if (verdict !== "LANDED") {
      /* STOP. Everyone still on a doomed team is named, with the team they are on, and the match
       * is still a ${teamCount}-team match, which is a match nobody has to repair. */
      for (const rest of plan.moves.slice(plan.moves.indexOf(mv))) {
        stranded.push(`${rest.fake ? "Fake player" : rest.name} (still on ${rest.fromTeam == null ? "no team" : `team ${rest.fromTeam}`})`);
      }
      return Response.json({
        ok: false, stoppedAt: "move", results,
        movesAttempted: movesLanded + 1, movesLanded, removesLanded, stranded,
        message: `STOPPED at ${who}. The match is still a ${teamCount}-team match and the shape has not been touched. ` +
          `All ${removesLanded} fake(s) came out and ${movesLanded} row(s) moved before this one. ` +
          `Still on their old team: ${stranded.join("; ")}. Nothing retried. Move them by hand or run it again once you know why.`,
      }, { status: 502 });
    }
    movesLanded += 1;
  }

  /* 3. THE SHAPE, LAST
   * teamCountWrites(2, perTeam): maxPlayerCount AND maxTeamSize2Team, both TOTALS for the whole
   * match. Writing the per-side number here is the bug that showed production match 18125's
   * players 5.5 players per team; the helper exists so no call site computes it. */
  const shapeBody = { ...plan.shape, teamNumbers: plan.targetTeams };
  const shapeWrite = await recordWrite(
    {
      env, source, actorName: auth.email, actorEmail: auth.email, saveId,
      matchId: Number(id), matchName: String(m.name ?? ""),
      method: "PUT", path: `/admin/matches/${id}`, body: shapeBody, keys: [], label: (k) => k,
      changes: [{
        key: "reduce2:shape", field: "Reduce to 2 teams",
        before: `${teamCount} teams, ${plan.capBefore} spots`,
        after: `${plan.targetTeams} teams, ${plan.total} spots · ${movesLanded} moved, ${removesLanded} fake(s) removed, ${plan.fakeKeepCount} fake(s) kept`,
      }],
      applied: (_b, a) => ((a as { match?: Record<string, unknown> }).match?.teams as unknown[] | undefined)?.length === plan.targetTeams,
    },
    {
      readResource: async () => ({ match: await apiGet(env, `/admin/matches/${id}`) }),
      write: () => apiWrite(env, "PUT", `/admin/matches/${id}`, shapeBody, actor),
      now: () => new Date().toISOString(),
    },
    store,
  );
  const shapeVerdict = shapeWrite.error ? "FAILED" : shapeWrite.outcome === "landed" ? "LANDED" : "NOT APPLIED";
  results.push({
    kind: "shape",
    label: `Shape: ${teamCount} teams, ${plan.capBefore} spots to ${plan.targetTeams} teams of ${plan.perTeam} (${plan.total} spots)`,
    verdict: shapeVerdict, detail: shapeWrite.error?.message,
  });

  /* THE MIRROR, AFTER THE SHAPE. maxPlayerCount and maxTeamSize2Team are mirrored columns, and a
   * reduce that landed in MatchDay but not in the mirror leaves every Clubhouse screen showing the
   * old spot count. Best-effort, and never able to turn a landed write into a failure. */
  let mirrored = false, mirrorReason: string | null = "no read-back";
  if (shapeVerdict === "LANDED") {
    try {
      const after = await apiGet<Record<string, unknown>>(env, `/admin/matches/${id}`);
      const r = await refreshMatchMirror(
        auth.supabase, env, Number(id), ["maxPlayerCount", "maxTeamSize2Team", "maxTeamSize4Team"], after, "landed",
      );
      mirrored = r.refreshed; mirrorReason = r.reason ?? null;
    } catch (e) { mirrorReason = e instanceof Error ? e.message : String(e); }
  }

  return Response.json({
    ok: shapeVerdict === "LANDED",
    results, movesLanded, removesLanded, stranded, mirrored, mirrorReason,
    message: shapeVerdict === "LANDED"
      ? `Reduced. ${plan.targetTeams} teams of ${plan.perTeam}, ${plan.total} spots, ${movesLanded} row(s) moved, ${removesLanded} fake(s) removed, ${plan.fakeKeepCount} fake(s) kept.`
      : `EVERY PLAYER IS ON TEAM 1 OR 2 AND THE FAKES ARE SORTED, but the shape write did not land. The match is still ` +
        `a ${teamCount}-team match with ${plan.capBefore} spots. Nobody is stranded; set the team count by hand or run it again.`,
  }, { status: shapeVerdict === "LANDED" ? 200 : 502 });
}
