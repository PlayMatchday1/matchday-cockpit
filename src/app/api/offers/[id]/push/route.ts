// PUT /api/offers/{id}/push: save the push settings (backend PUT .../push, docs/offer-push.md). Body
// { enabled, title, body, sendLocal }. On a launched offer, saving enabled queues the sends at once: the page
// asks first. LANDED means the campaign the backend returns carries the push as sent.

import { pushProblem } from "@/lib/offersPush";
import { offersGate, pushNotFound, pushesAllowed, readJson, savePush, verdictResponse } from "@/lib/offersServer";

export const dynamic = "force-dynamic";

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  if (!pushesAllowed(auth)) return pushNotFound();
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return pushNotFound();
  const raw = await readJson(req);
  if (raw instanceof Response) return raw;
  if (typeof raw.enabled !== "boolean") return Response.json({ error: "Say whether the push is on." }, { status: 400 });
  const body: Record<string, unknown> = raw.enabled
    ? { enabled: true, title: String(raw.title ?? ""), body: String(raw.body ?? ""), sendLocal: typeof raw.sendLocal === "string" ? raw.sendLocal : null }
    : { enabled: false };
  // The backend checks too ({match} needs a specific match); this catches the rest before a request.
  const problem = raw.enabled ? pushProblem({ enabled: true, title: body.title as string, body: body.body as string, at: body.sendLocal !== null, sendLocal: (body.sendLocal as string) ?? "" }, { title: "", body: "" }, "MATCH") : null;
  if (problem) return Response.json({ error: problem }, { status: 400 });
  return verdictResponse(await savePush(auth, id, body));
}
