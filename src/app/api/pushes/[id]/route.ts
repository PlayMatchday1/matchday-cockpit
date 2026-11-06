// GET /api/pushes/:id (a fresh copy) and PATCH (THE DIFF IS THE REQUEST BODY: the page sends only what changed, and
// only what may still change). Nothing is deleted: an unwanted draft is ended (POST .../end).

import { offersGate, readJson } from "@/lib/offersServer";
import { MESSAGES, pushesErrorText, pushesWrite, readPush, verdictResponse } from "@/lib/pushesServer";
import { PUSH_BODY_KEYS as BODY_KEYS } from "@/lib/pushesModel";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const idOf = async (ctx: Ctx) => { const n = Number((await ctx.params).id); return Number.isInteger(n) && n > 0 ? n : null; };

export async function GET(req: Request, ctx: Ctx) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const id = await idOf(ctx);
  if (id === null) return Response.json({ error: "Not found" }, { status: 404 });
  try {
    const p = await readPush(id);
    return p ? Response.json(p) : Response.json({ error: "That push no longer exists. Refresh the list." }, { status: 404 });
  } catch (e) { return Response.json({ error: pushesErrorText(e) }, { status: 502 }); }
}

export async function PATCH(req: Request, ctx: Ctx) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const id = await idOf(ctx);
  if (id === null) return Response.json({ error: "Not found" }, { status: 404 });
  const raw = await readJson(req);
  if (raw instanceof Response) return raw;
  const body = Object.fromEntries(Object.entries(raw).filter(([k]) => BODY_KEYS.has(k)));
  if (Object.keys(body).length === 0) return Response.json({ error: "Nothing to save." }, { status: 400 });
  let before;
  try { before = (await readPush(id)) ?? undefined; } catch (e) { return Response.json({ error: pushesErrorText(e) }, { status: 502 }); }
  if (!before) return Response.json({ error: "That push no longer exists. Refresh the list." }, { status: 404 });
  return verdictResponse(await pushesWrite({ auth, source: "pushes:edit", method: "PATCH", path: `${MESSAGES}/${id}`, body, id, before }));
}
