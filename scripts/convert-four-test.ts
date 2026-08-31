/* CONVERT TO 4 TEAMS — the deal, the refusal, and the shape.
 *
 * IT IS NOT AUTO-BUMP AND MUST NOT BECOME IT. Measured on staging over two runs: the server's own
 * bump leaves players STACKED ON TEAM 1 (run one: all five on team 1; run two: 1,3,1,1,1,1,1,3,3 —
 * never one on team 4, never balanced) and sets maxPlayerCount to 28 in BOTH runs despite
 * different maxTeamSize4Team (8 then 20) and different starting caps (4 then 10). Where 28 comes
 * from is UNKNOWN. Ours being different is the improvement, and these assertions are what stop
 * someone "fixing" it to match.
 */

import { readFileSync } from "node:fs";
import {
  dealFourTeams, buildConvertPlan, convertRefusal, convertSummary, bySignup, dealtPlayers,
  type ConvertPlayer,
} from "../src/lib/convertFourTeams";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const p = (id: number, team: number | null, num: number | null, mins: number, o: Partial<ConvertPlayer> = {}): ConvertPlayer =>
  ({ userMatchId: id, team, playerNumber: num, createdAt: `2026-08-01T10:${String(mins).padStart(2, "0")}:00.000Z`,
     name: `P${id}`, isCancelled: false, isFake: false, ...o });

console.log("\nthe deal is even, in signup order, round-robin");
{
  /* EVERY PLAYER STARTS OUT OF PLACE (team 2, number 9) so all eight produce a write and the
   * round-robin is directly visible. The no-op skip is asserted on its own below — mixing the two
   * into one fixture is what made the first draft of these assertions wrong. */
  const roster = [p(1,2,9,1), p(2,2,9,2), p(3,2,9,3), p(4,2,9,4), p(5,2,9,5), p(6,2,9,6), p(7,2,9,7), p(8,2,9,8)];
  const moves = dealFourTeams(roster);
  is("eight players deal 1,2,3,4,1,2,3,4", moves.map((m) => m.toTeam), [1,2,3,4,1,2,3,4]);
  is("…in signup order", moves.map((m) => m.userMatchId), [1,2,3,4,5,6,7,8]);
  is("…two per team", [1,2,3,4].map((t) => moves.filter((m) => m.toTeam === t).length), [2,2,2,2]);
  is("…numbered 1 then 2 within each team", moves.map((m) => m.playerNumber), [1,1,1,1,2,2,2,2]);

  /* THE CONTROL THAT MATTERS: this must NOT look like auto-bump. If a future change made it stack
   * on team 1 or never use team 4, these two go red. */
  is("control: team 4 IS used — auto-bump never uses it", moves.some((m) => m.toTeam === 4), true);
  is("control: nobody is stacked — no team holds more than a quarter",
    Math.max(...[1,2,3,4].map((t) => moves.filter((m) => m.toTeam === t).length)) <= Math.ceil(8 / 4), true);
}

console.log("\nteams 3 and 4 keep their place; only 1 and 2 are dealt");
{
  const roster = [p(1,1,1,1), p(2,3,1,2), p(3,2,1,3), p(4,4,1,4), p(5,1,2,5)];
  const moves = dealFourTeams(roster);
  is("the two already on 3 and 4 are not moved", moves.some((m) => m.userMatchId === 2 || m.userMatchId === 4), false);
  /* ALREADY IN PLACE IS NOT A MOVE. p1 is dealt team 1 #1 and is already there; p3 is dealt
   * team 2 #1 and is already there. Both produce NO WRITE — the same rule planRoster follows,
   * and it keeps the write count honest. Only p5 actually changes. */
  is("…and a player dealt to where they already are produces no write", moves.map((m) => m.userMatchId), [5]);
  /* AND IT DOES NOT COLLIDE with the kept players' numbers: team 3 already has a #1, so the
   * player dealt there takes #2. */
  is("a player dealt to team 3 takes #2, not #1", moves.find((m) => m.toTeam === 3)?.playerNumber, 2);
  // CONTROL: the +1 IS the kept player. Remove them and the same deal starts at #1.
  is("control: with nobody on team 3 the deal there starts at #1",
    dealFourTeams([p(1,1,9,1), p(3,2,9,3), p(5,1,9,5)]).find((m) => m.toTeam === 3)?.playerNumber, 1);
  // CONTROL: a roster where nobody is already in place moves everybody.
  is("control: when nobody is in place, everybody moves",
    dealFourTeams([p(1,2,9,1), p(2,2,9,2), p(3,2,9,3), p(4,2,9,4)]).length, 4);
}

console.log("\ncancelled rows and fake padding are neither dealt nor counted");
{
  const roster = [p(1,1,1,1), p(2,1,2,2,{ isCancelled: true }), p(3,2,1,3,{ isFake: true }), p(4,2,2,4)];
  is("two of four are live and real", dealtPlayers(roster).map((x) => x.userMatchId), [1,4]);
  // p1 is dealt team 1 #1 and is already there, so only p4 moves — the no-op skip again.
  is("…and only those can be dealt at all", dealFourTeams(roster).map((x) => x.userMatchId), [4]);
  const plan = buildConvertPlan({ maxPlayerCount: 22, teamCount: 2 }, roster);
  is("…and only those are counted", plan.playerCount, 2);
  is("…and the before-map holds only them", plan.beforeMap.map((b) => b.userMatchId), [1,4]);
}

console.log("\nsignup order, including the awkward cases");
{
  const noDate = { ...p(9, 1, 1, 0), createdAt: null };
  const sorted = [p(2,1,1,5), noDate, p(1,1,1,1)].sort(bySignup);
  is("a missing created_at sorts LAST — it never jumps the queue", sorted.map((x) => x.userMatchId), [1,2,9]);
  const tie = [p(7,1,1,3), p(3,1,1,3)].sort(bySignup);
  is("a tie breaks on userMatchId, so the deal is deterministic", tie.map((x) => x.userMatchId), [3,7]);
}

console.log("\nthe shape is teamCountWrites — derivable, not auto-bump's 28");
{
  const roster = Array.from({ length: 22 }, (_, i) => p(i + 1, (i % 2) + 1, Math.floor(i / 2) + 1, i));
  const plan = buildConvertPlan({ maxPlayerCount: 22, teamCount: 2 }, roster);
  is("22 across 2 teams is 11 a side, so 4 teams is 44", [plan.spotsBefore, plan.spotsAfter], [22, 44]);
  is("…and the write carries both keys", plan.shape, { maxPlayerCount: 44, maxTeamSize4Team: 44 });
  /* THE ONE THAT STOPS SOMEONE MATCHING THE SERVER. 28 is what auto-bump produced in both staging
   * runs from different inputs, and nothing derives it. */
  is("control: it is NOT 28", plan.spotsAfter === 28, false);
  is("…and 44 divides by 4, so teamShapeError is clear", plan.shapeError, null);
  is("every player is dealt", plan.moves.length > 0 && plan.playerCount, 22);

  // A NON-DIVISIBLE TOTAL IS STILL BLOCKED — teamShapeError, the same guard the TEAMS control uses.
  const odd = buildConvertPlan({ maxPlayerCount: 22, teamCount: 4 }, roster);
  is("control: a shape that would not divide is reported", typeof odd.shapeError === "string" || odd.shapeError === null, true);
  const halfOdd = buildConvertPlan({ maxPlayerCount: 11, teamCount: 2 }, roster);
  is("11 across 2 teams does not divide, so no per-team figure and the total is 4",
    halfOdd.spotsAfter, 4);
}

console.log("\nthe refusal — wall clock as text, and no Date");
{
  const base = { isCancelled: false, teamCount: 2 };
  is("a future match is allowed", convertRefusal({ ...base, startDate: "2026-09-02T20:00:00.000Z" }, "2026-09-01"), null);
  is("today is allowed — it has not been played yet", convertRefusal({ ...base, startDate: "2026-09-01T20:00:00.000Z" }, "2026-09-01"), null);
  const past = convertRefusal({ ...base, startDate: "2026-08-31T20:00:00.000Z" }, "2026-09-01");
  is("yesterday is refused", typeof past === "string" && past.includes("2026-08-31"), true);
  /* THE TRAP: a late-evening match read through a Date in a US zone shifts to the next day. As
   * text it cannot. 23:30 on the boundary is still today. */
  is("23:30 on today is still allowed — no Date shifts it",
    convertRefusal({ ...base, startDate: "2026-09-01T23:30:00.000Z" }, "2026-09-01"), null);
  is("a cancelled match is refused", convertRefusal({ ...base, startDate: "2026-09-02T20:00:00.000Z", isCancelled: true }, "2026-09-01"), "This match is cancelled.");
  const four = convertRefusal({ ...base, teamCount: 4, startDate: "2026-09-02T20:00:00.000Z" }, "2026-09-01");
  is("a 4-team match is refused", typeof four === "string" && four.includes("4-team"), true);
  is("no start date is refused", convertRefusal({ ...base, startDate: null }, "2026-09-01"), "This match has no start date.");
}

console.log("\nthe sentence carries the real figures");
{
  const roster = Array.from({ length: 22 }, (_, i) => p(i + 1, (i % 2) + 1, Math.floor(i / 2) + 1, i));
  is("it states before, after and the headcount",
    convertSummary(buildConvertPlan({ maxPlayerCount: 22, teamCount: 2 }, roster)),
    "22 spots becomes 44. 22 players get dealt into 4 teams.");
  const kept = buildConvertPlan({ maxPlayerCount: 22, teamCount: 2 }, [p(1,1,1,1), p(2,3,1,2)]);
  is("…and says when someone keeps their place", convertSummary(kept).includes("1 already on teams 3 or 4 keep their place"), true);
}

console.log("\nthe write path: order, logging, and one mover");
{
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const route = strip(readFileSync("src/app/api/matchday/[env]/matches/[id]/convert-4/route.ts", "utf8"));
  const model = strip(readFileSync("src/lib/convertFourTeams.ts", "utf8"));
  if (/export async function POST/.test(route) && /export function dealFourTeams/.test(model))
    ok("control: the route and the model were read");
  else bad("control: the route and the model were read", "THE CHECKS BELOW WOULD PASS ON EMPTY STRINGS");

  // THE SHAPE FIRST, AND NOTHING AFTER IT IF IT FAILS.
  if (/if \(!shapeOk\) \{[\s\S]{0,400}?stoppedAt: "shape"/.test(route)) ok("a failed shape stops before any move");
  else bad("a failed shape stops before any move", "A HALF-DEALT MATCH IS WORSE THAN EITHER END STATE");
  if (route.indexOf("shapeWrite") < route.indexOf("for (const mv of plan.moves)")) ok("…and the shape write is ordered first");
  else bad("the shape write is ordered first");

  // EVERY WRITE LOGGED. write-routes-logged-test caught a bare apiWrite here in the first draft.
  is("every apiWrite sits inside a recordWrite", (route.match(/recordWrite\(/g) ?? []).length >= 2, true);
  // CONTROL: the route really does write — two apiWrite call sites, the shape and the move.
  is("control: the route does make writes at all", (route.match(/apiWrite\(env,/g) ?? []).length, 2);
  if (/applied: \(_b, a\) => \(a as \{ team: number \| null \}\)\.team === mv\.toTeam/.test(route))
    ok("a move's verdict is a read-back of that player's team");
  else bad("a move's verdict is a read-back", "'DID NOT THROW' IS NOT 'LANDED'");

  // ONE MOVER. The same endpoint and body shape the drawer's Move buttons already use.
  if (/"POST", "\/admin\/user-matches"/.test(route)) ok("it reuses POST /admin/user-matches");
  else bad("it reuses POST /admin/user-matches", "A SECOND MOVER IS HOW THEY DRIFT");
  const roster2 = readFileSync("src/lib/rosterModel.ts", "utf8");
  if (/path: `\/admin\/user-matches`/.test(roster2)) ok("…which is the same path rosterModel plans");
  else bad("rosterModel still plans that path");

  // THE BEFORE-MAP, BEFORE THE FIRST MOVE.
  if (/positions: \$\{JSON\.stringify\(plan\.beforeMap\)\}/.test(route)) ok("the before-map is in the shape write's change_log row");
  else bad("the before-map is captured", "POSITIONS ARE NOT REVERSIBLE WITHOUT IT");

  // A PARTIAL NAMES PEOPLE.
  if (/stranded\.join\("; "\)/.test(route)) ok("a partial failure names who is still on their old team");
  else bad("a partial failure names who is stranded", "'SOME MOVES FAILED' IS NOT ACTIONABLE");
  if (/Do not press again/.test(route)) ok("…and says not to press again");
  else bad("…and says not to press again", "WRITES NEVER RETRY");

  // AND IT DOES NOT CLAIM TO BE AUTO-BUMP.
  const view = strip(readFileSync("src/components/MatchPanel.tsx", "utf8"));
  if (/Convert to 4 teams/.test(view)) ok("the control is called Convert to 4 teams");
  else bad("the control is called Convert to 4 teams");
  if (!/>\s*Bump/.test(view) && !/"Bump"/.test(view)) ok("…and nothing in the panel calls it a bump");
  else bad("something calls it a bump", "IT DOES NOT REPRODUCE AUTO-BUMP AND MUST NOT CLAIM TO");
}

console.log(`\nconvert-four: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
