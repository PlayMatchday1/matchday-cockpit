// POST /api/offers/audience: how many players match right now, and the most it could cost. A read
// the backend takes as a POST; see readAudienceCount in src/lib/offersServer.ts.

import { BODY_KEYS } from "@/lib/offersModel";
import { errorText, offersGate, readAudienceCount, readJson } from "@/lib/offersServer";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const raw = await readJson(req);
  if (raw instanceof Response) return raw;
  const body = Object.fromEntries(Object.entries(raw).filter(([k]) => BODY_KEYS.has(k)));
  try {
    return Response.json(await readAudienceCount(auth, body));
  } catch (e) {
    return Response.json({ error: errorText(e) }, { status: 502 });
  }
}
