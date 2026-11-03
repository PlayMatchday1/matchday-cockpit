/* BRING THE FAKE ROSTER TO A TARGET COUNT. One call from the client, N calls to MatchDay, and a
 * verdict read back off the roster rather than computed from the number we just sent.
 *
 * ── WHY A ROUTE AND NOT A CLIENT LOOP ─────────────────────────────────────────────────────────
 * Reducing a fake count is not one request. There is no endpoint that sets a total (measured — see
 * src/lib/fakeRosterPlan.ts), so it is one DELETE per row. Driving that from the browser would put
 * the plan, the ordering and the partial-failure handling in a component, and would send N writes
 * whose only guard is the one route each happens to pass through. Here it is one authenticated,
 * city-scoped, change-logged operation with a single verdict.
 *
 * ── THE VERDICT IS A RE-READ, ALWAYS ──────────────────────────────────────────────────────────
 * A 2xx does not mean the write landed — an add-fake to a finished match returns 2xx with an id
 * and persists nothing. So the roster is read again at the end and the outcome is decided by the
 * COUNT THAT CAME BACK. `landed` means the roster now holds the target. Anything else is reported
 * as what it is, with both numbers, never as success.
 *
 * ── NOTHING HERE CAN REMOVE A REAL PLAYER ─────────────────────────────────────────────────────
 * Two independent guarantees, because one is a rule and rules get edited:
 *   1. planFakeRoster only ever puts `rosterRowIsFake` rows in `removes`.
 *   2. This route re-checks every id against the fake set it read, immediately before deleting,
 *      and abandons the whole operation if one is not there.
 * The second is not redundant: it is what holds if the planner is changed by someone who has not
 * read this comment.
 */

import { randomUUID } from "node:crypto";
import { authenticateCapability } from "@/lib/capabilityAuth";
import { assertMatchInScope } from "@/lib/matchOpsAuth";
import {
  apiGet, apiWrite, AmbiguousWriteError, WriteFailedError, DeniedFieldError, DeniedEndpointError,
  ProductionWriteBoltedError, StageHostGuardError, StageConfigError, NotAuthorizedError, type MatchdayEnv,
} from "@/lib/matchdayStageApi";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { realOccupancyFromRoster, rosterRowCounts, rosterRowIsFake } from "@/lib/gamedayModel";
import { fakesFollowingSpotsLeft } from "@/lib/fakeLadder";
import { planFakeRoster, fakePlanNote, openFakeSlots, type PlanRow } from "@/lib/fakeRosterPlan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const isEnv = (x: string): x is MatchdayEnv => x === "staging" || x === "production";

export async function POST(req: Request, ctx: { params: Promise<{ env: string; id: string }> }) {
  const auth = await authenticateCapability(req, "editMatches");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env, id } = await ctx.params;

  // The same boundary the roster write path uses: a confined account must not act on a match it
  // was never shown. Filtering a list is not authorisation.
  {
    const scope = await assertMatchInScope(auth.supabase, auth.confinedCity, id, env);
    if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status });
  }
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  if (!/^\d+$/.test(id)) return Response.json({ error: "matchId must be numeric" }, { status: 400 });

  /* followSpotsLeft: after a team size write, the target is worked out HERE from the match as it
   * now stands (fakesFollowingSpotsLeft), so the app and the desktop resize share one rule. */
  const b = (await req.json().catch(() => null)) as
    { targetFakes?: number; followSpotsLeft?: boolean; saveId?: string; source?: string; matchName?: string } | null;
  if (!b || (b.followSpotsLeft !== true && !Number.isFinite(Number(b.targetFakes)))) {
    return Response.json({ error: "targetFakes (a number) or followSpotsLeft is required" }, { status: 400 });
  }
  let target = Math.trunc(Number(b.targetFakes));
  const actor = { canEditMatches: auth.canEditMatches, email: auth.email, userId: auth.appUserId };
  const saveId = b.saveId || randomUUID();

  const readRoster = async (): Promise<PlanRow[]> => {
    const r = await apiGet<PlanRow[] | { data?: PlanRow[] }>(env, `/admin/matches/${id}/players`);
    return Array.isArray(r) ? r : (r.data ?? []);
  };
  const countFakes = (rows: PlanRow[]) => rows.filter((r) => rosterRowCounts(r) && rosterRowIsFake(r)).length;

  try {
    const match = await apiGet<Record<string, unknown>>(env, `/admin/matches/${id}`);
    const capacity = Number(match.maxPlayerCount ?? 0);
    const matchName = b.matchName ?? (match.name as string) ?? null;

    const rows = await readRoster();
    let spotsLeft: number | null = null;
    if (b.followSpotsLeft === true) {
      const real = realOccupancyFromRoster(Number((match._count as Record<string, unknown> | undefined)?.players ?? 0), rows);
      const f = fakesFollowingSpotsLeft(match, real, Date.now());
      target = f.target; spotsLeft = f.spotsLeft;
    }
    const plan = planFakeRoster({ rows, capacity, targetFakes: target });

    if (plan.refusal) {
      // A REFUSAL SENDS NOTHING. It is not a failed write; it is a request that was never made.
      return Response.json({ ok: false, outcome: "refused", error: plan.refusal, plan }, { status: 400 });
    }
    if (plan.noop) {
      return Response.json({ ok: true, outcome: "landed", noop: true, fakesBefore: plan.liveFakes,
        fakesAfter: plan.liveFakes, target, spotsLeft, note: fakePlanNote(plan, target) });
    }

    /* THE SECOND GUARANTEE. Every id about to be deleted is checked against the fake set read a
     * moment ago. If the planner ever hands back something that is not a fake — or a row that has
     * since stopped being one — nothing is sent at all. */
    if (plan.removes.length > 0) {
      const fakeIds = new Set(rows.filter((r) => rosterRowCounts(r) && rosterRowIsFake(r)).map((r) => Number(r.id)));
      const notFake = plan.removes.filter((r) => !fakeIds.has(r.id)).map((r) => r.id);
      if (notFake.length > 0) {
        console.error(`[fakes] REFUSED: plan named non-fake user-match ids ${JSON.stringify(notFake)} on match ${id}`);
        return Response.json({ ok: false, outcome: "refused",
          error: `refusing to remove user-match ${notFake.join(", ")} — not a fake player row. Nothing was sent.` }, { status: 409 });
      }
    }

    /* ADDS GO ONE AT A TIME INTO OPEN BIBS INSIDE THE SIZE (openFakeSlots), and every new row is
     * read back and must carry the fake flag; the first that does not stops the run. MatchDay's
     * fake lookup returns the first user in its table once the pool of fake accounts is used up, so
     * a row that is not a fake is a person, or a deleted account, that nobody chose. */
    const teamNumbers = ((match.teams as Record<string, unknown>[] | undefined) ?? []).map((t) => Number(t.teamNumber)).filter(Number.isFinite);
    const slots = plan.add > 0 ? openFakeSlots(rows, teamNumbers, capacity, plan.add) : [];
    if (plan.add > 0 && slots.length < plan.add) {
      return Response.json({ ok: false, outcome: "refused", target, spotsLeft, plan,
        error: `Only ${slots.length} open bib${slots.length === 1 ? "" : "s"} inside the team size for ${plan.add} fake${plan.add === 1 ? "" : "s"}. Nothing was added.` }, { status: 400 });
    }
    let stoppedAt: { team: number; playerNumber: number; userMatchId: number | null; userId: number | null } | null = null;

    const method = plan.add > 0 ? "POST" as const : "DELETE" as const;
    const path = plan.add > 0
      ? `/admin/matches/${id}/fake-players {${slots.length} slots}`
      : `/admin/matches/user-matches/{${plan.removes.length} rows}`;
    const body = plan.add > 0 ? { slots } : { removes: plan.removes.map((r) => r.id) };

    /* ONE change_log ROW FOR THE WHOLE OPERATION, because it is one operator action with one
     * outcome. The body records the user-match ids and the team each came from — never a name,
     * never a phone. A fake row still points at a real pooled account. */
    const { result, error, outcome, logged } = await recordWrite(
      {
        env, source: b.source || "Gameday Ops · spots left", actorName: auth.email, actorEmail: auth.email,
        saveId, matchId: Number(id), matchName,
        method, path, body, keys: [], label: (k) => k,
        changes: [{
          key: "fakes", field: "Fake players on the roster",
          before: plan.liveFakes, after: target,
        }],
        /* LANDED IS THE RE-READ HITTING THE TARGET. Not "the count moved", not "we sent N" — the
         * number the roster came back with. A partial removal reads as NOT APPLIED, which is the
         * truth and is what the operator needs to see. */
        applied: (_before, after) => countFakes(((after as { players?: PlanRow[] }).players) ?? []) === target,
      },
      {
        readResource: async () => ({ players: await readRoster() }),
        write: async () => {
          /* BOTH CALLS ARE ARROW BODIES DECLARED INSIDE THIS CLOSURE, and that is not a style
           * choice. write-routes-logged-test scans every route SOURCE for a call to the write
           * client that is not immediately preceded by an arrow, which is how it proves no route
           * writes outside recordWrite. (It is a text scan, so this comment may not name that
           * function with its bracket either — doing so trips the guard on the comment.) Hoisting
           * these to the module or the handler would satisfy the scanner while making them
           * callable from outside
           * the logged path; declaring them here keeps the guard's guarantee true rather than
           * merely green. */
          const addOne = (team: number, playerNumber: number) => apiWrite(env, "POST", `/admin/matches/${id}/fake-players`, { team, playerNumber }, actor);
          const removeRow = (umId: number) => apiWrite(env, "DELETE", `/admin/matches/user-matches/${umId}`, undefined, actor);
          if (plan.add > 0) {
            const added: { team: number; playerNumber: number; userMatchId: number }[] = [];
            for (const s of slots) {
              await addOne(s.team, s.playerNumber);
              const now = await readRoster();
              const row = now.find((r) => rosterRowCounts(r) && Number(r.team) === s.team && Number(r.playerNumber) === s.playerNumber);
              if (!row || !rosterRowIsFake(row)) {
                stoppedAt = { ...s, userMatchId: row?.id == null ? null : Number(row.id), userId: (row as { userId?: unknown } | undefined)?.userId == null ? null : Number((row as { userId?: unknown }).userId) };
                break;
              }
              added.push({ ...s, userMatchId: Number(row.id) });
            }
            return { added, stoppedAt };
          }
          /* SEQUENTIAL, NOT Promise.all. These are writes with no idempotency key against an API
           * that validates against roster state; firing them together makes the failure ordering
           * unknowable and the partial state harder to describe than it already is. The first
           * failure stops the rest — a half-removal reported precisely beats a fuller one
           * reported vaguely. */
          const done: number[] = [];
          for (const r of plan.removes) { await removeRow(r.id); done.push(r.id); }
          return { removed: done };
        },
        now: () => new Date().toISOString(),
      },
      supabaseLogStore(),
    );
    if (error) return errToResponse(error);

    const after = await readRoster();
    const fakesAfter = countFakes(after);
    const stop = stoppedAt as { team: number; playerNumber: number; userMatchId: number | null; userId: number | null } | null;
    if (stop) console.error(`[fakes] STOPPED on match ${id}: the row added at team ${stop.team} #${stop.playerNumber} is not a fake (user ${stop.userId}, user-match ${stop.userMatchId})`);
    return Response.json({
      ok: !stop,
      outcome: !stop && fakesAfter === target ? "landed" : "not_applied",
      ...(stop ? { stoppedAt: stop, error: `Stopped: the row added at team ${stop.team} #${stop.playerNumber} is not a fake player (user ${stop.userId ?? "?"}, user-match ${stop.userMatchId ?? "?"}). Nothing more was added; it is still on the roster.` } : {}),
      target, spotsLeft, fakesBefore: plan.liveFakes, fakesAfter,
      added: plan.add, removed: plan.removes.length,
      note: fakePlanNote(plan, target),
      logRecorded: logged, result,
    });
  } catch (e) { return errToResponse(e); }
}

function errToResponse(e: unknown): Response {
  if (e instanceof NotAuthorizedError) return Response.json({ error: e.message, outcome: "failed" }, { status: 403 });
  // AMBIGUOUS is its own fact: the write may have landed. It must never read as a clean failure.
  if (e instanceof AmbiguousWriteError) return Response.json({ error: e.message, ambiguous: true, outcome: "unknown" }, { status: 502 });
  if (e instanceof ProductionWriteBoltedError) return Response.json({ error: e.message, outcome: "failed" }, { status: 503 });
  if (e instanceof DeniedEndpointError) return Response.json({ error: e.message, outcome: "failed" }, { status: 403 });
  if (e instanceof DeniedFieldError) return Response.json({ error: e.message, outcome: "failed" }, { status: 400 });
  if (e instanceof StageHostGuardError) return Response.json({ error: e.message, outcome: "failed" }, { status: 500 });
  if (e instanceof WriteFailedError) return Response.json({ error: e.message, outcome: "failed" }, { status: e.status >= 400 && e.status < 600 ? e.status : 400 });
  if (e instanceof StageConfigError) return Response.json({ error: e.message, outcome: "failed" }, { status: 500 });
  return Response.json({ error: e instanceof Error ? e.message : String(e), outcome: "unknown" }, { status: 500 });
}
