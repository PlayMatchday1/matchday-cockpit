// GET /api/public/site.json — the marketing site's single source of truth. PUBLIC, no auth.
// Model and rule: src/lib/publicSite.ts. Reads: src/lib/publicSiteServer.ts. Read only.
import { buildPublicSite, corsHeaders, EDGE_CACHE } from "@/lib/publicSiteServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // the EDGE caches it (Cache-Control below), not the build
export const maxDuration = 60;

export async function GET(req: Request) {
  const cors = corsHeaders(req);
  try {
    const payload = await buildPublicSite();
    return Response.json(payload, { headers: { ...cors, "Cache-Control": EDGE_CACHE } });
  } catch (e) {
    // Never a partial payload, never a cached error. The message is ours (no credentials reach it).
    console.error(`[public-site] build failed: ${(e as Error).message}`);
    return Response.json({ error: "The site feed could not be built. Try again shortly." }, { status: 503, headers: { ...cors, "Cache-Control": "no-store" } });
  }
}

export function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: { ...corsHeaders(req), "Access-Control-Max-Age": "86400" } });
}
