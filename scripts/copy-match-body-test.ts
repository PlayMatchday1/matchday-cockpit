/* A COPY CARRIES ITS PRICE, OR A MATCH GOES LIVE AT $0.
 *
 * WHAT HAPPENED. Production match 18408 "Parmer Stadium - Premier" was created by Copy match on
 * 2026-08-25T17:00:03. change_log holds the request body verbatim — nine keys, and
 * registrationPrice is not one of them:
 *
 *     {"name":"Parmer Stadium - Premier","type":"REGULAR","endDate":"…","fieldId":1585,
 *      "startDate":"…","description":"…","teamNumbers":4,"isFreeMember":false,"maxPlayerCount":36}
 *
 * The API defaults an absent price to 0. The match sold 44 spots at $0 against $15 siblings; 14 of
 * them are marked PAID with no payment intent. All three copies ever made landed at 0 — 18408, and
 * staging 2530 and 2531 — so this was the button, not the match.
 *
 * WHY THE OLD SHAPE MADE IT INEVITABLE. CREATE_FIELDS was one list doing two jobs: the REQUIRED set
 * and the ALLOWED set. registrationPrice was therefore not merely un-required, it was actively
 * REFUSED — the route returns "not creatable: registrationPrice" for anything outside the list. A
 * client that tried to send the price would have been rejected.
 *
 * AND THERE IS NO SECOND LINE OF DEFENCE. Measured on staging 2026-08-31: a match has no
 * published / hidden / draft / visible / active field of any kind, and the create endpoint refuses
 * isCancelled outright — "property isCancelled should not exist". A created match is joinable from
 * the first millisecond, so the body being right at creation IS the whole safety.
 */

import { readFileSync } from "node:fs";
import { EDITABLE_KEYS } from "../src/lib/matchEditModel";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const ROUTE = strip(readFileSync("src/app/api/matchday/[env]/matches/create/route.ts", "utf8"));
const VIEW = strip(readFileSync("src/app/(internal)/match-ops/matches/[id]/MatchEditor.tsx", "utf8"));

console.log("\nthe route was read, and it still holds the two lists");
{
  // POSITIVE CONTROL FIRST: every check below is a regex over a string.
  if (/export async function POST/.test(ROUTE) && /const CREATE_REQUIRED/.test(ROUTE))
    ok("control: the create route was read");
  else bad("control: the create route was read", "THE CHECKS BELOW WOULD PASS ON AN EMPTY STRING");
  if (/const createMatch = async/.test(VIEW)) ok("control: the copy flow was read");
  else bad("control: the copy flow was read");
}

/* ── THE ASSERTION THIS FILE EXISTS FOR ────────────────────────────────────────────────────────
 * A create body from the copy flow contains registrationPrice. Named on its own, first, and with
 * the consequence in the failure text — because this is the one that would have caught 18408. */
console.log("\na copy carries its price");
{
  if (/^\s*\.\.\.CREATE_REQUIRED,\s*$/m.test(ROUTE) && /EDITABLE_KEYS\.filter/.test(ROUTE))
    ok("CREATE_FIELDS is REQUIRED plus EDITABLE_KEYS, so price is allowed through");
  else bad("registrationPrice is allowed on create",
    "A COPIED MATCH WOULD GO LIVE AT $0 — the API defaults an absent price to 0, and 18408 sold 44 spots that way");
  if (/for \(const k of EDITABLE_KEYS\)/.test(VIEW.slice(VIEW.indexOf("const createMatch"))))
    ok("…and the copy flow actually SENDS every editable key");
  else bad("the copy flow sends registrationPrice",
    "ALLOWING IT IS NOT SENDING IT — a match would still go live at $0");
}

console.log("\nand the same for every key the widened set adds");
{
  /* THE SET IS DERIVED, NOT LISTED. Writing the 24 names here would mean a key added to
   * EDITABLE_KEYS tomorrow is silently unasserted — the same class of omission as the bug. */
  const REQUIRED = ["name", "description", "type", "startDate", "endDate", "fieldId", "maxPlayerCount", "teamNumbers", "isFreeMember"];
  const added = EDITABLE_KEYS.filter((k) => !REQUIRED.includes(k));
  is("the widened set adds 18 keys the old nine refused", added.length, 18);
  ok(`  they are: ${added.join(", ")}`);
  /* Each one is asserted through the DERIVATION rather than by name: if CREATE_FIELDS is
   * REQUIRED ∪ EDITABLE_KEYS and the client loops EDITABLE_KEYS, every member is carried. Both
   * halves are pinned above; this pins that the source of truth is the shared constant. */
  if (/\(CREATE_REQUIRED as readonly string\[\]\)\.includes\(k\)/.test(ROUTE)) ok("…and they are derived from EDITABLE_KEYS, not re-listed");
  else bad("the added keys are derived from EDITABLE_KEYS", "A RE-LISTED SET GOES STALE THE NEXT TIME ONE IS ADDED");
  for (const k of ["registrationPrice", "additionalSpotPrice", "guestCount"]) {
    if ((EDITABLE_KEYS as readonly string[]).includes(k)) ok(`  ${k} is in the set the copy sends`);
    else bad(`${k} is in the set the copy sends`, "IT WAS ONE OF THE THREE THAT BIT US");
  }
}

console.log("\nREQUIRED and ALLOWED are two lists, which is what went wrong");
{
  if (/const missing = CREATE_REQUIRED\.filter/.test(ROUTE)) ok("the required check reads CREATE_REQUIRED");
  else bad("the required check reads CREATE_REQUIRED",
    "CHECKING THE ALLOWED SET WOULD DEMAND A managerId ON EVERY COPY");
  if (/!\(CREATE_FIELDS as readonly string\[\]\)\.includes\(k\)/.test(ROUTE)) ok("…and the not-creatable check reads CREATE_FIELDS");
  else bad("the not-creatable check reads CREATE_FIELDS");
  // The nullable ones must NOT be required, or a copy of a match with no second manager is refused.
  const REQ = ROUTE.slice(ROUTE.indexOf("const CREATE_REQUIRED"), ROUTE.indexOf("const CREATE_FIELDS"));
  for (const k of ["managerId", "secondManagerId", "additionalSpotPrice", "registrationPrice"]) {
    if (!REQ.includes(`"${k}"`)) ok(`  ${k} is allowed but NOT required`);
    else bad(`${k} must not be required`, "A COPY WITH THAT FIELD EMPTY WOULD BE REFUSED");
  }
}

console.log("\nonly what was supplied goes on the wire");
{
  if (/if \(k in match\) payload\[k\] = match\[k\]/.test(ROUTE)) ok("an absent optional stays absent");
  else bad("an absent optional stays absent", "the diff IS the request body");
}

console.log("\nthere is no paused state to fall back on — measured, not assumed");
{
  /* Recorded here because it is the reason §1 is the WHOLE fix. A match object carries no
   * published/hidden/draft/visible flag, and the create endpoint refuses isCancelled by name. */
  const FULL = readFileSync("src/app/api/matchday/[env]/matches/create/route.ts", "utf8");
  if (/property isCancelled should not exist/.test(FULL)) ok("the finding is recorded where the fix lives");
  else bad("the no-paused-state finding is recorded", "the next reader will re-derive it");
  if (/no published \/ hidden \/ draft \/ visible/i.test(FULL) || /joinable from the first millisecond/i.test(FULL))
    ok("…and says why the body being right at creation IS the safety");
  else bad("…and says why the body must be right at creation");
}

console.log(`\ncopy-match-body: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
