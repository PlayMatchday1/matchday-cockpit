// GET /api/offers/push-mode?campaignId=N: whether this environment draws the push controls, and the backend's push
// mode as one campaign's push/reachable reports it (the API has no mode route of its own). Off production the answer
// is always visible; on production it is visible only while the mode is live. Asked by the page after its load, so
// the paced read behind it never holds the list up.

import { errorText, offersGate, readPushVisibility } from "@/lib/offersServer";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const raw = new URL(req.url).searchParams.get("campaignId");
  const id = raw === null ? null : Number(raw);
  if (id !== null && (!Number.isInteger(id) || id <= 0)) return Response.json({ error: "campaignId must be a whole number." }, { status: 400 });
  try { return Response.json(await readPushVisibility(id)); } catch (e) { return Response.json({ error: errorText(e) }, { status: 502 }); }
}
