// Promo Codes — DUPLICATE CHECK (Phase 18b). Read-only, PRODUCTION, gated on MANAGE_PROMOS.
// The API's ?code= is a SUBSTRING, case-insensitive filter that DOES return soft-deleted codes
// (both proven live). So "is EXACT code X taken?" = GET ?code=X, then keep only rows whose code
// equals X case-insensitively. This catches a taken name — including a soft-deleted one — that
// a bare substring result would blur. Debounced ~300ms on the client; one call.
import { authenticateAdmin } from "@/lib/adminAuth";
import { getMatchdayApiClient, MatchdayApiError } from "@/lib/matchdayApi";
import { promoState, type PromoRow } from "@/lib/promoModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (!auth.canManagePromos) return Response.json({ error: "You do not hold MANAGE PROMOS." }, { status: 403 });

  const code = (new URL(req.url).searchParams.get("code") ?? "").trim();
  if (!code) return Response.json({ taken: false, existing: null });

  try {
    const client = getMatchdayApiClient();
    // limit generously so a common substring (e.g. "free" → 449) can't page the exact match off
    const r = await client.get<{ data?: PromoRow[] }>("/api/v1/admin/promocodes", { code, limit: 100, page: 1 });
    const nowIso = new Date().toISOString();
    const hit = (r.data ?? []).find((x) => x.code.toLowerCase() === code.toLowerCase());
    return Response.json({
      taken: !!hit,
      existing: hit ? { id: hit.id, code: hit.code, state: promoState(hit, nowIso) } : null,
    });
  } catch (e) {
    const msg = e instanceof MatchdayApiError ? `promo check HTTP ${e.status}` : e instanceof Error ? e.message : String(e);
    // A failed check must NOT say "free" — surface the error so the UI shows uncertainty, not a green light.
    return Response.json({ error: msg }, { status: 502 });
  }
}
