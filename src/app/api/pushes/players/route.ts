// POST /api/pushes/players, body { text }: who the pasted ids, emails and phone numbers are (Exact players, shared
// by Push Notifications and Offers). A read; see readTokenLookup in src/lib/pushesServer.ts. Nothing about the
// players is logged.

import { offersGate, readJson } from "@/lib/offersServer";
import { LOOKUP_MAX, pushesErrorText, readTokenLookup } from "@/lib/pushesServer";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const text = typeof body.text === "string" ? body.text : "";
  if (!text.trim()) return Response.json({ players: [], notFound: [] });
  if (text.length > LOOKUP_MAX * 40) return Response.json({ error: `That's more than this page looks up at once (${LOOKUP_MAX.toLocaleString("en-US")} players).` }, { status: 400 });
  try { return Response.json(await readTokenLookup(auth, text)); }
  catch (e) { return Response.json({ error: pushesErrorText(e) }, { status: 502 }); }
}
