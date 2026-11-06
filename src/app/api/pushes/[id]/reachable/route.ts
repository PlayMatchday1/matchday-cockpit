// GET /api/pushes/:id/reachable: who the saved push would reach now, with how many are at the weekly cap (the amber
// flag under the count). GET /admin/push-notifications/messages/:id/reachable.

import { offersGate } from "@/lib/offersServer";
import { pushesErrorText, readReachable } from "@/lib/pushesServer";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Not found" }, { status: 404 });
  try { return Response.json(await readReachable(id)); }
  catch (e) { return Response.json({ error: pushesErrorText(e) }, { status: 502 }); }
}
