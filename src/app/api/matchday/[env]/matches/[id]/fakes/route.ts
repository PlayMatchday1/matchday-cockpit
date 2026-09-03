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
import { rosterRowCounts, rosterRowIsFake } from "@/lib/gamedayModel";
import { planFakeRoster, fakePlanNote, type PlanRow } from "@/lib/fakeRosterPlan";

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
    const scope = await assertMatchInScope(auth.supabase, auth.confinedCity, id);
    if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status });
  }
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  if (!/^\d+$/.test(id)) return Response.json({ error: "matchId must be numeric" }, { status: 400 });

  const b = (await req.json().catch(() => null)) as
    { targetFakes?: number; saveId?: string; source?: string; matchName?: string } | null;
  if (!b || !Number.isFinite(Number(b.targetFakes))) {
    return Response.json({ error: "targetFakes (a number) is required" }, { status: 400 });
  }
  const target = Math.trunc(Number(b.targetFakes));
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
    const plan = planFakeRoster({ rows, capacity, targetFakes: target });

    if (plan.refusal) {
      // A REFUSAL SENDS NOTHING. It is not a failed write; it is a request that was never made.
      return Response.json({ ok: false, outcome: "refused", error: plan.refusal, plan }, { status: 400 });
    }
    if (plan.noop) {
      return Response.json({ ok: true, outcome: "landed", noop: true, fakesBefore: plan.liveFakes,
        fakesAfter: plan.liveFakes, target, note: fakePlanNote(plan, target) });
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

    const method = plan.add > 0 ? "POST" as const : "DELETE" as const;
    const path = plan.add > 0
      ? `/admin/matches/${id}/batch/fake-players`
      : `/admin/matches/user-matches/{${plan.removes.length} rows}`;
    const body = plan.add > 0 ? { totalFakes: plan.add } : { removes: plan.removes.map((r) => r.id) };

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
          const addFakes = () => apiWrite(env, "POST", `/admin/matches/${id}/batch/fake-players`, { totalFakes: plan.add }, actor);
          const removeRow = (umId: number) => apiWrite(env, "DELETE", `/admin/matches/user-matches/${umId}`, undefined, actor);
          if (plan.add > 0) return await addFakes();
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
    return Response.json({
      ok: true,
      outcome: fakesAfter === target ? "landed" : "not_applied",
      target, fakesBefore: plan.liveFakes, fakesAfter,
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
