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

import { authenticateAdmin } from "@/lib/adminAuth";
import { apiGet, StageHostGuardError, StageConfigError, type MatchdayEnv } from "@/lib/matchdayStageApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const isEnv = (x: string): x is MatchdayEnv => x === "staging" || x === "production";
const PAGE_LIMIT = 100;

type RawCount = { players?: number; fakePlayers?: number };
type Raw = Record<string, unknown> & { _count?: RawCount; field?: Record<string, unknown>; manager?: Record<string, unknown> | null; teams?: Record<string, unknown>[] };

// Only the fields the board needs. No player arrays, no manager email/phone — a name
// is all a triage tile shows.
function trim(m: Raw) {
  const field = (m.field ?? {}) as Record<string, unknown>;
  const city = (field.city ?? {}) as Record<string, unknown>;
  const tz = (city.timeZone ?? {}) as Record<string, unknown>;
  const mgr = m.manager as Record<string, unknown> | null;
  const num = (v: unknown) => (typeof v === "number" ? v : v == null ? null : Number(v));
  return {
    id: m.id as number, name: (m.name as string) ?? "",
    startDate: m.startDate as string, startDateUtc: m.startDateUtc as string,
    isCancelled: !!m.isCancelled, autoCanceledMinutes: num(m.autoCanceledMinutes) ?? 0,
    minPlayerCount: num(m.minPlayerCount) ?? 0, maxPlayerCount: num(m.maxPlayerCount),
    registrationPrice: num(m.registrationPrice), additionalSpotPrice: num(m.additionalSpotPrice),
    fakeSpotLeft36h: num(m.fakeSpotLeft36h) ?? 0, fakeSpotLeft24h: num(m.fakeSpotLeft24h) ?? 0,
    fakeSpotLeft12h: num(m.fakeSpotLeft12h) ?? 0, fakeSpotLeft6h: num(m.fakeSpotLeft6h) ?? 0,
    fakeSpotLeft3h: num(m.fakeSpotLeft3h) ?? 0,
    isAutoBump: !!m.isAutoBump, category: (m.category as string) ?? null, type: (m.type as string) ?? null,
    _count: { players: m._count?.players ?? 0, fakePlayers: m._count?.fakePlayers ?? 0 },
    field: { title: ((field.title as string | undefined) ?? "").trim() || null,
      city: { id: (city.id as number) ?? null, name: (city.name as string) ?? null,
        timeZone: { abbr: ((tz.abbr as string | undefined) ?? "").trim() || null, name: (tz.name as string) ?? null } } },
    manager: mgr ? { firstName: (mgr.firstName as string) ?? "", lastName: (mgr.lastName as string) ?? "" } : null,
    teams: Array.isArray(m.teams) ? m.teams.map((t) => ({ teamNumber: (t.teamNumber as number) ?? null })) : [],
  };
}

export async function GET(req: Request, ctx: { params: Promise<{ env: string }> }) {
  const auth = await authenticateAdmin(req);
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
    return Response.json({ date, env, matches: out.map(trim) });
  } catch (e) {
    if (e instanceof StageHostGuardError) return Response.json({ error: e.message }, { status: 500 });
    if (e instanceof StageConfigError) return Response.json({ error: e.message }, { status: 500 });
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
