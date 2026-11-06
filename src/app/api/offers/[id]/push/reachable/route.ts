// GET /api/offers/{id}/push/reachable: who the push would reach now (the saved audience), with the breakdown.

import { errorText, offersGate, pushNotFound, readReach } from "@/lib/offersServer";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return pushNotFound();
  try { return Response.json(await readReach(id)); } catch (e) { return Response.json({ error: errorText(e) }, { status: 502 }); }
}
