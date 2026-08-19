// GET /api/partner-dashboards/preview?slug=<slug> — ADMIN ONLY.
//
// Returns the EXACT render props the public /partners/<slug> page builds, so the
// admin "view as the partner" preview can render the identical component from the
// identical data path (no raw rows — buildPartnerDashboardData returns aggregates).

import { authenticateCapability } from "@/lib/capabilityAuth";
import { buildPartnerDashboardData } from "@/lib/partnerDashboardData";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "matchops");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const slug = new URL(req.url).searchParams.get("slug");
  if (!slug) return Response.json({ error: "Missing ?slug" }, { status: 400 });

  try {
    const data = await buildPartnerDashboardData(auth.supabase, slug);
    if (!data) return Response.json({ error: "Partner not found" }, { status: 404 });
    return Response.json(data);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
