/* REDUCE TO 2 TEAMS — the plan, the refusal, the order, and the two totals.
 *
 * THE ORDER IS THE ASSERTION THAT MATTERS, AND IT CHANGED ON 2026-09-09. The shape is still LAST,
 * because shrinking removes teams people are standing on and `teamNumbers: 2` while they are is the
 * one write nobody can undo — that is what stops this being tidied into a mirror of convert-4.
 *
 * WHAT MOVED IS THE REMOVALS, WHICH NOW COME FIRST. While they came second the planner could only
 * deal movers into spots that were already free of fakes, so a crowded match refused and told the
 * operator to go and delete those fakes by hand — the exact thing the operation does. See "THE ATH
 * KATY REGRESSION" below, which carries the control proving its fixture is one the old ordering
 * genuinely refused.
 */

import { readFileSync } from "node:fs";
import {
  buildReducePlan, reduceRefusal, capacityRefusal, capacityRefusalWhy, fakePolicyFor, defaultPerTeam, perTeamError,
  livePlayers, isFakeRow, REDUCE_PER_TEAM, REDUCE_MIN_PER_TEAM, REDUCE_MAX_PER_TEAM, type ReducePlayer,
} from "../src/lib/reduceTwoTeams";
import { teamCountWrites } from "../src/lib/rosterEditModel";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const yes = (m: string, c: boolean, d = "") => (c ? ok(m) : bad(m, d));

let SEQ = 0;
const p = (team: number | null, num: number | null, o: Partial<ReducePlayer> = {}): ReducePlayer => {
  SEQ += 1;
  return { userMatchId: SEQ, team, playerNumber: num,
    createdAt: `2026-08-01T10:${String(SEQ).padStart(2, "0")}:00.000Z`,
    name: `P${SEQ}`, isCancelled: false, isFake: false, ...o };
};
const fake = (team: number, num: number) => p(team, num, { isFake: true, name: `Open spot ${SEQ + 1}` });
const M = (teamCount: number, cap: number) => ({ maxPlayerCount: cap, teamCount });

/* THE RULE THAT REPLACED `ontoFakeSpot`. A mover may land on a spot a fake is standing on — that is
 * the whole point of removing them first — but ONLY if that fake is on the removal list, because
 * the route empties it before the move goes out. A destination that is occupied by something not
 * being removed is the 403 this operation must never issue. */
const landsOnSomethingStillStanding = (plan: ReturnType<typeof buildReducePlan>, roster: ReducePlayer[]): string[] => {
  const removed = new Set(plan.removes.map((r) => r.userMatchId));
  return plan.moves.filter((m) => roster.some((x) =>
    x.isCancelled !== true && x.userMatchId !== m.userMatchId && !removed.has(x.userMatchId)
    && x.team === m.toTeam && x.playerNumber === m.playerNumber))
    .map((m) => `${m.name} -> ${m.toTeam}:${m.playerNumber}`);
};

console.log("\nthe mock's WestLake roster: 5 movers, 8 fakes, 2 x 11");
{
  SEQ = 0;
  const roster = [
    p(1,1), p(1,2), p(1,3), p(1,4), p(1,5), fake(1,6), fake(1,7),
    p(2,1), p(2,2), p(2,3), p(2,4), fake(2,5), fake(2,6), fake(2,7),
    p(3,1), p(3,2), p(3,3), fake(3,4), fake(3,5),
    p(4,1), p(4,2), fake(4,3),
  ];
  const plan = buildReducePlan(M(4, 36), roster);
  is("14 real players, 8 fakes", [plan.realCount, plan.fakeCount], [14, 8]);
  const realMoves = plan.moves.filter((m) => !m.fake);
  is("the 5 on teams 3 and 4 move", [plan.realMoveCount, realMoves.length], [5, 5]);
  is("…and they are exactly the ones who were on 3 or 4",
    realMoves.map((m) => m.fromTeam), [3, 3, 3, 4, 4]);
  is("…the 9 already on teams 1 and 2 stay put", plan.stayerCount, 9);
  /* THE FAKE RULE (2026-10-25). No ladder setting on this fixture, so only the fakes that do not
   * fit come out. 14 real players leave 8 spots and there are 8 fakes: every one stays. The 3 on
   * teams 3 and 4 are moved across AFTER the reals, into whatever is left. */
  is("no fake comes out: all 8 fit, so all 8 stay", [plan.removes.length, plan.fakeKeepCount], [0, 8]);
  is("…and the 3 on teams 3 and 4 move across", plan.fakeMoveCount, 3);
  is("…after every real player, so the list is reals first", plan.moves.map((m) => m.fake), [false, false, false, false, false, true, true, true]);
  is("the policy says why", [plan.fakePolicy.mode, plan.fakePolicy.fit, plan.fakePolicy.keep], ["none", 8, 8]);
  is("the shape is 2 teams of 11", plan.shape, teamCountWrites(2, 11));
  is("…which is maxPlayerCount 22 AND maxTeamSize2Team 22 — both TOTALS, never 11",
    [plan.shape.maxPlayerCount, plan.shape.maxTeamSize2Team], [22, 22]);
  is("22 divides by 2, so teamShapeError does not fire", plan.shapeError, null);
  is("nothing is refused", [capacityRefusal(plan), plan.shortfall], [null, -8]);

  /* NOBODY LANDS ON TOP OF ANYBODY. The end state is what an operator will look at. */
  const after = [
    ...roster.filter((x) => !isFakeRow(x) && (x.team ?? 0) <= 2 && !plan.moves.some((m) => m.userMatchId === x.userMatchId))
      .map((x) => `${x.team}:${x.playerNumber}`),
    ...realMoves.map((m) => `${m.toTeam}:${m.playerNumber}`),
  ];
  is("every real player ends on a distinct team+spot", new Set(after).size, after.length);
  /* AND THE WHOLE ROSTER, FAKES INCLUDED, ends on distinct spots: a staying fake never takes a
   * real player's spot, and never another fake's. */
  const everyone = [
    ...roster.filter((x) => (x.team ?? 0) <= 2 && !plan.moves.some((m) => m.userMatchId === x.userMatchId) && !plan.removes.some((r) => r.userMatchId === x.userMatchId))
      .map((x) => `${x.team}:${x.playerNumber}`),
    ...plan.moves.map((m) => `${m.toTeam}:${m.playerNumber}`),
  ];
  is("every row, real or fake, ends on a distinct team+spot", new Set(everyone).size, everyone.length);
  is("…and that is all 22 of them", everyone.length, 22);
  is("…and nobody is on a team above 2", plan.moves.every((m) => m.toTeam <= 2), true);
  is("…nor in a spot above 11", plan.moves.every((m) => m.playerNumber <= 11), true);
  yes("control: there were 14 real players to place, not zero", after.length === 14, String(after.length));

  /* THE SPOT RULE. A mover may take a spot a fake is vacating; it may never take one that will
   * still be occupied when the write goes out. */
  is("no mover is sent onto a spot something is still standing on", landsOnSomethingStillStanding(plan, roster), []);

  /* IT MUST NOT STACK. Filling team 1 and then team 2 put 6 of 8 reals on team 1 on the staging
   * fixture — auto-bump's own output, from a control whose confirmation says it is not auto-bump. */
  const endOn = (t: number) => roster.filter((x) => !isFakeRow(x) && x.team === t && !plan.moves.some((m) => m.userMatchId === x.userMatchId)).length
    + realMoves.filter((m) => m.toTeam === t).length;
  is("the two teams come out even, or as even as an odd count allows",
    Math.abs(endOn(1) - endOn(2)) <= 1, true);
  is("…which on this roster is 7 and 7", [endOn(1), endOn(2)], [7, 7]);
  yes("control: fakes really are holding spots on teams 1 and 2",
    roster.some((x) => isFakeRow(x) && (x.team ?? 0) <= 2), "the check above would be vacuous otherwise");

  /* THE CONSEQUENCE SENTENCE AND THE FILL LINE WERE ASSERTED HERE. Both were cut from the screen
   * on 2026-09-09 along with the helpers that built them, so these assertions went with the copy
   * rather than being kept alive against functions nothing calls. The FIGURES they quoted are still
   * pinned, on the plan itself: realCount/fakeCount above, and shownBefore/shownAfter below. */
  is("the numbers those sentences quoted are still on the plan (shownAfter now counts the staying fakes)",
    [plan.shownBefore, plan.capBefore, plan.shownAfter, plan.total], [22, 36, 22, 22]);
}

console.log("\nthe refusal: 33 real players do not fit into 22 spots");
{
  SEQ = 0;
  // Soccer Central Field 4A as Gameday Ops read it: 34 of 36, 33 real and 1 fake.
  const roster = [...Array.from({ length: 33 }, (_, i) => p((i % 4) + 1, Math.floor(i / 4) + 1)), fake(4, 9)];
  const plan = buildReducePlan(M(4, 36), roster);
  is("33 real, 1 fake, 11 over", [plan.realCount, plan.fakeCount, plan.shortfall], [33, 1, 11]);
  const why = capacityRefusal(plan)!;
  yes("it refuses", why != null);
  yes("…naming both numbers", /33 real players/.test(why) && /22 spots/.test(why), why);
  yes("…and the shortfall", /11 of them with nowhere to stand/.test(why), why);
  is("A REFUSED PLAN CARRIES NO WRITES AT ALL", [plan.moves.length, plan.removes.length], [0, 0]);
  is("…and keeps no fakes either, because nothing is going to happen", [plan.fakeKeepCount, plan.fakePolicy.keep, plan.fakeMoveCount], [0, 0, 0]);
  /* AND IT SAYS NOTHING ELSE — NOW BY CONSTRUCTION RATHER THAN BY SUPPRESSION. Staging once
   * returned "0 fakes come out, 0 real players move" and a fill line reading "24 of 22 after"
   * beside this refusal: arithmetic that is right about a plan with no writes in it and wrong as a
   * sentence. The route used to suppress all three on a refusal, and this block asserted that
   * suppression. It no longer ships them at all, on a refused plan or a good one, so the assertion
   * is now that the fields are absent outright — a stronger version of the same guarantee. */
  const route2 = readFileSync("src/app/api/matchday/[env]/matches/[id]/reduce-2/route.ts", "utf8");
  is("the GET payload carries no confirmation copy at all",
    ["consequence:", "steps:", "fillLine:", "reduceSteps", "reduceFillLine", "teamCountConsequence"].filter((k) => route2.includes(k)), []);
  yes("control: it does still ship the plan's own numbers", /realCount: plan\.realCount/.test(route2) && /shortfall: plan\.shortfall/.test(route2));

  const bullets = capacityRefusalWhy(plan);
  is("…and only two bullets, since this match HAS a fake to argue about", bullets.length, 2);
  SEQ = 0;
  const noFakes = buildReducePlan(M(4, 36), Array.from({ length: 30 }, (_, i) => p((i % 4) + 1, Math.floor(i / 4) + 1)));
  is("a match with NO fakes is not told that removing 0 of them would not help",
    capacityRefusalWhy(noFakes).some((b) => /fake/.test(b)), false);
  is("…it still gets the one bullet that applies", capacityRefusalWhy(noFakes).length, 1);
  yes("…and it answers the first thing anyone thinks of, that the fake makes room",
    bullets.some((b) => /fakes hold\s+no spot a real player needs/.test(b.replace(/\s+/g, " "))), JSON.stringify(bullets));
}

console.log("\n22 real players is allowed; 23 is not");
{
  SEQ = 0;
  const exact = buildReducePlan(M(4, 36), Array.from({ length: 22 }, (_, i) => p((i % 4) + 1, Math.floor(i / 4) + 1)));
  is("exactly 22 fits", [exact.shortfall, capacityRefusal(exact)], [0, null]);
  is("…and all 22 are placed", exact.moves.length + exact.stayerCount, 22);
  SEQ = 0;
  const over = buildReducePlan(M(4, 36), Array.from({ length: 23 }, (_, i) => p((i % 4) + 1, Math.floor(i / 4) + 1)));
  is("23 does not", over.shortfall, 1);
  yes("…and refuses", capacityRefusal(over) !== null);
}

console.log("\nTHE ATH KATY REGRESSION: a fake in the way is no longer a refusal");
{
  /* RYAN, ON ATH KATY 18555 (19 real, 9 fake, 28 of 32, four teams):
   *   "the reduce to 2 teams isn't working its suppose to remove the fakes from first 2 teams and
   *    then move the real players in teams 3 in 4 into team 1 and 2 bump it to 11v11 so they all
   *    fit"
   * It refused with "Remove those fakes first, then reduce", which is what step 1 now does. */
  SEQ = 0;
  // 4 reals on teams 1-2 and 17 fakes crowding the rest of them, with 4 reals to bring across.
  const roster = [
    p(1,1), p(1,2), p(2,1), p(2,2),
    fake(1,3), fake(1,4), fake(1,5), fake(1,6), fake(1,7), fake(1,8), fake(1,9), fake(1,10), fake(1,11),
    fake(2,3), fake(2,4), fake(2,5), fake(2,6), fake(2,7), fake(2,8), fake(2,9), fake(2,10),
    p(3,1), p(3,2), p(3,3), p(4,1),
  ];
  const plan = buildReducePlan(M(4, 44), roster);

  /* THE CONTROL, AND IT IS THE POINT OF THIS BLOCK. An ordering fix that cannot be shown to have
   * mattered is not verified — so compute the OLD predicate over this same fixture. Moves-first
   * could only use a spot free of BOTH a stayer and a fake; this roster has exactly one, and four
   * players who must come across. The assertions below are therefore not passing on an easy
   * roster: they are passing on the roster that used to refuse. */
  const stayerSpots = new Set(roster.filter((x) => !isFakeRow(x) && (x.team ?? 0) <= 2).map((x) => `${x.team}:${x.playerNumber}`));
  const fakeSpots = new Set(roster.filter(isFakeRow).map((f) => `${f.team}:${f.playerNumber}`));
  let oldCleanFree = 0;
  for (let t = 1; t <= 2; t++) for (let n = 1; n <= REDUCE_PER_TEAM; n++) {
    if (!stayerSpots.has(`${t}:${n}`) && !fakeSpots.has(`${t}:${n}`)) oldCleanFree += 1;
  }
  is("control: exactly 1 spot is free of both a stayer and a fake", oldCleanFree, 1);
  is("…against 4 real players who have to come across", plan.moves.length, 4);
  yes("SO THE OLD MOVES-FIRST ORDERING REFUSED THIS MATCH, blocked by 3",
    plan.moves.length - oldCleanFree === 3, `${plan.moves.length} movers vs ${oldCleanFree} clean spot`);

  /* AND NOW IT PLANS IT. */
  is("the reals fit — this was never the capacity refusal", plan.shortfall <= 0, true);
  is("IT NO LONGER REFUSES", capacityRefusal(plan), null);
  /* 8 reals leave 14 spots and there is no ladder on the fixture, so 14 fakes stay and only the 3
   * that do not fit come out: off the team holding the most, highest spot first, then the tie goes
   * to team 1. */
  is("…and it writes: 4 moves, 3 removals, 14 fakes kept", [plan.moves.length, plan.removes.length, plan.fakeKeepCount], [4, 3, 14]);
  is("…the removals walk the surplus toward even: 1:11 and 1:10 off the fuller team, then 2:10",
    plan.removes.map((r) => `${r.team}:${r.playerNumber}`).sort(), ["1:10", "1:11", "2:10"]);
  is("…no fake has to move, every staying one already fits", plan.fakeMoveCount, 0);
  is("…every one of the 8 reals is placed", plan.moves.filter((m) => !m.fake).length + plan.stayerCount, 8);

  /* THE MECHANISM, ASSERTED DIRECTLY. Movers land on spots the fakes are vacating — impossible
   * under the old ordering, and the only reason this roster fits at all. */
  const ontoVacated = plan.moves.filter((m) => fakeSpots.has(`${m.toTeam}:${m.playerNumber}`));
  yes("movers land on spots fakes are standing on, which is the whole fix", ontoVacated.length > 0, String(ontoVacated.length));
  is("…and every one of those fakes is removed first, so no move hits an occupied spot",
    landsOnSomethingStillStanding(plan, roster), []);
  is("…nobody doubles up: every real ends on a distinct team+spot",
    new Set([...stayerSpots, ...plan.moves.map((m) => `${m.toTeam}:${m.playerNumber}`)]).size, 8);

  /* THE COPY THAT TOLD THE OPERATOR TO DO IT BY HAND IS GONE WITH THE BRANCH. */
  const src = readFileSync("src/lib/reduceTwoTeams.ts", "utf8");
  const live = src.slice(src.indexOf("export const capacityRefusal ="));
  yes("no refusal still says 'Remove those fakes first'", !/Remove those fakes first, then reduce/.test(live), "the branch is unreachable and must not be re-added");
  yes("…nor blames fakes for holding the free spots", !/held by fakes/.test(live));
  is("…and capacityRefusalWhy has nothing to say about a match that fits", capacityRefusalWhy(plan), []);
}

console.log("\nwho else has to move, beyond the doomed teams");
{
  SEQ = 0;
  const roster = [p(1, 14), p(1, null), p(2, 1), p(2, 1), p(3, 1)];
  const plan = buildReducePlan(M(4, 36), roster);
  const reasons = Object.fromEntries(plan.moves.map((m) => [m.name, m.reason]));
  is("a player in spot 14 cannot stay in a 2 x 11 match", reasons.P1, "spot above the new size");
  is("a player with no spot is given one", reasons.P2, "had no spot");
  is("the second of two on the same spot moves; the first keeps it", reasons.P4, "spot taken twice");
  is("…and the first is not moved", plan.moves.some((m) => m.name === "P3"), false);
  is("the one on team 3 moves for the obvious reason", reasons.P5, "off a team being removed");
  is("four moves in all", plan.moves.length, 4);
  const spots = plan.moves.map((m) => `${m.toTeam}:${m.playerNumber}`);
  is("…into four distinct spots", new Set([...spots, "2:1"]).size, 5);
  is("…spread across both teams rather than stacked on team 1",
    [1, 2].map((t) => plan.moves.filter((m) => m.toTeam === t).length).every((n) => n > 0), true);
}

console.log("\ncancelled rows are not counted and not moved");
{
  SEQ = 0;
  const roster = [p(3, 1), p(3, 2, { isCancelled: true }), fake(4, 1)];
  const plan = buildReducePlan(M(4, 36), roster);
  is("a cancelled row is neither real nor fake nor moved", [plan.realCount, plan.fakeCount, plan.realMoveCount], [1, 1, 1]);
  is("…the live fake on team 4 fits, so it stays and is moved across rather than removed", [plan.fakeMoveCount, plan.removes.length], [1, 0]);
  is("livePlayers drops it", livePlayers(roster).length, 2);
  is("…and the before-map holds only live rows", plan.beforeMap.length, 2);
  is("the before-map records team AND spot for every one of them",
    plan.beforeMap.every((b) => "team" in b && "playerNumber" in b), true);
}

console.log("\nthe lifecycle refusals, mirroring convertRefusal");
{
  is("a cancelled match refuses",
    reduceRefusal({ startDate: "2026-09-10T19:00:00.000Z", isCancelled: true, teamCount: 4 }, "2026-09-06"),
    "This match is cancelled.");
  yes("a match that has already been played refuses",
    /was played on 2026-09-05/.test(reduceRefusal({ startDate: "2026-09-05T19:00:00.000Z", isCancelled: false, teamCount: 4 }, "2026-09-06") ?? ""));
  is("today's match does NOT refuse — it has not been played",
    reduceRefusal({ startDate: "2026-09-06T19:00:00.000Z", isCancelled: false, teamCount: 4 }, "2026-09-06"), null);
  yes("a 2-team match has nothing to reduce",
    /2-team match/.test(reduceRefusal({ startDate: "2026-09-10T19:00:00.000Z", isCancelled: false, teamCount: 2 }, "2026-09-06") ?? ""));
  is("a 4-team match in the future is allowed",
    reduceRefusal({ startDate: "2026-09-10T19:00:00.000Z", isCancelled: false, teamCount: 4 }, "2026-09-06"), null);

  /* THE WALL-CLOCK TRAP. A 9pm match on the operating day must not be refused because a Date
   * pushed its UTC string into tomorrow. The comparison is text, and this is the proof. */
  is("a 9pm match on the day itself is allowed — the date is compared as TEXT, never as a Date",
    reduceRefusal({ startDate: "2026-09-06T21:00:00.000Z", isCancelled: false, teamCount: 4 }, "2026-09-06"), null);
  const src = readFileSync("src/lib/reduceTwoTeams.ts", "utf8");
  is("…and reduceTwoTeams.ts constructs no Date at all", /new Date\(/.test(src), false);
}

console.log("\nthe write order, which is the reverse of convert-4's");
{
  SEQ = 0;
  // Rung 19 on 22 spots with 2 reals leaves 1 fake, so one of the two fakes comes out.
  const plan = buildReducePlan({ ...M(4, 36), rungInForce: 19 }, [p(3, 1), p(4, 1), fake(1, 5), fake(2, 5)]);
  is("the plan still has all three phases in it", [plan.removes.length, plan.moves.length, plan.shape.maxPlayerCount], [1, 2, 22]);

  /* THE ROUTE ITSELF, AND NOW IT IS THE ONLY PLACE THE ORDER IS ASSERTED. reduceSteps() used to
   * state the order in prose and was checked here; the confirmation that rendered it is gone, so
   * the prose went too. These assertions are the ones that mattered anyway — a sentence claiming
   * the fakes come out first never made them come out first, and these read the writes. */
  const route = readFileSync("src/app/api/matchday/[env]/matches/[id]/reduce-2/route.ts", "utf8");
  const iMove = route.indexOf('apiWrite(env, "POST", "/admin/user-matches"');
  const iRemove = route.indexOf('apiWrite(env, "DELETE", `/admin/matches/user-matches/');
  const iShape = route.indexOf('apiWrite(env, "PUT", `/admin/matches/${id}`');
  yes("the route writes a move, a removal and the shape", iMove > 0 && iRemove > 0 && iShape > 0, `${iMove}/${iRemove}/${iShape}`);
  /* REMOVES BEFORE MOVES — the fix. A mover can only be dealt a spot a fake is vacating if the
   * fake is already off the match, and this is the assertion that keeps it that way. */
  yes("REMOVES COME BEFORE MOVES", iRemove < iMove, `remove@${iRemove} move@${iMove}`);
  yes("MOVES COME BEFORE THE SHAPE — teamNumbers: 2 is the write nobody can undo", iMove < iShape);
  yes("the before-map is written ahead of all three", route.indexOf("reduce2:before") < iRemove);
  yes("…and it describes the roster as removals-then-moves-then-shape, which is what happens",
    /fake removal\(s\), then \$\{plan\.moves\.length\} move\(s\)/.test(route));
  /* THE FAILURE MESSAGES MUST DESCRIBE THE NEW STATES, not the old ones. A stop during the removals
   * has moved nobody; a stop during the moves has already taken every fake out. */
  yes("a stop during the removals says nobody has moved", /NOBODY HAS MOVED/.test(route));
  /* AND IT IS STRUCTURALLY TRUE, NOT JUST ASSERTED IN PROSE. The removals loop returns
   * `movesLanded: 0` as a LITERAL, because the moves loop — and the variable — come after it. A
   * future edit that moved the loops back would not typecheck against a literal 0 here. */
  yes("…and it is a literal 0, because the move loop has not been reached",
    /stoppedAt: "remove", results,\s*\n\s*movesLanded: 0, removesLanded,/.test(route));
  yes("a stop during the moves reports how many fakes already came out",
    /movesAttempted: movesLanded \+ 1, movesLanded, removesLanded, stranded,/.test(route));
  yes("a stop during the moves says the fakes are already out", /fake\(s\) came out and \$\{movesLanded\}/.test(route));
  yes("…and it is not optional — losing it stops the operation", /stoppedAt: "before-map"/.test(route));
  yes("a failed move stops the run rather than continuing to the shape", /stoppedAt: "move"/.test(route));
  yes("…and names who is still on their old team", /stranded\.join/.test(route));
  yes("a failed removal stops it too", /stoppedAt: "remove"/.test(route));
  /* NO RETRY, ASSERTED ON THE LOOPS RATHER THAN ON THE WORD "retry" — the first version of this
   * grepped for the word and went red on the header comment saying there are none. Every loop in
   * the route must walk a planned list once; a `while`, or a `for` over anything else, is where a
   * second attempt at the same write would live. */
  const loops = [...route.matchAll(/for \(([^)]*)\)/g)].map((m) => m[1].trim());
  is("every loop in the route walks a planned list, once",
    loops.filter((l) => !/^const \w+ of plan\.(moves|removes)/.test(l)), []);
  yes(`control: there are ${loops.length} loops to check`, loops.length >= 2, JSON.stringify(loops));
  is("…and there is no while loop at all", /while\s*\(/.test(route), false);
  yes("the shape uses teamCountWrites and never computes a rung at the call site",
    /plan\.shape/.test(route) && !/maxTeamSize2Team:\s*\d/.test(route));
  yes("every write goes through recordWrite", route.split("apiWrite(").length - 1 === route.split("write: () => apiWrite(").length - 1);
}

console.log("\nthe control, in the panel");
{
  const view = readFileSync("src/components/MatchPanel.tsx", "utf8");
  yes("it is called Reduce to 2 teams", /Reduce to 2 teams/.test(view));
  yes("…offered only above 2 teams, not disabled on a 2-team match", /rosterTeamCount > 2 && \(/.test(view));
  yes("…and Convert to 4 teams still guards on exactly 2", /rosterTeamCount === 2 && \(/.test(view));
  yes("it disables while another operation is busy", /disabled=\{rdBusy \|\| cvBusy \|\| !mayWrite\}/.test(view));
  yes("it says it is not auto-bump", /Takes the fakes out[^<]*not auto-bump/.test(view));
  /* THE CONFIRMATION IS ONE QUESTION AND TWO BUTTONS (2026-09-09). "dont need all this text when I
   * execute just say a confirmation are you sure — REMOVE ALL OF IT". */
  const confirm = view.slice(view.indexOf('data-testid="mp-reduce-confirm"'), view.indexOf('data-testid="mp-reduce-cancel"'));
  yes("control: the confirmation block was found", confirm.length > 0 && confirm.length < 7000, `${confirm.length} chars`);
  yes("it asks one question, naming the shape and the spots", /data-testid="mp-reduce-ask">Reduce to 2 teams of \{rd\.perTeam\}\? That's \{rd\.total\} spots\./.test(confirm), confirm.slice(-200));
  /* THE PICKER (2026-10-25). It renders the route's range, never a list typed into the panel, and
   * a change refetches the plan at that size rather than recomputing anything on this side. */
  yes("there is a size picker and it is built from the route's range", /data-testid="mp-reduce-size"/.test(confirm) && /rd\.maxPerTeam - rd\.minPerTeam \+ 1/.test(confirm));
  yes("…and picking a size fetches the plan again at that size", /onChange=\{\(e\) => void openReduce\(Number\(e\.target\.value\)\)\}/.test(confirm));
  yes("…and the POST sends the size the sentence was computed for", /reduce-2\?perTeam=\$\{rd\.perTeam\}`, \{\s*method: "POST"/.test(view));
  yes("the roster sentence is built from the plan's counts", /data-testid="mp-reduce-roster"/.test(confirm) && /rd\.fakeRemoveCount/.test(confirm) && /rd\.fakeKeepCount/.test(confirm) && /rd\.realMoveCount/.test(confirm));
  yes("over capacity disables Reduce it and says why, in the same block", /disabled=\{rdBusy \|\| !!rd\.capacityRefusal\}/.test(view) && /would have nowhere to stand, so nothing\s+changes at this size/.test(confirm));
  yes("…and the operator is told the way out", /cancel spots one at a time first so each player is told/.test(confirm));
  yes("it says when the write raises the match's 2-team max", /raises the match's 2-team max from/.test(confirm));
  yes("…and when the choice is above the field's recommended format", /Above this field's recommended format/.test(confirm));
  is("…and the copy that stood there is gone: no steps, no fill line, no consequence, no writes paragraph",
    ["mp-reduce-steps", "mp-reduce-step", "mp-reduce-fill", "mp-reduce-consequence", "rd.steps", "rd.fillLine", "rd.consequence", "rd.writeCount"]
      .filter((t) => view.includes(t)), []);
  yes("…and no details toggle was added instead", !/show details|More detail|mp-reduce-more/i.test(confirm), confirm.slice(0, 200));
  yes("both buttons keep their testids and labels",
    /data-testid="mp-reduce-cancel"[\s\S]*?>Keep \{rosterTeamCount\} teams/.test(view) && /data-testid="mp-reduce-go"/.test(view) && /"Reduce it"/.test(view));
  /* WHAT SURVIVES. The refusals still explain themselves, and the outcome is still one row per
   * write — the confirmation got shorter, not the reporting. */
  yes("the refusal screens are still there", /mp-reduce-refusal/.test(view) && /mp-reduce-nofit/.test(view));
  yes("the closed control still says what it does", /Takes the fakes out[^<]*not auto-bump/.test(view));
  yes("one row per write in the results", /mp-reduce-result"/.test(view));
  yes("the refusal renders its own arithmetic", /mp-reduce-nofit/.test(view));
}

console.log("\nTHE FAKE LADDER RULE (2026-10-25): fakes = new capacity minus the rung in force minus real, never below 0");
{
  /* PRODUCTION 19730, Soccer Central Field 4, read 2026-10-25 at 4.3 hours to kickoff: 4 teams,
   * 32 spots, 7 real, 19 fake, ladder 12/8/8/6/6. The 6h rung was in force and 32 - 6 - 7 = 19
   * is exactly the fake count on the roster, which is the check that the rule is the API's own.
   * At 2 x 9 the same rung gives 18 - 6 - 7 = 5. */
  is("the 6h rung reproduces the live fake count on 19730", fakePolicyFor(32, 7, 19, 6).ladderFakes, 19);
  is("at 2 x 9 the ladder wants 5, so 5 stay", fakePolicyFor(18, 7, 19, 6), { mode: "ladder", rung: 6, ladderFakes: 5, fit: 11, keep: 5 });
  is("never more than fit: a low rung cannot keep more fakes than the reals leave room for", fakePolicyFor(18, 7, 19, 0).keep, 11);
  is("…and never more than there are: fakes are never ADDED by a reduce", fakePolicyFor(22, 2, 3, 2).keep, 3);
  is("no ladder setting keeps every fake that fits", fakePolicyFor(18, 7, 19, null), { mode: "none", rung: null, ladderFakes: null, fit: 11, keep: 11 });
  is("…so does the step where the ladder shows zero fakes", fakePolicyFor(18, 7, 19, 12), { mode: "zero", rung: 12, ladderFakes: 0, fit: 11, keep: 11 });
  is("a rung above capacity floors at zero rather than going negative", fakePolicyFor(12, 7, 3, 40).ladderFakes, 0);
  is("no reals and no fakes is a plan that keeps nothing", fakePolicyFor(18, 0, 0, 6).keep, 0);

  /* THE 19730 ROSTER ITSELF, position for position. */
  SEQ = 0;
  const roster = [
    p(2,5), p(2,2), p(4,8), p(2,7), p(2,1), p(2,3), p(3,4),
    fake(4,6), fake(1,4), fake(4,7), fake(4,4), fake(3,2), fake(1,7), fake(1,8), fake(4,2), fake(3,8), fake(4,1),
    fake(2,4), fake(1,5), fake(2,6), fake(4,5), fake(2,8), fake(1,1), fake(3,7), fake(1,6), fake(3,3),
  ];
  const plan = buildReducePlan({ maxPlayerCount: 32, maxTeamSize2Team: 18, teamCount: 4, rungInForce: 6 }, roster, 9);
  is("7 real, 19 fake, 18 spots", [plan.realCount, plan.fakeCount, plan.total], [7, 19, 18]);
  is("14 fakes come out and 5 stay", [plan.removes.length, plan.fakeKeepCount], [14, 5]);
  is("the 2 reals on teams 3 and 4 move; the 5 on team 2 stay", [plan.realMoveCount, plan.stayerCount], [2, 5]);
  is("the 5 staying fakes were already on teams 1 and 2, so none has to move", plan.fakeMoveCount, 0);
  is("every fake on teams 3 and 4 is on the removal list", plan.removes.filter((r) => (r.team ?? 0) > 2).length, 10);
  is("…and the 4 that come off teams 1 and 2 walk the surplus toward even: team 1 held 6, team 2 held 3, so all 4 are team 1's highest",
    plan.removes.filter((r) => (r.team ?? 0) <= 2).map((r) => `${r.team}:${r.playerNumber}`).sort(), ["1:5", "1:6", "1:7", "1:8"]);
  const kept = roster.filter((x) => isFakeRow(x) && !plan.removes.some((r) => r.userMatchId === x.userMatchId));
  is("the 5 that stay are 1:1, 1:4, 2:4, 2:6, 2:8", kept.map((x) => `${x.team}:${x.playerNumber}`).sort(), ["1:1", "1:4", "2:4", "2:6", "2:8"]);
  yes("no real mover lands on a staying fake's spot",
    plan.moves.every((m) => !kept.some((k) => k.team === m.toTeam && k.playerNumber === m.playerNumber)), JSON.stringify(plan.moves.map((m) => `${m.toTeam}:${m.playerNumber}`)));
  is("the shape writes 18 spots and leaves the 2-team max alone, since it is already 18", plan.shape, { maxPlayerCount: 18 });
  is("…and shows 12 after: 7 real and 5 fake", plan.shownAfter, 12);
  is("nothing is refused", capacityRefusal(plan), null);

  /* THE SAME MATCH AT 11 A SIDE, which is what the old fixed number did: 22 spots raises the
   * 2-team max from 18 to 22. The picker exists so that this is a choice, not the default. */
  SEQ = 0;
  const at11 = buildReducePlan({ maxPlayerCount: 32, maxTeamSize2Team: 18, teamCount: 4, rungInForce: 6 }, roster, 11);
  is("at 11 the shape raises the 2-team max to 22", at11.shape, { maxPlayerCount: 22, maxTeamSize2Team: 22 });
  is("…and the ladder keeps 9: 22 - 6 - 7", at11.fakeKeepCount, 9);
}

console.log("\na staying fake never takes a real player's spot, and the surplus comes off the fuller team");
{
  SEQ = 0;
  // 4 reals on teams 3 and 4 need spots; 6 fakes sit on teams 1 and 2, rung says keep 4.
  const roster = [p(3,1), p(3,2), p(4,1), p(4,2), fake(1,1), fake(1,2), fake(1,3), fake(1,4), fake(2,1), fake(2,2)];
  const plan = buildReducePlan({ maxPlayerCount: 36, teamCount: 4, rungInForce: 14 }, roster, 11);
  is("22 - 14 - 4 = 4 fakes stay", [plan.fakePolicy.keep, plan.fakeKeepCount], [4, 4]);
  is("the 2 that come out are team 1's highest spots, since team 1 holds 4 and team 2 holds 2", plan.removes.map((r) => `${r.team}:${r.playerNumber}`).sort(), ["1:3", "1:4"]);
  const keptSpots = new Set(["1:1", "1:2", "2:1", "2:2"]);
  is("the reals land on free spots, not on a staying fake", plan.moves.filter((m) => keptSpots.has(`${m.toTeam}:${m.playerNumber}`)), []);
  is("…balanced two and two, by real players", [1, 2].map((t) => plan.moves.filter((m) => m.toTeam === t).length), [2, 2]);

  /* WHEN THE TARGET NEEDS FAKES FROM THE DOOMED TEAMS, they are moved after the reals and land on
   * spots nobody holds. */
  SEQ = 0;
  const roster2 = [p(1,1), p(3,1), fake(3,2), fake(4,1), fake(4,2)];
  const plan2 = buildReducePlan({ maxPlayerCount: 36, teamCount: 4, rungInForce: 17 }, roster2, 11);
  is("22 - 17 - 2 = 3 fakes stay, all of them from teams 3 and 4", [plan2.fakeKeepCount, plan2.removes.length, plan2.fakeMoveCount], [3, 0, 3]);
  is("the real mover goes first, to the emptier team", [plan2.moves[0].fake, plan2.moves[0].toTeam], [false, 2]);
  const spots = plan2.moves.map((m) => `${m.toTeam}:${m.playerNumber}`);
  is("every destination is distinct and none is 1:1, the real stayer's spot", [new Set(spots).size, spots.includes("1:1")], [4, false]);
  is("the fake moves carry a fake reason, so the route's row says what moved", plan2.moves.filter((m) => m.fake).map((m) => m.reason), Array(3).fill("a staying fake, off a team being removed"));
}

console.log("\nthe default size and the picker's range");
{
  is("the match's 2-team total halved: 18 is 9 a side", defaultPerTeam(18), 9);
  is("22 is 11", defaultPerTeam(22), 11);
  is("12 is 6, the smallest the picker offers", defaultPerTeam(12), 6);
  is("24 is 12, the largest", defaultPerTeam(24), 12);
  is("0 means the 2-team format is not set, so 11", defaultPerTeam(0), 11);
  is("null is 11", defaultPerTeam(null), 11);
  is("an odd total has no whole side, so 11", defaultPerTeam(25), 11);
  is("a total above the range is 11, not clamped to 12", defaultPerTeam(40), 11);
  is("a string the API might send still reads", defaultPerTeam("18"), 9);
  is("the range is 6 to 12", [REDUCE_MIN_PER_TEAM, REDUCE_MAX_PER_TEAM], [6, 12]);
  is("6 and 12 are allowed", [perTeamError(6), perTeamError(12)], [null, null]);
  yes("5 is not", perTeamError(5) != null);
  yes("13 is not", perTeamError(13) != null);
  yes("9.5 is not", perTeamError(9.5) != null);
  yes("text is not", perTeamError("nine") != null);
  is("the fallback is still 11", REDUCE_PER_TEAM, 11);
}

console.log(`\nreduce-two: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
