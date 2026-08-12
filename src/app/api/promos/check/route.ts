// Promo Codes — DUPLICATE CHECK (Phase 18b/c). Read-only, PRODUCTION, gated on MANAGE_PROMOS.
// The API's ?code= is a SUBSTRING, case-insensitive filter that DOES return soft-deleted codes,
// and it PAGES (default 20). So "is EXACT code X taken?" is NOT just "GET ?code=X and scan the
// page" — the literal X can sit beyond the page. e.g. ?code=MA has totalItems=94 but the default
// page is 20 rows and the real code "MA" (id 2547) is not among them. Scanning that page finds
// nothing and would call a TAKEN name FREE — the exact failure we must not ship (18c item 1).
//
// The safe contract, three outcomes:
//   taken        an exact (case-insensitive) match is IN the fetched rows.
//   free         the COMPLETE result set was fetched (totalItems <= rows) and holds no exact match.
//   inconclusive more matches exist than we fetched (totalItems > rows) and none of the fetched
//                rows is exact — the real one MAY be in the unseen remainder. Never say free.
// On "inconclusive" the UI lets the save proceed and the server becomes the real check.
import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth"; // Part D round 2 — a Match Ops READ (was is_admin + MANAGE PROMOS)
import { getMatchdayApiClient, MatchdayApiError } from "@/lib/matchdayApi";
import { dupeVerdict, promoState, type PromoRow } from "@/lib/promoModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const CHECK_LIMIT = 300; // fetch enough that a full intended code's substring set is usually complete

export async function GET(req: Request) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const code = (new URL(req.url).searchParams.get("code") ?? "").trim();
  if (!code) return Response.json({ result: "free", existing: null });

  try {
    const client = getMatchdayApiClient();
    const r = await client.get<{ data?: PromoRow[]; totalItems?: number }>("/api/v1/admin/promocodes", { code, limit: CHECK_LIMIT, page: 1 });
    const rows = r.data ?? [];
    const total = typeof r.totalItems === "number" ? r.totalItems : rows.length;
    const nowIso = new Date().toISOString();
    const verdict = dupeVerdict(rows, total, code);
    if (verdict === "taken") {
      const hit = rows.find((x) => x.code.toLowerCase() === code.toLowerCase())!;
      return Response.json({ result: "taken", existing: { id: hit.id, code: hit.code, state: promoState(hit, nowIso) } });
    }
    if (verdict === "inconclusive") return Response.json({ result: "inconclusive", similar: total });
    return Response.json({ result: "free", existing: null });
  } catch (e) {
    const msg = e instanceof MatchdayApiError ? `promo check HTTP ${e.status}` : e instanceof Error ? e.message : String(e);
    // A failed check must NOT say "free" — surface the error so the UI shows uncertainty, not a green light.
    return Response.json({ error: msg }, { status: 502 });
  }
}
