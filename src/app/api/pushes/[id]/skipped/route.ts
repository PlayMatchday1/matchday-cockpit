// GET /api/pushes/:id/skipped?reason=AT_LIMIT: who a push skips for that reason ("See who";
// GET /admin/push-notifications/messages/:id/skipped). Names and cities only, no contact details.

import { offersGate } from "@/lib/offersServer";
import { SKIP_REASONS, pushesErrorText, readSkipped } from "@/lib/pushesServer";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Not found" }, { status: 404 });
  const reason = new URL(req.url).searchParams.get("reason") ?? "AT_LIMIT";
  if (!(SKIP_REASONS as readonly string[]).includes(reason)) return Response.json({ error: "Unknown reason." }, { status: 400 });
  try { return Response.json(await readSkipped(id, reason as (typeof SKIP_REASONS)[number])); }
  catch (e) { return Response.json({ error: pushesErrorText(e) }, { status: 502 }); }
}
