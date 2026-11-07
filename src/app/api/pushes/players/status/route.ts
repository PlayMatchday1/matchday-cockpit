// POST /api/pushes/players/status, body { playerIds, kind }: this week's count and whether each will be skipped, for the
// push count tags (POST /admin/push-notifications/players/status). A read the backend takes as a POST.

import { offersGate, readJson } from "@/lib/offersServer";
import { pushesErrorText, readPlayerStatus } from "@/lib/pushesServer";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const ids = Array.isArray(body.playerIds) ? (body.playerIds as unknown[]).filter((x): x is number => Number.isInteger(x) && (x as number) > 0) : [];
  if (ids.length === 0) return Response.json({ weeklyLimit: null, players: [], notFound: [] });
  if (ids.length > 20000) return Response.json({ error: "Up to 20,000 players at once." }, { status: 400 });
  const kind = body.kind === "OFFER" ? "OFFER" : "MESSAGE";
  try { return Response.json(await readPlayerStatus(auth, [...new Set(ids)], kind)); }
  catch (e) { return Response.json({ error: pushesErrorText(e) }, { status: 502 }); }
}
