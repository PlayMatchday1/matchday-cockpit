// GET /api/offers/{id}/push/results: sent, skipped by reason, opened, booked within 72 hours. Test pushes aren't counted.

import { errorText, offersGate, pushNotFound, readPushResults } from "@/lib/offersServer";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return pushNotFound();
  try { return Response.json(await readPushResults(id)); } catch (e) { return Response.json({ error: errorText(e) }, { status: 502 }); }
}
