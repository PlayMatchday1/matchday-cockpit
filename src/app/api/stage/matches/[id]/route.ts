// Admin, STAGING-only match read + rename. GET returns a match's identity + name;
// PUT renames it. The write goes through the guarded staging client
// (matchdayStageApi) so it physically cannot reach production.
//
// The write sends ONLY { name }. PUT /admin/matches/{id} was proven on staging to
// be a PARTIAL update (it whitelist-validates what you send but leaves omitted
// fields untouched — verified: a { name }-only PUT preserved a marker set in
// description). So we never echo startDate/teams/scores/etc.: past matches stay
// editable and no wrongly-sourced field can overwrite anything unintended.

import { authenticateAdmin } from "@/lib/adminAuth";
import { stageGet, stageWrite, AmbiguousWriteError, WriteFailedError, StageHostGuardError, StageConfigError } from "@/lib/matchdayStageApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// The read-only identity we show the admin — enough to be sure it's the right match.
function identity(m: Record<string, unknown>) {
  const field = (m.field ?? {}) as Record<string, unknown>;
  const city = (field.city ?? {}) as Record<string, unknown>;
  return {
    id: m.id, name: m.name, startDate: m.startDate, type: m.type, category: m.category,
    isCancelled: m.isCancelled, fieldTitle: (field.title as string | undefined)?.trim() ?? null,
    cityName: (city.name as string | undefined) ?? null,
  };
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { id } = await ctx.params;
  if (!/^\d+$/.test(id)) return Response.json({ error: "Match id must be numeric" }, { status: 400 });
  try {
    const match = await stageGet<Record<string, unknown>>(`/admin/matches/${id}`);
    return Response.json({ match: identity(match) });
  } catch (e) {
    return errToResponse(e);
  }
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { id } = await ctx.params;
  if (!/^\d+$/.test(id)) return Response.json({ error: "Match id must be numeric" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });
  if (name.length > 200) return Response.json({ error: "name too long" }, { status: 400 });

  try {
    // Partial update — send ONLY the changed field. Omitted fields are left alone.
    await stageWrite("PUT", `/admin/matches/${id}`, { name });
    const after = await stageGet<Record<string, unknown>>(`/admin/matches/${id}`);
    return Response.json({ ok: true, match: identity(after) });
  } catch (e) {
    return errToResponse(e);
  }
}

function errToResponse(e: unknown): Response {
  // Surface the guard / ambiguity distinctly so the operator knows the risk.
  if (e instanceof StageHostGuardError) return Response.json({ error: `Host guard blocked the write: ${e.message}` }, { status: 500 });
  if (e instanceof AmbiguousWriteError) return Response.json({ error: `AMBIGUOUS: ${e.message}`, ambiguous: true }, { status: 502 });
  if (e instanceof WriteFailedError) return Response.json({ error: e.message }, { status: e.status >= 400 && e.status < 600 ? e.status : 400 });
  if (e instanceof StageConfigError) return Response.json({ error: e.message }, { status: 500 });
  return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
}
