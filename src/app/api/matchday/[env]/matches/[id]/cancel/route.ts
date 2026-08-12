// Phase 23 Step 2 Part C — CANCEL a match. This fires the SINGLE endpoint Retool fires:
// PATCH /admin/matches/{id}/cancel. A read-only audit of the Retool prod export proved cancel is one
// PATCH with no separate credit or notification call (there is no credit/notify endpoint or non-MatchDay
// host anywhere in it) — the CREDIT (wallet credit, not a card charge reversal) and the SMS to every
// signed-up player are SERVER-SIDE effects of this one call. So calling it alone reproduces Retool
// exactly; it does NOT cancel-without-crediting.
//
// GET  = a LIVE preview: { name, count, total, alreadyCancelled } read at confirm time (never a stale
//        render), so the confirmation states real numbers.
// POST = execute: requires the typed match NAME to match the LIVE name (re-checked server-side), fires
//        once (writes never retry), recordWrite'd WITHOUT any player identity, then re-reads and reports
//        LANDED / NOT APPLIED from match.isCancelled — not the status code.

import { randomUUID } from "node:crypto";
import { authenticateAdmin } from "@/lib/adminAuth";
import { apiGet, apiWrite, AmbiguousWriteError, WriteFailedError, DeniedFieldError, DeniedEndpointError, ProductionWriteBoltedError, StageHostGuardError, StageConfigError, NotAuthorizedError, type MatchdayEnv } from "@/lib/matchdayStageApi";
import { rosterRowIsFake, rosterRowCancelled, type RosterRow } from "@/lib/gamedayModel";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const isEnv = (x: string): x is MatchdayEnv => x === "staging" || x === "production";

// The people a cancellation credits + texts: real signed-up players (not fakes, not already cancelled).
function creditView(match: Record<string, unknown>, playersRaw: unknown[]) {
  const players = (playersRaw ?? []) as RosterRow[];
  const count = players.filter((p) => !rosterRowIsFake(p) && !rosterRowCancelled(p)).length;
  const perPlayer = Number(match.registrationPrice) || 0; // the match value, in cents — what each is credited
  return { name: (match.name as string) ?? "", count, perPlayerCents: perPlayer, totalCents: count * perPlayer, alreadyCancelled: match.isCancelled === true };
}

async function readLive(env: MatchdayEnv, id: string) {
  const [match, playersRaw] = await Promise.all([
    apiGet<Record<string, unknown>>(env, `/admin/matches/${id}`),
    apiGet<unknown[] | { data?: unknown[] }>(env, `/admin/matches/${id}/players`).catch(() => []),
  ]);
  const players = Array.isArray(playersRaw) ? playersRaw : (playersRaw?.data ?? []);
  return { match, players };
}

export async function GET(req: Request, ctx: { params: Promise<{ env: string; id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env, id } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  if (!/^\d+$/.test(id)) return Response.json({ error: "Match id must be numeric" }, { status: 400 });
  try {
    const { match, players } = await readLive(env, id);
    return Response.json(creditView(match, players));
  } catch (e) { return errToResponse(e); }
}

export async function POST(req: Request, ctx: { params: Promise<{ env: string; id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env, id } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  if (!/^\d+$/.test(id)) return Response.json({ error: "Match id must be numeric" }, { status: 400 });
  const body = (await req.json().catch(() => null)) as { confirmName?: string; saveId?: string; source?: string } | null;
  const confirmName = (body?.confirmName ?? "").trim();
  if (!confirmName) return Response.json({ error: "Type the match name to confirm the cancellation." }, { status: 400 });

  if (!auth.canEditMatches) {
    console.warn(`[edit-matches] 403: ${auth.email} attempted CANCEL match ${id} without EDIT MATCHES`);
    return Response.json({ error: "You have read-only Match Ops access. EDIT MATCHES is required to cancel a match." }, { status: 403 });
  }

  // Read LIVE and re-check the typed name against the CURRENT name (never a stale client render). A
  // mismatch cancels NOTHING; an already-cancelled match is a no-op the operator should see as such.
  let live: { match: Record<string, unknown>; players: unknown[] };
  try { live = await readLive(env, id); } catch (e) { return errToResponse(e); }
  const view = creditView(live.match, live.players);
  if (view.alreadyCancelled) return Response.json({ error: "This match is already cancelled.", ...view }, { status: 409 });
  if (confirmName !== view.name) return Response.json({ error: `The typed name doesn't match. Type the match name exactly: "${view.name}".`, nameMismatch: true }, { status: 400 });

  const actor = { canEditMatches: auth.canEditMatches, email: auth.email, userId: auth.appUserId };
  try {
    let cached = live.match; let reads = 0;
    const { outcome, error, logged } = await recordWrite(
      {
        env, source: body?.source || "Match panel · cancel", actorName: auth.email, actorEmail: auth.email,
        saveId: body?.saveId || randomUUID(), matchId: Number(id), matchName: view.name,
        method: "PATCH", path: `/admin/matches/${id}/cancel`,
        // NEVER a player identity in the log — only the counts a reviewer needs.
        body: { credited_players: view.count, credit_total_cents: view.totalCents },
        keys: [], label: (k) => k,
        changes: [{ key: "cancel", field: "Cancel match", before: "active", after: `cancelled — ${view.count} player(s) credited ${view.totalCents}¢` }],
        applied: (_b, a) => (a.match as Record<string, unknown> | undefined)?.isCancelled === true,
      },
      {
        readResource: async () => { if (reads++ === 0) return { match: cached }; cached = await apiGet<Record<string, unknown>>(env, `/admin/matches/${id}`); return { match: cached }; },
        write: () => apiWrite(env, "PATCH", `/admin/matches/${id}/cancel`, {}, actor),
        now: () => new Date().toISOString(),
      },
      supabaseLogStore(),
    );
    if (error) return errToResponse(error);
    // A 2xx is not proof — re-read and classify from match state.
    const after = await apiGet<Record<string, unknown>>(env, `/admin/matches/${id}`).catch(() => null);
    const landed = after?.isCancelled === true;
    return Response.json({
      ok: true, outcome, logRecorded: logged, landed,
      status: landed ? "LANDED" : "NOT APPLIED",
      count: view.count, totalCents: view.totalCents, name: view.name,
    });
  } catch (e) { return errToResponse(e); }
}

function errToResponse(e: unknown): Response {
  if (e instanceof NotAuthorizedError) return Response.json({ error: e.message }, { status: 403 });
  if (e instanceof AmbiguousWriteError) return Response.json({ error: e.message, ambiguous: true }, { status: 502 });
  if (e instanceof ProductionWriteBoltedError) return Response.json({ error: `Production writes are bolted: ${e.message}` }, { status: 503 });
  if (e instanceof DeniedEndpointError) return Response.json({ error: e.message }, { status: 403 });
  if (e instanceof DeniedFieldError) return Response.json({ error: e.message }, { status: 400 });
  if (e instanceof StageHostGuardError) return Response.json({ error: e.message }, { status: 500 });
  if (e instanceof WriteFailedError) return Response.json({ error: e.message }, { status: e.status >= 400 && e.status < 600 ? e.status : 400 });
  if (e instanceof StageConfigError) return Response.json({ error: e.message }, { status: 500 });
  return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
}
