/* POST /api/matchday/{env}/matches/{id}/convert-4 — 2 teams becomes 4, and the players are dealt.
 *
 * GET returns the PLAN and writes nothing, so the confirmation shows real figures computed at
 * click time rather than a guess made at render time.
 *
 * ── ONE SHAPE WRITE, THEN N MOVES, AND THERE IS NO TRANSACTION ────────────────────────────────
 * That is the whole risk of this endpoint. It is handled by ORDER and by REPORTING, because it
 * cannot be handled by rollback:
 *
 *   1. THE SHAPE GOES FIRST. If it fails, nothing else runs and nothing has changed — a match
 *      still on 2 teams with everyone where they were is a match nobody has to repair.
 *   2. THE MOVES GO SEQUENTIALLY, each with its own verdict. NO RETRIES: there is no
 *      Idempotency-Key, and a repeated move on a player who was moved again by someone else puts
 *      them somewhere nobody chose.
 *   3. THE RESPONSE IS A LIST, one row per write. A single outcome for eleven writes would be a
 *      lie, and a half-dealt match is worse than either end state — so a partial failure names
 *      the players still on their old team, by name, and says which team that is.
 *
 * ── THE BEFORE-MAP IS CAPTURED BEFORE THE FIRST MOVE ──────────────────────────────────────────
 * The shape is reversible — teamCountWrites(2, per) puts it back. POSITIONS ARE NOT: once 22
 * people are dealt across four teams the original arrangement is gone. So every live player's
 * (userMatchId, team, playerNumber) goes into change_log as the `before` of the shape write,
 * which is the only way back and is written before anything moves.
 *
 * ── IT IS NOT AUTO-BUMP ───────────────────────────────────────────────────────────────────────
 * See convertFourTeams.ts. The server's own bump stacks players on team 1, never uses team 4, and
 * sets a capacity of 28 that nothing derives. Ours is derivable and even. Do not reconcile them.
 */

import { randomUUID } from "node:crypto";
import { authenticateCapability } from "@/lib/capabilityAuth";
import { apiGet, apiWrite } from "@/lib/matchdayStageApi";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { refreshMatchMirror } from "@/lib/mirrorWriteThrough";
import { assertMatchInScope } from "@/lib/matchOpsAuth";
import { NO_EDIT_MATCHES } from "@/lib/matchEditAccess";
import {
  buildConvertPlan, convertRefusal, convertSummary, type ConvertPlayer,
} from "@/lib/convertFourTeams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const isEnv = (e: string): e is "production" | "staging" => e === "production" || e === "staging";

/** The operating timezone's today, as TEXT. The only Date in this file, and it never touches a
 *  match's startDate — see convertRefusal. */
const todayYmd = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());

type ApiMatch = {
  id: number; name?: string; startDate?: string | null; isCancelled?: unknown;
  maxPlayerCount?: unknown; teams?: unknown[]; players?: Record<string, unknown>[];
};

const toPlayers = (m: ApiMatch): ConvertPlayer[] =>
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

async function planFor(env: "production" | "staging", id: string) {
  const m = await apiGet<ApiMatch>(env, `/admin/matches/${id}`);
  const teamCount = (m.teams ?? []).length;
  const players = toPlayers(m);
  const refusal = convertRefusal({ startDate: m.startDate ?? null, isCancelled: m.isCancelled, teamCount }, todayYmd());
  const plan = buildConvertPlan({ maxPlayerCount: m.maxPlayerCount, teamCount }, players);
  return { m, teamCount, plan, refusal };
}

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
    const { m, teamCount, plan, refusal } = await planFor(env, id);
    return Response.json({
      matchId: Number(id), matchName: m.name ?? null, teamCount, refusal,
      summary: convertSummary(plan), shapeError: plan.shapeError,
      spotsBefore: plan.spotsBefore, spotsAfter: plan.spotsAfter,
      playerCount: plan.playerCount, keptCount: plan.keptCount,
      moveCount: plan.moves.length,
      moves: plan.moves.map((mv) => ({ name: mv.name, fromTeam: mv.fromTeam, toTeam: mv.toTeam, playerNumber: mv.playerNumber })),
    }, { headers: { "Cache-Control": "no-store" } });
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
    console.warn(`[edit-matches] 403: ${auth.email} attempted convert-4 on ${id}`);
    return Response.json({ error: NO_EDIT_MATCHES }, { status: 403 });
  }

  let plan, m, teamCount, refusal;
  try { ({ m, teamCount, plan, refusal } = await planFor(env, id)); }
  catch (e) { return Response.json({ error: `Couldn't read the match: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 }); }

  // EVERY REFUSAL BEFORE ANY WRITE.
  if (refusal) return Response.json({ error: refusal }, { status: 400 });
  if (plan.shapeError) return Response.json({ error: plan.shapeError }, { status: 400 });

  const actor = { canEditMatches: auth.canEditMatches, email: auth.email, userId: auth.appUserId };
  const saveId = randomUUID();
  const results: { kind: "shape" | "move"; label: string; verdict: string; detail?: string }[] = [];

  /* ── 1. THE SHAPE, FIRST, AND THE BEFORE-MAP WITH IT ──────────────────────────────────────
   * If this fails nothing else runs. The before-map rides on this write's change_log row because
   * it must exist BEFORE the first move, and this is the write that happens first. */
  let shapeOk = false;
  const shapeWrite = await recordWrite(
    {
      env, source: "Match panel · convert to 4 teams", actorName: auth.email, actorEmail: auth.email,
      saveId, matchId: Number(id), matchName: String(m.name ?? ""),
      method: "PUT", path: `/admin/matches/${id}`,
      body: { ...plan.shape, teamNumbers: 4 },
      keys: [], label: (k) => k,
      changes: [{
        key: "convert4:shape", field: "Convert to 4 teams",
        before: `${teamCount} teams, ${plan.spotsBefore} spots · positions: ${JSON.stringify(plan.beforeMap)}`,
        after: `4 teams, ${plan.spotsAfter} spots · ${plan.moves.length} move(s) to follow`,
      }],
      applied: (_b, a) => ((a as { match?: Record<string, unknown> }).match?.teams as unknown[] | undefined)?.length === 4,
    },
    {
      readResource: async () => ({ match: await apiGet(env, `/admin/matches/${id}`) }),
      write: () => apiWrite(env, "PUT", `/admin/matches/${id}`, { ...plan.shape, teamNumbers: 4 }, actor),
      now: () => new Date().toISOString(),
    },
    supabaseLogStore(),
  );
  shapeOk = !shapeWrite.error && shapeWrite.outcome === "landed";
  results.push({
    kind: "shape",
    label: `Shape — ${teamCount} teams, ${plan.spotsBefore} spots → 4 teams, ${plan.spotsAfter} spots`,
    verdict: shapeWrite.error ? "FAILED" : shapeWrite.outcome === "landed" ? "LANDED" : "NOT APPLIED",
    detail: shapeWrite.error?.message,
  });
  if (!shapeOk) {
    return Response.json({
      ok: false, stoppedAt: "shape", results, movesAttempted: 0,
      message: "The shape write did not land, so no player was moved. Nothing has changed.",
    }, { status: 502 });
  }

  /* ── THE MIRROR, AFTER THE SHAPE LANDED ───────────────────────────────────────────────────
   * maxPlayerCount and maxTeamSize4Team are both mirrored columns, and this route was the last
   * match-writing path that did not write through — a conversion moved a match from 22 spots to
   * 44 in MatchDay and every Clubhouse screen kept saying 22 until the nightly cron.
   *
   * The re-read is the shape write's own, so this is the read-back value and not the intent.
   * Best-effort and after the guard above, so a mirror hiccup can neither block the moves nor
   * turn a landed shape write into a failure. */
  let mirrored = false, mirrorReason: string | null = "no read-back";
  try {
    const afterShape = await apiGet<Record<string, unknown>>(env, `/admin/matches/${id}`);
    const r = await refreshMatchMirror(
      auth.supabase, env, Number(id), ["maxPlayerCount", "maxTeamSize4Team", "maxTeamSize2Team"], afterShape, "landed",
    );
    mirrored = r.refreshed; mirrorReason = r.reason ?? null;
  } catch (e) {
    mirrorReason = e instanceof Error ? e.message : String(e);
  }

  /* ── 2. THE MOVES, SEQUENTIALLY, EACH WITH ITS OWN VERDICT ────────────────────────────────
   * NO RETRIES. Same endpoint the drawer's Move buttons use — rosterModel.ts:136 — and the same
   * body shape, so there is one mover in the estate and not two. */
  const stranded: string[] = [];
  /* EVERY MOVE GOES THROUGH recordWrite. Not for tidiness — a bare apiWrite here would be an
   * unlogged write, and write-routes-logged-test caught exactly that in the first draft. It also
   * gives each move the verdict this endpoint promises: the read-back checks that PLAYER is on
   * the team we asked for, so "LANDED" means observed rather than "did not throw". */
  const teamOf = async (userMatchId: number): Promise<number | null> => {
    const fresh = await apiGet<ApiMatch>(env, `/admin/matches/${id}`);
    const row = (fresh.players ?? []).find((p) => Number(p.id) === userMatchId);
    return row ? (row.team == null ? null : Number(row.team)) : null;
  };
  for (const mv of plan.moves) {
    const w = await recordWrite(
      {
        env, source: "Match panel · convert to 4 teams", actorName: auth.email, actorEmail: auth.email,
        saveId, matchId: Number(id), matchName: String(m.name ?? ""),
        method: "POST", path: "/admin/user-matches",
        // NEVER A PLAYER IDENTITY IN THE LOG BODY — the user-match id and the destination only.
        body: mv.body,
        keys: [], label: (k) => k,
        changes: [{
          key: `convert4:move:${mv.userMatchId}`, field: "Team",
          before: mv.fromTeam == null ? "no team" : `team ${mv.fromTeam} #${mv.playerNumber}`,
          after: `team ${mv.toTeam} #${mv.playerNumber}`,
        }],
        applied: (_b, a) => (a as { team: number | null }).team === mv.toTeam,
      },
      {
        readResource: async () => ({ team: await teamOf(mv.userMatchId) }),
        write: () => apiWrite(env, "POST", "/admin/user-matches", mv.body, actor),
        now: () => new Date().toISOString(),
      },
      supabaseLogStore(),
    );
    const verdict = w.error ? "FAILED" : w.outcome === "landed" ? "LANDED" : "NOT APPLIED";
    if (verdict !== "LANDED") {
      stranded.push(`${mv.name} (still on ${mv.fromTeam == null ? "no team" : `team ${mv.fromTeam}`})`);
    }
    results.push({
      kind: "move", label: `${mv.name} → team ${mv.toTeam} #${mv.playerNumber}`,
      verdict, detail: w.error?.message ?? (w.logged ? undefined : "the change-log write did not record"),
    });
  }

  const landed = results.filter((r) => r.kind === "move" && r.verdict === "LANDED").length;
  const failed = results.filter((r) => r.kind === "move" && r.verdict !== "LANDED").length;
  return Response.json({
    ok: failed === 0,
    results,
    movesAttempted: plan.moves.length, movesLanded: landed, movesFailed: failed,
    stranded,
    mirrored, mirrorReason,
    message: failed === 0
      ? `Converted. 4 teams, ${plan.spotsAfter} spots, ${landed} player(s) dealt.`
      // A PARTIAL SAYS WHO, BY NAME. "Some moves failed" is not something anyone can act on.
      : `PARTIAL — the shape is 4 teams and ${landed} of ${plan.moves.length} move(s) landed. Still on their old team: ${stranded.join("; ")}. Do not press again; move them by hand or re-run and check.`,
  });
}
