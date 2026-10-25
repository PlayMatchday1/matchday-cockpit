/* REDUCE TO 2 TEAMS. The plan, as a pure function. Nothing here writes.
 *
 * IT IS THE MIRROR OF convert-4, EXCEPT IN THE ORDER, WHICH IS REVERSED.
 * convertFourTeams' route says the shape goes first because "every move below may name a team that
 * does not exist yet". That is right for GROWING: the new teams are empty and nobody stands on them.
 *
 * SHRINKING IS THE OPPOSITE. Teams 3 and 4 have people on them. Writing `teamNumbers: 2` while they
 * do is the one write in this operation that cannot be undone, because where those players land is
 * the API's decision and not ours, and nobody has established that it is safe. So:
 *
 *   1. REMOVE the fakes that are not staying, one at a time.
 *   2. MOVE every real player off the doomed teams into the spots that are now free, then move the
 *      fakes that are staying but standing somewhere that will not exist.
 *   3. SET 2 teams of N, last.
 *
 * WHY THE REMOVALS COME FIRST (CORRECTED 2026-09-09)
 * This used to be moves-then-removes, on the reasoning that a mover must never be handed a spot a
 * fake is about to vacate. The cost of that ordering was that the planner could only use spots
 * which were ALREADY clean, so on a crowded match it ran out and refused: ATH Katy 18555, 19 real
 * and 9 fake across 4 teams, told the operator "remove those fakes first, then reduce". It was
 * refusing to do the one thing it exists to do, and every fake standing in its way was already on
 * its own removal list.
 *
 * REMOVING FIRST DOES NOT MITIGATE THAT RACE, IT DELETES IT. The spot is empty before the move is
 * issued, so 403 PLAYER_NUMBER_ALREADY_TAKEN cannot arise, and the route reads every removal back
 * as gone before it issues a single move.
 *
 * IT IS SAFE BECAUSE A REMOVAL TOUCHES ONE ROW. Measured on staging twice, with read-back:
 * DELETE /admin/matches/user-matches/{umId} removes EXACTLY the row it names and leaves every other
 * row standing where it was (docs/matchday-api-facts.md, "REMOVING A HOST DOES NOT TOUCH THEIR
 * GUESTS"). Nothing re-packs, so the positions this plan is computed from are still true afterwards.
 *
 * THE FAKES THAT STAY (2026-10-25)
 * Until now every fake came out, which made a reduced match look as if it had suddenly emptied.
 * Now the plan keeps the number the Fake Ladder would show for the NEW capacity at this moment:
 * fakes = new capacity minus the rung in force (spots shown as left) minus real players, never
 * below zero and never more than fit. With no ladder setting, or inside the step where the ladder
 * says zero fakes, it keeps every fake that fits and removes only the ones that do not. Fakes are
 * never ADDED here; MatchDay's own reconciler tops the roster up to the ladder on its own schedule.
 *
 * Which fakes stay: the ones already on teams 1 and 2 in a spot that survives, first. If more of
 * those survive than the target, the surplus comes off the team holding the most, highest spot
 * first (the same walk-toward-even rule fakeRosterPlan uses). If fewer survive than the target,
 * the balance is made up from fakes on the doomed teams, which are moved into free spots AFTER
 * every real player has been placed, so a fake never takes a real player's spot.
 *
 * DO NOT RECONCILE THIS WITH convertFourTeams.ts.
 * The comparator below is a deliberate duplicate of that file's `bySignup`. These are two
 * operations that happen to be adjacent, and a shared "deal" helper would tie the safe direction's
 * behaviour to the dangerous one's.
 */

import { teamCountWrites, teamShapeError } from "./rosterEditModel";

/** A stored rung as a number, or null when it is absent or unreadable. */
const rungOf = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The fallback size when the match's own 2-team total does not name one. 2 x 11 = 22. */
export const REDUCE_PER_TEAM = 11;
export const REDUCE_TARGET_TEAMS = 2;
/** The picker's range. 12 a side is the most a 2-team match is ever set to. */
export const REDUCE_MIN_PER_TEAM = 6;
export const REDUCE_MAX_PER_TEAM = 12;

/** The size the picker opens on: the match's own "Max spots, 2 teams" halved, when that is a whole
 *  number inside the picker's range. Otherwise 11. maxTeamSize2Team is a TOTAL, so 18 means 9. */
export const defaultPerTeam = (maxTeamSize2Team: unknown): number => {
  const total = rungOf(maxTeamSize2Team);
  if (total == null || total <= 0) return REDUCE_PER_TEAM;
  const per = total / 2;
  return Number.isInteger(per) && per >= REDUCE_MIN_PER_TEAM && per <= REDUCE_MAX_PER_TEAM ? per : REDUCE_PER_TEAM;
};

/** Why a requested size is not one the picker offers, or null when it is. */
export const perTeamError = (n: unknown): string | null => {
  const v = Number(n);
  if (!Number.isInteger(v) || v < REDUCE_MIN_PER_TEAM || v > REDUCE_MAX_PER_TEAM) {
    return `Team size must be a whole number from ${REDUCE_MIN_PER_TEAM} to ${REDUCE_MAX_PER_TEAM}.`;
  }
  return null;
};

export type ReducePlayer = {
  userMatchId: number;
  team: number | null;
  playerNumber: number | null;
  createdAt: string | null;
  name: string;
  isCancelled?: unknown;
  isFake?: unknown;
};

/** Why a row has to move. Not decoration: it is what the operator reads on a partial. */
export type MoveReason =
  | "off a team being removed" | "had no spot" | "spot above the new size" | "spot taken twice"
  | "a staying fake, off a team being removed" | "a staying fake, outside the new shape";

export type ReduceMove = {
  userMatchId: number; name: string;
  fromTeam: number | null; fromNumber: number | null;
  toTeam: number; playerNumber: number;
  reason: MoveReason;
  /** True for a fake that is staying and has to stand somewhere that will exist. */
  fake: boolean;
  /** The wire body: the same shape rosterModel's `move` builds, for the same endpoint. */
  body: { userMatchId: number; team: number; playerNumber: number };
};

export type ReduceRemove = {
  userMatchId: number; name: string; team: number | null; playerNumber: number | null;
};

/** How many fakes stay, and why that number. */
export type FakePolicy = {
  /** "ladder": the rung in force decides. "zero": the ladder says no fakes right now, so only the
   *  ones that do not fit come out. "none": the match has no ladder setting; same rule as "zero". */
  mode: "ladder" | "zero" | "none";
  /** Spots shown as left under the rung in force, or null when the match has none. */
  rung: number | null;
  /** What the ladder would show for the new capacity: capacity minus rung minus real, floored. */
  ladderFakes: number | null;
  /** Spots the real players leave over. The most fakes that can stay. */
  fit: number;
  keep: number;
};

export type ReducePlan = {
  perTeam: number; targetTeams: number; total: number;
  /** maxPlayerCount + maxTeamSize2Team, from teamCountWrites. Never computed at a call site. */
  shape: Record<string, number>;
  /** Real moves first, then the staying fakes that have to move. One list, one loop in the route. */
  moves: ReduceMove[];
  removes: ReduceRemove[];
  /** Every live player's position BEFORE anything is written: the only way back. */
  beforeMap: { userMatchId: number; team: number | null; playerNumber: number | null; name: string; fake: boolean }[];
  realCount: number; fakeCount: number; stayerCount: number;
  realMoveCount: number; fakeMoveCount: number; fakeKeepCount: number;
  fakePolicy: FakePolicy;
  /** What the match reads now and after, so the operator sees it BEFORE pressing. */
  shownBefore: number; capBefore: number; shownAfter: number;
  /** > 0 means the real players do not fit and nothing may be written. THE ONLY REFUSAL THE ROSTER
   *  CAN RAISE: see the proof beside the spot map below for why a mover can no longer be blocked. */
  shortfall: number;
  shapeError: string | null;
};

/** Live rows. Cancelled rows are neither moved nor counted; fakes are counted separately because
 *  this operation decides which of them stay. */
export const livePlayers = (players: ReducePlayer[]): ReducePlayer[] =>
  players.filter((p) => p.isCancelled !== true);
export const isFakeRow = (p: ReducePlayer): boolean => p.isFake === true;

/* SIGNUP ORDER, with userMatchId as the tie-break so the same roster always produces the same plan.
 * A missing created_at sorts last, so an unknown join time never jumps the queue. */
const bySignup = (a: ReducePlayer, b: ReducePlayer): number =>
  String(a.createdAt ?? "￿").localeCompare(String(b.createdAt ?? "￿")) || a.userMatchId - b.userMatchId;

const key = (t: number, n: number) => `${t}:${n}`;

/** THE FAKE COUNT RULE, on its own so the test can pin it without a roster. */
export function fakePolicyFor(total: number, reals: number, fakes: number, rungInForce: number | null | undefined): FakePolicy {
  const fit = Math.max(0, total - reals);
  const rung = rungOf(rungInForce);
  if (rung == null) return { mode: "none", rung: null, ladderFakes: null, fit, keep: Math.min(fakes, fit) };
  const ladderFakes = Math.max(0, total - rung - reals);
  if (ladderFakes === 0) return { mode: "zero", rung, ladderFakes, fit, keep: Math.min(fakes, fit) };
  return { mode: "ladder", rung, ladderFakes, fit, keep: Math.min(ladderFakes, fakes, fit) };
}

/**
 * THE PLAN. Who stays put, who moves where, which fakes come out, and the shape at the end.
 *
 * A REAL PLAYER STAYS ONLY IF THEIR SPOT SURVIVES AS IT IS: on team 1 or 2, numbered, within the
 * new per-team size, and not already claimed by someone earlier in signup order. Everyone else
 * moves, including a player left on spot 14 of team 1, who would otherwise sit outside a
 * 2 x 11 match, and the second of two players sharing a spot.
 */
export function buildReducePlan(
  /* maxTeamSize2Team rides in so the shape can RAISE a stale 2-team rung without lowering a
   * deliberate one. Optional: absent means unknown, and teamCountWrites then writes it, which is
   * the 18125-safe direction. rungInForce is the Fake Ladder's spots-shown-as-left under the rung
   * in force right now; null or absent means the match has no ladder setting. */
  match: { maxPlayerCount?: unknown; maxTeamSize2Team?: unknown; teamCount: number; rungInForce?: number | null },
  players: ReducePlayer[],
  perTeam: number = REDUCE_PER_TEAM,
): ReducePlan {
  const targetTeams = REDUCE_TARGET_TEAMS;
  const total = Math.max(0, Math.round(perTeam)) * targetTeams;
  const live = livePlayers(players);
  const fakes = live.filter(isFakeRow).sort((a, b) => a.userMatchId - b.userMatchId);
  const reals = live.filter((p) => !isFakeRow(p)).sort(bySignup);
  const capBefore = Number(match.maxPlayerCount) || 0;
  const fakePolicy = fakePolicyFor(total, reals.length, fakes.length, match.rungInForce);

  const shape = teamCountWrites(targetTeams, perTeam, rungOf(match.maxTeamSize2Team));
  const base = {
    perTeam, targetTeams, total, shape,
    beforeMap: live.slice().sort(bySignup).map((p) => ({
      userMatchId: p.userMatchId, team: p.team, playerNumber: p.playerNumber, name: p.name, fake: isFakeRow(p),
    })),
    realCount: reals.length, fakeCount: fakes.length,
    shownBefore: live.length, capBefore, shownAfter: reals.length + fakePolicy.keep,
    shortfall: reals.length - total,
    shapeError: teamShapeError(total, targetTeams),
  };

  /* THE REFUSAL IS A PLAN WITH NO WRITES IN IT. Not an exception: the panel still needs every
   * number to say why, and a plan that carried moves "for later" could be pressed. */
  if (base.shortfall > 0) {
    return {
      ...base, moves: [], removes: [], stayerCount: 0, realMoveCount: 0, fakeMoveCount: 0, fakeKeepCount: 0,
      fakePolicy: { ...fakePolicy, keep: 0 }, shownAfter: reals.length,
    };
  }

  const claimed = new Set<string>();
  const stayers: ReducePlayer[] = [];
  const movers: { p: ReducePlayer; reason: MoveReason }[] = [];
  const survives = (p: ReducePlayer): MoveReason | null => {
    const t = p.team, n = p.playerNumber;
    if (t == null || t > targetTeams) return "off a team being removed";
    if (n == null) return "had no spot";
    if (n < 1 || n > perTeam) return "spot above the new size";
    if (claimed.has(key(t, n))) return "spot taken twice";
    return null;
  };
  for (const p of reals) {
    const why = survives(p);
    if (why) { movers.push({ p, reason: why }); continue; }
    claimed.add(key(p.team!, p.playerNumber!));
    stayers.push(p);
  }

  /* WHICH FAKES STAY. The ones whose spot survives on teams 1 and 2 are candidates first; the rest
   * are "doomed" and either come out or, when the target needs them, are moved after the reals. */
  const surviving: ReducePlayer[] = [];
  const doomed: { p: ReducePlayer; reason: MoveReason }[] = [];
  for (const f of fakes) {
    const why = survives(f);
    if (why) {
      doomed.push({ p: f, reason: why === "off a team being removed" ? "a staying fake, off a team being removed" : "a staying fake, outside the new shape" });
      continue;
    }
    claimed.add(key(f.team!, f.playerNumber!));
    surviving.push(f);
  }
  const keep = fakePolicy.keep;
  const removeSet = new Set<number>();
  if (surviving.length > keep) {
    /* THE SURPLUS COMES OFF THE TEAM HOLDING THE MOST, HIGHEST SPOT FIRST, ties to the lower team
     * number, so a lopsided roster walks toward even and the same roster always plans the same. */
    const byTeam = new Map<number, ReducePlayer[]>();
    for (const f of surviving) { const arr = byTeam.get(f.team!) ?? []; arr.push(f); byTeam.set(f.team!, arr); }
    for (const arr of byTeam.values()) arr.sort((a, b) => (b.playerNumber! - a.playerNumber!) || (b.userMatchId - a.userMatchId));
    for (let i = surviving.length - keep; i > 0; i--) {
      const teams = [...byTeam.keys()].sort((a, b) => (byTeam.get(b)!.length - byTeam.get(a)!.length) || (a - b));
      const out = byTeam.get(teams[0])!.shift()!;
      removeSet.add(out.userMatchId);
      claimed.delete(key(out.team!, out.playerNumber!));
    }
  }
  const fakeMovers: { p: ReducePlayer; reason: MoveReason }[] = [];
  const stillNeeded = Math.max(0, keep - (surviving.length - removeSet.size));
  for (const d of doomed) {
    if (fakeMovers.length < stillNeeded) fakeMovers.push(d); else removeSet.add(d.p.userMatchId);
  }

  /* WHERE A MOVER LANDS: THE EMPTIER TEAM FIRST, ties to team 1.
   *
   * Filling team 1 and then team 2 is what the mock drew, and on a real roster it stacks: a staging
   * match with 4 stayers and 4 movers ended 6 v 2, because team 1 had seven free spots and the
   * movers walked straight down them. That is auto-bump's own failure, convert-4 documents it at
   * length and refuses to reproduce it, and a control whose confirmation says "this is not
   * auto-bump" must not produce its output.
   *
   * THERE IS NO SECOND RULE ANY MORE, AND THAT IS THE FIX. It used to prefer a spot nobody was
   * standing on over one a fake was standing on, because the fakes were still there when the moves
   * went out and the API answers 403 PLAYER_NUMBER_ALREADY_TAKEN on a taken number. The removals
   * happen first now, and the route reads each one back as gone before the first move, so every
   * spot below is genuinely empty and there is nothing left to prefer. A spot a STAYING fake holds
   * is in `claimed` and is never dealt. */
  const free = new Map<number, number[]>();
  const realOccupants = new Map<number, number>();
  const allOccupants = new Map<number, number>();
  for (let t = 1; t <= targetTeams; t++) {
    realOccupants.set(t, stayers.filter((x) => x.team === t).length);
    allOccupants.set(t, realOccupants.get(t)! + surviving.filter((x) => x.team === t && !removeSet.has(x.userMatchId)).length);
    free.set(t, Array.from({ length: perTeam }, (_, i) => i + 1).filter((n) => !claimed.has(key(t, n))));
  }

  /* THEY ALWAYS FIT, WHICH IS WHY THERE IS NO SECOND REFUSAL, AND IT IS ARITHMETIC, NOT A HOPE.
   * `claimed` holds one spot per stayer and one per staying fake, so the free spots number
   * `total - stayers - keptSurviving`. Real movers number `reals - stayers`, and keep <= fit =
   * total - reals, so keptSurviving <= total - reals and movers <= free. The fake movers that
   * follow number `keep - keptSurviving`, which is at most `total - reals - keptSurviving`, the
   * free spots left once every real is placed. */

  const takeSpot = (occupants: Map<number, number>): { team: number; playerNumber: number } => {
    const order = Array.from({ length: targetTeams }, (_, i) => i + 1)
      .sort((a, b) => (occupants.get(a)! - occupants.get(b)!) || a - b);
    for (const t of order) if (free.get(t)!.length) {
      occupants.set(t, occupants.get(t)! + 1);
      if (occupants !== allOccupants) allOccupants.set(t, allOccupants.get(t)! + 1);
      return { team: t, playerNumber: free.get(t)!.shift()! };
    }
    // Unreachable: the movers <= free proof above has already established there are enough.
    return { team: 1, playerNumber: perTeam };
  };

  const toMove = (p: ReducePlayer, reason: MoveReason, fake: boolean, occupants: Map<number, number>): ReduceMove => {
    const to = takeSpot(occupants);
    return {
      userMatchId: p.userMatchId, name: p.name,
      fromTeam: p.team, fromNumber: p.playerNumber,
      toTeam: to.team, playerNumber: to.playerNumber,
      reason, fake,
      body: { userMatchId: p.userMatchId, team: to.team, playerNumber: to.playerNumber },
    };
  };
  /* REALS FIRST, balanced on real players per side. Then the staying fakes, balanced on everyone. */
  const moves: ReduceMove[] = [
    ...movers.map(({ p, reason }) => toMove(p, reason, false, realOccupants)),
    ...fakeMovers.map(({ p, reason }) => toMove(p, reason, true, allOccupants)),
  ];

  /* Deterministic order so a retry after a partial walks the same sequence. */
  const removes: ReduceRemove[] = fakes
    .filter((f) => removeSet.has(f.userMatchId))
    .map((f) => ({ userMatchId: f.userMatchId, name: f.name, team: f.team, playerNumber: f.playerNumber }));

  return {
    ...base, moves, removes, stayerCount: stayers.length,
    realMoveCount: movers.length, fakeMoveCount: fakeMovers.length,
    fakeKeepCount: fakes.length - removes.length, fakePolicy,
  };
}

/* THE LIFECYCLE REFUSALS, mirroring convertRefusal, including its wall-clock rule.
 *
 * WALL CLOCK AS TEXT. startDate carries a Z it does not mean, so it is compared YYYY-MM-DD against
 * YYYY-MM-DD. A Date here would re-shift a late-evening match across midnight and refuse (or
 * allow) the wrong day. */
export function reduceRefusal(
  match: { startDate?: string | null; isCancelled?: unknown; teamCount: number },
  todayYmd: string,
): string | null {
  if (match.isCancelled === true) return "This match is cancelled.";
  if (match.teamCount <= REDUCE_TARGET_TEAMS) {
    return `This is a ${match.teamCount}-team match. Reducing is for matches with more than ${REDUCE_TARGET_TEAMS} teams.`;
  }
  const d = typeof match.startDate === "string" ? match.startDate.slice(0, 10) : "";
  if (!d) return "This match has no start date.";
  if (d < todayYmd) return `This match was played on ${d}. Reducing a match that has already happened would move players who turned up.`;
  return null;
}

/* THE CAPACITY REFUSAL, with both numbers and the shortfall. It is separate from the lifecycle
 * refusals because it needs the roster, and it is the one an operator will argue with, so it also
 * answers the first thing anyone thinks of.
 *
 * THERE IS ONLY ONE BRANCH NOW. It used to have a second, for a roster whose reals fit but whose
 * free spots were held by fakes, and it read "Remove those fakes first, then reduce." That told the
 * operator to go and do by hand the exact thing this operation exists to do, on a match it could
 * have reduced perfectly well, and Ryan was deleting fakes one at a time in the roster editor to
 * unblock it. The removals moved to the front instead, and the state that sentence described can no
 * longer occur; the proof is beside the spot map in buildReducePlan. DO NOT REINTRODUCE IT. */
export const capacityRefusal = (plan: ReducePlan): string | null =>
  plan.shortfall > 0
    ? `${plan.realCount} real players will not fit into ${plan.total} spots. ` +
      `Reducing this match would leave ${plan.shortfall} of them with nowhere to stand, and a real player is never dropped to make a shape fit.`
    : null;

export const capacityRefusalWhy = (plan: ReducePlan): string[] =>
  plan.shortfall <= 0 ? [] : [
    /* ONLY WHEN THERE ARE FAKES. "Removing all 0 fakes does not help" is what this printed on a
     * real production match with none, which reads as a bug in the arithmetic rather than as an
     * answer to the question nobody asked on that match. */
    ...(plan.fakeCount > 0
      ? [`Removing ${plan.fakeCount === 1 ? "the 1 fake" : `all ${plan.fakeCount} fakes`} does not help: fakes hold no spot a real player needs.`]
      : []),
    "If this match really should be smaller, cancel the spots deliberately first, one at a time, so each player is told.",
  ];

/* reduceSteps() AND reduceFillLine() WERE HERE, AND THEY ARE GONE (2026-09-09).
 *
 * They built the confirmation panel's numbered steps and its "the match reads 28 of 32 now and 19
 * of 22 after" line. Ryan cut the whole panel down to one question ("dont need all this text when
 * I execute just say a confirmation are you sure"), so both had exactly one caller left, the GET
 * payload, feeding markup that no longer exists. The 2026-10-25 roster line is a different thing:
 * one plain sentence about what happens to the roster, built in the panel from the plan's counts.
 *
 * THE ORDER THEY DESCRIBED IS STILL ASSERTED, on the route's writes rather than on a sentence about
 * them: see "REMOVES COME BEFORE MOVES" in scripts/reduce-two-test.ts. */
