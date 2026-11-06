// POST /api/audiences/count, body { audience, holdoutPercent? }: how many match, allow pushes, are held back and will
// be sent (POST /admin/audiences/count). A read the backend takes as a POST. Shared by pushes and offers.

import type { ContractAudience } from "@/lib/audienceModel";
import { offersGate, readJson } from "@/lib/offersServer";
import { pushesErrorText, readCount } from "@/lib/pushesServer";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const raw = await readJson(req);
  if (raw instanceof Response) return raw;
  const a = raw.audience as ContractAudience | undefined;
  if (!a || (a.mode !== "FILTERS" && a.mode !== "PLAYERS")) return Response.json({ error: "Send an audience." }, { status: 400 });
  const hp = typeof raw.holdoutPercent === "number" ? raw.holdoutPercent : undefined;
  try { return Response.json(await readCount(auth, a, hp)); }
  catch (e) { return Response.json({ error: pushesErrorText(e) }, { status: 502 }); }
}
