// POST /api/offers/{id}/send-to-me: the popup on the signed-in person's own phone, next app open.
// Any status, drafts included. Reported as SENT on a 2xx (see sendToMe in src/lib/offersServer.ts).

import { offersGate, sendToMe } from "@/lib/offersServer";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Not found" }, { status: 404 });
  return sendToMe(auth, id);
}
