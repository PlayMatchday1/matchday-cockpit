// POST /api/offers/players, body { ids: number[] } (1 to MAX_OFFER_PLAYER_IDS, 20,000): who those players
// are, and which ids are not players. A read; see readPlayerLookup in src/lib/offersServer.ts. The page
// sends LOOKUP_BATCH (2,000) at a time to keep each backend read light; the route takes the backend's own max.

import { errorText, offersGate, readJson, readPlayerLookup } from "@/lib/offersServer";
import { MAX_OFFER_PLAYER_IDS } from "@/lib/offersModel";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (ids.length < 1 || ids.length > MAX_OFFER_PLAYER_IDS || !ids.every((x) => Number.isInteger(x) && (x as number) > 0)) {
    return Response.json({ error: `Send 1 to ${MAX_OFFER_PLAYER_IDS.toLocaleString("en-US")} player IDs.` }, { status: 400 });
  }
  try {
    return Response.json(await readPlayerLookup(auth, ids as number[]));
  } catch (e) {
    return Response.json({ error: errorText(e) }, { status: 502 });
  }
}
