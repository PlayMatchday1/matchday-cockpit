// GET /api/covers/matches/{matchId} — the match's cover, its field's choices, the same-slot upcoming matches.
// PUT /api/covers/matches/{matchId} { coverId: number | null } — set or clear (null = Default). Read back from GET.
import { coversGate, coversGet, coverWrite, idParam, upstreamMessage } from "@/lib/fieldCoversServer";
import type { MatchCover } from "@/lib/fieldCovers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ matchId: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const g = await coversGate(req, false);
  if (!g.ok) return g.res;
  const matchId = idParam((await ctx.params).matchId);
  if (!matchId) return Response.json({ error: "A numeric match id is required." }, { status: 400 });
  try {
    return Response.json(await coversGet<MatchCover>(g.ctx, `/admin/matches/${matchId}/cover`));
  } catch (e) {
    return Response.json({ error: upstreamMessage(e) }, { status: 502 });
  }
}

export async function PUT(req: Request, ctx: Ctx) {
  const g = await coversGate(req, true);
  if (!g.ok) return g.res;
  const matchId = idParam((await ctx.params).matchId);
  const body = (await req.json().catch(() => null)) as { coverId?: unknown } | null;
  const coverId = body?.coverId === null ? null : idParam(String(body?.coverId ?? ""));
  if (!matchId || (body?.coverId !== null && coverId === null)) return Response.json({ error: "Send { coverId: <id> } or { coverId: null } for Default." }, { status: 400 });
  const w = await coverWrite<unknown>(g.ctx, {
    what: "set match cover", method: "PUT", path: `/admin/matches/${matchId}/cover`, body: { coverId }, matchId,
    logBody: { match_id: matchId, cover_id: coverId },
    readBack: () => coversGet<Record<string, unknown>>(g.ctx, `/admin/matches/${matchId}/cover`),
    landed: (after) => ((after as MatchCover).cover?.id ?? null) === coverId,
  });
  return Response.json({ verdict: w.verdict, error: w.error ?? null, match: w.after ?? null, logRecorded: w.logRecorded },
    { status: w.verdict === "LANDED" ? 200 : w.verdict === "FAILED" ? 400 : 502 });
}
