/* APPLY THE NEW FAKE LADDER TO ONE MATCH — POST /api/matchday/{env}/fake-ladder/{id}
 *   body { switchId }   the fake_ladder_switches row this write belongs to (required)
 *
 * ONE MATCH PER CALL, ON PURPOSE. The page drives the run so it can stop at the first write that
 * does not land and never hit a function time limit.
 *
 * ONE MATCHDAY REQUEST PER SECOND, ENFORCED HERE. This call's own requests (read, write,
 * read-back) are spaced a second apart, and the page waits a second after each call before the
 * next, so the gap between any two requests of a run is at least one second.
 *
 * ── THE DECISION IS MADE AGAIN, ON A FRESH READ ──────────────────────────────────────────────────
 * The preview was a snapshot. Between it and this call a match can cross its 3h mark, be
 * cancelled, or be put on the new ladder by hand. So the match is read here and planNewLadder —
 * the same function the preview counted with — decides. Anything but "change" sends nothing.
 *
 * ── THE WRITE ─────────────────────────────────────────────────────────────────────────────────
 * PUT /admin/matches/{id} with ONLY the rungs that differ (the diff IS the body; PUT patches —
 * proven on production 17256). Through recordWrite: the read above is its before, then the write,
 * then a read-back that decides LANDED / NOT APPLIED / FAILED / UNKNOWN. Never retried — a run
 * that stops is restarted by a person, and the plan then finds the landed matches unchanged.
 * Three MatchDay requests when it writes, one when it does not.
 */
import { authenticateCapability } from "@/lib/capabilityAuth";
import { assertMatchInScope } from "@/lib/matchOpsAuth";
import {
  apiGet, apiWrite, AmbiguousWriteError, WriteFailedError, DeniedFieldError, DeniedEndpointError,
  ProductionWriteBoltedError, StageHostGuardError, StageConfigError, NotAuthorizedError, type MatchdayEnv,
} from "@/lib/matchdayStageApi";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { NO_EDIT_MATCHES } from "@/lib/matchEditAccess";
import { refreshMatchMirror } from "@/lib/mirrorWriteThrough";
import { planNewLadder } from "@/lib/fakeLadder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const isEnv = (x: string): x is MatchdayEnv => x === "staging" || x === "production";
/** The pause before each MatchDay request after the first in a call. */
const gap = () => new Promise<void>((r) => setTimeout(r, 1000));

export async function POST(req: Request, ctx: { params: Promise<{ env: string; id: string }> }) {
  const auth = await authenticateCapability(req, "editMatches");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env, id } = await ctx.params;
  {
    const scope = await assertMatchInScope(auth.supabase, auth.confinedCity, id);
    if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status });
  }
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  if (!/^\d+$/.test(id)) return Response.json({ error: "Match id must be numeric" }, { status: 400 });
  // EDIT MATCHES before any MatchDay request, so a read-only account makes zero network calls.
  if (!auth.canEditMatches) {
    console.warn(`[edit-matches] 403: ${auth.email} attempted the new fake ladder on ${id} without EDIT MATCHES`);
    return Response.json({ error: NO_EDIT_MATCHES }, { status: 403 });
  }
  const b = (await req.json().catch(() => null)) as { switchId?: unknown } | null;
  const switchId = Number(b?.switchId);
  /* EVERY BULK WRITE BELONGS TO A RECORDED SWITCH. Without one the before/after comparison loses
   * the date this match crossed over. */
  if (!Number.isInteger(switchId) || switchId <= 0) return Response.json({ error: "switchId required" }, { status: 400 });
  const actor = { canEditMatches: auth.canEditMatches, email: auth.email, userId: auth.appUserId };

  try {
    let cached = await apiGet<Record<string, unknown>>(env, `/admin/matches/${id}`);
    const plan = planNewLadder(cached, Date.now());
    if (plan.status !== "change") {
      return Response.json({ ok: true, status: plan.status, outcome: null, requests: 1 });
    }
    const changes = plan.diff;
    const keys = Object.keys(changes);
    let reads = 0;
    const { outcome, error, logged } = await recordWrite(
      {
        env, source: "Apply new ladder", actorName: auth.email, actorEmail: auth.email,
        saveId: `ladder-${switchId}-${id}`, matchId: Number(id), matchName: (cached.name as string) ?? null,
        method: "PUT", path: `/admin/matches/${id}`, body: changes, keys, label: (k) => k,
      },
      {
        readResource: async () => { if (reads++ === 0) return cached; await gap(); cached = await apiGet<Record<string, unknown>>(env, `/admin/matches/${id}`); return cached; },
        write: () => gap().then(() => apiWrite(env, "PUT", `/admin/matches/${id}`, changes, actor)),
        now: () => new Date().toISOString(),
      },
      supabaseLogStore(),
    );
    if (error) return errToResponse(error, keys.length);
    const mirror = await refreshMatchMirror(auth.supabase, env, Number(id), keys, cached, outcome);
    return Response.json({
      ok: outcome === "landed", status: "change", outcome, requests: 3, diff: changes,
      logRecorded: logged, mirrored: mirror.refreshed, mirrorReason: mirror.reason ?? null,
    });
  } catch (e) {
    return errToResponse(e, 0);
  }
}

/* `requests` rides on errors too: the page keeps pacing honestly even on the call that stops it. */
function errToResponse(e: unknown, wrote: number): Response {
  const requests = wrote ? 2 : 1;
  const j = (error: string, status: number, extra: Record<string, unknown> = {}) =>
    Response.json({ error, outcome: extra.ambiguous ? "unknown" : "failed", requests, ...extra }, { status });
  if (e instanceof NotAuthorizedError) return j(e.message, 403);
  if (e instanceof ProductionWriteBoltedError) return j(`Production writes are bolted: ${e.message}`, 503);
  if (e instanceof DeniedEndpointError) return j(e.message, 403);
  if (e instanceof DeniedFieldError) return j(e.message, 400);
  if (e instanceof StageHostGuardError) return j(`Host guard blocked the write: ${e.message}`, 500);
  if (e instanceof AmbiguousWriteError) return j(`AMBIGUOUS: ${e.message}`, 502, { ambiguous: true });
  if (e instanceof WriteFailedError) return j(e.message, e.status >= 400 && e.status < 600 ? e.status : 400);
  if (e instanceof StageConfigError) return j(e.message, 500);
  return j(e instanceof Error ? e.message : String(e), 500);
}
