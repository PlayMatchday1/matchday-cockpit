// Promo Codes — LIST (Phase 18b). Read-only, PRODUCTION, gated on MANAGE_PROMOS. Two modes:
//   browse:  ?bucket=live|past&page=N   -> endDateMin|endDateMax + limit=25 + page (server split)
//   search:  ?code=<text>&page=N        -> substring, case-insensitive, ACROSS both buckets
// The client re-buckets search rows by end date. Reads go through the production READ client
// (matchdayApi, the Vercel-wired sync creds), NOT the write client — a list render must not
// depend on write credentials. Every page uses the /api/v1 path because only it accepts ?code=
// (see docs/matchday-api-facts.md "Promo codes").
import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { getMatchdayApiClient, MatchdayApiError } from "@/lib/matchdayApi";
import type { PromoRow } from "@/lib/promoModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PAGE = 25;

export async function GET(req: Request) {
  // READ is now open to Match Ops (Part D); the promo WRITE route stays admin + MANAGE-PROMOS gated.
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const url = new URL(req.url);
  const code = (url.searchParams.get("code") ?? "").trim();
  const bucket = url.searchParams.get("bucket") === "live" ? "live" : "past";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const nowIso = new Date().toISOString();

  const query: Record<string, string | number> = { limit: PAGE, page };
  if (code) query.code = code;                          // search: substring, ignores date filter
  else if (bucket === "live") query.endDateMin = nowIso; // browse LIVE: end >= now
  else query.endDateMax = nowIso;                        // browse PAST: end < now

  // ── ?all=1 — EVERY PAGE, ASSEMBLED HERE ────────────────────────────────────────────────────
  //
  // WHY THE SERVER AND NOT THE BROWSER. Sorting by CREATED needs every row, and at 25 a page that
  // is 88 round trips. From a laptop through Vercel that measured 1.5s at concurrency 12; done
  // here it is 88 hops inside the datacenter and ONE response to the client.
  //
  // THE NO-ORDER-BY TRAP IS REAL AND IS NOT MADE WORSE BY THIS. /api/v1/admin/promocodes has no
  // ORDER BY (docs/matchday-api-facts.md), so a row written between two page fetches can come back
  // twice or be missed. That is already true of "Show 25 more" today. What is new is that this
  // path DEDUPES by id — keeping the LAST copy, which is the freshest read of that row — and
  // reports both counts so a divergence is visible instead of silent.
  const wantAll = url.searchParams.get("all") === "1";
  if (wantAll) {
    const started = Date.now();
    try {
      const client = getMatchdayApiClient();
      const base: Record<string, string | number> = { ...query };
      delete base.page;
      const first = await client.get<{ data?: PromoRow[]; totalItems?: number }>(
        "/api/v1/admin/promocodes", { ...base, limit: PAGE, page: 1 });
      const totalItems = first.totalItems ?? 0;
      const pages = Math.max(1, Math.ceil(totalItems / PAGE));
      const byId = new Map<number, PromoRow>();
      let rawCount = 0;
      const take = (rows: PromoRow[] | undefined) => {
        for (const r of rows ?? []) { rawCount++; byId.set(r.id, r); } // last copy wins
      };
      take(first.data);

      // Bounded concurrency. 8 keeps the walk quick without opening 88 sockets at a read-only
      // endpoint; a failed page throws and the whole assembly fails rather than returning a
      // silently short list.
      const queue = Array.from({ length: pages - 1 }, (_, i) => i + 2);
      await Promise.all(Array.from({ length: Math.min(8, queue.length) }, async () => {
        for (;;) {
          const p = queue.shift();
          if (!p) return;
          const r = await client.get<{ data?: PromoRow[] }>("/api/v1/admin/promocodes", { ...base, limit: PAGE, page: p });
          take(r.data);
        }
      }));

      return Response.json({
        data: [...byId.values()],
        totalItems,
        rawCount,                       // rows the API handed back, duplicates included
        distinctCount: byId.size,       // after dedupe — a gap between these two IS the trap firing
        elapsedMs: Date.now() - started,
        complete: byId.size >= totalItems,
        nowIso, page: 1, pageSize: PAGE,
      });
    } catch (e) {
      const msg = e instanceof MatchdayApiError ? `promo list HTTP ${e.status}` : e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 502 });
    }
  }

  try {
    const client = getMatchdayApiClient();
    const r = await client.get<{ data?: PromoRow[]; totalItems?: number }>("/api/v1/admin/promocodes", query);
    return Response.json({ data: r.data ?? [], totalItems: r.totalItems ?? 0, nowIso, page, pageSize: PAGE });
  } catch (e) {
    const msg = e instanceof MatchdayApiError ? `promo list HTTP ${e.status}` : e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 502 });
  }
}
