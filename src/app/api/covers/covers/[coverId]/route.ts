// /api/covers/covers/{coverId}
//   GET    ?fieldId=  usage: how many upcoming matches use it (fresh, for the remove confirmation)
//   PATCH  { name, fieldId }        rename
//   PUT    multipart { file, fieldId }  replace the image
//   DELETE ?fieldId=  remove: soft delete, every match using it back to Default (one backend transaction)
// fieldId names the field whose list is the read-back.
import { coversGate, coversGet, coverWrite, fileFrom, idParam, upstreamMessage, uploadCoverImage } from "@/lib/fieldCoversServer";
import { coverNameProblem, type FieldCovers } from "@/lib/fieldCovers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ coverId: string }> };
const status = (v: string) => (v === "LANDED" ? 200 : v === "FAILED" ? 400 : 502);
const listOf = (after: Record<string, unknown>) => ((after as FieldCovers).covers ?? []);

export async function GET(req: Request, ctx: Ctx) {
  const g = await coversGate(req, false);
  if (!g.ok) return g.res;
  const coverId = idParam((await ctx.params).coverId);
  if (!coverId) return Response.json({ error: "A numeric cover id is required." }, { status: 400 });
  try {
    return Response.json(await coversGet(g.ctx, `/admin/field-covers/${coverId}/usage`));
  } catch (e) {
    return Response.json({ error: upstreamMessage(e) }, { status: 502 });
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  const g = await coversGate(req, true);
  if (!g.ok) return g.res;
  const coverId = idParam((await ctx.params).coverId);
  const body = (await req.json().catch(() => null)) as { name?: unknown; fieldId?: unknown } | null;
  const fieldId = idParam(String(body?.fieldId ?? ""));
  if (!coverId || !fieldId) return Response.json({ error: "Numeric cover and field ids are required." }, { status: 400 });
  const name = String(body?.name ?? "").replace(/\s+/g, " ").trim();
  let current: FieldCovers;
  try { current = await coversGet<FieldCovers>(g.ctx, `/admin/fields/${fieldId}/covers`); }
  catch (e) { return Response.json({ error: upstreamMessage(e) }, { status: 502 }); }
  const problem = coverNameProblem(name, current.covers.filter((c) => c.id !== coverId).map((c) => c.name));
  if (problem) return Response.json({ error: problem }, { status: 400 });
  const before = current.covers.find((c) => c.id === coverId)?.name ?? null;
  const w = await coverWrite(g.ctx, {
    what: "rename", method: "PATCH", path: `/admin/field-covers/${coverId}`, body: { name },
    logBody: { field_id: fieldId, cover_id: coverId, name_before: before, name },
    readBack: () => coversGet<Record<string, unknown>>(g.ctx, `/admin/fields/${fieldId}/covers`),
    landed: (after) => listOf(after).some((c) => c.id === coverId && c.name === name),
  });
  return Response.json({ verdict: w.verdict, error: w.error ?? null, covers: w.after ?? null, logRecorded: w.logRecorded }, { status: status(w.verdict) });
}

export async function PUT(req: Request, ctx: Ctx) {
  const g = await coversGate(req, true);
  if (!g.ok) return g.res;
  const coverId = idParam((await ctx.params).coverId);
  const f = await fileFrom(req);
  if (!f.ok) return f.res;
  const fieldId = idParam(String(f.form.get("fieldId") ?? ""));
  if (!coverId || !fieldId) return Response.json({ error: "Numeric cover and field ids are required." }, { status: 400 });
  const up = await uploadCoverImage(g.ctx, fieldId, "extraCover", f.file);
  if (!up.ok) return Response.json({ verdict: up.verdict, error: up.error }, { status: 502 });
  const w = await coverWrite(g.ctx, {
    what: "replace image", method: "PUT", path: `/admin/field-covers/${coverId}/image`, body: { fileKey: up.fileKey },
    logBody: { field_id: fieldId, cover_id: coverId, file_key: up.fileKey },
    readBack: () => coversGet<Record<string, unknown>>(g.ctx, `/admin/fields/${fieldId}/covers`),
    landed: (after) => listOf(after).some((c) => c.id === coverId && (c.url ?? "").endsWith(up.fileKey)),
  });
  return Response.json({ verdict: w.verdict, error: w.error ?? null, covers: w.after ?? null, logRecorded: w.logRecorded }, { status: status(w.verdict) });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const g = await coversGate(req, true);
  if (!g.ok) return g.res;
  const coverId = idParam((await ctx.params).coverId);
  const fieldId = idParam(new URL(req.url).searchParams.get("fieldId") ?? "");
  if (!coverId || !fieldId) return Response.json({ error: "Numeric cover and field ids are required." }, { status: 400 });
  const w = await coverWrite<{ upcomingMatchesReset: number; matchesReset: number }>(g.ctx, {
    what: "remove", method: "DELETE", path: `/admin/field-covers/${coverId}`,
    logBody: { field_id: fieldId, cover_id: coverId },
    readBack: () => coversGet<Record<string, unknown>>(g.ctx, `/admin/fields/${fieldId}/covers`),
    landed: (after) => !listOf(after).some((c) => c.id === coverId),
  });
  return Response.json({ verdict: w.verdict, error: w.error ?? null, removed: w.result ?? null, covers: w.after ?? null, logRecorded: w.logRecorded }, { status: status(w.verdict) });
}
