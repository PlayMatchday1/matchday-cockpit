// Promo Codes — DETAIL (Phase 18b). Read-only, PRODUCTION, gated on MANAGE_PROMOS. This is the
// ONLY place usageCount (redemptions) is available, so REDEEMED / LEFT live here — never as a
// list column, never an N+1 across rows. Called once when a row is opened. Also serves the
// "all-digits search = look up by ID" path (GET /admin/promocodes/{id}).
import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth"; // Part D round 2 — a Match Ops READ (was is_admin + MANAGE PROMOS)
import { getMatchdayApiClient, MatchdayApiError } from "@/lib/matchdayApi";
import type { PromoRow } from "@/lib/promoModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Detail = PromoRow & { usageCount?: number };

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  if (!/^\d+$/.test(id)) return Response.json({ error: "numeric id required" }, { status: 400 });

  try {
    const client = getMatchdayApiClient();
    const r = await client.get<Detail>(`/admin/promocodes/${id}`);
    const d = (r && typeof r === "object" && "data" in r ? (r as { data: Detail }).data : r) ?? null;
    if (!d || typeof d !== "object") return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ promo: d, usageCount: typeof d.usageCount === "number" ? d.usageCount : 0, nowIso: new Date().toISOString() });
  } catch (e) {
    if (e instanceof MatchdayApiError && e.status === 404) return Response.json({ error: "not found" }, { status: 404 });
    const msg = e instanceof MatchdayApiError ? `promo detail HTTP ${e.status}` : e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 502 });
  }
}
