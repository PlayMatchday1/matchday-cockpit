// Gameday Ops — the LIVE day board read (Phase 15). Reads matches straight from the
// MatchDay API for one wall-clock day, never the synced Supabase mirror: a stale
// board on a match night is worse than none. Env is in the PATH and passed to the
// guarded client per call (production reads are allowed; the host allowlist still
// applies). GET only — edits go through the existing /matches/{id} PUT.
//
// The API has no city filter worth using here (we need every city for the chips and
// their counts) and no other date filter: the working params are fromDate/toDate
// (YYYY-MM-DD, bounding the WALL-CLOCK date — exactly the operator's "day"),
// sortColumn/sortDirection, page/limit. We over-fetch nothing and page to the end.

import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { apiGet, StageHostGuardError, StageConfigError, type MatchdayEnv } from "@/lib/matchdayStageApi";
// The row shape is SHARED with /api/city/gameday — same board, same rows. See gamedayApiShape.
import { trimMatch, type Raw } from "@/lib/gamedayApiShape";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const isEnv = (x: string): x is MatchdayEnv => x === "staging" || x === "production";
const PAGE_LIMIT = 100;

export async function GET(req: Request, ctx: { params: Promise<{ env: string }> }) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  const date = new URL(req.url).searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ error: "date=YYYY-MM-DD required" }, { status: 400 });

  try {
    const out: Raw[] = [];
    for (let page = 1; page <= 20; page++) { // 20*100 = 2000 hard ceiling; a single day is never near it
      const res = await apiGet<{ data?: Raw[]; totalItems?: number }>(env, `/admin/matches`, {
        fromDate: date, toDate: date, page, limit: PAGE_LIMIT, sortColumn: "startDate", sortDirection: "asc",
      });
      const rows = Array.isArray(res) ? (res as Raw[]) : (res.data ?? []);
      out.push(...rows);
      const total = Array.isArray(res) ? rows.length : (res.totalItems ?? rows.length);
      if (rows.length < PAGE_LIMIT || out.length >= total) break;
    }
    return Response.json({ date, env, matches: out.map(trimMatch) });
  } catch (e) {
    if (e instanceof StageHostGuardError) return Response.json({ error: e.message }, { status: 500 });
    if (e instanceof StageConfigError) return Response.json({ error: e.message }, { status: 500 });
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
