// POST /api/offers/players, body { ids: number[] } (1 to 2000): who those players are, and which ids
// are not players. A read; see readPlayerLookup in src/lib/offersServer.ts.

import { errorText, offersGate, readJson, readPlayerLookup } from "@/lib/offersServer";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (ids.length < 1 || ids.length > 2000 || !ids.every((x) => Number.isInteger(x) && (x as number) > 0)) {
    return Response.json({ error: "Send 1 to 2000 player IDs." }, { status: 400 });
  }
  try {
    return Response.json(await readPlayerLookup(auth, ids as number[]));
  } catch (e) {
    return Response.json({ error: errorText(e) }, { status: 502 });
  }
}
