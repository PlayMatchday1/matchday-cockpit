// Promo Codes — DELETE and RESTORE (Phase 18d). Both are REAL production writes on the same
// resource, so they live in one file and share one guard.
//
// PATHS CONFIRMED FROM THE RETOOL PROD EXPORT, not assumed:
//   DELETE /admin/promocodes/{id}            (deleteFuturePromocode)
//   PATCH  /admin/promocodes/{id}/restore    (restoreDeletedPromocode)
// NOTE the restore verb is **PATCH**, not POST. It was briefed to me as POST; the export says
// PATCH and the export wins. Wiring POST would have produced a 404 on a path that looks right.
//
// SOFT DELETE. It sets deletedAt; the row survives, keeps its redemptions, and can be restored.
// The guard is calibrated to match: a single plain confirm, NOT the type-the-name friction that
// cancelling a match earns — that one credits every player and texts them, and is not reversible.
// Friction that does not match the stakes trains people to click through it.
//
// A retried delete on an already-deleted code is IMPOSSIBLE, not merely harmless: the state is
// re-read first and a no-op is refused before any outbound request.
import { randomUUID } from "node:crypto";
import { authenticateAdmin } from "@/lib/adminAuth";
import { getMatchdayApiClient } from "@/lib/matchdayApi";
import {
  apiWrite, AmbiguousWriteError, WriteFailedError, DeniedFieldError, DeniedEndpointError,
  ProductionWriteBoltedError, StageHostGuardError, StageConfigError, NotAuthorizedError,
} from "@/lib/matchdayStageApi";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import type { Change } from "@/lib/changeLogModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ENV = "production" as const;

type Ctx = { params: Promise<{ id: string }> };

async function run(req: Request, ctx: Ctx, mode: "delete" | "restore") {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const { id: idRaw } = await ctx.params;
  const id = Number(idRaw);
  if (!Number.isFinite(id) || id <= 0) return Response.json({ error: "A numeric promo id is required." }, { status: 400 });

  if (!auth.canManagePromos) {
    console.warn(`[manage-promos] 403: ${auth.email} attempted ${mode} of promo ${id} without MANAGE PROMOS`);
    return Response.json({ error: `You do not hold MANAGE PROMOS. ${mode === "delete" ? "Deleting" : "Restoring"} a promo code requires it.` }, { status: 403 });
  }
  const actor = { canEditMatches: auth.canEditMatches, canManagePlayers: auth.canManagePlayers, canManagePromos: auth.canManagePromos, email: auth.email, userId: auth.appUserId };

  const client = getMatchdayApiClient();
  const readResource = async (): Promise<Record<string, unknown>> => {
    const r = (await client.get<Record<string, unknown>>(`/admin/promocodes/${id}`).catch(() => null)) ?? {};
    return { deletedAt: r.deletedAt ?? null, code: r.code ?? null, found: r.id != null };
  };

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const saveId = (body as { saveId?: string })?.saveId || randomUUID();

  try {
    const before = await readResource();
    if (!before.found) return Response.json({ error: `Promo ${id} was not found.` }, { status: 404 });

    // NO-OP REFUSAL — this is what makes a retried delete impossible rather than harmless.
    if (mode === "delete" && before.deletedAt) {
      return Response.json({ error: `${before.code} is already deleted. Nothing was sent.`, noop: true, status: "NOT APPLIED" }, { status: 409 });
    }
    if (mode === "restore" && !before.deletedAt) {
      return Response.json({ error: `${before.code} is not deleted. Nothing was sent.`, noop: true, status: "NOT APPLIED" }, { status: 409 });
    }

    const changes: Change[] = [{
      key: "deletedAt",
      field: mode === "delete" ? "Delete promo code" : "Restore promo code",
      before: (before.deletedAt as string | null) ?? null,
      after: mode === "delete" ? "(deleted)" : null,
    }] as Change[];

    // ONE call site, chosen up front, rather than a ternary inside the write closure. The gate's
    // unlogged-write detector requires every write call to sit directly after an arrow, and a
    // multi-line ternary hides it. That rule is worth keeping strict — it is what proves no route
    // can write without going through recordWrite — so the code bends to it, not the test.
    const method: "DELETE" | "PATCH" = mode === "delete" ? "DELETE" : "PATCH";
    const path = mode === "delete" ? `/admin/promocodes/${id}` : `/admin/promocodes/${id}/restore`;

    const { result, error, outcome, logged } = await recordWrite(
      {
        env: ENV, source: "Promo Codes", actorName: auth.email, actorEmail: auth.email,
        saveId, matchId: null, matchName: String(before.code ?? id),
        method, path,
        body: {}, keys: ["deletedAt"], label: () => "deletedAt",
        // LANDED is decided by the RE-READ of deletedAt, never by the status code.
        applied: (_bef, aft) => (mode === "delete" ? aft.deletedAt != null : aft.deletedAt == null),
        changes,
      },
      {
        readResource,
        write: () => apiWrite(ENV, method, path, undefined, actor, "promos"),
        now: () => new Date().toISOString(),
      },
      supabaseLogStore(),
    );
    if (error) return errToResponse(error);

    const after = await readResource();
    const landed = mode === "delete" ? after.deletedAt != null : after.deletedAt == null;
    return Response.json({
      ok: true, result, logRecorded: logged, landed,
      status: landed ? "LANDED" : "NOT APPLIED",
      deletedAt: after.deletedAt ?? null,
      serverOutcome: outcome,
    });
  } catch (e) { return errToResponse(e); }
}

export async function DELETE(req: Request, ctx: Ctx) { return run(req, ctx, "delete"); }
export async function PATCH(req: Request, ctx: Ctx) { return run(req, ctx, "restore"); }

function errToResponse(e: unknown): Response {
  if (e instanceof NotAuthorizedError) return Response.json({ error: e.message }, { status: 403 });
  if (e instanceof AmbiguousWriteError) return Response.json({ error: e.message, ambiguous: true, status: "UNKNOWN" }, { status: 502 });
  if (e instanceof ProductionWriteBoltedError) return Response.json({ error: e.message }, { status: 503 });
  if (e instanceof DeniedEndpointError) return Response.json({ error: e.message }, { status: 403 });
  if (e instanceof DeniedFieldError) return Response.json({ error: e.message }, { status: 400 });
  if (e instanceof StageHostGuardError) return Response.json({ error: e.message }, { status: 500 });
  if (e instanceof WriteFailedError) return Response.json({ error: e.message, status: "FAILED" }, { status: e.status >= 400 && e.status < 600 ? e.status : 400 });
  if (e instanceof StageConfigError) return Response.json({ error: e.message }, { status: 500 });
  return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
}
