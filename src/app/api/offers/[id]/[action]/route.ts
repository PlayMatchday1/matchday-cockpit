// POST /api/offers/{id}/launch | pause | end. Bodyless: no body and no content-type, because the
// backend rejects an empty body sent as application/json. LANDED means the read-back shows the status
// the move was meant to leave (launch: LAUNCHED, pause: PAUSED, end: ENDED).

import { CAMPAIGNS, offersGate, offersWrite, verdictResponse } from "@/lib/offersServer";

export const dynamic = "force-dynamic";

const MOVES = { launch: "LAUNCHED", pause: "PAUSED", end: "ENDED" } as const;

export async function POST(req: Request, ctx: { params: Promise<{ id: string; action: string }> }) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const { id: rawId, action } = await ctx.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0 || !(action in MOVES)) return Response.json({ error: "Not found" }, { status: 404 });
  const status = MOVES[action as keyof typeof MOVES];
  const w = await offersWrite({ auth, source: `offers:${action}`, method: "POST", path: `${CAMPAIGNS}/${id}/${action}`, id, expect: { status } });
  return verdictResponse(w);
}
