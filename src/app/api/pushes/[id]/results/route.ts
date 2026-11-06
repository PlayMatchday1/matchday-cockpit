// GET /api/pushes/:id/results: sent, opened, booked within 3 days, held back and their bookings
// (GET /admin/push-notifications/messages/:id/results). See src/lib/pushesServer.ts.

import { offersGate } from "@/lib/offersServer";
import { pushesErrorText, readPushResults } from "@/lib/pushesServer";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Not found" }, { status: 404 });
  try { return Response.json(await readPushResults(id)); }
  catch (e) { return Response.json({ error: pushesErrorText(e) }, { status: 502 }); }
}
