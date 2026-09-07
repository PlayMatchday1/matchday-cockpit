/* REDUCE TO 2 TEAMS — the plan, the refusal, the order, and the two totals.
 *
 * THE ORDER IS THE ASSERTION THAT MATTERS. convert-4 writes the shape first because growing adds
 * empty teams; this writes it LAST because shrinking removes teams people are standing on, and
 * `teamNumbers: 2` while they are is the one write nobody can undo. Every "moves before removes
 * before shape" assertion below exists to stop that being tidied into a mirror of convert-4.
 */

import { readFileSync } from "node:fs";
import {
  buildReducePlan, reduceRefusal, capacityRefusal, capacityRefusalWhy, reduceSteps, reduceFillLine,
  livePlayers, isFakeRow, REDUCE_PER_TEAM, type ReducePlayer,
} from "../src/lib/reduceTwoTeams";
import { teamCountConsequence, teamCountWrites, emptyPending } from "../src/lib/rosterEditModel";

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
  is("the 5 on teams 3 and 4 move", plan.moves.length, 5);
  is("…and they are exactly the ones who were on 3 or 4",
    plan.moves.map((m) => m.fromTeam), [3, 3, 3, 4, 4]);
  is("…the 9 already on teams 1 and 2 stay put", plan.stayerCount, 9);
  is("every fake comes out, including the ones on teams 1 and 2", plan.removes.length, 8);
  is("the shape is 2 teams of 11", plan.shape, teamCountWrites(2, 11));
  is("…which is maxPlayerCount 22 AND maxTeamSize2Team 22 — both TOTALS, never 11",
    [plan.shape.maxPlayerCount, plan.shape.maxTeamSize2Team], [22, 22]);
  is("22 divides by 2, so teamShapeError does not fire", plan.shapeError, null);
  is("nothing is refused", [capacityRefusal(plan), plan.shortfall], [null, -8]);

  /* NOBODY LANDS ON TOP OF ANYBODY. The end state is what an operator will look at. */
  const after = [
    ...roster.filter((x) => !isFakeRow(x) && (x.team ?? 0) <= 2 && !plan.moves.some((m) => m.userMatchId === x.userMatchId))
      .map((x) => `${x.team}:${x.playerNumber}`),
    ...plan.moves.map((m) => `${m.toTeam}:${m.playerNumber}`),
  ];
  is("every real player ends on a distinct team+spot", new Set(after).size, after.length);
  is("…and nobody is on a team above 2", plan.moves.every((m) => m.toTeam <= 2), true);
  is("…nor in a spot above 11", plan.moves.every((m) => m.playerNumber <= 11), true);
  yes("control: there were 14 real players to place, not zero", after.length === 14, String(after.length));

  /* THE FAKE-SPOT RULE. The mock dealt movers into spots fakes were standing on; this does not,
   * while any spot nobody is standing on remains. */
  is("no mover is handed a spot a fake is still standing on", plan.moves.filter((m) => m.ontoFakeSpot).length, 0);

  /* IT MUST NOT STACK. Filling team 1 and then team 2 put 6 of 8 reals on team 1 on the staging
   * fixture — auto-bump's own output, from a control whose confirmation says it is not auto-bump. */
  const endOn = (t: number) => roster.filter((x) => !isFakeRow(x) && x.team === t && !plan.moves.some((m) => m.userMatchId === x.userMatchId)).length
    + plan.moves.filter((m) => m.toTeam === t).length;
  is("the two teams come out even, or as even as an odd count allows",
    Math.abs(endOn(1) - endOn(2)) <= 1, true);
  is("…which on this roster is 7 and 7", [endOn(1), endOn(2)], [7, 7]);
  yes("control: fakes really are holding spots on teams 1 and 2",
    roster.some((x) => isFakeRow(x) && (x.team ?? 0) <= 2), "the check above would be vacuous otherwise");

  is("the consequence line is the plan's own numbers",
    teamCountConsequence({ rows: [], teams: [] }, emptyPending(), 2,
      { fromTeamCount: 4, fakes: plan.removes.length, movers: plan.moves.length, perTeam: plan.perTeam }),
    "Teams 3 and 4 are removed. 8 fakes come out, 5 real players move into teams 1 and 2, " +
    "and the match becomes 2 teams of 11. Nobody is dropped. This is not auto-bump.");

  const fill = reduceFillLine(plan);
  yes("what players will see states both figures", /reads 22 of 36 now and 14 of 22 after/.test(fill), fill);
  yes("…and warns it looks emptier", /emptier by 8/.test(fill), fill);
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
  /* AND IT SAYS NOTHING ELSE. Staging returned "0 fakes come out, 0 real players move" and a fill
   * line reading "24 of 22 after" beside this refusal — arithmetic that is right about a plan with
   * no writes in it and wrong as a sentence. The route suppresses all three; this pins that the
   * numbers behind them really are the empty ones, so suppressing is the only correct handling. */
  const route2 = readFileSync("src/app/api/matchday/[env]/matches/[id]/reduce-2/route.ts", "utf8");
  yes("a refused plan carries no consequence line", /consequence: noFit \? null :/.test(route2));
  yes("…no steps", /steps: noFit \? \[\] :/.test(route2));
  yes("…and no what-players-will-see line", /fillLine: noFit \? null :/.test(route2));

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

console.log("\nthe API enforces one row per spot, so a fake in the way is a refusal");
{
  /* MEASURED ON STAGING, and it is the reason the fallback was removed:
   *   POST /admin/matches/{id}/players/{playerId} onto a taken number
   *   → 403 {"message":"Player number already taken","errorCode":"PLAYER_NUMBER_ALREADY_TAKEN"}
   * The mock's plan dealt movers into fake-held spots; every one of those writes would have been
   * rejected. */
  SEQ = 0;
  // 4 reals on teams 1-2 and 6 fakes crowding the rest of them, with 8 reals to bring across.
  const roster = [
    p(1,1), p(1,2), p(2,1), p(2,2),
    fake(1,3), fake(1,4), fake(1,5), fake(1,6), fake(1,7), fake(1,8), fake(1,9), fake(1,10), fake(1,11),
    fake(2,3), fake(2,4), fake(2,5), fake(2,6), fake(2,7), fake(2,8), fake(2,9), fake(2,10),
    p(3,1), p(3,2), p(3,3), p(4,1),
  ];
  const plan = buildReducePlan(M(4, 44), roster);
  is("the reals fit — this is not the capacity refusal", plan.shortfall <= 0, true);
  is("but 3 of the 4 movers have nowhere clean to land", plan.blockedByFakes, 3);
  is("SO IT WRITES NOTHING", [plan.moves.length, plan.removes.length], [0, 0]);
  const why = capacityRefusal(plan)!;
  yes("…and says the fakes are in the way, not the capacity", /held by fakes/.test(why), why);
  yes("…quoting what the API actually answers", /PLAYER_NUMBER_ALREADY_TAKEN/.test(why), why);
  yes("…and what to do about it", /Remove those fakes first/.test(why), why);

  /* THE CONTROL: one fewer fake and it proceeds, so the refusal is about the crowding and not
   * about fakes existing. */
  SEQ = 0;
  const roomier = buildReducePlan(M(4, 44), [
    p(1,1), p(1,2), p(2,1), p(2,2), fake(1,3), fake(2,3),
    p(3,1), p(3,2), p(3,3), p(4,1),
  ]);
  is("with room to spare it plans normally", [roomier.blockedByFakes, roomier.moves.length], [0, 4]);
  is("…and still lands nobody on a fake's spot", roomier.moves.filter((m) => m.ontoFakeSpot).length, 0);
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
  is("a cancelled row is neither real nor fake nor moved", [plan.realCount, plan.fakeCount, plan.moves.length], [1, 1, 1]);
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
  const plan = buildReducePlan(M(4, 36), [p(3, 1), p(4, 1), fake(1, 5)]);
  const steps = reduceSteps(plan);
  is("three steps", steps.length, 3);
  yes("1 — the moves", /^Move 2 real players onto teams 1 and 2/.test(steps[0].label), steps[0].label);
  yes("2 — the fakes, after the moves", /^Remove 1 fake/.test(steps[1].label), steps[1].label);
  yes("…and nobody is notified", /nobody is notified/.test(steps[1].detail), steps[1].detail);
  yes("3 — the shape, last", /^Set 2 teams of 11/.test(steps[2].label), steps[2].label);
  yes("…written as teamNumbers plus BOTH totals",
    /teamNumbers: 2/.test(steps[2].detail) && /maxPlayerCount: 22/.test(steps[2].detail) && /maxTeamSize2Team: 22/.test(steps[2].detail),
    steps[2].detail);

  /* THE ROUTE ITSELF. The order is prose in a plan object; these are the writes. */
  const route = readFileSync("src/app/api/matchday/[env]/matches/[id]/reduce-2/route.ts", "utf8");
  const iMove = route.indexOf('apiWrite(env, "POST", "/admin/user-matches"');
  const iRemove = route.indexOf('apiWrite(env, "DELETE", `/admin/matches/user-matches/');
  const iShape = route.indexOf('apiWrite(env, "PUT", `/admin/matches/${id}`');
  yes("the route writes a move, a removal and the shape", iMove > 0 && iRemove > 0 && iShape > 0, `${iMove}/${iRemove}/${iShape}`);
  yes("MOVES COME BEFORE REMOVES", iMove < iRemove);
  yes("REMOVES COME BEFORE THE SHAPE — teamNumbers: 2 is the write nobody can undo", iRemove < iShape);
  yes("the before-map is written ahead of all three", route.indexOf("reduce2:before") < iMove);
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
  yes("the confirmation shows the consequence, the steps and what players will see",
    /mp-reduce-consequence/.test(view) && /mp-reduce-steps/.test(view) && /mp-reduce-fill/.test(view));
  yes("one row per write in the results", /mp-reduce-result"/.test(view));
  yes("the refusal renders its own arithmetic", /mp-reduce-nofit/.test(view));
}

console.log(`\nreduce-two: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
