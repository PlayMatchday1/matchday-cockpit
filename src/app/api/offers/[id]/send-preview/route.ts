// POST /api/offers/{id}/send-preview, body { userIds: number[] } (at most 20; empty = my own account).
// Any status, drafts included. Reported as SENT on a 2xx (see sendPreview in src/lib/offersServer.ts).

import { MAX_TEST_IDS } from "@/lib/offersModel";
import { offersGate, readJson, sendPreview } from "@/lib/offersServer";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Not found" }, { status: 404 });
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const raw = Array.isArray(body.userIds) ? body.userIds : [];
  if (!raw.every((x) => Number.isInteger(x) && (x as number) > 0)) return Response.json({ error: "Player IDs must be whole numbers." }, { status: 400 });
  if (raw.length > MAX_TEST_IDS) return Response.json({ error: `A test goes to ${MAX_TEST_IDS} players at most.` }, { status: 400 });
  return sendPreview(auth, id, raw as number[]);
}
