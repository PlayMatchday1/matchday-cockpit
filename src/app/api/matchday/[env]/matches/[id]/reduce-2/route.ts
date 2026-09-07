/* POST /api/matchday/{env}/matches/{id}/reduce-2 — 4 teams becomes 2, the fakes come out, and
 * every real player is moved onto teams 1 and 2 BEFORE the shape is touched.
 *
 * GET returns the PLAN and writes nothing, so the confirmation shows figures computed at click time
 * rather than a guess made at render time.
 *
 * ── THE ORDER IS THE REVERSE OF convert-4's, AND THAT IS THE WHOLE POINT ──────────────────────
 * convert-4 writes the shape first because a move to team 3 is rejected while the match has two
 * teams. Growing is safe that way: the new teams are empty.
 *
 * SHRINKING IS NOT. Teams 3 and 4 have people standing on them, and `teamNumbers: 2` while they do
 * is the one write here that cannot be undone — where those players land is the API's decision, not
 * ours, and nobody has established that it is safe. So the writes go:
 *
 *   1. MOVES, one player at a time, off the doomed teams.  STOPS AT THE FIRST FAILURE.
 *   2. REMOVES, every fake. After the moves so a mover is never handed a spot a fake is about to
 *      vacate; before the shape so the count is right when it lands. ALSO STOPS AT A FAILURE —
 *      a fake left on team 4 when the shape lands is one more row the API gets to decide about.
 *   3. THE SHAPE, last, and only if everything above landed.
 *
 * A failure partway through step 1 leaves a four-team match with everyone standing somewhere real.
 * That is a match nobody has to repair.
 *
 * ── THE BEFORE-MAP IS ITS OWN ROW, WRITTEN BEFORE THE FIRST MOVE ──────────────────────────────
 * convert-4 hangs its map on the shape write because that write happens first. Here the shape is
 * LAST, so the map goes into change_log on its own, ahead of everything, with method `PLAN` — a
 * method no MatchDay request uses, so this row can never be read as something that went to the API.
 * The shape is reversible; the arrangement is not.
 *
 * ── NO RETRIES ────────────────────────────────────────────────────────────────────────────────
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
import { teamCountConsequence } from "@/lib/rosterEditModel";
import {
  buildReducePlan, reduceRefusal, capacityRefusal, capacityRefusalWhy, reduceSteps, reduceFillLine,
  REDUCE_PER_TEAM, REDUCE_TARGET_TEAMS, type ReducePlayer,
} from "@/lib/reduceTwoTeams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const isEnv = (e: string): e is "production" | "staging" => e === "production" || e === "staging";

/** The operating timezone's today, as TEXT. The only Date in this file, and it never touches a
 *  match's startDate — see reduceRefusal. */
const todayYmd = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());

type ApiMatch = {
  id: number; name?: string; startDate?: string | null; isCancelled?: unknown;
  maxPlayerCount?: unknown; teams?: unknown[]; players?: Record<string, unknown>[];
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

async function planFor(env: "production" | "staging", id: string, perTeam: number) {
  const m = await apiGet<ApiMatch>(env, `/admin/matches/${id}`);
  const teamCount = (m.teams ?? []).length;
  const plan = buildReducePlan({ maxPlayerCount: m.maxPlayerCount, teamCount }, toPlayers(m), perTeam);
  const refusal = reduceRefusal({ startDate: m.startDate ?? null, isCancelled: m.isCancelled, teamCount }, todayYmd());
  return { m, teamCount, plan, refusal };
}

const perTeamFrom = (url: string): number => {
  const raw = new URL(url).searchParams.get("perTeam");
  const n = raw == null ? REDUCE_PER_TEAM : Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= 40 ? Math.round(n) : REDUCE_PER_TEAM;
};

const planPayload = (id: string, m: ApiMatch, teamCount: number,
  plan: ReturnType<typeof buildReducePlan>, refusal: string | null) => {
  /* A REFUSED PLAN DESCRIBES NOTHING, because nothing is going to happen. Measured on staging with
   * 24 real players: the payload still carried "0 fakes come out, 0 real players move" and a fill
   * line reading "24 of 22 after" — both computed correctly from a plan that has no writes in it,
   * and both false as sentences. The refusal is the only thing this payload has to say. */
  const noFit = capacityRefusal(plan);
  return ({
  matchId: Number(id), matchName: m.name ?? null, teamCount, refusal,
  capacityRefusal: noFit, capacityWhy: capacityRefusalWhy(plan),
  shapeError: plan.shapeError,
  /* THE CONSEQUENCE LINE COMES FROM teamCountConsequence, extended — not from a second sentence
   * written here. The origin is empty because the reduce branch reads none of it; every number in
   * the sentence is the plan's own. */
  consequence: noFit ? null : teamCountConsequence({ rows: [], teams: [] }, { teamCount: null, moves: {}, removes: [], names: {} },
    REDUCE_TARGET_TEAMS, { fromTeamCount: teamCount, fakes: plan.removes.length, movers: plan.moves.length, perTeam: plan.perTeam }),
  steps: noFit ? [] : reduceSteps(plan),
  fillLine: noFit ? null : reduceFillLine(plan),
  perTeam: plan.perTeam, total: plan.total,
  realCount: plan.realCount, fakeCount: plan.fakeCount, stayerCount: plan.stayerCount,
  shortfall: plan.shortfall,
  shownBefore: plan.shownBefore, capBefore: plan.capBefore, shownAfter: plan.shownAfter,
  moveCount: plan.moves.length, removeCount: plan.removes.length,
  writeCount: plan.moves.length + plan.removes.length + 1,
  moves: plan.moves.map((mv) => ({
    name: mv.name, fromTeam: mv.fromTeam, toTeam: mv.toTeam, playerNumber: mv.playerNumber,
    reason: mv.reason, ontoFakeSpot: mv.ontoFakeSpot,
  })),
  });
};

/** GET — the plan, for the confirmation. Writes nothing. */
export async function GET(req: Request, ctx: { params: Promise<{ env: string; id: string }> }) {
  const auth = await authenticateCapability(req, "editMatches");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env, id } = await ctx.params;
  const scope = await assertMatchInScope(auth.supabase, auth.confinedCity, id);
  if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status });
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  if (!/^\d+$/.test(id)) return Response.json({ error: "Match id must be numeric" }, { status: 400 });
  try {
    const { m, teamCount, plan, refusal } = await planFor(env, id, perTeamFrom(req.url));
    return Response.json(planPayload(id, m, teamCount, plan, refusal), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ env: string; id: string }> }) {
  const auth = await authenticateCapability(req, "editMatches");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env, id } = await ctx.params;
  const scope = await assertMatchInScope(auth.supabase, auth.confinedCity, id);
  if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status });
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  if (!/^\d+$/.test(id)) return Response.json({ error: "Match id must be numeric" }, { status: 400 });
  if (!auth.canEditMatches) {
    console.warn(`[edit-matches] 403: ${auth.email} attempted reduce-2 on ${id}`);
    return Response.json({ error: NO_EDIT_MATCHES }, { status: 403 });
  }

  let plan, m, teamCount, refusal;
  try { ({ m, teamCount, plan, refusal } = await planFor(env, id, perTeamFrom(req.url))); }
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

  /* ── 0. THE BEFORE-MAP, AHEAD OF EVERY WRITE ──────────────────────────────────────────────
   * Its own row, because the first real write here is a MOVE and a map recorded after the first
   * move is not a map back. `PLAN` is not an HTTP method any MatchDay call uses, so this row
   * cannot be mistaken for a request. */
  let mapped = false;
  try {
    await store.insert({
      saveId, at: new Date().toISOString(), actorName: auth.email, actorEmail: auth.email,
      source, env, matchId: Number(id), matchName: String(m.name ?? ""),
      method: "PLAN", endpoint: `/admin/matches/${id}`, body: {}, outcome: "landed", serverSaid: null,
      changes: [{
        key: "reduce2:before", field: "Roster before the reduce",
        before: `${teamCount} teams, ${plan.capBefore} spots · positions: ${JSON.stringify(plan.beforeMap)}`,
        after: `${plan.moves.length} move(s), then ${plan.removes.length} fake removal(s), then ${plan.targetTeams} teams of ${plan.perTeam}`,
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
        "The roster snapshot could not be written to the change log, so nothing was moved. " +
        "That snapshot is the only way back from this operation, and it is not optional.",
    }, { status: 500 });
  }
  results.push({ kind: "plan", label: `Roster snapshot — ${plan.beforeMap.length} live rows recorded before anything moved`, verdict: "LANDED" });

  /* ── 1. THE MOVES, ONE AT A TIME, STOPPING AT THE FIRST FAILURE ───────────────────────────
   * The read-back checks that PLAYER is on the team we asked for, so LANDED means observed rather
   * than "did not throw". */
  const teamOf = async (userMatchId: number): Promise<number | null> => {
    const fresh = await apiGet<ApiMatch>(env, `/admin/matches/${id}`);
    const row = (fresh.players ?? []).find((p) => Number(p.id) === userMatchId);
    return row ? (row.team == null ? null : Number(row.team)) : null;
  };
  const stranded: string[] = [];
  let movesLanded = 0;
  for (const mv of plan.moves) {
    const w = await recordWrite(
      {
        env, source, actorName: auth.email, actorEmail: auth.email, saveId,
        matchId: Number(id), matchName: String(m.name ?? ""),
        method: "POST", path: "/admin/user-matches",
        // NEVER A PLAYER IDENTITY IN THE LOG BODY — the user-match id and the destination only.
        body: mv.body, keys: [], label: (k) => k,
        changes: [{
          key: `reduce2:move:${mv.userMatchId}`, field: "Team",
          before: mv.fromTeam == null ? "no team" : `team ${mv.fromTeam} #${mv.fromNumber ?? "—"}`,
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
      kind: "move", label: `${mv.name} → team ${mv.toTeam} #${mv.playerNumber} (${mv.reason})`,
      verdict, detail: w.error?.message ?? (w.logged ? undefined : "the change-log write did not record"),
    });
    if (verdict !== "LANDED") {
      /* STOP. Everyone still on a doomed team is named, by name, with the team they are on — and
       * the match is still a ${teamCount}-team match, which is a match nobody has to repair. */
      for (const rest of plan.moves.slice(plan.moves.indexOf(mv))) {
        stranded.push(`${rest.name} (still on ${rest.fromTeam == null ? "no team" : `team ${rest.fromTeam}`})`);
      }
      return Response.json({
        ok: false, stoppedAt: "move", results,
        movesAttempted: movesLanded + 1, movesLanded, stranded,
        message: `STOPPED at ${mv.name}. The match is still a ${teamCount}-team match and nothing has been removed. ` +
          `Still on their old team: ${stranded.join("; ")}. Nothing retried — move them by hand or run it again once you know why.`,
      }, { status: 502 });
    }
    movesLanded += 1;
  }

  /* ── 2. THE FAKES, AFTER THE MOVES AND BEFORE THE SHAPE ───────────────────────────────────
   * DELETE /admin/matches/user-matches/{umId} — the same removal rosterModel builds, so there is
   * one remover in the estate and not two. Nobody is notified: this is padding, not a person. */
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
          before: rm.team == null ? "no team" : `team ${rm.team} #${rm.playerNumber ?? "—"}`,
          after: "removed from the match",
        }],
        applied: (_b, a) => (a as { gone: boolean }).gone === true,
      },
      {
        readResource: async () => ({ gone: await rowGone(rm.userMatchId) }),
        /* NO BODY, DELIBERATELY. apiWrite only declares Content-Type when a body is present, and
         * the API rejects an empty JSON body on a bodyless write with a 400 — passing `{}` here
         * would have made every fake removal fail. rosterModel's own `remove` sends undefined. */
        write: () => apiWrite(env, "DELETE", `/admin/matches/user-matches/${rm.userMatchId}`, undefined, actor),
        now: () => new Date().toISOString(),
      },
      store,
    );
    const verdict = w.error ? "FAILED" : w.outcome === "landed" ? "LANDED" : "NOT APPLIED";
    results.push({
      kind: "remove", label: `Remove fake — ${rm.team == null ? "no team" : `team ${rm.team} #${rm.playerNumber ?? "—"}`}`,
      verdict, detail: w.error?.message ?? (w.logged ? undefined : "the change-log write did not record"),
    });
    if (verdict !== "LANDED") {
      return Response.json({
        ok: false, stoppedAt: "remove", results,
        movesLanded, removesLanded,
        message: `Every player is on team 1 or 2 and ${movesLanded} move(s) landed, but a fake would not come off ` +
          `(${plan.removes.length - removesLanded} left). The match is STILL a ${teamCount}-team match — the shape was not written, ` +
          `because a fake still standing on a removed team is one more row the API would get to decide about. Nothing retried.`,
      }, { status: 502 });
    }
    removesLanded += 1;
  }

  /* ── 3. THE SHAPE, LAST ───────────────────────────────────────────────────────────────────
   * teamCountWrites(2, perTeam) — maxPlayerCount AND maxTeamSize2Team, both TOTALS for the whole
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
        after: `${plan.targetTeams} teams, ${plan.total} spots · ${movesLanded} moved, ${removesLanded} fake(s) removed`,
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
    label: `Shape — ${teamCount} teams, ${plan.capBefore} spots → ${plan.targetTeams} teams of ${plan.perTeam} (${plan.total} spots)`,
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
      ? `Reduced. ${plan.targetTeams} teams of ${plan.perTeam}, ${plan.total} spots, ${movesLanded} player(s) moved, ${removesLanded} fake(s) removed.`
      : `EVERY PLAYER IS ON TEAM 1 OR 2 AND EVERY FAKE IS OUT, but the shape write did not land — the match is still ` +
        `a ${teamCount}-team match with ${plan.capBefore} spots. Nobody is stranded; set the team count by hand or run it again.`,
  }, { status: shapeVerdict === "LANDED" ? 200 : 502 });
}
