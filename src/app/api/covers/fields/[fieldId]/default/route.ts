// PUT /api/covers/fields/{fieldId}/default — replace the field's Default cover: multipart { file }. That is
// fields.cover_s3_key: every match on Default AND the Field Partners card. Read back from the covers list.
import { coversGate, coversGet, coverWrite, fileFrom, idParam, uploadCoverImage } from "@/lib/fieldCoversServer";
import type { FieldCovers } from "@/lib/fieldCovers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function PUT(req: Request, ctx: { params: Promise<{ fieldId: string }> }) {
  const g = await coversGate(req, true);
  if (!g.ok) return g.res;
  const fieldId = idParam((await ctx.params).fieldId);
  if (!fieldId) return Response.json({ error: "A numeric field id is required." }, { status: 400 });
  const f = await fileFrom(req);
  if (!f.ok) return f.res;
  const up = await uploadCoverImage(g.ctx, fieldId, "cover", f.file);
  if (!up.ok) return Response.json({ verdict: up.verdict, error: up.error }, { status: 502 });
  const w = await coverWrite(g.ctx, {
    what: "replace default", method: "PUT", path: `/admin/fields/${fieldId}/covers/default/image`, body: { fileKey: up.fileKey },
    logBody: { field_id: fieldId, file_key: up.fileKey },
    readBack: () => coversGet<Record<string, unknown>>(g.ctx, `/admin/fields/${fieldId}/covers`),
    landed: (after) => ((after as FieldCovers).default?.url ?? "").endsWith(up.fileKey),
  });
  return Response.json({ verdict: w.verdict, error: w.error ?? null, covers: w.after ?? null, logRecorded: w.logRecorded },
    { status: w.verdict === "LANDED" ? 200 : w.verdict === "FAILED" ? 400 : 502 });
}
