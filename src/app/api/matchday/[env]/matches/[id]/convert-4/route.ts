/* POST /api/matchday/{env}/matches/{id}/convert-4 — 2 teams becomes 4, and the players are dealt.
 *
 * GET returns the PLAN and writes nothing, so the confirmation shows real figures computed at
 * click time rather than a guess made at render time. Both take `?perTeam=N` (6 to 12, the sizes
 * rosterEditModel's teamSizes offers this roster); without it the match's current per-side figure
 * carries over when it is offered, else the smallest size that holds the real players.
 *
 * ── THE FAKES, THEN ONE SHAPE WRITE, THEN N MOVES, THEN THE FAKES AGAIN; NO TRANSACTION ───────
 * That is the whole risk of this endpoint. It is handled by ORDER and by REPORTING, because it
 * cannot be handled by rollback:
 *
 *   0. EVERY FAKE COMES OFF FIRST (Ryan, 2026-11-05), one DELETE per row, read back as gone,
 *      stopping at the first failure. A fake left on #1 is in a dealt player's way and one on a
 *      bib above the new size sits outside the team; with them gone every move lands on an empty
 *      spot. A failure here leaves a 2-team match with fewer fakes and nobody moved.
 *   1. THE SHAPE GOES NEXT. If it fails, nothing else runs — a match still on 2 teams with
 *      everyone where they were is a match nobody has to repair.
 *   2. THE MOVES GO SEQUENTIALLY, each with its own verdict. NO RETRIES: there is no
 *      Idempotency-Key, and a repeated move on a player who was moved again by someone else puts
 *      them somewhere nobody chose.
 *   3. THE FAKES FOLLOW THE STORED SPOTS LEFT at the new capacity, through the fakes route's
 *      followSpotsLeft, the one rule every capacity change shares (the desktop Save's and the
 *      staff app's size writes reach it the same way). Reported, never retried.
 *   4. THE RESPONSE IS A LIST, one row per write. A single outcome for eleven writes would be a
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

import { pathEnv, type PathEnv } from "@/lib/localMode";
import { randomUUID } from "node:crypto";
import { authenticateCapability } from "@/lib/capabilityAuth";
import { apiGet, apiWrite } from "@/lib/matchdayStageApi";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { refreshMatchMirror } from "@/lib/mirrorWriteThrough";
import { assertMatchInScope } from "@/lib/matchOpsAuth";
import { NO_EDIT_MATCHES } from "@/lib/matchEditAccess";
import { ladderClampPatch } from "@/lib/fakeLadder";
import {
  buildConvertPlan, convertRefusal, convertSummary, type ConvertPlayer,
} from "@/lib/convertFourTeams";
import { perTeamError } from "@/lib/reduceTwoTeams";
import { TEAM_SIZE_MAX, TEAM_SIZE_MIN } from "@/lib/rosterEditModel";
import { fakesFollowingSpotsLeft } from "@/lib/fakeLadder";
import { POST as fakesPost } from "@/app/api/matchday/[env]/matches/[id]/fakes/route";
import { forwardedAuth } from "@/lib/viewAs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// "local" only while local mode is on (src/lib/localMode.ts pathEnv); staging/production unchanged.
const isEnv = (x: string): x is PathEnv => pathEnv(x) !== null;

/** The operating timezone's today, as TEXT. The only Date in this file, and it never touches a
 *  match's startDate — see convertRefusal. */
const todayYmd = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());

type ApiMatch = {
  id: number; name?: string; startDate?: string | null; startDateUtc?: string | null; isCancelled?: unknown;
  maxPlayerCount?: unknown; maxTeamSize4Team?: unknown; teams?: unknown[]; players?: Record<string, unknown>[];
  [rung: `fakeSpotLeft${number}h`]: unknown;
};

/** `?perTeam=N`, or null when absent (the plan's default applies). A value outside 6 to 12 is an error. */
const perTeamFrom = (url: string): { perTeam: number | null; error: string | null } => {
  const raw = new URL(url).searchParams.get("perTeam");
  if (raw == null || raw === "") return { perTeam: null, error: null };
  const err = perTeamError(raw);
  return err ? { perTeam: null, error: err } : { perTeam: Number(raw), error: null };
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

async function planFor(env: PathEnv, id: string, perTeam: number | null) {
  const m = await apiGet<ApiMatch>(env, `/admin/matches/${id}`);
  const teamCount = (m.teams ?? []).length;
  const players = toPlayers(m);
  const refusal = convertRefusal({ startDate: m.startDate ?? null, isCancelled: m.isCancelled, teamCount }, todayYmd());
  const plan = buildConvertPlan({ maxPlayerCount: m.maxPlayerCount, maxTeamSize4Team: m.maxTeamSize4Team, teamCount }, players, perTeam);
  /* THE FAKES AFTER: what followSpotsLeft will bring the roster to at the new capacity, the stored
   * spots left under the rung in force kept (fakeLadder.fakesFollowingSpotsLeft). A figure for the
   * confirmation, computed by the same function the fakes route runs after the deal. */
  const follow = fakesFollowingSpotsLeft({ ...(m as Record<string, unknown>), maxPlayerCount: plan.spotsAfter }, plan.playerCount, Date.now());
  return { m, teamCount, plan, refusal, fakesAfter: follow.target, spotsLeft: follow.spotsLeft };
}

/** GET — the plan, for the confirmation. Writes nothing. */
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
    const { m, teamCount, plan, refusal, fakesAfter, spotsLeft } = await planFor(env, id, asked.perTeam);
    return Response.json({
      matchId: Number(id), matchName: m.name ?? null, teamCount, refusal,
      summary: convertSummary(plan), shapeError: plan.shapeError,
      /* THE SIZE, 6 TO 12 A SIDE: the one the plan is at, the ones this roster may run at, and why
       * none when the list is empty. sizeRefusal is set when perTeam is not on the list. */
      perTeam: plan.perTeam, sizes: plan.sizes, sizeReason: plan.sizeReason, sizeRefusal: plan.sizeRefusal,
      minPerTeam: TEAM_SIZE_MIN, maxPerTeam: TEAM_SIZE_MAX,
      spotsBefore: plan.spotsBefore, spotsAfter: plan.spotsAfter,
      playerCount: plan.playerCount, keptCount: plan.keptCount,
      /* THE FAKES: every one comes off first, and the stored spots left bring back fakesAfter. */
      fakeCount: plan.fakeCount, removeCount: plan.removes.length, fakesAfter, spotsLeft,
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
  const scope = await assertMatchInScope(auth.supabase, auth.confinedCity, id, env);
  if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status });
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  if (!/^\d+$/.test(id)) return Response.json({ error: "Match id must be numeric" }, { status: 400 });
  if (!auth.canEditMatches) {
    console.warn(`[edit-matches] 403: ${auth.email} attempted convert-4 on ${id}`);
    return Response.json({ error: NO_EDIT_MATCHES }, { status: 403 });
  }

  const asked = perTeamFrom(req.url);
  if (asked.error) return Response.json({ error: asked.error }, { status: 400 });

  let plan, m, teamCount, refusal;
  try { ({ m, teamCount, plan, refusal } = await planFor(env, id, asked.perTeam)); }
  catch (e) { return Response.json({ error: `Couldn't read the match: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 }); }

  // EVERY REFUSAL BEFORE ANY WRITE.
  if (refusal) return Response.json({ error: refusal }, { status: 400 });
  if (plan.sizeRefusal) return Response.json({ error: plan.sizeRefusal }, { status: 400 });
  if (plan.shapeError) return Response.json({ error: plan.shapeError }, { status: 400 });

  const actor = { canEditMatches: auth.canEditMatches, email: auth.email, userId: auth.appUserId };
  const saveId = randomUUID();
  const source = "Match panel · convert to 4 teams";
  const results: { kind: "remove" | "shape" | "move" | "fakes"; label: string; verdict: string; detail?: string }[] = [];

  /* ── 0. EVERY FAKE, FIRST, ONE AT A TIME, STOPPING AT THE FIRST FAILURE ───────────────────
   * DELETE /admin/matches/user-matches/{umId}: the same removal rosterModel and Reduce to 2 build,
   * so there is one remover in the estate and not three. Read back as gone before the next write,
   * so no move below is ever issued onto a spot a fake is still standing on. Nobody is notified:
   * this is padding, not a person. A failure here is the cheapest one in the operation: the match
   * is still 2 teams and every real player is standing exactly where they were. */
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
          key: `convert4:remove:${rm.userMatchId}`, field: "Fake player",
          before: rm.team == null ? "no team" : `team ${rm.team} #${rm.playerNumber ?? "none"}`,
          after: "removed before the convert",
        }],
        applied: (_b, a) => (a as { gone: boolean }).gone === true,
      },
      {
        readResource: async () => ({ gone: await rowGone(rm.userMatchId) }),
        // NO BODY: the API rejects an empty JSON body on a bodyless write (see reduce-2).
        write: () => apiWrite(env, "DELETE", `/admin/matches/user-matches/${rm.userMatchId}`, undefined, actor),
        now: () => new Date().toISOString(),
      },
      supabaseLogStore(),
    );
    const verdict = w.error ? "FAILED" : w.outcome === "landed" ? "LANDED" : "NOT APPLIED";
    results.push({
      kind: "remove", label: `Remove fake: ${rm.team == null ? "no team" : `team ${rm.team} #${rm.playerNumber ?? "none"}`}`,
      verdict, detail: w.error?.message ?? (w.logged ? undefined : "the change-log write did not record"),
    });
    if (verdict !== "LANDED") {
      return Response.json({
        ok: false, stoppedAt: "remove", results, movesAttempted: 0, removesLanded,
        message: `STOPPED: a fake would not come off (${plan.removes.length - removesLanded} of ${plan.removes.length} still on the match). ` +
          `NOBODY HAS MOVED and the shape was not written. This match is still a ${teamCount}-team match and every real player is ` +
          `standing exactly where they were. ${removesLanded} fake(s) did come out. Nothing retried.`,
      }, { status: 502 });
    }
    removesLanded += 1;
  }

  /* ── 1. THE SHAPE, FIRST, AND THE BEFORE-MAP WITH IT ──────────────────────────────────────
   * If this fails nothing else runs. The before-map rides on this write's change_log row because
   * it must exist BEFORE the first move, and this is the write that happens first. */
  let shapeOk = false;
  /* NO RUNG ABOVE THE NEW CAPACITY (fakeLadder.ts ladderClampPatch) — rides on the shape write. */
  const shapeBody = { ...plan.shape, teamNumbers: 4, ...ladderClampPatch(m as Record<string, unknown>, plan.shape as Record<string, unknown>) };
  const shapeWrite = await recordWrite(
    {
      env, source, actorName: auth.email, actorEmail: auth.email,
      saveId, matchId: Number(id), matchName: String(m.name ?? ""),
      method: "PUT", path: `/admin/matches/${id}`,
      body: shapeBody,
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
      write: () => apiWrite(env, "PUT", `/admin/matches/${id}`, shapeBody, actor),
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
      ok: false, stoppedAt: "shape", results, movesAttempted: 0, removesLanded,
      message: `The shape write did not land, so no player was moved. The match is still ${teamCount} teams` +
        (removesLanded > 0 ? `, with ${removesLanded} fake(s) taken off; nothing else has changed.` : "; nothing has changed."),
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
        env, source, actorName: auth.email, actorEmail: auth.email,
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

  /* ── 3. THE FAKES FOLLOW THE STORED SPOTS LEFT ────────────────────────────────────────────
   * The fakes route, in process with this caller's own bearer, works the count out itself
   * (followSpotsLeft) from the match as it now stands: 4 x perTeam spots, the rung in force kept.
   * Its verdict is a re-read of the roster. One row here, reported beside the moves, never able to
   * undo a landed deal and never retried. */
  const fakes: { before: number; after: number | null; target: number | null; spotsLeft: number | null; outcome: string; error: string | null } =
    { before: plan.fakeCount, after: null, target: null, spotsLeft: null, outcome: "unknown", error: null };
  try {
    const origin = new URL(req.url).origin;
    const fr = await fakesPost(new Request(`${origin}/api/matchday/${env}/matches/${id}/fakes`, {
      method: "POST", headers: { ...forwardedAuth(req), "content-type": "application/json" },
      body: JSON.stringify({ followSpotsLeft: true, matchName: m.name ?? null, source, saveId }),
    }), { params: Promise.resolve({ env, id }) });
    const fj = (await fr.json().catch(() => null)) as Record<string, unknown> | null;
    const num = (v: unknown) => (Number.isFinite(Number(v)) && v != null ? Number(v) : null);
    fakes.after = num(fj?.fakesAfter); fakes.target = num(fj?.target); fakes.spotsLeft = num(fj?.spotsLeft);
    fakes.outcome = String(fj?.outcome ?? (fr.ok ? "unknown" : "failed")).toLowerCase();
    fakes.error = typeof fj?.error === "string" ? fj.error : null;
  } catch (e) {
    fakes.outcome = "failed"; fakes.error = e instanceof Error ? e.message : String(e);
  }
  const fakesOk = fakes.outcome === "landed";
  results.push({
    kind: "fakes",
    label: `Fakes for the spots left: ${fakes.target ?? "?"} on (spots left ${fakes.spotsLeft ?? "?"}, ${plan.fakeCount} were on before)`,
    verdict: fakesOk ? "LANDED" : fakes.outcome === "refused" ? "NOT APPLIED" : "FAILED", detail: fakes.error ?? undefined,
  });

  return Response.json({
    ok: failed === 0,
    results,
    perTeam: plan.perTeam, spotsAfter: plan.spotsAfter,
    removesLanded, movesAttempted: plan.moves.length, movesLanded: landed, movesFailed: failed,
    stranded, fakes,
    mirrored, mirrorReason,
    message: (failed === 0
      ? `Converted. 4 teams of ${plan.perTeam}, ${plan.spotsAfter} spots, ${landed} player(s) dealt, ${removesLanded} fake(s) off first.`
      // A PARTIAL SAYS WHO, BY NAME. "Some moves failed" is not something anyone can act on.
      : `PARTIAL — the shape is 4 teams of ${plan.perTeam} and ${landed} of ${plan.moves.length} move(s) landed. Still on their old team: ${stranded.join("; ")}. Do not press again; move them by hand or re-run and check.`)
      + (fakesOk ? ` ${fakes.after ?? fakes.target ?? 0} fake(s) on for the spots left (${fakes.spotsLeft ?? "?"}), re-read confirmed.`
        : ` BUT THE FAKES WERE NOT BROUGHT TO THE SPOTS LEFT: ${fakes.error ?? fakes.outcome}. Set them by hand.`),
  });
}
