// GET /api/offers/matches/{id}: one match, cut down, for an offer that names a match the page's list
// doesn't have. Read when that offer is opened, and again on Retry; never on page load.

import { errorText, offersGate, readMatch } from "@/lib/offersServer";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Not found" }, { status: 404 });
  try { return Response.json(await readMatch(id)); }
  catch (e) { return Response.json({ error: errorText(e) }, { status: 502 }); }
}
