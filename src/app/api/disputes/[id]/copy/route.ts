// POST /api/disputes/[id]/copy: records that someone copied the evidence packet. Writes one change_log
// row (who, which dispute) and nothing else: no Stripe write, and the packet itself is never sent here.
import { authenticateAdmin } from "@/lib/adminAuth";
import { logDisputeEvent } from "@/lib/disputesServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { id } = await ctx.params;
  if (!/^(dp|du)_[A-Za-z0-9]+$/.test(id)) return Response.json({ error: "not a dispute id" }, { status: 400 });
  const logged = await logDisputeEvent("COPY", id, auth.email);
  return Response.json({ logged }, { status: logged ? 200 : 500 });
}
