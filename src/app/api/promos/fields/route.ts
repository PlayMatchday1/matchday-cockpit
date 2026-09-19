// Promo Codes — FIELD LIST for the Specific Fields picker (Phase 20 D4). Read-only, PRODUCTION,
// gated on MANAGE_PROMOS. /admin/fields returns every field with its city; the picker groups by
// city. The MatchDay field id is what a promo scope stores (fieldIDs).
import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth"; // Part D round 2 — a Match Ops READ (was is_admin + MANAGE PROMOS)
import { getMatchdayApiClient, MatchdayApiError } from "@/lib/matchdayApi";
import { cityNameFor } from "@/lib/cityScope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type ApiField = { id: number; title?: string; city?: { id?: number; name?: string } };

export async function GET(req: Request) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  try {
    const client = getMatchdayApiClient();
    const r = await client.get<ApiField[] | { data?: ApiField[] }>("/admin/fields");
    const arr = Array.isArray(r) ? r : (r.data ?? []);
    const fields = arr.map((f) => ({ id: f.id, title: (f.title ?? "").trim() || `Field ${f.id}`, city: f.city?.name ?? "—", cityId: f.city?.id ?? null }))
      .sort((a, b) => a.city.localeCompare(b.city) || a.title.localeCompare(b.title));
    /* ── defaultCity: A DEFAULT, AND NOT A BOUNDARY ───────────────────────────────────────────
     * THIS ROUTE STILL RETURNS EVERY FIELD IN THE ESTATE, to a confined caller as much as anyone.
     * That is deliberate and it is Ryan's ruling: a promo carries no city, estate-wide redemption
     * is acceptable, and nothing may refuse a request that names a field outside the caller's own
     * city. Filtering the LIST here would be a boundary by the back door.
     *
     * WHAT WAS ACTUALLY WRONG. Being on the confined route allowlist made this route REACHABLE;
     * it never made it SCOPED, and nothing else did either. So a Warsaw operator opening the
     * Specific Fields picker was handed every field in every city with their own nowhere near the
     * top. This names their city so the picker can open on it; the search box still reaches
     * everything, and the server accepts any field id whatever this says. */
    return Response.json({ fields, defaultCity: auth.confinedCity ? cityNameFor(auth.confinedCity) : null });
  } catch (e) {
    const msg = e instanceof MatchdayApiError ? `field list HTTP ${e.status}` : e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 502 });
  }
}
