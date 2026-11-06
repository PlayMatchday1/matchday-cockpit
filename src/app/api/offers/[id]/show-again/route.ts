// GET /api/offers/{id}/show-again: what pressing Show again would do now ({ allowed, reason, reach, round, lastAt,
// lastByStaffEmail, nextAllowedAt }). POST, body { fromRound }: starts the next popup round, as the signed-in person
// (X-Acting-Staff-Email). LANDED when the campaign the backend returns is one round past fromRound.

import { errorText, offersGate, readJson, readShowAgain, showAgain } from "@/lib/offersServer";

export const dynamic = "force-dynamic";

const idOf = async (ctx: { params: Promise<{ id: string }> }) => { const id = Number((await ctx.params).id); return Number.isInteger(id) && id > 0 ? id : null; };

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const id = await idOf(ctx);
  if (id === null) return Response.json({ error: "Not found" }, { status: 404 });
  try { return Response.json(await readShowAgain(id)); } catch (e) { return Response.json({ error: errorText(e) }, { status: 502 }); }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const id = await idOf(ctx);
  if (id === null) return Response.json({ error: "Not found" }, { status: 404 });
  const raw = await readJson(req);
  if (raw instanceof Response) return raw;
  const fromRound = raw.fromRound;
  if (!Number.isInteger(fromRound) || (fromRound as number) < 1) return Response.json({ error: "Say which round the page is on (fromRound)." }, { status: 400 });
  return showAgain(auth, id, fromRound as number);
}
