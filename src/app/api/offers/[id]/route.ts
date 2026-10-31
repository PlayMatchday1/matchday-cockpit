// DELETE /api/offers/{id}: discard a DRAFT (backend DELETE admin/offers/campaigns/{id}, 204). Refused
// here for anything that has launched (the backend would 400; a launched offer is paused or ended).
// LANDED means reading it back finds nothing.
// PATCH /api/offers/{id}: an edit. The page sends only what changed (patchBody). The campaign is read
// fresh first: after launch only the backend's EDITABLE_AFTER_LAUNCH fields may go, and anything else
// is refused HERE before any request (the backend would 400 OFFER_CAMPAIGN_FIELD_LOCKED anyway).

import { BODY_KEYS, EDITABLE_AFTER_LAUNCH } from "@/lib/offersModel";
import { CAMPAIGNS, errorText, offersGate, offersWrite, readCampaign, readJson, verdictResponse } from "@/lib/offersServer";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Not found" }, { status: 404 });
  const raw = await readJson(req);
  if (raw instanceof Response) return raw;
  const body = Object.fromEntries(Object.entries(raw).filter(([k]) => BODY_KEYS.has(k)));
  if (Object.keys(body).length === 0) return Response.json({ error: "Nothing changed." }, { status: 400 });
  let current;
  try { current = await readCampaign(id); } catch (e) { return Response.json({ error: errorText(e) }, { status: 502 }); }
  if (!current) return Response.json({ error: "That offer no longer exists. Refresh the list." }, { status: 404 });
  if (current.status === "ENDED") return Response.json({ error: "An ended offer can't change." }, { status: 400 });
  if (current.status !== "DRAFT") {
    const locked = Object.keys(body).filter((k) => !EDITABLE_AFTER_LAUNCH.has(k));
    if (locked.length) return Response.json({ error: `Those parts can't change once it has launched (${locked.join(", ")}). Nothing was sent.` }, { status: 400 });
  }
  const w = await offersWrite({ auth, source: "offers:edit", method: "PATCH", path: `${CAMPAIGNS}/${id}`, body, id, expect: body, before: current });
  return verdictResponse(w);
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Not found" }, { status: 404 });
  let current;
  try { current = await readCampaign(id); } catch (e) { return Response.json({ error: errorText(e) }, { status: 502 }); }
  if (!current) return Response.json({ error: "That offer no longer exists. Refresh the list." }, { status: 404 });
  if (current.status !== "DRAFT") return Response.json({ error: "Only a draft can be deleted. Pause or end a launched offer instead." }, { status: 400 });
  const w = await offersWrite({ auth, source: "offers:delete", method: "DELETE", path: `${CAMPAIGNS}/${id}`, id, expect: {}, expectGone: true, before: current });
  return verdictResponse(w);
}
