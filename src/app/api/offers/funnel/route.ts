// GET /api/offers/funnel?from=YYYY-MM-DD: the Offer results card (GET /admin/offers/campaigns/funnel; offers launched
// in [from, now), totals, planner). No from: the backend's default, the last 30 days. See src/lib/offersFunnel.ts.

import { FUNNEL_MISSING, errorText, funnelMissing, offersGate, readFunnel } from "@/lib/offersServer";
import { fixtureOn } from "@/lib/pushesServer";
import { fixture } from "@/lib/pushesFixture";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const from = new URL(req.url).searchParams.get("from");
  if (from !== null && !/^\d{4}-\d{2}-\d{2}$/.test(from)) return Response.json({ error: "from must be a date, YYYY-MM-DD." }, { status: 400 });
  if (fixtureOn()) return Response.json({ ...fixture.funnel(), fixture: true });
  try { return Response.json(await readFunnel(from)); }
  catch (e) { return Response.json({ error: funnelMissing(e) ? FUNNEL_MISSING : errorText(e), missing: funnelMissing(e) }, { status: 502 }); }
}
