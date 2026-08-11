// Promo Codes — FIELD LIST for the Specific Fields picker (Phase 20 D4). Read-only, PRODUCTION,
// gated on MANAGE_PROMOS. /admin/fields returns every field with its city; the picker groups by
// city. The MatchDay field id is what a promo scope stores (fieldIDs).
import { authenticateAdmin } from "@/lib/adminAuth";
import { getMatchdayApiClient, MatchdayApiError } from "@/lib/matchdayApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type ApiField = { id: number; title?: string; city?: { id?: number; name?: string } };

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (!auth.canManagePromos) return Response.json({ error: "You do not hold MANAGE PROMOS." }, { status: 403 });

  try {
    const client = getMatchdayApiClient();
    const r = await client.get<ApiField[] | { data?: ApiField[] }>("/admin/fields");
    const arr = Array.isArray(r) ? r : (r.data ?? []);
    const fields = arr.map((f) => ({ id: f.id, title: (f.title ?? "").trim() || `Field ${f.id}`, city: f.city?.name ?? "—", cityId: f.city?.id ?? null }))
      .sort((a, b) => a.city.localeCompare(b.city) || a.title.localeCompare(b.title));
    return Response.json({ fields });
  } catch (e) {
    const msg = e instanceof MatchdayApiError ? `field list HTTP ${e.status}` : e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 502 });
  }
}
