// GET /api/pushes/players/:id?limit=5|all&env=: Player Lookup › Pushes (GET /admin/push-notifications/players/:id).
// A read. The pushes backend is the one OFFERS_ENV names; env is the environment Player Lookup is showing, and when the
// two differ the answer says so (envMismatch) instead of reading another backend's player with the same id.

import { _offersCfg, offersGate } from "@/lib/offersServer";
import { pushesErrorText, readPlayerPushes } from "@/lib/pushesServer";
import { WriteFailedError } from "@/lib/matchdayStageApi";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Not found" }, { status: 404 });
  const q = new URL(req.url).searchParams;
  const limit = q.get("limit") === "all" ? "all" : "5";
  const env = q.get("env");
  if (env && env !== _offersCfg().env) return Response.json({ envMismatch: true, pushesEnv: _offersCfg().env });
  try { return Response.json(await readPlayerPushes(id, limit)); }
  catch (e) {
    if (e instanceof WriteFailedError && e.status === 404 && /NOT_FOUND_PLAYER/.test(e.bodySnippet)) return Response.json({ error: "No such player on this backend." }, { status: 404 });
    return Response.json({ error: pushesErrorText(e) }, { status: 502 });
  }
}
