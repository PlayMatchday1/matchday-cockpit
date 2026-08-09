// Player Lookup ban actions (Phase 18) — suspend / expel / lift. Guarded by MANAGE
// PLAYERS, a SEPARATE authority from EDIT MATCHES. The request bodies + verbs are the
// ones Retool sends, extracted verbatim from retool-export-prod.json (NOT probed live —
// there is no test player):
//   suspend : POST   /admin/players/{id}/ban  { permanent:false, reason, banExpiredAt:"YYYY-MM-DD" }
//   expel   : POST   /admin/players/{id}/ban  { permanent:true,  reason }
//   lift    : DELETE /admin/players/{id}/ban  (no body)
// Every action goes through recordWrite (read-before, write, read-after, classify, log)
// with the actor, exactly like the roster writes.

import { randomUUID } from "node:crypto";
import { authenticateAdmin } from "@/lib/adminAuth";
import { apiGet, apiWrite, AmbiguousWriteError, WriteFailedError, DeniedFieldError, DeniedEndpointError, ProductionWriteBoltedError, StageHostGuardError, StageConfigError, NotAuthorizedError, type MatchdayEnv } from "@/lib/matchdayStageApi";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import type { Change } from "@/lib/changeLogModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const isEnv = (x: string): x is MatchdayEnv => x === "staging" || x === "production";

type BanOp = { action?: "suspend" | "expel" | "lift"; playerId?: number; reason?: string; until?: string; playerName?: string; saveId?: string; source?: string };

function banLabel(p: Record<string, unknown>): string {
  if (p.isBanned !== true) return "active";
  if (p.isBanPermanent === true) return "expelled";
  return p.banExpiredAt ? `suspended until ${String(p.banExpiredAt).slice(0, 10)}` : "suspended";
}

export async function POST(req: Request, ctx: { params: Promise<{ env: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });

  const op = (await req.json().catch(() => null)) as BanOp | null;
  if (!op || (op.action !== "suspend" && op.action !== "expel" && op.action !== "lift")) {
    return Response.json({ error: "op {action: suspend|expel|lift} required" }, { status: 400 });
  }
  if (!Number.isFinite(op.playerId)) return Response.json({ error: "playerId required" }, { status: 400 });
  const reason = (op.reason ?? "").trim();
  if (!reason) return Response.json({ error: "A reason is required — it is recorded in the account history and Change Log." }, { status: 400 });
  if (op.action === "suspend" && !/^\d{4}-\d{2}-\d{2}$/.test(op.until ?? "")) {
    return Response.json({ error: "Suspend requires an 'until' date (YYYY-MM-DD). For an indefinite ban, use Expel." }, { status: 400 });
  }

  // MANAGE PLAYERS check — BEFORE any MatchDay call. A caller without it produces ZERO
  // outbound requests. (apiWrite re-checks with requires:"manage" as the unbypassable
  // chokepoint, but this early return is what makes the 403 network-free.)
  if (!auth.canManagePlayers) {
    console.warn(`[manage-players] 403: ${auth.email} attempted ${op.action} on player ${op.playerId} without MANAGE PLAYERS`);
    return Response.json({ error: "You do not hold MANAGE PLAYERS. Suspend / expel / lift require it." }, { status: 403 });
  }
  const actor = { canEditMatches: auth.canEditMatches, canManagePlayers: auth.canManagePlayers, email: auth.email, userId: auth.appUserId };

  // Build the request SERVER-SIDE from the action — the client never sends a path/verb.
  const id = op.playerId as number;
  const path = `/admin/players/${id}/ban`;
  let method: "POST" | "DELETE";
  let body: Record<string, unknown> | undefined;
  if (op.action === "suspend") { method = "POST"; body = { permanent: false, reason, banExpiredAt: op.until }; }
  else if (op.action === "expel") { method = "POST"; body = { permanent: true, reason }; }
  else { method = "DELETE"; body = undefined; } // lift — DELETE /ban, no body

  const readResource = async (): Promise<Record<string, unknown>> => {
    const r = await apiGet<Record<string, unknown>>(env, `/admin/players/${id}`).catch(() => ({} as Record<string, unknown>));
    const d = (r && typeof r === "object" && "data" in r ? (r.data as Record<string, unknown>) : r) ?? {};
    return { isBanned: d.isBanned, isBanPermanent: d.isBanPermanent, banExpiredAt: d.banExpiredAt, banReason: d.banReason };
  };
  const applied = (_b: Record<string, unknown>, a: Record<string, unknown>): boolean =>
    op.action === "suspend" ? a.isBanned === true && a.isBanPermanent !== true
    : op.action === "expel" ? a.isBanned === true && a.isBanPermanent === true
    : a.isBanned !== true; // lift
  const changes: Change[] = [{
    key: op.action, field: op.action === "lift" ? "Lift ban" : op.action === "expel" ? "Expel" : "Suspend",
    before: null, after: op.action === "lift" ? `active — ${reason}` : op.action === "expel" ? `expelled — ${reason}` : `suspended until ${op.until} — ${reason}`,
  }];

  try {
    const before = await readResource();
    changes[0].before = banLabel(before);
    const { result, error, outcome, logged } = await recordWrite(
      {
        env, source: op.source || "Player Lookup", actorName: auth.email, actorEmail: auth.email,
        saveId: op.saveId || randomUUID(), matchId: id, matchName: op.playerName ?? `player ${id}`,
        method, path, body: body ?? {}, keys: [], label: (k) => k, applied, changes,
      },
      { readResource, write: () => apiWrite(env, method, path, body, actor, "manage"), now: () => new Date().toISOString() },
      supabaseLogStore(),
    );
    if (error) return errToResponse(error);
    return Response.json({ ok: true, result, outcome, logRecorded: logged });
  } catch (e) { return errToResponse(e); }
}

function errToResponse(e: unknown): Response {
  if (e instanceof NotAuthorizedError) return Response.json({ error: e.message }, { status: 403 });
  if (e instanceof AmbiguousWriteError) return Response.json({ error: e.message, ambiguous: true }, { status: 502 });
  if (e instanceof ProductionWriteBoltedError) return Response.json({ error: e.message }, { status: 503 });
  if (e instanceof DeniedEndpointError) return Response.json({ error: e.message }, { status: 403 });
  if (e instanceof DeniedFieldError) return Response.json({ error: e.message }, { status: 400 });
  if (e instanceof StageHostGuardError) return Response.json({ error: e.message }, { status: 500 });
  if (e instanceof WriteFailedError) return Response.json({ error: e.message }, { status: e.status >= 400 && e.status < 600 ? e.status : 400 });
  if (e instanceof StageConfigError) return Response.json({ error: e.message }, { status: 500 });
  return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
}
