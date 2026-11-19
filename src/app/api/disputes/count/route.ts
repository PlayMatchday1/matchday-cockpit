// GET /api/disputes/count: the rail badge, disputes needing a response. Admins only. Served from the
// same cached list as the page (disputesServer), so a badge poll is not a Stripe read most of the time.
import { authenticateAdmin } from "@/lib/adminAuth";
import { listDisputes } from "@/lib/disputesServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  try {
    const { rows } = await listDisputes();
    return Response.json({ count: rows.filter((r) => r.bucket === "needs_response").length });
  } catch {
    // No number on failure: the badge keeps its last value. A false zero is worse than no badge.
    return Response.json({ error: "unavailable" }, { status: 502 });
  }
}
