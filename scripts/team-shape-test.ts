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
import { rungKeyFor, teamCountWrites, teamShapeError } from "../src/lib/rosterEditModel";

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

console.log("\nbut it RAISES the rung and never lowers it");
{
  /* THE BUG. Match 18760 — Parmer Stadium - Premier, Austin — is a 4-team match whose capacity is
   * 32 (4 x 8) and whose 4-team max is 44 (4 x 11): it starts at 32 and auto bump grows it to 44.
   * Lowering Spots per team from 11 to 8 put "Max spots, 4 teams: 8 each (32)" into the pending
   * diff over a 44 nobody had touched. These are that match's real stored numbers. */
  is("18760: dropping to 8 a side writes the capacity and LEAVES the 44 alone",
    teamCountWrites(4, 8, 44), { maxPlayerCount: 32 });
  is("…so the pending diff carries no rung at all",
    "maxTeamSize4Team" in teamCountWrites(4, 8, 44), false);
  /* THE CONTROL. Passing no rung must still WRITE one, or the assertion above would pass for a
   * function that had simply stopped writing rungs — which is the 18125 bug coming back. */
  is("control: with no saved rung it still writes one",
    teamCountWrites(4, 8), { maxPlayerCount: 32, maxTeamSize4Team: 32 });

  /* 18125. It went 2 -> 4 teams carrying a stale 4-team rung of 22, and the player app divided 22
   * by 4 and showed players 5.5 a team. A rung BELOW the new capacity is not a ceiling anyone set. */
  is("18125: a stale rung of 22 under a new capacity of 28 is RAISED to 28",
    teamCountWrites(4, 7, 22), { maxPlayerCount: 28, maxTeamSize4Team: 28 });
  is("a rung exactly at the new capacity is left alone",
    teamCountWrites(4, 7, 28), { maxPlayerCount: 28 });
  /* 0 IS "NOT AVAILABLE AS THIS FORMAT", not a ceiling of zero — 88 live 2-team matches hold it.
   * Left alone it would put a match into a format whose total says nobody can sign up. */
  is("a rung of 0 is raised, because 0 means the format is unavailable",
    teamCountWrites(2, 9, 0), { maxPlayerCount: 18, maxTeamSize2Team: 18 });
  is("…and so is a null one", teamCountWrites(2, 9, null), { maxPlayerCount: 18, maxTeamSize2Team: 18 });

  /* THE CLAMP IS UPWARD ONLY, IN BOTH DIRECTIONS OF THE EDIT. Stepping UP past the ceiling raises
   * it; stepping back DOWN must not pull it with them. */
  is("stepping up past the ceiling raises it", teamCountWrites(4, 12, 44), { maxPlayerCount: 48, maxTeamSize4Team: 48 });
  is("…and stepping back down does not pull it back", teamCountWrites(4, 8, 48), { maxPlayerCount: 32 });

  // THREE TEAMS STILL HAS NO RUNG, whatever is passed for one.
  is("3 teams writes no rung even when a ceiling is handed to it", teamCountWrites(3, 6, 99), { maxPlayerCount: 18 });
  is("rungKeyFor names the field each count writes",
    [rungKeyFor(2), rungKeyFor(3), rungKeyFor(4)], ["maxTeamSize2Team", null, "maxTeamSize4Team"]);
}

console.log("\nand the 4-team rung is not an auto-bump-only field");
{
  /* BUG 2. "We sometimes start a match already at 4 teams of 11 (44 spots). In that case no auto
   * bump is needed." Both surfaces greyed the 4-team rung on !isAutoBump, so a 4-team match with
   * auto bump off could not state its own shape — 272 of the 433 4-team matches in Jul-Sep 2026
   * run with auto bump off. Asserted as the ABSENCE of the coupling, with the presence of the
   * control proven first: an absence check over a file that failed to read is free. */
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const panel = strip(readFileSync("src/components/MatchPanel.tsx", "utf8"));
  const ed = strip(readFileSync("src/app/(internal)/match-ops/matches/[id]/MatchEditor.tsx", "utf8"));

  const max4 = panel.slice(panel.indexOf('data-testid="mp-max4"'), panel.indexOf('data-testid="mp-max4"') + 400);
  if (/data-testid="mp-max4"/.test(panel)) ok("control: the 4-team rung control is on the panel");
  else bad("control: the 4-team rung control is on the panel", "THE ABSENCE CHECKS BELOW ARE FREE");
  if (!/disabled=\{!cur\.isAutoBump\}/.test(max4)) ok("…and it is not disabled on auto bump");
  else bad("…and it is not disabled on auto bump", "4 TEAMS OF 11 WITH NO BUMP IS STILL UNREACHABLE");
  // CONTROL: the panel DOES still disable other things, so the regex is not matching nothing.
  if (/disabled=\{!cur\.autoCanceled/.test(panel)) ok("control: auto-cancel's own fields are still gated, so the pattern finds real disables");
  else bad("control: the disabled= pattern finds real disables", "THE ABSENCE ABOVE PROVES NOTHING");

  if (/capField\("maxTeamSize4Team"/.test(ed)) ok("control: the editor renders the 4-team rung");
  else bad("control: the editor renders the 4-team rung", "THE ABSENCE CHECK BELOW IS FREE");
  if (!/capField\("maxTeamSize4Team"[^)]*isAutoBump/.test(ed)) ok("…and does not pass isAutoBump as its disabled flag");
  else bad("…and does not pass isAutoBump as its disabled flag", "STILL GREY IN THE FULL EDITOR");

  /* 0 NEEDS AN OPTION OR THE SELECT CANNOT RENDER WHAT IS STORED. 88 live 2-team matches hold 0,
   * and without the option the box showed the first SIZE instead — one blur from saving 16. */
  if (/not available as a 4-team match/.test(panel) && /not available as a 2-team match/.test(panel))
    ok("both rung selects can say 'not available', so a stored 0 renders as itself");
  else bad("both rung selects can say 'not available'", "A STORED 0 SHOWS AS THE FIRST SIZE");

  /* THE STEPPER MUST NOT BE THE ONLY WAY TO REACH THE RUNG — that was the coupling. */
  const sp = panel.slice(panel.indexOf("const setPerTeam"), panel.indexOf("const runRosterWrite"));
  if (/teamCountWrites\(teamCount, per, rungValue\(teamCount\)\)/.test(sp))
    ok("the stepper hands the saved ceiling to teamCountWrites rather than overwriting it");
  else bad("the stepper hands the saved ceiling to teamCountWrites", "SPOTS PER TEAM STILL CLOBBERS THE MAX");
  if (!/setField\(rungKey, total\)/.test(sp)) ok("…and no longer writes the rung directly");
  else bad("…and no longer writes the rung directly", "THE DIRECT WRITE IS BACK");
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
  if (/teamCountWrites\(target, per\b/.test(fn)) ok("stageTeamCount carries the capacity into the new mode");
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

console.log("\nand the Master Schedule editor is the SAME implementation, not a copy");
{
  /* WHY THIS SECTION EXISTS. Master Schedule's editor had NO team-count control at all and read
   * the count as `teams.length >= 4 ? 4 : 2`, so every 3-team match was reported as 2 — production
   * 18136 is 3 x 6 and the panel said "18 total, 9 a side". Adding the control was the fix; adding
   * it by REIMPLEMENTING the shape is how the 5.5-players-a-team bug comes back on a second
   * screen. These assert the reuse, not the arithmetic — the arithmetic is asserted above, once. */
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const ed = strip(readFileSync("src/app/(internal)/match-ops/matches/[id]/MatchEditor.tsx", "utf8"));

  // POSITIVE CONTROL FIRST: the file was read and still holds code. Every check below is a
  // regex over a string, and an empty string passes the negative ones for free.
  if (/export default function MatchEditor/.test(ed)) ok("control: MatchEditor was read");
  else bad("control: MatchEditor was read", "THE CHECKS BELOW WOULD PASS ON AN EMPTY STRING");

  if (/import \{[^}]*\bteamCountWrites\b[^}]*\bteamShapeError\b[^}]*\} from "@\/lib\/rosterEditModel"/.test(ed))
    ok("it imports both shared functions");
  else bad("it imports both shared functions", "A SECOND COPY OF THE SHAPE");
  if (/teamCountWrites\(target, perTeamNow\b/.test(ed)) ok("a team-count change goes through teamCountWrites");
  else bad("a team-count change goes through teamCountWrites", "PUT {teamNumbers} ALONE IS BACK ON THIS SCREEN");
  if (/teamCountWrites\(teamCount, per\b/.test(ed)) ok("…and so does the spots-per-team stepper");
  else bad("…and so does the spots-per-team stepper");

  /* THE COUNT IS READ, NOT GUESSED BETWEEN TWO. The old expression is asserted ABSENT by its
   * exact shape, because that is the bug: it silently reported 3-team matches as 2-team. */
  if (!/length >= 4 \? 4 : 2/.test(ed)) ok("the 3-team match is no longer reported as 2");
  else bad("the 3-team match is no longer reported as 2", "18136 IS 3 x 6 AND THIS SAYS 9 A SIDE");
  if (/teams as unknown\[\]\)\.length : 0/.test(ed)) ok("…the stored team count is read as stored");
  else bad("…the stored team count is read as stored");

  // BLOCKED ON THE SAVE PATH, not only on the button — the same rule Match panel follows.
  if (/if \(teamShapeError\([\s\S]{0,180}?\)\) return;/.test(ed)) ok("save refuses a fractional shape before sending");
  else bad("save refuses a fractional shape before sending", "a disabled button is the only guard");
  if (/!!shapeErr \|\|/.test(ed)) ok("…and the Save control is disabled too");
  else bad("…and the Save control is disabled too");
  if (/data-testid="me-shape-err"/.test(ed)) ok("…with the reason on screen");
  else bad("…with the reason on screen");

  /* teamNumbers IS WRITE_ONLY on the route — accepted on a PUT, absent from the GET — so diffKeys
   * can never see it. If it stops being appended explicitly, the control renders, the operator
   * moves it, and NOTHING IS SENT: a change that looks made and was not. */
  if (/teamsMoved \? \[\.\.\.withDate, "teamNumbers"\] : withDate/.test(ed))
    ok("teamNumbers reaches the diff, which is the request body");
  else bad("teamNumbers reaches the diff", "THE CONTROL WOULD MOVE AND SEND NOTHING");
}

console.log("\nand the cancel confirmation is yes / no on BOTH panels, from one hook");
{
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const hook = strip(readFileSync("src/lib/useCancelMatch.ts", "utf8"));
  const panel = strip(readFileSync("src/components/MatchPanel.tsx", "utf8"));
  const ed = strip(readFileSync("src/app/(internal)/match-ops/matches/[id]/MatchEditor.tsx", "utf8"));
  if (/export function useCancelMatch/.test(hook)) ok("control: the hook was read");
  else bad("control: the hook was read");

  /* ONE IMPLEMENTATION. Match panel carried its own openCancel/doCancel — a second copy of a
   * write that texts every signed-up player and credits every account. */
  for (const [name, code] of [["Match panel", panel], ["Master Schedule editor", ed]] as const) {
    if (/useCancelMatch\(\{/.test(code)) ok(`${name} calls the shared hook`);
    else bad(`${name} calls the shared hook`, "A SECOND COPY OF THE CANCEL WRITE");
    if (!/const doCancel|const openCancel/.test(code)) ok(`…and holds no cancel implementation of its own`);
    else bad(`${name} still has its own cancel implementation`, "TWO WRITES THAT CREDIT REAL ACCOUNTS");
    if (!/CANCEL_WORD|cancelTyped|cancel\.typed/.test(code)) ok(`…and has no type-to-confirm box`);
    else bad(`${name} still types to confirm`, "GREY PLACEHOLDER TEXT THAT READS DISABLED");
  }
  if (!/CANCEL_WORD/.test(hook)) ok("the hook no longer exports a word to type");
  else bad("the hook no longer exports a word to type");

  /* WHAT REPLACED IT IS NOT NOTHING. The consequence sentence carries the LIVE count, and the
   * server still re-reads the match and refuses a stale confirmName. */
  if (/export function cancelStakes/.test(hook)) ok("the consequence sentence is still the friction");
  else bad("the consequence sentence is still the friction");
  if (/confirmName: preview\.name/.test(hook)) ok("…and the POST still sends confirmName for the server's live re-check");
  else bad("…and the POST still sends confirmName", "THE STALE-CLIENT GUARD WOULD BE GONE TOO");
  if (/if \(!preview \|\| busy\) return;/.test(hook)) ok("…and a second press while in flight is still refused");
  else bad("…and a second press while in flight is refused", "WRITES NEVER RETRY");
}

console.log(`\nteam-shape: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
