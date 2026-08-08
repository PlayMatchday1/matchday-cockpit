// Env-EXPLICIT roster read + single-op execute. The env is in the path and passed
// to the guarded client per call. GET reads the roster LIVE (never the synced
// table). POST executes ONE planned operation — the path is built SERVER-SIDE from
// {kind} + ids (the client never supplies a raw path), and the guarded client's
// host allowlist, field deny-list (incl password), endpoint deny-list and
// single-shot no-retry all apply. There is no bulk endpoint: the screen fires these
// one at a time.

import { authenticateAdmin } from "@/lib/adminAuth";
import { apiGet, apiWrite, AmbiguousWriteError, WriteFailedError, DeniedFieldError, DeniedEndpointError, ProductionWriteBoltedError, StageHostGuardError, StageConfigError, type MatchdayEnv } from "@/lib/matchdayStageApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const isEnv = (x: string): x is MatchdayEnv => x === "staging" || x === "production";
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

type Row = { id: number; userId: number; team: number; playerNumber: number; user?: { firstName?: string; lastName?: string; isFakePlayer?: boolean } };

export async function GET(req: Request, ctx: { params: Promise<{ env: string; matchId: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env, matchId } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  if (!/^\d+$/.test(matchId)) return Response.json({ error: "matchId must be numeric" }, { status: 400 });
  const url = new URL(req.url);
  const q = url.searchParams.get("q");
  try {
    // search-to-add: GET /admin/players?email|id — return id + name only (no PII beyond the name a dropdown needs)
    if (q !== null) {
      const isId = /^\d+$/.test(q.trim());
      const r = await apiGet<{ data?: Record<string, unknown>[] }>(env, `/admin/players`, isId ? { id: q.trim(), limit: 10, page: 1 } : { email: q, limit: 10, page: 1, sortColumn: "createdAt", sortDirection: "desc" });
      const rows = Array.isArray(r) ? r : (r.data ?? []);
      return Response.json({ results: (rows as Record<string, unknown>[]).map((u) => ({ id: u.id as number, name: [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || `User ${u.id}`, isFake: !!u.isFakePlayer })) });
    }
    const [match, playersRaw] = await Promise.all([
      apiGet<Record<string, unknown>>(env, `/admin/matches/${matchId}`),
      apiGet<Row[] | { data?: Row[] }>(env, `/admin/matches/${matchId}/players`),
    ]);
    const players = (Array.isArray(playersRaw) ? playersRaw : (playersRaw.data ?? [])).map((p) => ({
      umId: p.id, playerId: p.userId, team: p.team, playerNumber: p.playerNumber,
      name: [p.user?.firstName, p.user?.lastName].filter(Boolean).join(" ").trim() || `Player ${p.userId}`,
      fake: !!p.user?.isFakePlayer,
    }));
    const teamsRaw = (match.teams as Record<string, unknown>[]) ?? [];
    const teams = teamsRaw.map((t) => ({ id: t.id as number, teamNumber: t.teamNumber as number, name: (t.name as string) ?? `Team ${t.teamNumber}`, locked: !!t.locked }))
      .sort((a, b) => a.teamNumber - b.teamNumber);
    const teamN = teams.length || 2;
    const perTeam = teamN > 0 ? Math.round((num(match.maxPlayerCount) ?? 0) / teamN) || 0 : 0;
    return Response.json({
      matchId: Number(matchId), name: (match.name as string) ?? "", teams, players,
      shape: { teamN, perTeam }, maxPlayerCount: num(match.maxPlayerCount),
    });
  } catch (e) { return errToResponse(e); }
}

export async function POST(req: Request, ctx: { params: Promise<{ env: string; matchId: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env, matchId } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  if (!/^\d+$/.test(matchId)) return Response.json({ error: "matchId must be numeric" }, { status: 400 });
  const op = (await req.json().catch(() => null)) as { kind?: string; playerId?: number; userMatchId?: number; teamId?: number; team?: number; playerNumber?: number; totalFakes?: number; fields?: Record<string, unknown> } | null;
  if (!op || typeof op.kind !== "string") return Response.json({ error: "op {kind} required" }, { status: 400 });

  // Build the request SERVER-SIDE from the op kind — the client never sends a path.
  let method: "POST" | "PUT" | "DELETE" | "PATCH", path: string, body: Record<string, unknown> | undefined;
  const M = matchId;
  switch (op.kind) {
    case "add": method = "POST"; path = `/admin/matches/${M}/players/${op.playerId}`; body = { team: op.team, playerNumber: op.playerNumber }; break;
    case "add-fake": method = "POST"; path = `/admin/matches/${M}/fake-players`; body = { team: op.team, playerNumber: op.playerNumber }; break;
    case "bulk-fake": method = "POST"; path = `/admin/matches/${M}/batch/fake-players`; body = { totalFakes: op.totalFakes }; break;
    case "move": method = "POST"; path = `/admin/user-matches`; body = { userMatchId: op.userMatchId, team: op.team, playerNumber: op.playerNumber }; break;
    case "remove": method = "DELETE"; path = `/admin/matches/user-matches/${op.userMatchId}`; body = undefined; break;
    case "fake": method = "PATCH"; path = `/admin/players/${op.playerId}/fake-player`; body = undefined; break;
    case "teams": method = "PUT"; path = `/admin/teams/${op.teamId}`; body = op.fields ?? {}; break;
    case "shape": method = "PUT"; path = `/admin/matches/${M}`; body = op.fields ?? {}; break;
    default: return Response.json({ error: `unknown op kind ${JSON.stringify(op.kind)}` }, { status: 400 });
  }
  try {
    const result = await apiWrite(env, method, path, body); // guarded: host + deny-lists (incl password) + single-shot
    return Response.json({ ok: true, result });
  } catch (e) { return errToResponse(e); }
}

function errToResponse(e: unknown): Response {
  // AMBIGUOUS is a distinct fact the save UI must not conflate with a clean failure.
  if (e instanceof AmbiguousWriteError) return Response.json({ error: e.message, ambiguous: true }, { status: 502 });
  if (e instanceof ProductionWriteBoltedError) return Response.json({ error: e.message }, { status: 503 });
  if (e instanceof DeniedEndpointError) return Response.json({ error: e.message }, { status: 403 });
  if (e instanceof DeniedFieldError) return Response.json({ error: e.message }, { status: 400 });
  if (e instanceof StageHostGuardError) return Response.json({ error: e.message }, { status: 500 });
  if (e instanceof WriteFailedError) return Response.json({ error: e.message }, { status: e.status >= 400 && e.status < 600 ? e.status : 400 });
  if (e instanceof StageConfigError) return Response.json({ error: e.message }, { status: 500 });
  return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
}
