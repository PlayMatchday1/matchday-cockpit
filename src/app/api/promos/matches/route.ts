// Promo Codes — MATCH SEARCH for the Specific Matches picker (Phase 20 D3). Read-only,
// PRODUCTION, gated on MANAGE_PROMOS. Lists matches in a date range (the promo window by
// default); the upstream /admin/matches has no city filter worth using, so the client narrows
// by city. Same read client as the other promo routes.
import { authenticateAdmin } from "@/lib/adminAuth";
import { getMatchdayApiClient, MatchdayApiError } from "@/lib/matchdayApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type ApiMatch = {
  id: number; name?: string; startDate?: string; startDateUtc?: string; isCancelled?: boolean;
  maxPlayerCount?: number | null; _count?: { players?: number; fakePlayers?: number };
  field?: { title?: string; city?: { id?: number; name?: string; timeZone?: { abbr?: string } } };
};

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (!auth.canManagePromos) return Response.json({ error: "You do not hold MANAGE PROMOS." }, { status: 403 });

  const u = new URL(req.url);
  const from = (u.searchParams.get("from") ?? "").trim();
  const to = (u.searchParams.get("to") ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return Response.json({ error: "from and to (YYYY-MM-DD) required" }, { status: 400 });

  try {
    const client = getMatchdayApiClient();
    const r = await client.get<{ data?: ApiMatch[]; totalItems?: number }>("/admin/matches", { fromDate: from, toDate: to, limit: 100, page: 1, sortColumn: "startDateUtc", sortDirection: "ASC" });
    const matches = (r.data ?? []).filter((m) => !m.isCancelled).map((m) => ({
      id: m.id, name: m.name ?? `Match ${m.id}`,
      venue: m.field?.title ?? "—", city: m.field?.city?.name ?? "—", cityId: m.field?.city?.id ?? null,
      kickoffUtc: m.startDateUtc ?? null, startDate: m.startDate ?? null, tz: m.field?.city?.timeZone?.abbr ?? "",
      cap: m.maxPlayerCount ?? null, filled: Math.max(0, (m._count?.players ?? 0)),
    }));
    // distinct cities for the client's city filter
    const cities = [...new Map(matches.filter((m) => m.cityId != null).map((m) => [m.cityId, m.city])).entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
    return Response.json({ matches, cities, totalItems: r.totalItems ?? matches.length });
  } catch (e) {
    const msg = e instanceof MatchdayApiError ? `match search HTTP ${e.status}` : e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 502 });
  }
}
