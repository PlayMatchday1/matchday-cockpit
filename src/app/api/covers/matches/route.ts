// PUT /api/covers/matches { matchIds: number[], coverId: number | null } — "Apply to other upcoming matches".
// All-or-nothing on the backend. LANDED only when EVERY match reads back with the cover; one log entry per batch.
import { coversGate, coversGet, coverWrite, idParam } from "@/lib/fieldCoversServer";
import type { MatchCover } from "@/lib/fieldCovers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function PUT(req: Request) {
  const g = await coversGate(req, true);
  if (!g.ok) return g.res;
  const body = (await req.json().catch(() => null)) as { matchIds?: unknown; coverId?: unknown } | null;
  const ids = Array.isArray(body?.matchIds) ? body!.matchIds.map((x) => idParam(String(x))) : [];
  const coverId = body?.coverId === null ? null : idParam(String(body?.coverId ?? ""));
  if (!ids.length || ids.length > 200 || ids.some((x) => x === null) || new Set(ids).size !== ids.length) return Response.json({ error: "Send 1 to 200 distinct match ids." }, { status: 400 });
  if (body?.coverId !== null && coverId === null) return Response.json({ error: "Send a cover id, or null for Default." }, { status: 400 });
  const matchIds = ids as number[];
  const readAll = async () => {
    const rows = await Promise.all(matchIds.map((id) => coversGet<MatchCover>(g.ctx, `/admin/matches/${id}/cover`)));
    return { matches: rows.map((m) => ({ matchId: m.matchId, coverId: m.cover?.id ?? null, coverName: m.cover?.name ?? "Default" })) } as Record<string, unknown>;
  };
  const w = await coverWrite(g.ctx, {
    what: "apply to matches", method: "PUT", path: "/admin/match-covers", body: { matchIds, coverId },
    logBody: { match_ids: matchIds.join(","), cover_id: coverId },
    readBack: readAll,
    landed: (after) => {
      const rows = (after.matches as { matchId: number; coverId: number | null }[]) ?? [];
      return rows.length === matchIds.length && rows.every((r) => r.coverId === coverId);
    },
  });
  return Response.json({ verdict: w.verdict, error: w.error ?? null, readBack: w.after ?? null, logRecorded: w.logRecorded },
    { status: w.verdict === "LANDED" ? 200 : w.verdict === "FAILED" ? 400 : 502 });
}
