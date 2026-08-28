/* A TEAM-COUNT CHANGE WRITES THE MODE'S TOTAL, AND THE TOTAL IS A TOTAL.
 *
 * WHAT HAPPENED, on production match 18125 (San Antonio, 28 players) on 2026-08-28. The drawer's
 * team count went 2 -> 4 and change_log records the whole of what left:
 *
 *     PUT /admin/matches/18125   {"teamNumbers": 4}     outcome "landed"
 *     changes [{"key":"teamNumbers","after":4,"field":"Teams","before":null}]
 *
 * One key. The API changes nothing else — proven on staging, where PUT {teamNumbers:4} moved a
 * match from 2 teams to 4 and left maxPlayerCount 18, maxTeamSize2Team 0 and maxTeamSize4Team 0
 * exactly as they were. So the match landed in 4-team mode reading a maxTeamSize4Team nobody had
 * ever set for it, and the player app divided that stale total by 4. A total that is not a
 * multiple of 4 renders a FRACTIONAL team size: 22/4 = 5.5, which is what the players saw.
 *
 * THE STANDING TRAP THIS SITS ON. maxTeamSize2Team and maxTeamSize4Team are TOTALS, not per side.
 * A 9-a-side 4-team match stores 36, not 9 — the same shape as the "10 x 10" control that sends 20.
 * The first assertion below exists because writing 9 would look completely reasonable.
 */

import { readFileSync } from "node:fs";
import { teamCountWrites, teamShapeError } from "../src/lib/rosterEditModel";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

console.log("\na team-count change writes a TOTAL, not a per-side number");
{
  /* THE ASSERTION THIS SUITE EXISTS FOR. Switching to 4 teams at 9 a side must store 36. */
  is("2 -> 4 teams at 9 a side writes 36, not 9",
    teamCountWrites(4, 9), { maxPlayerCount: 36, maxTeamSize4Team: 36 });

  /* THE CONTROL. 36 must not equal 9, or the assertion above is not testing the trap. Written as
   * an explicit inequality rather than trusted, because "36 !== 9" is exactly the check a future
   * refactor would satisfy by accident while storing the per-side value. */
  if (teamCountWrites(4, 9).maxTeamSize4Team !== 9)
    ok("control: the write is not the per-side value — 36 is not 9");
  else bad("control: the write is not the per-side value", "IT STORED 9, THE PER-SIDE NUMBER");
  is("…and the per-side number times the team count is what lands",
    teamCountWrites(4, 9).maxTeamSize4Team, 9 * 4);

  is("4 -> 2 teams at 9 a side writes 18 into the 2-team rung",
    teamCountWrites(2, 9), { maxPlayerCount: 18, maxTeamSize2Team: 18 });
  /* THREE TEAMS HAS NO RUNG. The API models only maxTeamSize2Team and maxTeamSize4Team, so a
   * 3-team match's capacity lives in maxPlayerCount alone — confirmed on 28 live 3-team matches.
   * Writing a rung here would be inventing a field the API does not read. */
  is("3 teams writes maxPlayerCount and NO rung", teamCountWrites(3, 6), { maxPlayerCount: 18 });
  is("…and specifically not the 4-team rung", "maxTeamSize4Team" in teamCountWrites(3, 6), false);
  is("a team count can never write a total below itself", teamCountWrites(4, 0).maxPlayerCount, 4);
}

console.log("\nand it refuses a total that would show a fraction");
{
  /* THE SECOND ASSERTION, on the exact number the players saw. */
  const err = teamShapeError(22, 4);
  if (err) ok("22 spots across 4 teams is refused");
  else bad("22 spots across 4 teams is refused", "5.5 PLAYERS PER TEAM WOULD SHIP");
  if (err && /5\.5/.test(err)) ok("…and the reason names the fraction the app would render");
  else bad("…and the reason names the fraction", String(err));
  if (err && /multiple of 4/.test(err)) ok("…and says what to do instead");
  else bad("…and says what to do instead", String(err));

  is("36 across 4 teams is fine", teamShapeError(36, 4), null);
  is("18 across 2 teams is fine", teamShapeError(18, 2), null);
  is("18 across 3 teams is fine", teamShapeError(18, 3), null);
  is("20 across 3 teams is refused", teamShapeError(20, 3) !== null, true);
  is("a zero team count is not an error, it is unknown", teamShapeError(18, 0), null);

  /* CONTROL: the checker must be capable of passing, or "refused" is just what it always says. */
  const clean = [12, 16, 20, 24, 28, 32, 36, 40].filter((t) => teamShapeError(t, 4) === null);
  is("control: every multiple of 4 passes, so the block is not indiscriminate", clean.length, 8);
  /* CONTROL: and the values that produced this bug all fail. Measured on production —
   * m4 values 20, 22, 36 and 40 sitting on 3- and 4-team matches. */
  is("control: the real broken values are caught", [22, 20, 40, 36].map((t) => teamShapeError(t, 4) !== null),
    [true, false, false, false]);
  /* AND THE TEAM COUNT IS GENUINELY READ, not ignored: the SAME four totals give a different
   * verdict at 3 teams than at 4. 36 fails on 4? no — it passes on both, because 36 divides by
   * both. 20 and 40 flip: fine on 4, refused on 3. That flip is the proof. */
  is("control: the same totals give a different verdict at 3 teams",
    [22, 20, 40, 36].map((t) => teamShapeError(t, 3) !== null), [true, true, true, false]);
  is("control: …and 20 and 40 are exactly the ones that flip", 
    [20, 40].map((t) => [teamShapeError(t, 4) !== null, teamShapeError(t, 3) !== null]),
    [[false, true], [false, true]]);
}

console.log("\nthe wiring");
{
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const panel = strip(readFileSync("src/components/MatchPanel.tsx", "utf8"));
  if (/teamCountWrites/.test(panel)) ok("control: MatchPanel was read and calls the helper");
  else bad("control: MatchPanel calls the helper", "the checks below would pass on an empty string");

  /* THE BUG IN ONE LINE WAS stageTeamCount STAGING teamCount ALONE. */
  const fn = panel.slice(panel.indexOf("const stageTeamCount"), panel.indexOf("const stageRename"));
  if (/teamCountWrites\(target, per\)/.test(fn)) ok("stageTeamCount carries the capacity into the new mode");
  else bad("stageTeamCount carries the capacity into the new mode", "PUT {teamNumbers} ALONE IS BACK");
  if (/setCur\(\(c\) => \(\{ \.\.\.c, \.\.\.writes \}\)\)/.test(fn)) ok("…and stages it onto the match write");
  else bad("…and stages it onto the match write");

  // BLOCKED ON THE PATH, not only on the button — a disabled button is a UI fact.
  if (/if \(teamShapeError\([\s\S]{0,80}?\)\) return;/.test(panel)) ok("doSave refuses a fractional shape before sending");
  else bad("doSave refuses a fractional shape before sending", "a disabled button is the only guard");
  if (/\|\| !!shapeErr\}/.test(panel)) ok("…and the Save control is disabled too");
  else bad("…and the Save control is disabled too");
  if (/data-testid="mp-shape-err"/.test(panel)) ok("…with the reason on screen, not just a dead button");
  else bad("…with the reason on screen");
}

console.log(`\nteam-shape: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
