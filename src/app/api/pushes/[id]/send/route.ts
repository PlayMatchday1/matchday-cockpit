// POST /api/pushes/:id/send: queue it (now, or at its time). One write, never retried; LANDED when the push comes
// back SCHEDULED or SENT. See sendPush in src/lib/pushesServer.ts.

import { offersGate } from "@/lib/offersServer";
import { pushesErrorText, readPush, sendPush, verdictResponse } from "@/lib/pushesServer";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Not found" }, { status: 404 });
  let before;
  try { before = (await readPush(id)) ?? undefined; } catch (e) { return Response.json({ error: pushesErrorText(e) }, { status: 502 }); }
  if (!before) return Response.json({ error: "That push no longer exists. Refresh the list." }, { status: 404 });
  if (before.status !== "DRAFT") return Response.json({ error: "It was already sent or scheduled. Refresh to see its status." }, { status: 400 });
  return verdictResponse(await sendPush(auth, id, before));
}
