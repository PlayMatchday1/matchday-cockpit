// GET /api/offers/:id/players-without-app: the players this offer chooses now who aren't on app 1.88+ and aren't held
// back (GET /admin/offers/campaigns/:id/players-without-app), for "Add message push". A read; nothing is logged.

import { FUNNEL_MISSING, errorText, funnelMissing, offersGate, readWithoutApp } from "@/lib/offersServer";
import { fixtureOn } from "@/lib/pushesServer";
import { fixture } from "@/lib/pushesFixture";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Not found" }, { status: 404 });
  if (fixtureOn()) return Response.json(fixture.withoutApp(id));
  try { return Response.json(await readWithoutApp(id)); }
  catch (e) { return Response.json({ error: funnelMissing(e) ? FUNNEL_MISSING : errorText(e), missing: funnelMissing(e) }, { status: 502 }); }
}
