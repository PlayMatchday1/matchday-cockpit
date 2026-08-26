import "server-only"; // no-op under --conditions=react-server
// ASSIGNING A MATCH MANAGER TO A MATCH — the write that decides who gets paid.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/manager-assign-test.ts
//
// IN THE FAST SET, and it belongs there under the bar's one exception: this changes what a match
// record says happened and what Manager Pay pays. Four failure modes, none visible on screen:
//
//   1. "" ON THE WIRE. A cleared <select> yields "", the API rejects "" with a 400, and the
//      operator sees "save failed" for a control that looked like it had a blank option.
//   2. A NULL managerId SELECTING THE FIRST OPTION. `value={Number(cur.managerId ?? 0)}` matches no
//      <option>, so the browser paints whichever manager sorts first — and a blind Save attaches
//      them. The match looks managed; nobody chose that person.
//   3. THE WHOLE MATCH AS THE BODY. The diff IS the request body; a PUT carrying unchanged fields
//      is a write nobody asked for on a route with PATCH semantics.
//   4. A CONFIRMATION THAT NAMES AN ID. "Attach id 41207" confirms nothing a human can check.
//
// AND THE MONEY RULE IS NOT RESTATED HERE. payAmount is imported from managerPayCompute — the same
// function the payroll runs on — so a change to the $20/$30 bands cannot make this suite disagree
// with the pay sheet. That is the Crossbar/PARMER shape and it is closed by construction.

import {
  normalizeManagerId, assignBody, pickerOptions, offeredCounts, confirmLines,
  DETACH_VALUE, DETACH_PROOF, CAN_ASSIGN_MANAGER_TO_MATCH, CAN_UNASSIGN_MANAGER_FROM_MATCH,
} from "../src/lib/managerAssign";
import { payAmount } from "../src/lib/managerPayCompute";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

console.log("ASSIGN A MATCH MANAGER\n");

// ── 1. "" NEVER REACHES THE WIRE ──────────────────────────────────────────────────────────────
console.log('the detach value: null detaches, "" is a 400');
{
  is("an empty select value becomes null", normalizeManagerId(""), null);
  is("the picker's own sentinel becomes null", normalizeManagerId("none"), null);
  is("undefined becomes null", normalizeManagerId(undefined), null);
  is("null stays null", normalizeManagerId(null), null);
  is("0 is not a manager", normalizeManagerId(0), null);
  is("a negative id is not a manager", normalizeManagerId(-3), null);
  is("garbage is not a manager", normalizeManagerId("abc"), null);
  is("a numeric string becomes a number", normalizeManagerId("41207"), 41207);
  is("a number stays a number", normalizeManagerId(41207), 41207);
  is("DETACH_VALUE is null and nothing else", DETACH_VALUE, null);
  // The proof is carried in the code so the next person does not re-run the probe or, worse,
  // disable the control on a guess.
  if (/staging match 3/i.test(DETACH_PROOF) && /400/.test(DETACH_PROOF)) ok("the detach proof names the staging probe and the 400");
  else bad("the detach proof names the staging probe and the 400", DETACH_PROOF);
  is("unassign is ENABLED — null was proven to detach", CAN_UNASSIGN_MANAGER_FROM_MATCH, true);
  is("assign is enabled", CAN_ASSIGN_MANAGER_TO_MATCH, true);
  // Whatever a select can produce, the body is a number or null. Never "".
  for (const raw of ["", "none", null, undefined, 0, "0", "abc", "41207", 41207, -1, NaN]) {
    const b = assignBody(raw, 999);
    if (b === null || b.managerId === null || typeof b.managerId === "number") continue;
    bad(`a body built from ${JSON.stringify(raw)} is a number or null`, JSON.stringify(b));
  }
  ok('no select value can put "" in the body');
}

// ── 2. THE DIFF IS THE REQUEST BODY ───────────────────────────────────────────────────────────
console.log("\nthe body: one key, and only when it changed");
{
  is("attach sends only managerId", assignBody(41207, null), { managerId: 41207 });
  is("swap sends only managerId", assignBody(41207, 500), { managerId: 41207 });
  is("detach sends managerId null", assignBody(null, 500), { managerId: null });
  is("no change sends NOTHING", assignBody(500, 500), null);
  is('"" against an already-detached match sends nothing', assignBody("", null), null);
  is("a string id equal to the current id sends nothing", assignBody("500", 500), null);
  const b = assignBody(41207, 500)!;
  is("the body has exactly one key", Object.keys(b), ["managerId"]);
}

// ── 3. THE PICKER: CITY BY DEFAULT, A VISIBLE ESCAPE, AND THE CURRENT PERSON ALWAYS ───────────
console.log("\nthe picker: 28 of 87 by default for an Austin fixture");
{
  // Shaped from the measured production figures: /city-managers/users?cityId=1 -> 28, and the same
  // endpoint with no cityId -> 87.
  const all = Array.from({ length: 87 }, (_, i) => ({ id: 1000 + i, name: `Manager ${String(i).padStart(2, "0")}` }));
  const city = all.slice(0, 28);
  const c = offeredCounts(city, all);
  is("an Austin fixture offers 28 by default", c.city, 28);
  is("…of 87 in total", c.all, 87);
  is("…so 59 are behind the escape", c.hidden, 59);
  is("collapsed, the picker offers the city roster", pickerOptions(city, all, false).length, 28);
  is("expanded, it offers everyone", pickerOptions(city, all, true).length, 87);
  is("nobody is offered twice when the lists overlap", new Set(pickerOptions(city, all, true).map((o) => o.id)).size, 87);
  is("nobody on the city roster is labelled off-city", pickerOptions(city, all, false).filter((o) => o.offCity).length, 0);
  is("expanded, exactly the 59 extras are labelled off-city", pickerOptions(city, all, true).filter((o) => o.offCity).length, 59);
  is("off-city people sort AFTER the city's own", pickerOptions(city, all, true).slice(0, 28).every((o) => !o.offCity), true);

  // THE CURRENT MANAGER IS ALWAYS AN OPTION. A match attached to someone who has since come off
  // this city's roster must still render THEIR name — a picker that drops them shows a different
  // person than the match has, and the next Save attaches that different person.
  const gone = { id: 99999, name: "Left The Roster" };
  const withGone = pickerOptions(city, all, false, gone);
  is("a manager on neither list is still offered when the match has them", withGone.length, 29);
  is("…and is labelled off-city", withGone.find((o) => o.id === gone.id)?.offCity, true);
  is("…and is not duplicated when they ARE on the roster", pickerOptions(city, all, false, city[0]).length, 28);

  // A city with nobody hidden must not offer a pointless escape.
  is("when every manager covers the city, nothing is hidden", offeredCounts(all, all).hidden, 0);
}

// ── 4. THE CONFIRMATION NAMES THE PERSON, THE MATCH AND THE MONEY ─────────────────────────────
console.log("\nthe confirmation: a person, a match, an amount — never an id");
{
  const base = { matchName: "Crossbar Rowlett 8v8", whenText: "2026-09-02 20:30", cityLabel: "Dallas",
                 maxPlayerCount: 16, coManaged: false, offCity: false };
  const attach = confirmLines({ ...base, fromName: null, toName: "Marisol Reyes" });
  const txt = attach.join(" ");
  if (txt.includes("Marisol Reyes")) ok("it names the person"); else bad("it names the person", txt);
  if (txt.includes("Crossbar Rowlett 8v8")) ok("it names the match"); else bad("it names the match", txt);
  if (txt.includes("2026-09-02 20:30")) ok("it names when"); else bad("it names when", txt);
  if (/\$\d+/.test(txt)) ok("it names the amount"); else bad("it names the amount", txt);
  if (/never retried/i.test(txt)) ok("it says the write is never retried"); else bad("it says the write is never retried", txt);
  // POSITIVE CONTROL for the absence check below: the pattern fires on a line that DOES name an id.
  if (/\bid \d+/.test("Attach id 41207 to this match")) ok("control: the bare-id pattern fires when an id is there");
  else bad("control: the bare-id pattern fires when an id is there", "THE REGEX MATCHES NOTHING");
  if (!/\bid \d+/.test(txt)) ok("it never confirms a bare id"); else bad("it never confirms a bare id", txt);

  const swap = confirmLines({ ...base, fromName: "Marisol Reyes", toName: "Joba" }).join(" ");
  if (swap.includes("Marisol Reyes") && swap.includes("Joba")) ok("a swap names BOTH people");
  else bad("a swap names BOTH people", swap);
  if (/moves from/i.test(swap)) ok("…and says the money moves between them"); else bad("…and says the money moves", swap);

  const detach = confirmLines({ ...base, fromName: "Joba", toName: null }).join(" ");
  if (/detach/i.test(detach) && detach.includes("Joba")) ok("a detach names who is being removed");
  else bad("a detach names who is being removed", detach);
  if (/stops paying/i.test(detach)) ok("…and says the pay stops"); else bad("…and says the pay stops", detach);

  const off = confirmLines({ ...base, fromName: null, toName: "Joba", offCity: true }).join(" ");
  if (/off-city/i.test(off)) ok("an off-city assignment says so"); else bad("an off-city assignment says so", off);
  if (!/off-city/i.test(attach.join(" "))) ok("an in-city one does not"); else bad("an in-city one does not");

  /* THE AMOUNT COMES FROM THE PAYROLL'S OWN FUNCTION. Not restated here — asserted to agree with
   * payAmount across every band, so a change to the bands moves both or fails here. This is the
   * two-paths-one-question shape that cost four months and $191 on PARMER. */
  for (const [max, co] of [[10, false], [16, false], [22, false], [30, false], [16, true], [30, true]] as [number, boolean][]) {
    const want = payAmount(max, co);
    const line = confirmLines({ ...base, maxPlayerCount: max, coManaged: co, fromName: null, toName: "X" }).join(" ");
    if (line.includes(`$${want}`)) ok(`max ${max}${co ? " co-managed" : ""} confirms $${want} — payAmount's own figure`);
    else bad(`max ${max}${co ? " co-managed" : ""} confirms $${want}`, line);
  }
  is("a null max_player_count still names an amount", /\$\d+/.test(confirmLines({ ...base, maxPlayerCount: null, fromName: null, toName: "X" }).join(" ")), true);
}

// ── 5. THE PANEL WIRES IT THE WAY THE MODEL EXPECTS ───────────────────────────────────────────
console.log("\nthe panel: the select cannot paint a person nobody chose");
{
  const raw = readFileSync("src/components/MatchPanel.tsx", "utf8");
  /* READ THE CODE, NOT THE PROSE — the same false positive the auth census fixed. The comment
   * beside this select QUOTES the old form to explain what it broke, and the first version of this
   * assertion went red on that comment. Strip comments before deciding what the file DOES. */
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
  /* THE BUG THIS PINS. `value={Number(cur.managerId ?? 0)}` matches no <option>, so a match with no
   * manager rendered whichever manager sorted first and a blind Save would have attached them. The
   * value must be a STRING with an explicit "none" option behind it. */
  if (/value=\{cur\.managerId == null \? "none" : String\(cur\.managerId\)\}/.test(src))
    ok("a null managerId selects the explicit no-manager option");
  else bad("a null managerId selects the explicit no-manager option", "the select would paint the first manager");
  if (/value=\{cur\.secondManagerId == null \? "none" : String\(cur\.secondManagerId\)\}/.test(src))
    ok("…and so does a null secondManagerId");
  else bad("…and so does a null secondManagerId");
  if (!/Number\(cur\.managerId \?\? 0\)/.test(src)) ok("the Number(... ?? 0) form is gone from the CODE");
  else bad("the Number(... ?? 0) form is gone from the CODE", "it is still live in MatchPanel");
  if (/Number\(cur\.managerId \?\? 0\)/.test(raw)) ok("…and the comment beside the select still records why it was wrong");
  else bad("…and the comment beside the select still records why it was wrong", "the trap is unrecorded");
  // POSITIVE CONTROL: the pattern above does find that form when it is present.
  if (/Number\(cur\.managerId \?\? 0\)/.test('value={Number(cur.managerId ?? 0)}')) ok("control: the pattern finds the old form when it is there");
  else bad("control: the pattern finds the old form when it is there", "THE REGEX MATCHES NOTHING");

  for (const t of ["mp-mgr", "mp-mgr2"]) {
    if (new RegExp(`data-testid="${t}"[\\s\\S]{0,300}?normalizeManagerId\\(e\\.target\\.value\\)`).test(src))
      ok(`${t} routes its value through normalizeManagerId`);
    else bad(`${t} routes its value through normalizeManagerId`, "a raw \"\" could reach the body");
  }
  for (const t of ["mp-mgr-confirm", "mp-mgr-go", "mp-mgr-cancel", "mp-mgr-allcities"])
    if (src.includes(`data-testid="${t}"`)) ok(`${t} is on the panel`); else bad(`${t} is on the panel`);
  // SAVE MUST NOT COMMIT A MANAGER CHANGE UNCONFIRMED.
  if (/mgrChanged\.length > 0 && !confirmedMgr/.test(src)) ok("Save stops on a manager change until it is confirmed");
  else bad("Save stops on a manager change until it is confirmed");
  if (/setMgrConfirm\(null\)/.test(src)) ok("Cancel clears the confirmation and sends nothing");
  else bad("Cancel clears the confirmation and sends nothing");
  // The escape must be a real control, not a hidden affordance.
  if (/Show managers from all cities/.test(src)) ok("the show-all-cities escape is a visible, labelled control");
  else bad("the show-all-cities escape is visible");
}

// ── 6. THE ROUTE STILL SENDS THE DIFF, AND ONLY OVER THE GUARDED CLIENT ───────────────────────
console.log("\nthe route: the diff is the body, and it goes through the guarded client");
{
  const r = readFileSync("src/app/api/matchday/[env]/matches/[id]/route.ts", "utf8");
  if (/apiWrite\(env, "PUT", `\/admin\/matches\/\$\{id\}`, changes, actor\)/.test(r))
    ok("the PUT body IS `changes` — never the whole match");
  else bad("the PUT body IS `changes`");
  if (/recordWrite\(/.test(r)) ok("every write goes through recordWrite into change_log"); else bad("recordWrite is wired");
  if (/refreshMatchMirror\(/.test(r)) ok("the mirror is refreshed from the read-back"); else bad("the mirror is refreshed");
  if (/managersAllCities/.test(r)) ok("the route serves the all-cities escape list"); else bad("the route serves the all-cities escape list");
  /* THE MIRROR MUST REWRITE THE EMAIL, NOT JUST THE ID. Manager Pay groups on manager_email; this
   * write sets managerId. They are one source only because the write-through rewrites both from the
   * SAME read-back payload. A path that set manager_id alone would keep paying the previous person. */
  const w = readFileSync("src/lib/mirrorWriteThrough.ts", "utf8");
  const block = w.match(/keys\.includes\("managerId"\)[\s\S]{0,500}?\n  \}/);
  if (block && /patch\.manager_email/.test(block[0]) && /patch\.manager_id/.test(block[0]))
    ok("a managerId write rewrites manager_email too — the column Manager Pay actually groups on");
  else bad("a managerId write rewrites manager_email too", "MANAGER PAY WOULD KEEP PAYING THE PREVIOUS PERSON");
  if (block && /patch\.manager_first_name/.test(block[0]) && /patch\.manager_last_name/.test(block[0]))
    ok("…and the denormalised name, so the pay sheet does not show the old one");
  else bad("…and the denormalised name");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
