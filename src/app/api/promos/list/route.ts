// Promo Codes — LIST (Phase 18b). Read-only, PRODUCTION, gated on MANAGE_PROMOS. Two modes:
//   browse:  ?bucket=live|past&page=N   -> endDateMin|endDateMax + limit=25 + page (server split)
//   search:  ?code=<text>&page=N        -> substring, case-insensitive, ACROSS both buckets
// The client re-buckets search rows by end date. Reads go through the production READ client
// (matchdayApi, the Vercel-wired sync creds), NOT the write client — a list render must not
// depend on write credentials. Every page uses the /api/v1 path because only it accepts ?code=
// (see docs/matchday-api-facts.md "Promo codes").
import { authenticateAdmin } from "@/lib/adminAuth";
import { getMatchdayApiClient, MatchdayApiError } from "@/lib/matchdayApi";
import type { PromoRow } from "@/lib/promoModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const PAGE = 25;

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (!auth.canManagePromos) return Response.json({ error: "You do not hold MANAGE PROMOS." }, { status: 403 });

  const url = new URL(req.url);
  const code = (url.searchParams.get("code") ?? "").trim();
  const bucket = url.searchParams.get("bucket") === "live" ? "live" : "past";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const nowIso = new Date().toISOString();

  const query: Record<string, string | number> = { limit: PAGE, page };
  if (code) query.code = code;                          // search: substring, ignores date filter
  else if (bucket === "live") query.endDateMin = nowIso; // browse LIVE: end >= now
  else query.endDateMax = nowIso;                        // browse PAST: end < now

  try {
    const client = getMatchdayApiClient();
    const r = await client.get<{ data?: PromoRow[]; totalItems?: number }>("/api/v1/admin/promocodes", query);
    return Response.json({ data: r.data ?? [], totalItems: r.totalItems ?? 0, nowIso, page, pageSize: PAGE });
  } catch (e) {
    const msg = e instanceof MatchdayApiError ? `promo list HTTP ${e.status}` : e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 502 });
  }
}
