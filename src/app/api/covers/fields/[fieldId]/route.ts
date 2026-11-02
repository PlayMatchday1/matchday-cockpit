// GET  /api/covers/fields/{fieldId} — the field's Default and extra covers, each with its upcoming-match count.
// POST /api/covers/fields/{fieldId} — add an extra cover: multipart { name, file }. Upload, then register; the
//      verdict is the register's, read back from the list (the new id with that name and that file).
import { coversGate, coversGet, coverWrite, fileFrom, idParam, upstreamMessage, uploadCoverImage } from "@/lib/fieldCoversServer";
import { coverNameProblem, type CoverView, type FieldCovers } from "@/lib/fieldCovers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ fieldId: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const g = await coversGate(req, false);
  if (!g.ok) return g.res;
  const fieldId = idParam((await ctx.params).fieldId);
  if (!fieldId) return Response.json({ error: "A numeric field id is required." }, { status: 400 });
  try {
    return Response.json(await coversGet<FieldCovers>(g.ctx, `/admin/fields/${fieldId}/covers`));
  } catch (e) {
    return Response.json({ error: upstreamMessage(e) }, { status: 502 });
  }
}

export async function POST(req: Request, ctx: Ctx) {
  const g = await coversGate(req, true);
  if (!g.ok) return g.res;
  const fieldId = idParam((await ctx.params).fieldId);
  if (!fieldId) return Response.json({ error: "A numeric field id is required." }, { status: 400 });
  const f = await fileFrom(req);
  if (!f.ok) return f.res;
  const name = String(f.form.get("name") ?? "").replace(/\s+/g, " ").trim();
  let current: FieldCovers;
  try { current = await coversGet<FieldCovers>(g.ctx, `/admin/fields/${fieldId}/covers`); }
  catch (e) { return Response.json({ error: upstreamMessage(e) }, { status: 502 }); }
  const problem = coverNameProblem(name, current.covers.map((c) => c.name));
  if (problem) return Response.json({ error: problem }, { status: 400 });

  const up = await uploadCoverImage(g.ctx, fieldId, "extraCover", f.file);
  if (!up.ok) return Response.json({ verdict: up.verdict, error: up.error }, { status: 502 });
  const w = await coverWrite<CoverView>(g.ctx, {
    what: "add", method: "POST", path: `/admin/fields/${fieldId}/covers`, body: { name, fileKey: up.fileKey },
    logBody: { field_id: fieldId, name, file_key: up.fileKey },
    readBack: () => coversGet<Record<string, unknown>>(g.ctx, `/admin/fields/${fieldId}/covers`),
    landed: (after, result) => {
      const id = (result as CoverView | undefined)?.id;
      return ((after as FieldCovers).covers ?? []).some((c) => c.id === id && c.name === name && (c.url ?? "").endsWith(up.fileKey));
    },
  });
  return Response.json({ verdict: w.verdict, error: w.error ?? null, cover: w.result ?? null, covers: w.after ?? null, logRecorded: w.logRecorded },
    { status: w.verdict === "LANDED" ? 200 : w.verdict === "FAILED" ? 400 : 502 });
}
