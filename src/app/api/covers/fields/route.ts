// GET /api/covers/fields — the backend's fields (id, title, city), for the local cover page's picker.
import { coversGate, coversGet, upstreamMessage } from "@/lib/fieldCoversServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ApiField = { id: number; title: string; city?: { name?: string } | null; deletedAt?: string | null };

export async function GET(req: Request) {
  const g = await coversGate(req, false);
  if (!g.ok) return g.res;
  try {
    const raw = await coversGet<unknown>(g.ctx, "/admin/fields", { limit: 500 });
    const list = (Array.isArray(raw) ? raw : ((raw as { data?: unknown[] })?.data ?? [])) as ApiField[];
    return Response.json({ fields: list.filter((f) => !f.deletedAt).map((f) => ({ id: f.id, title: f.title, city: f.city?.name ?? null })) });
  } catch (e) {
    return Response.json({ error: upstreamMessage(e) }, { status: 502 });
  }
}
