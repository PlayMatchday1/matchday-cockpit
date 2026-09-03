/* BRINGING THE FAKE ROSTER TO A TARGET — pure. Nothing here fetches and nothing here writes.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────────
 * "Spots left now" used to write LADDER RUNGS ONLY. The ladder is a forward schedule: the fake
 * count it implies does not appear on the roster until MatchDay's worker next evaluates it, about
 * 150 seconds later. An operator in the last hour before kickoff who sets "7 spots left" needs the
 * player app to show seven spots left NOW, not in two and a half minutes, so the roster is brought
 * to the target as well. This file decides what that takes.
 *
 * ── WHAT THE API ACTUALLY DOES, MEASURED ON STAGING 2026-09-02 (match 2470, capacity 10) ───────
 * `POST /admin/matches/{id}/batch/fake-players {totalFakes: n}` **ADDS n FAKES. IT DOES NOT SET A
 * TOTAL.** The parameter name says otherwise and so did MatchPanel.tsx's comment; neither had a
 * probe behind it. The discriminating step:
 *
 *     empty roster, totalFakes 6   -> 6 fakes                        (consistent with both)
 *     6 fakes,      totalFakes 6   -> 403 NO_SPOTS_LEFT              (SET would be a no-op)
 *     6 fakes,      totalFakes 2   -> 8 fakes    <- THE DISCRIMINATOR: a LOWER total ADDED
 *     8 fakes,      totalFakes 0   -> 403 INVALID_TOTAL_FAKES        (zero is not a way to clear)
 *
 * So there is NO endpoint that lowers a fake count in one call. Reducing means removing rows one
 * at a time: `DELETE /admin/matches/user-matches/{userMatchId}`, which was measured landing on a
 * fake (8 fakes -> 7) in the same run.
 *
 * ── A FAKE IS NOT A ROW WITHOUT A USER ────────────────────────────────────────────────────────
 * A fake roster row carries a REAL user id, with an email and a 2024 signup date — they come from
 * a pool of accounts flagged `isFakePlayer`. The ONLY discriminator is that flag, via
 * `rosterRowIsFake`. Anything that tried to spot a fake by a null userId would remove real people.
 *
 * ── WHICH FAKES GO, AND THE TEAM BALANCE ──────────────────────────────────────────────────────
 * The API chooses the teams when it adds — the same call gave {1:3, 2:3} on one run and {1:2, 2:4}
 * on the next — so removal is where balance can be kept. Each removal is taken from the team
 * holding the MOST fakes, which walks a lopsided roster toward even: production 18318's 4 White /
 * 6 Dark, asked for four fewer, goes 6->5, 5->4, 4->3, 4->3 and lands 3/3.
 *
 * Ties are broken deterministically, never arbitrarily — a plan that varies between two identical
 * calls cannot be asserted on, and an operator re-running a save should get the same rows.
 */

import { rosterRowCounts, rosterRowIsFake, type RosterRow } from "./gamedayModel";

/** The fields a plan needs off a roster row. `id` is the userMatchId — the only unambiguous key. */
export type PlanRow = RosterRow & { id?: number; team?: number; playerNumber?: number | null };

export type FakePlan = {
  /** Live fakes and live reals as counted now — `rosterRowCounts`, never the raw row total. */
  liveFakes: number;
  liveReal: number;
  /** How many to ADD via one batch call. Zero when reducing or already correct. */
  add: number;
  /** Which rows to DELETE, in order. Every one is a fake; asserted, not assumed. */
  removes: { id: number; team: number; playerNumber: number | null }[];
  /** True when the roster already sits at the target and no write should be sent at all. */
  noop: boolean;
  /** Set when the target cannot be reached; no write may be attempted. */
  refusal: string | null;
};

/**
 * What it takes to bring the live fake count to `targetFakes`.
 *
 * THE ROSTER GET RETURNS MORE ROWS THAN THE MATCH HOLDS. Production 17516 had 38 rows against a
 * `_count.players` of 18 — the gap is eighteen `WAITING` checkouts and two cancellations, not
 * cancellations alone. `rosterRowCounts` is the one predicate for "this row occupies a spot"; a
 * plan built on the raw list would count dead rows as fakes and delete live ones to compensate.
 */
export function planFakeRoster(opts: {
  rows: PlanRow[];
  capacity: number;
  targetFakes: number;
}): FakePlan {
  const live = (opts.rows ?? []).filter((r) => rosterRowCounts(r));
  const fakes = live.filter((r) => rosterRowIsFake(r));
  const liveFakes = fakes.length;
  const liveReal = live.length - liveFakes;
  const target = Math.trunc(Number(opts.targetFakes));
  const cap = Math.trunc(Number(opts.capacity));

  const base: FakePlan = { liveFakes, liveReal, add: 0, removes: [], noop: false, refusal: null };

  if (!Number.isFinite(target) || target < 0) {
    return { ...base, refusal: `a fake count of ${opts.targetFakes} is not a number of players` };
  }
  /* THE CEILING IS CAPACITY MINUS THE REAL PLAYERS, and it is a refusal rather than a clamp.
   * Silently trimming the request would report LANDED for a number the operator did not ask for.
   * A real player is never displaced to make room for a fake — this is the line that guarantees it
   * on the way IN, and the removes-are-fakes-only rule guarantees it on the way OUT. */
  if (cap > 0 && target > cap - liveReal) {
    return { ...base, refusal:
      `${target} fakes will not fit: capacity ${cap} less ${liveReal} real player${liveReal === 1 ? "" : "s"} leaves ${Math.max(0, cap - liveReal)}` };
  }
  if (target === liveFakes) return { ...base, noop: true };
  if (target > liveFakes) return { ...base, add: target - liveFakes };

  /* REDUCING. Take from the team holding the most fakes each time, so a lopsided roster walks
   * toward even instead of being emptied from one side. */
  const need = liveFakes - target;
  const pool = fakes.map((r) => ({
    id: Number(r.id),
    team: Number(r.team ?? 0),
    playerNumber: r.playerNumber == null ? null : Number(r.playerNumber),
  })).filter((r) => Number.isFinite(r.id) && r.id > 0);

  /* A FAKE ROW WITHOUT A USABLE userMatchId CANNOT BE NAMED, and removing by any other key is the
   * ambiguity that `DELETE …/players/{userId}` suffers from — one user routinely holds several
   * rows on one match. Rather than guess at a row, the plan refuses. */
  if (pool.length < need) {
    return { ...base, refusal:
      `only ${pool.length} of ${liveFakes} fake rows carry a user-match id; ${need} need removing and a row cannot be removed without one` };
  }

  const removes: FakePlan["removes"] = [];
  const remaining = new Map<number, typeof pool>();
  for (const r of pool) {
    const arr = remaining.get(r.team) ?? [];
    arr.push(r);
    remaining.set(r.team, arr);
  }
  /* WITHIN A TEAM, THE HIGHEST SLOT GOES FIRST — it keeps the low, stable slot numbers occupied and
   * makes the plan reproducible. A null playerNumber sorts LAST (it is removed first), matching the
   * estate's rule that a null slot is not slot zero. */
  for (const arr of remaining.values()) {
    arr.sort((a, b) => {
      if (a.playerNumber == null && b.playerNumber != null) return -1;
      if (b.playerNumber == null && a.playerNumber != null) return 1;
      const d = (b.playerNumber ?? 0) - (a.playerNumber ?? 0);
      return d !== 0 ? d : b.id - a.id;
    });
  }
  for (let i = 0; i < need; i++) {
    let pickTeam: number | null = null;
    let most = -1;
    /* THE TIE-BREAK IS THE LOWEST TEAM NUMBER. Iterating a Map in insertion order would make the
     * plan depend on the order the API happened to return rows in. */
    for (const t of [...remaining.keys()].sort((a, b) => a - b)) {
      const n = (remaining.get(t) ?? []).length;
      if (n > most) { most = n; pickTeam = t; }
    }
    if (pickTeam == null || most <= 0) break;
    const arr = remaining.get(pickTeam)!;
    removes.push(arr.shift()!);
  }

  return { ...base, removes };
}

/** The line the operator is shown, and the line written to the change log. */
export function fakePlanNote(plan: FakePlan, target: number): string {
  if (plan.refusal) return plan.refusal;
  if (plan.noop) return `roster already holds ${target} fake${target === 1 ? "" : "s"}`;
  if (plan.add > 0) return `added ${plan.add} fake${plan.add === 1 ? "" : "s"} (${plan.liveFakes} to ${target})`;
  const byTeam = plan.removes.reduce<Record<number, number>>((a, r) => (a[r.team] = (a[r.team] ?? 0) + 1, a), {});
  return `removed ${plan.removes.length} fake${plan.removes.length === 1 ? "" : "s"} (${plan.liveFakes} to ${target}) · teams ${JSON.stringify(byTeam)}`;
}
