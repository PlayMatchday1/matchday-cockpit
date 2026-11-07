// GET /api/pushes/:id/send-summary: the send bar's numbers as if the saved push went now
// (GET /admin/push-notifications/messages/:id/send-summary).

import { offersGate } from "@/lib/offersServer";
import { pushesErrorText, readSendSummary } from "@/lib/pushesServer";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Not found" }, { status: 404 });
  try { return Response.json(await readSendSummary(id)); }
  catch (e) { return Response.json({ error: pushesErrorText(e) }, { status: 502 }); }
}
