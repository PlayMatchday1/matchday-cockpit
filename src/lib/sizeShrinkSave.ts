/* THE MATCH PANEL'S SAVE WHEN A TEAM GETS SMALLER (2026-11-21). Pure: it orders writes, it sends none.
 *
 * Since backend ad5155a0 (2026-11-15) MatchDay refuses a team count or a player count that leaves a
 * booked row on a bib above the new team size, floor(maxPlayerCount / teams):
 * MAX_PLAYER_COUNT_BELOW_BOOKED (user-matches.repository.ts setMaxPlayerCountWithinBookings). The
 * panel's Save sent the shape first, then moves, then removals, then the capacity PUT, so:
 *   - SPOTS PER TEAM 12 to 10 with a real player on bib 11 was refused at the PUT, however few
 *     players that team had;
 *   - TEAMS 2 to 3 sent {teamNumbers: 3} over the old 22, which MatchDay reads as 7 a team, and was
 *     refused while anyone stood on bib 8 or up.
 *
 * WHEN THE TEAM SIZE SHRINKS the order is instead:
 *   1. the staged REMOVALS (the fakes SPOTS PER TEAM takes off, and anything else staged), so their
 *      bibs are free;
 *   2. the BIB FIXES: each real player above the new size to the lowest free bib on their own team
 *      (appMatchV2 bibFixMoves, computed by the panel from a fresh read after step 1);
 *   3. the SHAPE, carrying the size fields with it when the team count changes, so MatchDay checks
 *      the final size in one write and never the halfway one;
 *   4. the staged MOVES and renames, in savePlan's order;
 *   5. the match PUT with whatever size fields were not folded into the shape, and everything else.
 * Every step stops at the first write that does not land. A real player is never removed here: the
 * only removals are the ones the operator staged.
 *
 * WHEN IT DOES NOT SHRINK it is savePlan's order, then the PUT, except that the size fields still ride on
 * the shape whenever the team count changes too. */

import type { PlannedWrite } from "./rosterEditModel";
import { teamCapOf } from "./reduceTwoTeams";

export const SIZE_KEYS = ["maxPlayerCount", "maxTeamSize2Team", "maxTeamSize4Team"] as const;

export type ShrinkOrder = {
  shrinks: boolean;
  /** The team size after the save, or null for no limit. */
  capAfter: number | null;
  teamsAfter: number;
  removes: PlannedWrite[];
  /** The shape write with the size fields folded in, or null when the team count is not changing. */
  shape: PlannedWrite | null;
  rest: PlannedWrite[];
  /** The match PUT body that is left once the size fields ride on the shape. */
  changesLeft: Record<string, unknown>;
  /** The size keys that went with the shape, so the caller still brings the fakes to spots left. */
  folded: string[];
};

export function shrinkSaveOrder(
  plan: PlannedWrite[],
  changes: Record<string, unknown>,
  teamsNow: number,
  maxNow: unknown,
): ShrinkOrder {
  const shapeW = plan.find((w) => w.kind === "shape") ?? null;
  const teamsAfter = shapeW && shapeW.kind === "shape" ? shapeW.fields.teamNumbers : teamsNow;
  const maxAfter = "maxPlayerCount" in changes ? changes.maxPlayerCount : maxNow;
  const capNow = teamCapOf(maxNow, teamsNow);
  const capAfter = teamCapOf(maxAfter, teamsAfter);
  const shrinks = capAfter != null && (capNow == null || capAfter < capNow);
  /* THE SIZE RIDES ON THE SHAPE WHENEVER BOTH CHANGE, shrinking or not: 2 x 11 to 3 x 11 keeps the
   * team size, but {teamNumbers: 3} sent alone over the old 22 reads as 7 a team and is refused. */
  const folded = shapeW ? Object.keys(changes).filter((k) => (SIZE_KEYS as readonly string[]).includes(k)) : [];
  const changesLeft = Object.fromEntries(Object.entries(changes).filter(([k]) => !folded.includes(k)));
  const shape: PlannedWrite | null = shapeW && shapeW.kind === "shape"
    ? { ...shapeW, label: folded.length ? `${shapeW.label}, ${Number(maxAfter)} spots` : shapeW.label,
        fields: { ...shapeW.fields, ...Object.fromEntries(folded.map((k) => [k, Number(changes[k])])) } }
    : null;
  if (!shrinks) {
    // savePlan's order, with the folded shape in the shape's place.
    return { shrinks, capAfter, teamsAfter, removes: [], shape: null, rest: plan.map((w) => (w === shapeW ? shape! : w)), changesLeft, folded };
  }
  return {
    shrinks, capAfter, teamsAfter, shape, changesLeft, folded,
    removes: plan.filter((w) => w.kind === "remove"),
    rest: plan.filter((w) => w.kind === "move" || w.kind === "teams"),
  };
}
