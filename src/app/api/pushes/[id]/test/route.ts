// POST /api/pushes/:id/test, body { title, body, to? }: a test to one player's phones (to: an ID or email; empty is the
// signed-in person), with the text as typed. Nothing is saved and nothing is read back; the answer is how many phones took it (SENT or PARTIAL).

import { PUSH_BODY_MAX, PUSH_TITLE_MAX } from "@/lib/offersPush";
import { offersGate, readJson, testTargetOf } from "@/lib/offersServer";
import { sendTestPush } from "@/lib/pushesServer";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Not found" }, { status: 404 });
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!title || !text) return Response.json({ error: "Write a title and a message first." }, { status: 400 });
  if (title.length > PUSH_TITLE_MAX || text.length > PUSH_BODY_MAX) return Response.json({ error: "The push is too long to send." }, { status: 400 });
  const to = testTargetOf(body.to);
  if ("error" in to) return Response.json({ error: to.error }, { status: 400 });
  return sendTestPush(auth, id, { title, body: text }, to);
}
