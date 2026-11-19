// GET /api/admin/disputes/[id]: one dispute with its evidence. Admins only. The ONLY route that carries the
// saved IP address and user agent (for the detail panel and the copied packet). Every call is a VIEW row
// in change_log (who, which dispute; never the evidence). Evidence is read for this dispute alone.
import { authenticateAdmin } from "@/lib/adminAuth";
import { disputeDetail, logDisputeEvent, DisputesReadError } from "@/lib/disputesServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { id } = await ctx.params;
  if (!/^(dp|du)_[A-Za-z0-9]+$/.test(id)) return Response.json({ error: "not a dispute id" }, { status: 400 });
  const logged = await logDisputeEvent("VIEW", id, auth.email);
  try {
    const d = await disputeDetail(id);
    if (!d) return Response.json({ error: "No such dispute in the last year.", logged }, { status: 404 });
    return Response.json({ ...d, logged }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const msg = e instanceof DisputesReadError ? e.message : "The dispute could not be read.";
    return Response.json({ error: msg, logged }, { status: 502 });
  }
}
