/* REDUCE TO 2 TEAMS — the plan, as a pure function. Nothing here writes.
 *
 * ── IT IS THE MIRROR OF convert-4, EXCEPT IN THE ORDER, WHICH IS REVERSED ──────────────────────
 * convertFourTeams' route says the shape goes first because "every move below may name a team that
 * does not exist yet". That is right for GROWING: the new teams are empty and nobody stands on them.
 *
 * SHRINKING IS THE OPPOSITE. Teams 3 and 4 have people on them. Writing `teamNumbers: 2` while they
 * do is the one write in this operation that cannot be undone, because where those players land is
 * the API's decision and not ours, and nobody has established that it is safe. So:
 *
 *   1. MOVE every real player off the doomed teams into free spots on 1 and 2, one at a time.
 *   2. REMOVE every fake — AFTER the moves, so a mover is never handed a spot a fake is about to
 *      vacate, and BEFORE the shape, so the count is right when it lands.
 *   3. SET 2 teams of 11, last.
 *
 * A failure partway through step 1 leaves a four-team match with everyone standing somewhere real.
 * That is a match nobody has to repair, which is convert-4's own reasoning about its own order.
 *
 * ── DO NOT RECONCILE THIS WITH convertFourTeams.ts ────────────────────────────────────────────
 * The comparator below is a deliberate duplicate of that file's `bySignup`. These are two
 * operations that happen to be adjacent, and a shared "deal" helper would tie the safe direction's
 * behaviour to the dangerous one's.
 */

import { teamCountWrites, teamShapeError } from "./rosterEditModel";

/** Ryan's number, and the default. 2 x 11 = 22, which divides by 2. */
export const REDUCE_PER_TEAM = 11;
export const REDUCE_TARGET_TEAMS = 2;

export type ReducePlayer = {
  userMatchId: number;
  team: number | null;
  playerNumber: number | null;
  createdAt: string | null;
  name: string;
  isCancelled?: unknown;
  isFake?: unknown;
};

/** Why a real player has to move. Not decoration — it is what the operator reads on a partial. */
export type MoveReason = "off a team being removed" | "had no spot" | "spot above the new size" | "spot taken twice";

export type ReduceMove = {
  userMatchId: number; name: string;
  fromTeam: number | null; fromNumber: number | null;
  toTeam: number; playerNumber: number;
  reason: MoveReason;
  /** True when the destination is currently held by a fake that step 2 removes. */
  ontoFakeSpot: boolean;
  /** The wire body — the same shape rosterModel's `move` builds, for the same endpoint. */
  body: { userMatchId: number; team: number; playerNumber: number };
};

export type ReduceRemove = {
  userMatchId: number; name: string; team: number | null; playerNumber: number | null;
};

export type ReducePlan = {
  perTeam: number; targetTeams: number; total: number;
  /** maxPlayerCount + maxTeamSize2Team, from teamCountWrites. Never computed at a call site. */
  shape: Record<string, number>;
  moves: ReduceMove[];
  removes: ReduceRemove[];
  /** Every live player's position BEFORE anything is written — the only way back. */
  beforeMap: { userMatchId: number; team: number | null; playerNumber: number | null; name: string; fake: boolean }[];
  realCount: number; fakeCount: number; stayerCount: number;
  /** What the match reads now and after, so the operator sees it emptier BEFORE pressing. */
  shownBefore: number; capBefore: number; shownAfter: number;
  /** > 0 means it does not fit and nothing may be written. */
  shortfall: number;
  /** Movers with no spot free of a fake — see the blockedByFakes rule. > 0 also refuses. */
  blockedByFakes: number;
  shapeError: string | null;
};

/** Live, real people. Cancelled rows are neither moved nor counted; fakes are counted separately
 *  because this operation is the one that takes them out. */
export const livePlayers = (players: ReducePlayer[]): ReducePlayer[] =>
  players.filter((p) => p.isCancelled !== true);
export const isFakeRow = (p: ReducePlayer): boolean => p.isFake === true;

/* SIGNUP ORDER, with userMatchId as the tie-break so the same roster always produces the same plan.
 * A missing created_at sorts last, so an unknown join time never jumps the queue. */
const bySignup = (a: ReducePlayer, b: ReducePlayer): number =>
  String(a.createdAt ?? "￿").localeCompare(String(b.createdAt ?? "￿")) || a.userMatchId - b.userMatchId;

const key = (t: number, n: number) => `${t}:${n}`;

/**
 * THE PLAN. Who stays put, who moves where, which fakes come out, and the shape at the end.
 *
 * A REAL PLAYER STAYS ONLY IF THEIR SPOT SURVIVES AS IT IS: on team 1 or 2, numbered, within the
 * new per-team size, and not already claimed by someone earlier in signup order. Everyone else
 * moves — including a player left on spot 14 of team 1, who would otherwise sit outside a
 * 2 x 11 match, and the second of two players sharing a spot.
 */
export function buildReducePlan(
  match: { maxPlayerCount?: unknown; teamCount: number },
  players: ReducePlayer[],
  perTeam: number = REDUCE_PER_TEAM,
): ReducePlan {
  const targetTeams = REDUCE_TARGET_TEAMS;
  const total = Math.max(0, Math.round(perTeam)) * targetTeams;
  const live = livePlayers(players);
  const fakes = live.filter(isFakeRow);
  const reals = live.filter((p) => !isFakeRow(p)).sort(bySignup);
  const capBefore = Number(match.maxPlayerCount) || 0;

  const shape = teamCountWrites(targetTeams, perTeam);
  const base = {
    perTeam, targetTeams, total, shape,
    beforeMap: live.slice().sort(bySignup).map((p) => ({
      userMatchId: p.userMatchId, team: p.team, playerNumber: p.playerNumber, name: p.name, fake: isFakeRow(p),
    })),
    realCount: reals.length, fakeCount: fakes.length,
    shownBefore: live.length, capBefore, shownAfter: reals.length,
    shortfall: reals.length - total,
    shapeError: teamShapeError(total, targetTeams),
  };

  /* THE REFUSAL IS A PLAN WITH NO WRITES IN IT. Not an exception — the panel still needs every
   * number to say why, and a plan that carried moves "for later" could be pressed. */
  if (base.shortfall > 0) return { ...base, moves: [], removes: [], stayerCount: 0, blockedByFakes: 0 };

  const claimed = new Set<string>();
  const stayers: ReducePlayer[] = [];
  const movers: { p: ReducePlayer; reason: MoveReason }[] = [];
  for (const p of reals) {
    const t = p.team, n = p.playerNumber;
    if (t == null || t > targetTeams) { movers.push({ p, reason: "off a team being removed" }); continue; }
    if (n == null) { movers.push({ p, reason: "had no spot" }); continue; }
    if (n < 1 || n > perTeam) { movers.push({ p, reason: "spot above the new size" }); continue; }
    if (claimed.has(key(t, n))) { movers.push({ p, reason: "spot taken twice" }); continue; }
    claimed.add(key(t, n));
    stayers.push(p);
  }

  /* WHERE A MOVER LANDS — TWO RULES, BOTH OF WHICH THE OBVIOUS VERSION GETS WRONG.
   *
   * 1. THE EMPTIER TEAM FIRST, ties to team 1. Filling team 1 and then team 2 is what the mock
   *    drew, and on a real roster it stacks: a staging match with 4 stayers and 4 movers ended
   *    6 v 2, because team 1 had seven free spots and the movers walked straight down them. That
   *    is auto-bump's own failure — convert-4 documents it at length and refuses to reproduce it —
   *    and a control whose confirmation says "this is not auto-bump" must not produce its output.
   *
   * 2. A SPOT NOBODY IS STANDING ON, before one a fake is standing on. The mock dealt movers into
   *    fake-held spots, which puts two rows on one number for as long as step 2 takes to run.
   *    Nothing in the estate proves the API rejects that, and nothing proves it accepts it, so the
   *    plan does not need to find out. Fake-held spots remain as a fallback, because refusing a
   *    match that genuinely fits would be worse than a brief overlap. */
  const fakeSpots = new Set(fakes.filter((f) => f.team != null && f.playerNumber != null).map((f) => key(f.team!, f.playerNumber!)));
  const cleanBy = new Map<number, number[]>(), heldBy = new Map<number, number[]>();
  const occupants = new Map<number, number>();
  for (let t = 1; t <= targetTeams; t++) {
    cleanBy.set(t, []); heldBy.set(t, []);
    occupants.set(t, stayers.filter((x) => x.team === t).length);
    for (let n = 1; n <= perTeam; n++) {
      if (claimed.has(key(t, n))) continue;
      (fakeSpots.has(key(t, n)) ? heldBy : cleanBy).get(t)!.push(n);
    }
  }
  /* THE FAKE-HELD SPOTS ARE NOT A FALLBACK — MEASURED. Staging answered
   *   POST /admin/matches/{id}/players/{playerId} {team, playerNumber} on a taken number with
   *   HTTP 403 {"errorCode":"PLAYER_NUMBER_ALREADY_TAKEN"}
   * so the API enforces one row per team+spot. A mover sent onto a spot a fake is still standing on
   * would be REJECTED, not silently doubled up — which is what the mock's plan would have done on
   * every crowded match. So when the clean spots run out the operation refuses and says which fakes
   * are in the way, rather than issuing writes that cannot land. */
  const cleanFree = Array.from({ length: targetTeams }, (_, i) => cleanBy.get(i + 1)!.length).reduce((a, b) => a + b, 0);
  if (cleanFree < movers.length) {
    return { ...base, moves: [], removes: [], stayerCount: stayers.length, blockedByFakes: movers.length - cleanFree };
  }

  const takeSpot = (): { team: number; playerNumber: number } => {
    const order = Array.from({ length: targetTeams }, (_, i) => i + 1)
      .sort((a, b) => (occupants.get(a)! - occupants.get(b)!) || a - b);
    for (const t of order) if (cleanBy.get(t)!.length) { occupants.set(t, occupants.get(t)! + 1); return { team: t, playerNumber: cleanBy.get(t)!.shift()! }; }
    // Unreachable: the cleanFree guard above has already established there are enough.
    return { team: 1, playerNumber: perTeam };
  };

  const moves: ReduceMove[] = movers.map(({ p, reason }) => {
    const to = takeSpot();
    return {
      userMatchId: p.userMatchId, name: p.name,
      fromTeam: p.team, fromNumber: p.playerNumber,
      toTeam: to.team, playerNumber: to.playerNumber,
      reason,
      ontoFakeSpot: fakeSpots.has(key(to.team, to.playerNumber)),
      body: { userMatchId: p.userMatchId, team: to.team, playerNumber: to.playerNumber },
    };
  });

  /* EVERY FAKE COMES OUT, not only the ones on the doomed teams. The whole point of the operation
   * is a real 2 x 11 match, and a fake on team 1 is padding either way. Deterministic order so a
   * retry after a partial walks the same sequence. */
  const removes: ReduceRemove[] = fakes
    .slice().sort((a, b) => a.userMatchId - b.userMatchId)
    .map((f) => ({ userMatchId: f.userMatchId, name: f.name, team: f.team, playerNumber: f.playerNumber }));

  return { ...base, moves, removes, stayerCount: stayers.length, blockedByFakes: 0 };
}

/* THE LIFECYCLE REFUSALS, mirroring convertRefusal — including its wall-clock rule.
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
    return `This is a ${match.teamCount}-team match — reducing is for matches with more than ${REDUCE_TARGET_TEAMS} teams.`;
  }
  const d = typeof match.startDate === "string" ? match.startDate.slice(0, 10) : "";
  if (!d) return "This match has no start date.";
  if (d < todayYmd) return `This match was played on ${d}. Reducing a match that has already happened would move players who turned up.`;
  return null;
}

/* THE CAPACITY REFUSAL, with both numbers and the shortfall. It is separate from the lifecycle
 * refusals because it needs the roster, and it is the one an operator will argue with — so it also
 * answers the first thing anyone thinks of. */
export const capacityRefusal = (plan: ReducePlan): string | null =>
  plan.shortfall > 0
    ? `${plan.realCount} real players will not fit into ${plan.total} spots. ` +
      `Reducing this match would leave ${plan.shortfall} of them with nowhere to stand, and a real player is never dropped to make a shape fit.`
    : plan.blockedByFakes > 0
      ? `${plan.realCount} real players do fit into ${plan.total} spots, but ${plan.blockedByFakes} of them have nowhere to land: ` +
        `the free spots on teams 1 and 2 are held by fakes, and the API refuses a move onto a taken spot ` +
        `(403 PLAYER_NUMBER_ALREADY_TAKEN). Remove those fakes first, then reduce.`
      : null;

export const capacityRefusalWhy = (plan: ReducePlan): string[] =>
  plan.blockedByFakes > 0 ? ["The roster editor removes a fake in one click; this control will not move a player onto a spot that is taken."]
  : plan.shortfall <= 0 ? [] : [
    /* ONLY WHEN THERE ARE FAKES. "Removing all 0 fakes does not help" is what this printed on a
     * real production match with none, which reads as a bug in the arithmetic rather than as an
     * answer to the question nobody asked on that match. */
    ...(plan.fakeCount > 0
      ? [`Removing ${plan.fakeCount === 1 ? "the 1 fake" : `all ${plan.fakeCount} fakes`} does not help: fakes hold no spot a real player needs.`]
      : []),
    "If this match really should be smaller, cancel the spots deliberately first, one at a time, so each player is told.",
  ];

/** The three steps, in the order they are written, for the confirmation. Numbers from the plan. */
export const reduceSteps = (plan: ReducePlan): { label: string; detail: string }[] => [
  {
    label: `Move ${plan.moves.length} real player${plan.moves.length === 1 ? "" : "s"} onto teams 1 and 2`,
    detail: plan.moves.length === 0 ? "Nobody needs to move."
      : plan.moves.map((m) => `${m.name} → team ${m.toTeam} spot ${m.playerNumber}`).join(" · "),
  },
  {
    label: `Remove ${plan.removes.length} fake${plan.removes.length === 1 ? "" : "s"}`,
    detail: "They hold no spot and nobody is notified.",
  },
  {
    label: `Set ${plan.targetTeams} teams of ${plan.perTeam}`,
    detail: `teamNumbers: ${plan.targetTeams}, ` + Object.entries(plan.shape).map(([k, v]) => `${k}: ${v}`).join(", "),
  },
];

/** What players will see, from the plan's own numbers rather than a second count. */
export const reduceFillLine = (plan: ReducePlan): string =>
  `The match reads ${plan.shownBefore} of ${plan.capBefore} now and ${plan.shownAfter} of ${plan.total} after.` +
  (plan.fakeCount > 0
    ? ` Removing the fakes makes it look emptier by ${plan.fakeCount}; that is the point of it, but it is what the app will show.`
    : "");
