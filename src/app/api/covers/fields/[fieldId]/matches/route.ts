// GET /api/covers/fields/{fieldId}/matches — the field's matches (id, name, wall-clock start, cover), for the
// local cover page. Reads GET /admin/matches?fieldId[]= on the local backend.
import { coversGate, coversGet, idParam, upstreamMessage } from "@/lib/fieldCoversServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ApiMatch = { id: number; name: string; startDate: string; startDateUtc: string; isCancelled: boolean; fieldId: number; coverId?: number | null; coverUrl?: string | null };

export async function GET(req: Request, ctx: { params: Promise<{ fieldId: string }> }) {
  const g = await coversGate(req, false);
  if (!g.ok) return g.res;
  const fieldId = idParam((await ctx.params).fieldId);
  if (!fieldId) return Response.json({ error: "A numeric field id is required." }, { status: 400 });
  try {
    const raw = await coversGet<{ data?: ApiMatch[] }>(g.ctx, "/admin/matches", { "fieldId[]": fieldId, limit: 200, sortColumn: "startDate", sortDirection: "asc" });
    const rows = (raw.data ?? []).filter((m) => m.fieldId === fieldId);
    return Response.json({
      matches: rows.map((m) => ({ id: m.id, name: m.name, startDate: m.startDate, startDateUtc: m.startDateUtc, isCancelled: m.isCancelled, coverId: m.coverId ?? null, coverUrl: m.coverUrl ?? null })),
    });
  } catch (e) {
    return Response.json({ error: upstreamMessage(e) }, { status: 502 });
  }
}
