// POST /api/audiences/sample, body { audience }: up to 50 of the players who match, most recent first ("See players";
// POST /admin/audiences/sample). Names come as first name and last initial; no email or phone.

import type { ContractAudience } from "@/lib/audienceModel";
import { offersGate, readJson } from "@/lib/offersServer";
import { fixtureOn, pushesErrorText, readSample } from "@/lib/pushesServer";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const raw = await readJson(req);
  if (raw instanceof Response) return raw;
  const a = raw.audience as ContractAudience | undefined;
  if (!a || (a.mode !== "FILTERS" && a.mode !== "PLAYERS")) return Response.json({ error: "Send an audience." }, { status: 400 });
  try { return Response.json({ ...(await readSample(auth, a)), fixture: fixtureOn() }); }
  catch (e) { return Response.json({ error: pushesErrorText(e) }, { status: 502 }); }
}
