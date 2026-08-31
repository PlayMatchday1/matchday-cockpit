/* CONVERT TO 4 TEAMS — the plan, as a pure function. Nothing here writes.
 *
 * ── WHAT THIS IS FOR, AND WHAT IT IS NOT ──────────────────────────────────────────────────────
 * The value is CAPACITY. Two teams at 11 becomes four teams, and new players can register into
 * the spots that opens. IT IS NOT PROMOTING A WAITLIST — there is no waitlist. `paid_status`
 * WAITING means a checkout that never settled (a retried one leaves a row per attempt; one player
 * once made 27), so there is no queue of people waiting to be let in.
 *
 * ── IT IS NOT AUTO-BUMP, AND THE DIFFERENCE IS DELIBERATE ─────────────────────────────────────
 * DO NOT "FIX" THIS TO MATCH THE SERVER'S AUTO-BUMP. Measured on staging over two runs:
 *
 *   - auto-bump leaves players STACKED ON TEAM 1. Run one ended with all five on team 1 and
 *     teams 3 and 4 created empty. Run two ended 1,3,1,1,1,1,1,3,3 — some on 3, never one on 4,
 *     never balanced.
 *   - it sets maxPlayerCount to 28 — the SAME 28 in both runs, with different maxTeamSize4Team
 *     (8 then 20) and different starting caps (4 then 10). It is not the field's
 *     recommendedPlayerCount x4 either (22 x 4 = 88). Where 28 comes from is UNKNOWN.
 *
 * That is not a design, it is whatever the server happens to do, and ours being different is the
 * improvement. Ours is DERIVABLE: teamCountWrites gives teams x spots-per-team, and every number
 * on the confirmation is computed from the match in front of you.
 *
 * ── THE SPLIT ─────────────────────────────────────────────────────────────────────────────────
 * Even by count, SIGNUP ORDER, round-robin into 1,2,3,4. created_at is the only ordering the data
 * carries that means anything to a player; alphabetical is arbitrary and random splits two people
 * who signed up together for no reason anyone can explain at the pitch.
 *
 * ANYONE ALREADY ON TEAM 3 OR 4 KEEPS THEIR PLACE. Only 1 and 2 are dealt. That way a partly
 * converted match converges on a second run instead of reshuffling people who were already placed.
 */

import { teamCountWrites, teamShapeError } from "./rosterEditModel";

export type ConvertPlayer = {
  userMatchId: number;
  team: number | null;
  playerNumber: number | null;
  createdAt: string | null;
  name: string;
  isCancelled?: unknown;
  isFake?: unknown;
};

export type ConvertMove = {
  userMatchId: number;
  name: string;
  fromTeam: number | null;
  toTeam: number;
  playerNumber: number;
  /** The wire body — the same shape rosterModel's `move` builds, for the same endpoint. */
  body: { userMatchId: number; team: number; playerNumber: number };
};

export type ConvertPlan = {
  /** maxPlayerCount + maxTeamSize4Team, from teamCountWrites. */
  shape: Record<string, number>;
  moves: ConvertMove[];
  /** Every live player's position BEFORE anything is written — the only way back. */
  beforeMap: { userMatchId: number; team: number | null; playerNumber: number | null; name: string }[];
  spotsBefore: number;
  spotsAfter: number;
  playerCount: number;
  keptCount: number;
  shapeError: string | null;
};

/** Live, real people. Cancelled rows and fake padding are neither dealt nor counted. */
export const dealtPlayers = (players: ConvertPlayer[]): ConvertPlayer[] =>
  players.filter((p) => p.isCancelled !== true && p.isFake !== true);

/* SIGNUP ORDER. created_at is an ISO string and compares correctly as text; a missing one sorts
 * last so an unknown join time never jumps the queue, with userMatchId as the tie-break so the
 * deal is deterministic — the same roster must always produce the same plan. */
export const bySignup = (a: ConvertPlayer, b: ConvertPlayer): number =>
  String(a.createdAt ?? "￿").localeCompare(String(b.createdAt ?? "￿")) || a.userMatchId - b.userMatchId;

/**
 * THE DEAL. Players already on 3 or 4 keep their team; everyone on 1, 2 or nowhere is dealt
 * round-robin across 1,2,3,4 in signup order.
 *
 * playerNumber is the position WITHIN the team, 1-based, assigned in the same order — so the
 * first person dealt to team 3 is #1 on team 3. Two players cannot end up on the same number.
 */
export function dealFourTeams(players: ConvertPlayer[]): ConvertMove[] {
  const live = dealtPlayers(players).slice().sort(bySignup);
  const kept = live.filter((p) => p.team === 3 || p.team === 4);
  const toDeal = live.filter((p) => !(p.team === 3 || p.team === 4));

  // Numbers already taken on the kept teams, so a dealt player never collides with one.
  const nextNum = new Map<number, number>([[1, 1], [2, 1], [3, 1], [4, 1]]);
  for (const p of kept) {
    const t = p.team as number;
    const n = Number(p.playerNumber) || 0;
    if (n >= (nextNum.get(t) ?? 1)) nextNum.set(t, n + 1);
  }

  const moves: ConvertMove[] = [];
  let i = 0;
  for (const p of toDeal) {
    const toTeam = (i % 4) + 1;
    i += 1;
    const playerNumber = nextNum.get(toTeam) ?? 1;
    nextNum.set(toTeam, playerNumber + 1);
    // ALREADY THERE IS NOT A MOVE. A player whose team and number are unchanged produces no
    // write — the same rule planRoster follows, and it keeps the write count honest.
    if (p.team === toTeam && Number(p.playerNumber) === playerNumber) continue;
    moves.push({
      userMatchId: p.userMatchId, name: p.name, fromTeam: p.team, toTeam, playerNumber,
      body: { userMatchId: p.userMatchId, team: toTeam, playerNumber },
    });
  }
  return moves;
}

/* THE REFUSAL. There is no lifecycle field on a match — no published, started or locked; the only
 * flag is isCancelled. So this guard is ours or it does not exist.
 *
 * WALL CLOCK AS TEXT. startDate carries a Z it does not mean, so it is compared YYYY-MM-DD against
 * YYYY-MM-DD. A Date here would re-shift a late-evening match across midnight and refuse (or
 * allow) the wrong day. */
export function convertRefusal(
  match: { startDate?: string | null; isCancelled?: unknown; teamCount: number },
  todayYmd: string,
): string | null {
  if (match.isCancelled === true) return "This match is cancelled.";
  if (match.teamCount !== 2) return `This is a ${match.teamCount}-team match — conversion is for 2-team matches.`;
  const d = typeof match.startDate === "string" ? match.startDate.slice(0, 10) : "";
  if (!d) return "This match has no start date.";
  if (d < todayYmd) return `This match was played on ${d}. Converting a match that has already happened would re-deal players who turned up.`;
  return null;
}

export function buildConvertPlan(
  match: { maxPlayerCount?: unknown; teamCount: number },
  players: ConvertPlayer[],
): ConvertPlan {
  const live = dealtPlayers(players);
  const spotsBefore = Number(match.maxPlayerCount) || 0;
  /* THE SHAPE IS teamCountWrites — teams x spots per team, the same helper the TEAMS control uses,
   * so a conversion and a manual team-count change cannot disagree about what 4 teams means. The
   * per-team figure comes from the CURRENT shape: 22 across 2 teams is 11 a side, so 4 teams is 44.
   * Not auto-bump's 28, which nothing derives. */
  const perTeam = match.teamCount > 0 && spotsBefore % match.teamCount === 0 ? spotsBefore / match.teamCount : 0;
  const shape = teamCountWrites(4, perTeam);
  const spotsAfter = Number(shape.maxPlayerCount) || 0;
  const moves = dealFourTeams(players);
  return {
    shape,
    moves,
    beforeMap: live.slice().sort(bySignup)
      .map((p) => ({ userMatchId: p.userMatchId, team: p.team, playerNumber: p.playerNumber, name: p.name })),
    spotsBefore,
    spotsAfter,
    playerCount: live.length,
    keptCount: live.filter((p) => p.team === 3 || p.team === 4).length,
    // teamShapeError still blocks a total that would show a fractional team size in the app.
    shapeError: teamShapeError(spotsAfter, 4),
  };
}

/** The sentence on the button, from the plan's own numbers. */
export const convertSummary = (p: ConvertPlan): string =>
  `${p.spotsBefore} spots becomes ${p.spotsAfter}. ${p.playerCount} player${p.playerCount === 1 ? "" : "s"} get dealt into 4 teams` +
  (p.keptCount > 0 ? `, ${p.keptCount} already on teams 3 or 4 keep their place` : "") + ".";
