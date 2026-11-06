// POST /api/audiences/lookup, body { text }: who the pasted ids, emails and phone numbers are (Exact players, and the
// Send to box; POST /admin/audiences/players/lookup). A read; nothing about the players is logged.

import { MAX_ENTRIES, entriesOf } from "@/lib/audienceModel";
import { offersGate, readJson } from "@/lib/offersServer";
import { pushesErrorText, readLookup } from "@/lib/pushesServer";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const text = typeof body.text === "string" ? body.text : "";
  if (entriesOf(text).length > MAX_ENTRIES) return Response.json({ error: `That's more than ${MAX_ENTRIES.toLocaleString("en-US")} entries.` }, { status: 400 });
  try { return Response.json(await readLookup(auth, text)); }
  catch (e) { return Response.json({ error: pushesErrorText(e) }, { status: 502 }); }
}
