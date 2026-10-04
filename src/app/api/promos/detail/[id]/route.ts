// Promo Codes — DETAIL (Phase 18b). Read-only, PRODUCTION, gated on MANAGE_PROMOS. This is the
// promo itself; REDEEMED comes from our copy (lib/promoRedemptions), not MatchDay's usageCount. Called once when a row is opened. Also serves the
// "all-digits search = look up by ID" path (GET /admin/promocodes/{id}).
import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth"; // Part D round 2 — a Match Ops READ (was is_admin + MANAGE PROMOS)
import { getMatchdayApiClient, MatchdayApiError } from "@/lib/matchdayApi";
import type { PromoRow } from "@/lib/promoModel";
import { createClient } from "@supabase/supabase-js";
import { statsFor, type RedemptionStats } from "@/lib/promoRedemptions";

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
    // MATCHDAY'S usageCount IS DROPPED (Ryan, 2026-10-04): it matched no set of bookings. REDEEMED
    // is our copy's standing bookings on played matches — lib/promoRedemptions, the one rule. A failed
    // read is reported as such, never as 0.
    const { usageCount: _drop, ...promo } = d; void _drop;
    let redeemed: RedemptionStats | null = null, redeemedError: string | null = null;
    try {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(), key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
      if (!url || !key) throw new Error("Supabase env not configured");
      redeemed = (await statsFor(createClient(url, key, { auth: { persistSession: false } }), [Number(id)])).get(Number(id)) ?? null;
    } catch (e) { redeemedError = e instanceof Error ? e.message : String(e); }
    return Response.json({ promo, redeemed, redeemedError, nowIso: new Date().toISOString() });
  } catch (e) {
    if (e instanceof MatchdayApiError && e.status === 404) return Response.json({ error: "not found" }, { status: 404 });
    const msg = e instanceof MatchdayApiError ? `promo detail HTTP ${e.status}` : e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 502 });
  }
}
