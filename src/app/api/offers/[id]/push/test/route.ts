// POST /api/offers/{id}/push/test, body { title?, body? } (the unsaved text, or the saved text when left
// out): the push, filled in for the signed-in person, to their own phones only. See sendTestPush.

import { PUSH_BODY_MAX, PUSH_TITLE_MAX } from "@/lib/offersPush";
import { offersGate, pushNotFound, pushesAllowed, readJson, sendTestPush } from "@/lib/offersServer";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  if (!pushesAllowed(auth)) return pushNotFound();
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return pushNotFound();
  const raw = await readJson(req);
  if (raw instanceof Response) return raw;
  // Only the text: nothing here can name who it goes to.
  const text: { title?: string; body?: string } = {};
  if (typeof raw.title === "string") text.title = raw.title;
  if (typeof raw.body === "string") text.body = raw.body;
  if ((text.title?.length ?? 0) > PUSH_TITLE_MAX || (text.body?.length ?? 0) > PUSH_BODY_MAX) return Response.json({ error: "The push text is too long." }, { status: 400 });
  return sendTestPush(auth, id, text);
}
