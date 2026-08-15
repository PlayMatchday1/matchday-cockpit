// Env-EXPLICIT roster read + single-op execute. The env is in the path and passed
// to the guarded client per call. GET reads the roster LIVE (never the synced
// table). POST executes ONE planned operation — the path is built SERVER-SIDE from
// {kind} + ids (the client never supplies a raw path), and the guarded client's
// host allowlist, field deny-list (incl password), endpoint deny-list and
// single-shot no-retry all apply. There is no bulk endpoint: the screen fires these
// one at a time.

import { randomUUID } from "node:crypto";
import { authenticateAdmin } from "@/lib/adminAuth";
import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth"; // GET is a Match Ops READ (Part D round 2); POST stays admin + EDIT MATCHES
import { apiGet, apiWrite, AmbiguousWriteError, WriteFailedError, DeniedFieldError, DeniedEndpointError, ProductionWriteBoltedError, StageHostGuardError, StageConfigError, NotAuthorizedError, type MatchdayEnv } from "@/lib/matchdayStageApi";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { rosterRowCounts } from "@/lib/gamedayModel";
import type { Change } from "@/lib/changeLogModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const isEnv = (x: string): x is MatchdayEnv => x === "staging" || x === "production";
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

type RosterShape = { isCancelled?: boolean; canceledAt?: string | null; refunded?: boolean; paidStatus?: string | null };
type Row = { id: number; userId: number; team: number; playerNumber: number; promocodeId?: number | null; isCancelled?: boolean; refunded?: boolean; user?: { firstName?: string; lastName?: string; isFakePlayer?: boolean; phoneNumber?: string | null } };

export async function GET(req: Request, ctx: { params: Promise<{ env: string; matchId: string }> }) {
  const auth = await authenticateMatchOpsRead(req);
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
    // THE POPULATION _count.players COUNTS — cancelled, refunded AND paidStatus "WAITING" are all
    // excluded. The old filter dropped only cancelled/refunded, which left every unsettled sign-up
    // in the list: on production 17516 that meant 36 rendered rows against an authoritative 18, and
    // one player's retried checkout appeared 27 times. Across the last 8 weeks 64% of matches had
    // at least 3 extra rows (worst: 22 counted, 59 rendered).
    const allRows = (Array.isArray(playersRaw) ? playersRaw : (playersRaw.data ?? []));
    const hiddenRows = allRows.filter((p) => !rosterRowCounts(p as RosterShape));
    const players = allRows
      .filter((p) => rosterRowCounts(p as RosterShape))
      .map((p) => ({
        umId: p.id, playerId: p.userId, team: p.team, playerNumber: p.playerNumber,
        name: [p.user?.firstName, p.user?.lastName].filter(Boolean).join(" ").trim() || `Player ${p.userId}`,
        // PHONE — DISPLAY ONLY, and it goes no further than the screen. The panel shows it so an
        // operator can reach a player without leaving for the CRM. It is carried on p.user as
        // `phoneNumber` in E.164; measured on production it is present on 239/239 REAL players
        // across 49 matches (the rows without one are fake players, which have no phone at all).
        //
        // IT MUST NEVER REACH change_log. The standing rule is last-4 via phoneLast4(), and showing
        // the full number on screen does not relax it — the log has different access rules and a
        // longer life than the panel. The POST below builds its `changes` from names and spot
        // numbers only; scripts/roster-edit-model-test.ts asserts no logged payload can carry a
        // phone, and mutates the payload to prove that assertion can fail.
        phone: typeof p.user?.phoneNumber === "string" && p.user.phoneNumber.trim() !== "" ? p.user.phoneNumber : null,
        fake: !!p.user?.isFakePlayer,
        // WHO CAME IN ON A PROMO. Same join the uses panel uses (promocode_id on the user-match
        // row) — no new data path. The CODE NAME is resolved below, because "promo" tells you
        // nothing and "TOMBALL" tells you half a team arrived on one code.
        promocodeId: (p as { promocodeId?: number | null }).promocodeId ?? null,
      }));
    const teamsRaw = (match.teams as Record<string, unknown>[]) ?? [];
    const teams = teamsRaw.map((t) => ({ id: t.id as number, teamNumber: t.teamNumber as number, name: (t.name as string) ?? `Team ${t.teamNumber}`, locked: !!t.locked }))
      .sort((a, b) => a.teamNumber - b.teamNumber);
    const teamN = teams.length || 2;
    const perTeam = teamN > 0 ? Math.round((num(match.maxPlayerCount) ?? 0) / teamN) || 0 : 0;
    // Resolve the distinct promo ids to their CODE names. One call per distinct code on this
    // match — typically 0 or 1, never per row.
    const promoIds = [...new Set(players.map((p) => p.promocodeId).filter((x): x is number => x != null))];
    const promoCodes: Record<number, string> = {};
    await Promise.all(promoIds.map(async (pid) => {
      try {
        const d = await apiGet<Record<string, unknown>>(env, `/admin/promocodes/${pid}`);
        if (typeof d.code === "string") promoCodes[pid] = d.code;
      } catch { /* an unresolvable code still shows as a chip, by id */ }
    }));
    const withCode = players.map((p) => ({ ...p, promoCode: p.promocodeId != null ? (promoCodes[p.promocodeId] ?? `#${p.promocodeId}`) : null }));

    return Response.json({
      matchId: Number(matchId), name: (match.name as string) ?? "", teams, players: withCode,
      // once per match: how many spots came in on a code. A 100%-off code filling a roster is
      // revenue that never arrived, and that should be visible without opening Promo Codes.
      promo: { spots: withCode.filter((p) => p.promocodeId != null).length, codes: Object.values(promoCodes) },
      shape: { teamN, perTeam }, maxPlayerCount: num(match.maxPlayerCount),
      // authoritative occupancy (real + fake) — the count the rest of the app uses; the
      // roster headline reads THIS, not players.length (which double-counts duplicate rows).
      occupancy: num((match._count as Record<string, unknown> | undefined)?.players),
      // NOT dropped silently. A 20-deep repeat from one player is a payment failure and the panel
      // says so; only the noise is removed, never the signal that it happened.
      hidden: {
        total: hiddenRows.length,
        cancelled: hiddenRows.filter((p) => (p as RosterShape).isCancelled === true || (p as RosterShape).canceledAt != null).length,
        unpaid: hiddenRows.filter((p) => (p as RosterShape).paidStatus === "WAITING").length,
        refunded: hiddenRows.filter((p) => (p as RosterShape).refunded === true).length,
      },
    });
  } catch (e) { return errToResponse(e); }
}

export async function POST(req: Request, ctx: { params: Promise<{ env: string; matchId: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env, matchId } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  if (!/^\d+$/.test(matchId)) return Response.json({ error: "matchId must be numeric" }, { status: 400 });
  const op = (await req.json().catch(() => null)) as { kind?: string; playerId?: number; userMatchId?: number; teamId?: number; team?: number; playerNumber?: number; totalFakes?: number; fields?: Record<string, unknown>; saveId?: string; source?: string; matchName?: string } | null;
  if (!op || typeof op.kind !== "string") return Response.json({ error: "op {kind} required" }, { status: 400 });

  // EDIT MATCHES check — before ANY MatchDay read or write (the per-kind read-back
  // below is a GET), so a read-only user produces zero network calls.
  if (!auth.canEditMatches) {
    console.warn(`[edit-matches] 403: ${auth.email} attempted roster ${op.kind} on match ${matchId} without EDIT MATCHES`);
    return Response.json({ error: "You have read-only Match Ops access. EDIT MATCHES is required to change rosters." }, { status: 403 });
  }
  const actor = { canEditMatches: auth.canEditMatches, email: auth.email, userId: auth.appUserId };

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

  // Per-kind read-back + descriptive changes so EVERY roster write is logged with a
  // correct outcome (remove — the most consequential write — included). The resource
  // read is the players list (player ops), the team (teams), or the match (shape).
  const readPlayers = async (): Promise<Record<string, unknown>> => { const r = await apiGet<Row[] | { data?: Row[] }>(env, `/admin/matches/${M}/players`).catch(() => []); return { players: Array.isArray(r) ? r : (r.data ?? []) }; };
  const readMatch = async (): Promise<Record<string, unknown>> => { const m = await apiGet<Record<string, unknown>>(env, `/admin/matches/${M}`).catch(() => ({} as Record<string, unknown>)); return { match: m, teams: (m.teams as unknown[]) ?? [] }; };
  const plOf = (r: Record<string, unknown>) => (r.players as Row[]) ?? [];
  const nameOf = (p?: Row) => p ? ([p.user?.firstName, p.user?.lastName].filter(Boolean).join(" ").trim() || `user-match ${p.id}`) : null;
  const fieldsChanges = (before: Record<string, unknown>, fields: Record<string, unknown>, kind: "teams" | "shape"): Change[] => {
    const src = kind === "teams" ? ((before.teams as { id: number }[]) ?? []).find((t) => t.id === op.teamId) as Record<string, unknown> | undefined : (before.match as Record<string, unknown>);
    const lbl: Record<string, string> = { name: "Team name", locked: "Locked", teamNumbers: "Teams", maxPlayerCount: "Capacity", maxTeamSize2Team: "Total as 2 teams", maxTeamSize4Team: "Total as 4 teams" };
    return Object.keys(fields).map((k) => ({ key: k, field: lbl[k] ?? k, before: (src?.[k] as unknown) ?? null, after: fields[k] }));
  };

  let readResource: () => Promise<Record<string, unknown>>;
  let applied: (b: Record<string, unknown>, a: Record<string, unknown>) => boolean;
  let changes: Change[] = [];
  let preName: string | null = op.matchName ?? null;
  if (op.kind === "teams" || op.kind === "shape") {
    readResource = readMatch;
    const before = await readMatch(); // read once for change labels + name (reused below)
    preName = op.matchName ?? ((before.match as Record<string, unknown>)?.name as string) ?? null;
    changes = fieldsChanges(before, op.fields ?? {}, op.kind);
    applied = op.kind === "teams"
      ? (_b, a) => { const t = ((a.teams as { id: number }[]) ?? []).find((x) => x.id === op.teamId) as Record<string, unknown> | undefined; const f = op.fields ?? {}; return !!t && Object.keys(f).every((k) => JSON.stringify(t[k]) === JSON.stringify(f[k])); }
      : (_b, a) => { const f = op.fields ?? {}; return f.maxPlayerCount === undefined || (a.match as Record<string, unknown>)?.maxPlayerCount === f.maxPlayerCount; };
  } else {
    readResource = readPlayers;
    const before = await readPlayers();
    const mover = plOf(before).find((p) => p.id === op.userMatchId);
    changes =
      op.kind === "add" ? [{ key: "add", field: "Add player", before: "—", after: `team ${op.team} #${op.playerNumber}` }]
      : op.kind === "add-fake" ? [{ key: "add-fake", field: "Add fake player", before: "—", after: `team ${op.team} #${op.playerNumber}` }]
      : op.kind === "bulk-fake" ? [{ key: "bulk-fake", field: "Add fake players", before: "—", after: `${op.totalFakes} fakes` }]
      : op.kind === "move" ? [{ key: "move", field: "Move", before: mover ? `team ${mover.team} #${mover.playerNumber}` : `user-match ${op.userMatchId}`, after: `team ${op.team} #${op.playerNumber}` }]
      : op.kind === "remove" ? [{ key: "remove", field: "Remove from match", before: nameOf(mover) ?? `user-match ${op.userMatchId}`, after: "—" }]
      : [{ key: "fake", field: "Fake flag", before: plOf(before).find((p) => p.userId === op.playerId)?.user?.isFakePlayer ? "on" : "off", after: plOf(before).find((p) => p.userId === op.playerId)?.user?.isFakePlayer ? "off" : "on" }];
    applied =
      op.kind === "add" ? (_b, a) => plOf(a).some((p) => p.userId === op.playerId)
      : op.kind === "add-fake" || op.kind === "bulk-fake" ? (b, a) => plOf(a).length > plOf(b).length
      : op.kind === "move" ? (_b, a) => plOf(a).some((p) => p.id === op.userMatchId && p.team === op.team && p.playerNumber === op.playerNumber)
      : op.kind === "remove" ? (_b, a) => !plOf(a).some((p) => p.id === op.userMatchId)
      : (b, a) => (plOf(b).find((p) => p.userId === op.playerId)?.user?.isFakePlayer) !== (plOf(a).find((p) => p.userId === op.playerId)?.user?.isFakePlayer);
  }

  try {
    const { result, error, outcome, logged } = await recordWrite(
      {
        env, source: op.source || "Roster", actorName: auth.email, actorEmail: auth.email,
        saveId: op.saveId || randomUUID(), matchId: Number(M), matchName: preName,
        method, path, body: body ?? {}, keys: [], label: (k) => k, applied, changes,
      },
      { readResource, write: () => apiWrite(env, method, path, body, actor), now: () => new Date().toISOString() },
      supabaseLogStore(),
    );
    if (error) return errToResponse(error);
    return Response.json({ ok: true, result, outcome, logRecorded: logged });
  } catch (e) { return errToResponse(e); }
}

function errToResponse(e: unknown): Response {
  if (e instanceof NotAuthorizedError) return Response.json({ error: e.message }, { status: 403 });
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
