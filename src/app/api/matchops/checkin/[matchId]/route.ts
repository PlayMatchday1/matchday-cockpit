// Phase 26 — Manager Check-In. GET the roster + marks, POST a mark, DELETE a mark, POST a move.
//
// MARKS ARE CLUBHOUSE-ONLY IN THIS PHASE. Part 0 proved the attendance field exists on the
// user-match (`userStatus`: NONE / ON_TIME / LATE / NO_SHOW / CANCEL_W_IN_SOME_HOURS) but found NO
// admin write path for it — Retool, the reference implementation, only ever reads it. So a mark is
// stored in match_checkin_marks and the page says so. Nothing is sent to MatchDay here. See
// migration 0121 for why a future push must NOT be wired to the per-tap sync.
//
// MOVES ARE LIVE. `POST /admin/user-matches { userMatchId, team, playerNumber }` is proven and
// already used by the roster screen, verified by re-reading the roster. It never touches
// teamNumbers, so the write-only partial-array hazard does not arise.
//
// A SWAP IS TWO WRITES AND THERE IS NO TRANSACTION. Each step is performed and re-read on its own,
// and if the second fails we STOP — we do NOT auto-revert, because a revert is a third write that
// can also fail and would leave the manager unable to tell what is true. The response reports
// LANDED / FAILED / NOT APPLIED / UNKNOWN PER CALL and returns the live state of both spots.

import { randomUUID } from "node:crypto";
import { authenticateMatchOpsRead, assertMatchInScope } from "@/lib/matchOpsAuth";
import { makeServerClient } from "@/lib/supabaseServer";
import { apiGet, apiWrite, AmbiguousWriteError, WriteFailedError, NotAuthorizedError } from "@/lib/matchdayStageApi";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { strikeValueFor, type MarkStatus } from "@/lib/checkinModel";
import { rosterRowCounts } from "@/lib/gamedayModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ENV = "production" as const;
const STATUSES: MarkStatus[] = ["ok", "late", "no_show"];
const isStatus = (s: unknown): s is MarkStatus => typeof s === "string" && (STATUSES as string[]).includes(s);

type Row = Record<string, unknown>;
const num = (v: unknown) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

// THE SAME POPULATION _count.players COUNTS. This previously filtered cancelled + refunded only,
// which is the incomplete rule that made the match panel render 36 rows against an authoritative 18
// — and here it was worse than cosmetic: a manager at a touchline would have been handed 38 people
// to mark on an 18-player match, most of them the same name repeated (one unsettled checkout leaves
// a row per retry). rosterRowCounts is the single predicate; do not re-derive it.
const isLive = (p: Row) => rosterRowCounts(p as { isCancelled?: boolean; canceledAt?: string | null; refunded?: boolean; paidStatus?: string | null });

function playerOut(p: Row) {
  const u = (p.user as Row | undefined) ?? {};
  return {
    userMatchId: num(p.id) ?? 0,
    playerId: num(p.userId) ?? 0,
    // Names live under p.user, never on p directly.
    fullName: [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || `Player ${num(p.userId) ?? "?"}`,
    team: num(p.team),
    playerNumber: num(p.playerNumber),
    avatar: (u.avatar as string | null) ?? null,
    userType: (p.userType as string | null) ?? null, // PLAYER | ADDITIONAL_SPOT | GUEST
  };
}

async function readMatch(matchId: string) {
  const [m, praw] = await Promise.all([
    apiGet<Row>(ENV, `/admin/matches/${matchId}`),
    apiGet<Row[] | { data?: Row[] }>(ENV, `/admin/matches/${matchId}/players`).catch(() => [] as Row[]),
  ]);
  const players = (Array.isArray(praw) ? praw : (praw?.data ?? [])).filter(isLive);
  return { m, players };
}

export async function GET(req: Request, ctx: { params: Promise<{ matchId: string }> }) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { matchId } = await ctx.params;

  // THE BOUNDARY ON THE ID ITSELF — filtering a list is not authorisation. See assertMatchInScope.
  {
    const scope = await assertMatchInScope(auth.supabase, auth.confinedCity, matchId);
    if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status });
  }
  if (!/^\d+$/.test(matchId)) return Response.json({ error: "matchId must be numeric" }, { status: 400 });

  try {
    const { m, players } = await readMatch(matchId);
    const sb = makeServerClient();
    const [marks, result] = await Promise.all([
      sb.from("match_checkin_marks").select("player_id,status,strike_value,pushed_at,push_error").eq("match_id", Number(matchId)),
      sb.from("match_checkin_result").select("winning_team,team_placing").eq("match_id", Number(matchId)).maybeSingle(),
    ]);
    const teams = ((m.teams as Row[]) ?? []).map((t) => ({
      teamNumber: num(t.teamNumber) ?? 0, name: (t.name as string) ?? `Team ${num(t.teamNumber)}`, id: num(t.id),
    })).sort((a, b) => a.teamNumber - b.teamNumber);

    return Response.json({
      match: {
        id: Number(matchId), name: (m.name as string) ?? "", fieldTitle: ((m.field as Row | undefined)?.title as string) ?? null,
        startDate: (m.startDate as string) ?? null,
        cityName: (((m.field as Row | undefined)?.city as Row | undefined)?.name as string) ?? null,
        // The TOTAL fields — the client divides by team count. Never a hardcoded 9 or 10.
        maxPlayerCount: num(m.maxPlayerCount), maxTeamSize2Team: num(m.maxTeamSize2Team), maxTeamSize4Team: num(m.maxTeamSize4Team),
        isCancelled: m.isCancelled === true,
      },
      teams,
      players: players.map(playerOut),
      marks: (marks.data ?? []).map((r) => ({
        playerId: Number(r.player_id), status: r.status as MarkStatus,
        strikeValue: Number(r.strike_value), pushed: !!r.pushed_at, pushError: (r.push_error as string) ?? null,
      })),
      result: result.data ? { winningTeam: result.data.winning_team, placing: result.data.team_placing } : null,
      // Stated on every response so the page can never imply otherwise.
      pushEnabled: false,
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ matchId: string }> }) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { matchId } = await ctx.params;

  // THE BOUNDARY ON THE ID ITSELF — filtering a list is not authorisation. See assertMatchInScope.
  {
    const scope = await assertMatchInScope(auth.supabase, auth.confinedCity, matchId);
    if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status });
  }
  if (!/^\d+$/.test(matchId)) return Response.json({ error: "matchId must be numeric" }, { status: 400 });
  const body = (await req.json().catch(() => null)) as
    { kind?: "mark" | "move" | "result"; playerId?: number; status?: string;
      steps?: Array<{ userMatchId: number; team: number; playerNumber: number }>;
      winningTeam?: number | null; placing?: unknown; saveId?: string } | null;
  const sb = makeServerClient();
  const mid = Number(matchId);

  // ── MARK — Clubhouse only. Upsert on the PK, so a retried tap can never double-count. ──
  if (body?.kind === "mark") {
    const playerId = Number(body.playerId);
    if (!Number.isFinite(playerId)) return Response.json({ error: "playerId required" }, { status: 400 });
    if (!isStatus(body.status)) return Response.json({ error: "status must be ok | late | no_show" }, { status: 400 });
    const strikeValue = strikeValueFor(body.status);
    const { error } = await sb.from("match_checkin_marks")
      .upsert({ match_id: mid, player_id: playerId, status: body.status, strike_value: strikeValue, marked_by: auth.email, marked_at: new Date().toISOString() },
        { onConflict: "match_id,player_id" });
    if (error) return Response.json({ error: error.message }, { status: 500 });
    // change_log gets match_id, player_id and status — NEVER the player's name or phone.
    await logLocal(auth.email, mid, `mark player ${playerId}`, [{ key: "status", field: `Check-in · player ${playerId}`, before: null, after: `${body.status} (+${strikeValue})` }]);
    return Response.json({ ok: true, playerId, status: body.status, strikeValue, pushed: false });
  }

  // ── RESULT / WINNER — Clubhouse only (Part 0 q8: no winner or placing field exists). ──
  if (body?.kind === "result") {
    const { error } = await sb.from("match_checkin_result")
      .upsert({ match_id: mid, winning_team: body.winningTeam ?? null, team_placing: (body.placing ?? null) as never, set_by: auth.email, set_at: new Date().toISOString() },
        { onConflict: "match_id" });
    if (error) return Response.json({ error: error.message }, { status: 500 });
    await logLocal(auth.email, mid, "match result", [{ key: "winner", field: "Winner", before: null, after: String(body.winningTeam ?? "—") }]);
    return Response.json({ ok: true, winningTeam: body.winningTeam ?? null, pushed: false });
  }

  // ── MOVE — LIVE, one write at a time, re-read after each, STOP on failure. ──
  if (body?.kind === "move") {
    const steps = Array.isArray(body.steps) ? body.steps : [];
    if (steps.length === 0 || steps.length > 2) return Response.json({ error: "move needs 1 step (fill) or 2 (swap)" }, { status: 400 });
    const actor = { canEditMatches: auth.canEditMatches, email: auth.email, userId: auth.appUserId };
    if (!auth.canEditMatches) {
      return Response.json({ error: "You have read-only Match Ops access. EDIT MATCHES is required to move players." }, { status: 403 });
    }

    const results: Array<{ step: number; userMatchId: number; team: number; playerNumber: number; outcome: string }> = [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      let outcome = "UNKNOWN";
      try {
        const { outcome: o, error } = await recordWrite(
          {
            env: ENV, source: "Check-in · move", actorName: auth.email, actorEmail: auth.email,
            saveId: `${body.saveId || randomUUID()}-${i}`, matchId: mid, matchName: null,
            method: "POST", path: `/admin/user-matches`,
            body: { userMatchId: s.userMatchId, team: s.team, playerNumber: s.playerNumber },
            keys: [], label: (k) => k,
            changes: [{ key: "move", field: `user-match ${s.userMatchId}`, before: "—", after: `team ${s.team} #${s.playerNumber}` }],
            // The read-back IS the verdict: the roster must show this player on that spot.
            applied: (_b, a) => ((a.players as Row[]) ?? []).some((p) => num(p.id) === s.userMatchId && num(p.team) === s.team && num(p.playerNumber) === s.playerNumber),
          },
          {
            readResource: async () => {
              const r = await apiGet<Row[] | { data?: Row[] }>(ENV, `/admin/matches/${matchId}/players`).catch(() => [] as Row[]);
              return { players: Array.isArray(r) ? r : (r?.data ?? []) };
            },
            write: () => apiWrite(ENV, "POST", `/admin/user-matches`, { userMatchId: s.userMatchId, team: s.team, playerNumber: s.playerNumber }, actor),
            now: () => new Date().toISOString(),
          },
          supabaseLogStore(),
        );
        outcome = error ? (error instanceof AmbiguousWriteError ? "UNKNOWN" : "FAILED")
          : o === "landed" ? "LANDED" : o === "notapplied" ? "NOT APPLIED" : o === "failed" ? "FAILED" : "UNKNOWN";
      } catch (e) {
        outcome = e instanceof AmbiguousWriteError ? "UNKNOWN" : "FAILED";
      }
      results.push({ step: i + 1, ...s, outcome });
      // STOP. Do not attempt the second half of a swap, and do NOT revert the first — a revert is
      // a third write that can also fail, and then nobody can tell what is true.
      if (outcome !== "LANDED") break;
    }

    // Always return the LIVE state of the affected spots so the manager sees what is actually true
    // rather than what we hoped happened.
    const { players } = await readMatch(matchId).catch(() => ({ players: [] as Row[], m: {} as Row }));
    const touched = steps.map((s) => ({
      team: s.team, playerNumber: s.playerNumber,
      occupiedBy: players.filter(isLive).map(playerOut).find((p) => p.team === s.team && p.playerNumber === s.playerNumber) ?? null,
    }));
    const allLanded = results.length === steps.length && results.every((r) => r.outcome === "LANDED");
    return Response.json({
      ok: allLanded, isSwap: steps.length === 2, results, spots: touched,
      halfApplied: steps.length === 2 && results.length >= 1 && results[0].outcome === "LANDED" && !allLanded,
    }, { status: allLanded ? 200 : 207 });
  }

  return Response.json({ error: "unknown kind" }, { status: 400 });
}

// Clearing a mark DELETES the row — absence means unmarked, which is not a status value.
export async function DELETE(req: Request, ctx: { params: Promise<{ matchId: string }> }) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { matchId } = await ctx.params;

  // THE BOUNDARY ON THE ID ITSELF — filtering a list is not authorisation. See assertMatchInScope.
  {
    const scope = await assertMatchInScope(auth.supabase, auth.confinedCity, matchId);
    if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status });
  }
  if (!/^\d+$/.test(matchId)) return Response.json({ error: "matchId must be numeric" }, { status: 400 });
  const playerId = Number(new URL(req.url).searchParams.get("playerId"));
  if (!Number.isFinite(playerId)) return Response.json({ error: "playerId required" }, { status: 400 });
  const sb = makeServerClient();
  const { error } = await sb.from("match_checkin_marks").delete().eq("match_id", Number(matchId)).eq("player_id", playerId);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  await logLocal(auth.email, Number(matchId), `clear player ${playerId}`, [{ key: "status", field: `Check-in · player ${playerId}`, before: "marked", after: "cleared" }]);
  return Response.json({ ok: true, playerId, cleared: true });
}

// A Clubhouse-only write still belongs in change_log, but it fires NO MatchDay request — so it goes
// in directly rather than through recordWrite's read/write/read cycle, which would have nothing to
// read. Never a name, never a phone.
async function logLocal(email: string, matchId: number, what: string, changes: Array<{ key: string; field: string; before: unknown; after: unknown }>) {
  try {
    await supabaseLogStore().insert({
      saveId: randomUUID(), at: new Date().toISOString(), actorName: email, actorEmail: email,
      source: "Check-in", env: ENV, matchId, matchName: null,
      method: "LOCAL", endpoint: `match_checkin_marks · ${what}`, body: {}, outcome: "landed",
      serverSaid: null, changes,
    });
  } catch { /* logging must never fail the write it records */ }
}

export function errShape(e: unknown) {
  if (e instanceof NotAuthorizedError) return 403;
  if (e instanceof WriteFailedError) return e.status;
  return 500;
}
