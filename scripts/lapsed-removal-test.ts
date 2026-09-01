/* THE LAPSED-SPOT REMOVAL CONTROL — a production write path with NO UNDO.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE OTHER SUITES. Every other guard here protects a number on a
 * screen. This one protects a DELETE against a live roster that cannot be reversed: a freed spot
 * can be taken by a new registration within seconds, and re-adding needs an open slot that may no
 * longer exist. There is no rollback, so the assertions below are the last thing standing between
 * a mis-selection and a player who turns up to a match they are no longer on.
 *
 * EVERY ASSERTION CARRIES A CONTROL. The passing value of most of these is a refusal, an absence
 * or a zero, and a model that silently returns nothing produces exactly the same answer as a model
 * that correctly refuses. Where the control is not obvious it is named "control:" and it fails
 * loudly if the thing being asserted was never exercised.
 *
 * WRITES: none. This file calls no endpoint. The staging round-trip is a separate, deliberate run
 * — see the report — because a suite that writes production is banned and a suite that writes
 * STAGING on every push is still a suite that fires a DELETE sixty times a day.
 */

import { readFileSync } from "node:fs";
import {
  buildLapsedSpots, guardFor, defaultChecked, membershipStateOf,
  confirmSentence, confirmCounts, removalCsv, HALTS_RUN, INTERNAL_EMAIL_RX, hasStarted,
  type SubRow, type SpotRow, type MatchRow, type LapsedSpot, type RemovalResult,
} from "../src/lib/lapsedSpots";
import { assertAllowedEndpoint, DeniedEndpointError } from "../src/lib/matchdayStageApi";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const TODAY = "2026-08-31";

/* ── THE FIXTURE. Every guard branch is populated, so no assertion below can pass by being empty.
 * Three people in the LAPSED bucket, one PAST_DUE, one ACTIVE, plus a staff row, a paid row and a
 * match carrying a guest. */
const MATCHES: MatchRow[] = [
  { api_id: 900, name: "Sept Opener", start_date: "2026-09-04T19:00:00Z", is_cancelled: false, city_name: "Austin", field_title: "NEMP" },
  { api_id: 901, name: "Sept Second", start_date: "2026-09-11T19:00:00Z", is_cancelled: false, city_name: "Austin", field_title: "Parmer" },
  { api_id: 902, name: "Guest Match", start_date: "2026-09-06T19:00:00Z", is_cancelled: false, city_name: "Houston", field_title: "ATH Katy" },
  { api_id: 903, name: "Yesterday", start_date: "2026-08-30T19:00:00Z", is_cancelled: false, city_name: "Austin", field_title: "NEMP" },
];
let umId = 5000;
const spot = (o: Partial<SpotRow>): SpotRow => ({
  api_id: umId++, match_api_id: 900, user_id: 1, user_email: "a@gmail.com",
  user_first_name: "A", user_last_name: "Player", paid_status: "FREE", user_type: "PLAYER",
  amount: 0, is_cancelled: false, user_is_fake_player: false, is_first_match: false, ...o,
});
const SPOTS: SpotRow[] = [
  // user 1 — lapsed, TWO spots, both clean. The person-checkbox case.
  spot({ user_id: 1, match_api_id: 900 }),
  spot({ user_id: 1, match_api_id: 901 }),
  // user 2 — lapsed, PAID. Must be blocked.
  spot({ user_id: 2, match_api_id: 900, user_email: "paid@gmail.com", user_first_name: "P", amount: 1299 }),
  // user 3 — lapsed, STAFF email on the roster row.
  spot({ user_id: 3, match_api_id: 900, user_email: "ops@playmatchday.com", user_first_name: "S" }),
  // user 4 — lapsed, on a match that also carries a GUEST.
  spot({ user_id: 4, match_api_id: 902, user_email: "host@gmail.com", user_first_name: "H" }),
  spot({ user_id: 9, match_api_id: 902, user_email: "host@gmail.com", user_type: "GUEST" }),
  // user 5 — PAST_DUE, clean otherwise.
  spot({ user_id: 5, match_api_id: 901, user_email: "dunning@gmail.com", user_first_name: "D" }),
  // user 6 — ACTIVE member. Context only, never selectable.
  spot({ user_id: 6, match_api_id: 901, user_email: "active@gmail.com", user_first_name: "M" }),
  // user 7 — lapsed but the match is in the PAST. Must not appear at all.
  spot({ user_id: 7, match_api_id: 903, user_email: "past@gmail.com" }),
  // a fake player and a cancelled row — neither is a person to act on.
  spot({ user_id: 8, match_api_id: 900, user_is_fake_player: true }),
  spot({ user_id: 10, match_api_id: 900, is_cancelled: true }),
];
const SUBS: SubRow[] = [
  { user_id: 1, status: "CANCELED", canceled_at: "2026-08-02T10:00:00+00:00", cancel_reason: "Moving", member_email: "a@gmail.com" },
  { user_id: 2, status: "CANCELED", canceled_at: "2026-08-03T10:00:00+00:00", cancel_reason: null, member_email: "paid@gmail.com" },
  { user_id: 3, status: "CANCELED", canceled_at: "2026-08-04T10:00:00+00:00", cancel_reason: null, member_email: "ops@playmatchday.com" },
  { user_id: 4, status: "CANCELED", canceled_at: "2026-08-05T10:00:00+00:00", cancel_reason: null, member_email: "host@gmail.com" },
  { user_id: 5, status: "PAST_DUE", canceled_at: null, cancel_reason: null, member_email: "dunning@gmail.com" },
  { user_id: 6, status: "ACTIVE", canceled_at: null, cancel_reason: null, member_email: "active@gmail.com" },
  { user_id: 7, status: "CANCELED", canceled_at: "2026-08-06T10:00:00+00:00", cancel_reason: null, member_email: "past@gmail.com" },
];

const V = buildLapsedSpots(MATCHES, SPOTS, SUBS, TODAY);
const group = (st: string) => V.groups.find((g) => g.state === st)!;
const bySpotUser = (st: string, uid: number) => group(st).rows.find((r) => r.userId === uid);

console.log("\ncontrol: the fixture produced rows in every bucket this file asserts on");
{
  if (V.groups.length === 4) ok("four buckets exist (LAPSED · PAST_DUE · ACTIVE · NEVER_A_MEMBER)");
  else bad("four buckets exist", `${V.groups.length}`);
  for (const [st, n] of [["LAPSED", 5], ["PAST_DUE", 1], ["ACTIVE", 1]] as [string, number][]) {
    if (group(st).rows.length === n) ok(`  control: ${st} holds ${n} spot row(s)`);
    else bad(`control: ${st} holds ${n} row(s)`, `got ${group(st).rows.length} — EVERY ASSERTION ON THIS BUCKET WOULD BE VACUOUS`);
  }
  is("the PAST match is excluded entirely", V.groups.flatMap((g) => g.rows).some((r) => r.matchId === 903), false);
  is("the fake player is excluded", V.groups.flatMap((g) => g.rows).some((r) => r.userId === 8), false);
  is("the cancelled row is excluded", V.groups.flatMap((g) => g.rows).some((r) => r.userId === 10), false);
}

console.log("\n1. A SPOT WITH paid > $0 CANNOT BE SELECTED");
{
  const paid = bySpotUser("LAPSED", 2)!;
  is("  it is BLOCKED, not merely cautioned", paid.guard.selectability, "blocked");
  is("  it is not checked by default", defaultChecked(paid.guard), false);
  if (/Paid \$12\.99/.test(paid.guard.reason ?? "")) ok("  and the chip states the amount");
  else bad("the blocked chip states the amount", paid.guard.reason ?? "(none)");
  // CONTROL: an otherwise identical row at $0 IS selectable — so "blocked" is the money, not the model.
  const free = guardFor({ amountCents: 0, isStaff: false, state: "LAPSED" });
  is("  control: the same row at $0 is selectable", [free.selectability, defaultChecked(free)], ["ok", true]);
  // ...and one cent is enough.
  is("  one cent is enough to block it", guardFor({ amountCents: 1, isStaff: false, state: "LAPSED" }).selectability, "blocked");
  /* THE VIEW MUST ENFORCE IT TWICE: disabled in the markup AND filtered out of the resolved
   * selection. A checkbox is a control and a control can be driven by something other than a
   * click. */
  const VIEW = readFileSync("src/components/LapsedSpotsView.tsx", "utf8");
  if (/disabled=\{r\.guard\.selectability === "blocked"/.test(VIEW)) ok("  the input is disabled for a blocked row");
  else bad("the blocked input is disabled", "A PAID SPOT COULD BE TICKED");
  if (/picked\.has\(r\.spotId\) && r\.guard\.selectability !== "blocked"/.test(VIEW)) ok("  …and blocked rows are filtered OUT of the resolved selection too");
  else bad("blocked rows are filtered from the selection", "DISABLING THE INPUT IS NOT THE SAME AS REFUSING THE ACTION");
}

console.log("\n2. A STAFF-EMAIL ROW IS UNCHECKED BY DEFAULT AND ITS CHIP RENDERS");
{
  const staff = bySpotUser("LAPSED", 3)!;
  is("  it is flagged staff", staff.isStaff, true);
  is("  caution, not blocked — an operator may still opt in", staff.guard.selectability, "caution");
  is("  unchecked by default", defaultChecked(staff.guard), false);
  is("  the chip says why", staff.guard.reason, "Internal staff account");
  // CONTROL: the same person on a normal address IS checked by default.
  const normal = bySpotUser("LAPSED", 1)!;
  is("  control: a non-staff lapsed row IS checked by default", [normal.isStaff, defaultChecked(normal.guard)], [false, true]);
  // The regex is the ONE from membershipStats, not a second copy.
  const LIB = readFileSync("src/lib/lapsedSpots.ts", "utf8");
  if (/import \{ INTERNAL_EMAIL_RX \} from "\.\/membershipStats"/.test(LIB)) ok("  the regex is IMPORTED from membershipStats, not retyped");
  else bad("INTERNAL_EMAIL_RX is imported", "A SECOND COPY IS HOW THE FOUR STAFF ACCOUNTS READ AS MEMBERS FOR A MONTH");
  is("  control: the regex actually matches a staff address", INTERNAL_EMAIL_RX.test("ops@playmatchday.com"), true);
  is("  control: …and rejects a real one", INTERNAL_EMAIL_RX.test("a@gmail.com"), false);
  /* AND IT IS CHECKED ON THE SUBSCRIPTION SIDE TOO — a staff member can hold a subscription under
   * a different address from the one on the roster row. */
  const viaSub = buildLapsedSpots(MATCHES, [spot({ user_id: 77, match_api_id: 900, user_email: "personal@gmail.com" })],
    [{ user_id: 77, status: "CANCELED", canceled_at: "2026-08-02T10:00:00Z", member_email: "dev@matchday.com" }], TODAY);
  is("  staff is caught via the SUBSCRIPTION email too", viaSub.groups.find((g) => g.state === "LAPSED")!.rows[0].isStaff, true);
}

console.log("\n3. A PAST_DUE MEMBER DOES NOT APPEAR IN LAPSED");
{
  is("  PAST_DUE is its own bucket", group("PAST_DUE").rows.map((r) => r.userId), [5]);
  is("  and is absent from LAPSED", group("LAPSED").rows.some((r) => r.userId === 5), false);
  is("  the bucket is labelled payment pending, not lapsed",
    /payment pending/i.test(require("../src/lib/lapsedSpots").STATE_LABEL.PAST_DUE), true);
  /* DEFENSIVE, ON PURPOSE. If the bucket is empty this must REPORT, not throw — a suite that dies
   * mid-file leaves every later assertion unrun and the exit code says only "something broke". */
  const pd = group("PAST_DUE").rows[0];
  if (!pd) bad("PAST_DUE has a row to inspect", "THE BUCKET IS EMPTY — THE SPLIT IS NOT WORKING");
  else {
    /* ── INVERTED 2026-09-01 (assertion body, itemised) ───────────────────────────────────────
     * This asserted PAST_DUE was UNCHECKED with the dunning text as its guard reason. The ruling
     * reversed it: removing a past-due member IS the lever that gets a failed card fixed, so they
     * are TICKED like anyone else. The dunning note survives as CONTEXT on the row — a chip that
     * said "excluded" beside a ticked box would be copy contradicting the checkbox, which is
     * worse than no copy. The SEPARATION is unchanged and still asserted above. */
    is("  TICKED by default — removal is the lever, not the exclusion", defaultChecked(pd.guard), true);
    is("  …so it carries no guard reason", pd.guard.reason, null);
    is("  …and the dunning note moved to the context chip", pd.contextChip, "Payment pending — still in dunning");
    // CONTROL: the context chip is not on every row — it would say nothing if it were.
    is("  control: a plain LAPSED row has no context chip", bySpotUser("LAPSED", 1)!.contextChip, null);
    // CONTROL: the guard still refuses the things it always refused, on a PAST_DUE row too.
    is("  control: a PAID past-due row is still BLOCKED",
      guardFor({ amountCents: 500, isStaff: false, state: "PAST_DUE" }).selectability, "blocked");
    is("  control: a STAFF past-due row is still caution",
      guardFor({ amountCents: 0, isStaff: true, state: "PAST_DUE" }).selectability, "caution");
  }
  // ORDER: PAST_DUE beats a stale ACTIVE row on the same person.
  const both = new Map<string, SubRow[]>([["50", [
    { user_id: 50, status: "ACTIVE", member_email: "x@gmail.com" },
    { user_id: 50, status: "PAST_DUE", member_email: "x@gmail.com" },
  ]]]);
  is("  PAST_DUE wins over a stale ACTIVE row on the same person", membershipStateOf(50, both), "PAST_DUE");
  // CONTROL: before this change the same person resolved to LAPSED. Prove the branch is live by
  // showing a CANCELED-only person still resolves to LAPSED.
  const only = new Map<string, SubRow[]>([["51", [{ user_id: 51, status: "CANCELED", member_email: "y@gmail.com" }]]]);
  is("  control: a CANCELED-only person is still LAPSED", membershipStateOf(51, only), "LAPSED");
  is("  control: someone with no rows is still NEVER_A_MEMBER", membershipStateOf(52, new Map()), "NEVER_A_MEMBER");
}

console.log("\n4. THE CONFIRM SENTENCE'S N, M AND K COME FROM THE SELECTION, NOT THE PAGE TOTAL");
{
  // user 1 holds two spots on two matches; add user 4's single spot -> 3 spots, 2 people, 3 matches.
  const sel: LapsedSpot[] = [...group("LAPSED").rows.filter((r) => r.userId === 1), bySpotUser("LAPSED", 4)!];
  is("  counts", confirmCounts(sel), { spots: 3, people: 2, matches: 3 });
  const sentence = confirmSentence(sel);
  is("  the sentence", sentence,
    "Remove 3 spots from 2 people across 3 matches. This cannot be undone — a freed spot can be " +
    "taken by a new registration immediately, and re-adding requires an open slot.");
  // THE CONTROL THAT MATTERS: the page total is DIFFERENT from the selection, so a sentence built
  // from the total would be visibly wrong here.
  const everything = V.groups.flatMap((g) => g.rows);
  if (everything.length !== sel.length) ok(`  control: the page holds ${everything.length} rows but the selection is ${sel.length} — the two cannot be confused`);
  else bad("control: the page total differs from the selection", "THE ASSERTION ABOVE WOULD PASS ON EITHER");
  is("  singulars are handled", confirmSentence([bySpotUser("LAPSED", 4)!]).startsWith("Remove 1 spot from 1 person across 1 match."), true);
  // The view must call confirmSentence, not assemble its own string.
  const VIEW = readFileSync("src/components/LapsedSpotsView.tsx", "utf8");
  if (/confirmSentence\(selected\)/.test(VIEW)) ok("  the dialog renders confirmSentence(selected)");
  else bad("the dialog uses confirmSentence(selected)", "A LOCALLY ASSEMBLED SENTENCE CAN QUIETLY START READING THE PAGE TOTAL");
  if (/const selected: LapsedSpot\[\] = useMemo/.test(VIEW)) ok("  …over the resolved selection, which excludes blocked rows");
  else bad("`selected` is the resolved selection");
}

console.log("\n5. REMOVAL CALLS user-matches/{userMatchId}, NEVER players/{userId}");
{
  const ROUTE = readFileSync("src/app/api/matchday/[env]/roster/[matchId]/route.ts", "utf8");
  if (/case "remove": method = "DELETE"; path = `\/admin\/matches\/user-matches\/\$\{op\.userMatchId\}`/.test(ROUTE))
    ok("  the route builds DELETE /admin/matches/user-matches/{userMatchId}");
  else bad("remove uses user-matches/{userMatchId}",
    "/admin/matches/{id}/players/{userId} RETURNS 403 USER_NOT_JOINED — the facts doc records it as a conflict");
  const VIEW = readFileSync("src/components/LapsedSpotsView.tsx", "utf8");
  const call = VIEW.slice(VIEW.indexOf("const runRemoval"), VIEW.indexOf("const downloadCsv"));
  if (/userMatchId: r\.userMatchId/.test(call)) ok("  the client sends userMatchId, the ROSTER ROW id");
  else bad("the client sends userMatchId", "SENDING userId TARGETS THE WRONG RECORD");
  if (!/userMatchId: r\.userId|players\/\$\{/.test(call)) ok("  …and never userId, and never a raw path");
  else bad("the client never sends userId as userMatchId, nor a path", "THE PATH IS BUILT SERVER-SIDE");
  // The two ids are distinct in the model, so a mix-up is detectable rather than coincidental.
  const r1 = bySpotUser("LAPSED", 1)!;
  if (r1.userMatchId !== r1.userId) ok(`  control: userMatchId ${r1.userMatchId} and userId ${r1.userId} are different values`);
  else bad("control: the two ids differ in the fixture", "A MIX-UP WOULD BE INVISIBLE");

  /* THE DENY-LIST DISCRIMINATES BETWEEN THE TWO DELETEs — one path segment apart. */
  const H = "https://matchday-stage.herokuapp.com";
  try { assertAllowedEndpoint("DELETE", `${H}/admin/matches/user-matches/5001`); ok("  remove is ALLOWED by the endpoint deny-list"); }
  catch (e) { bad("remove is allowed", `THE CONTROL COULD NEVER FIRE — ${(e as Error).message.slice(0, 90)}`); }
  try { assertAllowedEndpoint("DELETE", `${H}/admin/matches/5001`); bad("match-delete is DENIED", "IT WAS ALLOWED — ONE SEGMENT SHORTER AND IT DESTROYS THE MATCH"); }
  catch (e) { is("  control: match-delete one segment shorter IS denied", e instanceof DeniedEndpointError, true); }
  try { assertAllowedEndpoint("PATCH", `${H}/admin/matches/9/players/3/refund-and-cancel`); bad("refund-and-cancel is DENIED", "IT WAS ALLOWED — IT MOVES MONEY"); }
  catch (e) { is("  control: refund-and-cancel is still denied", e instanceof DeniedEndpointError, true); }
  // …and prod-guard-test still asserts the pair, so this is not the only place it is held.
  const PG = readFileSync("scripts/prod-guard-test.ts", "utf8");
  if (/user-matches/.test(PG) && /admin\/matches\//.test(PG)) ok("  prod-guard-test still asserts the same pair");
  else bad("prod-guard-test asserts the deny pair", "THIS SUITE WOULD BE THE ONLY THING HOLDING IT");
}

console.log("\n6. AN UNKNOWN HALTS THE RUN AND LEAVES LATER ROWS UNTOUCHED");
{
  is("  unknown halts", HALTS_RUN("unknown"), true);
  for (const v of ["landed", "failed", "notapplied"] as const)
    is(`  control: ${v} does NOT halt — it is a settled fact about one row`, HALTS_RUN(v), false);
  const VIEW = readFileSync("src/components/LapsedSpotsView.tsx", "utf8");
  const run = VIEW.slice(VIEW.indexOf("const runRemoval"), VIEW.indexOf("const downloadCsv"));
  if (/if \(HALTS_RUN\(verdict\)\) \{[\s\S]*?break;/.test(run)) ok("  the loop BREAKS on a halting verdict");
  else bad("the run breaks on UNKNOWN", "LATER ROWS WOULD BE SENT AFTER AN AMBIGUOUS WRITE");
  if (/for \(const r of selected\)/.test(run)) ok("  …and it is a sequential for-loop, so a break actually stops the rest");
  else bad("the run is sequential", "Promise.all CANNOT BE HALTED — EVERY ROW WOULD ALREADY BE IN FLIGHT");
  if (!/Promise\.all|Promise\.allSettled/.test(run)) ok("  …with no parallel dispatch anywhere in it");
  else bad("no parallel dispatch", "A HALT AFTER THE FACT IS NOT A HALT");
  // NO RETRY. There is no Idempotency-Key on any MatchDay write.
  if (!/retry|retries/i.test(run)) ok("  and a failed row is never re-sent — there is no Idempotency-Key");
  else bad("no retry logic exists", "A DUPLICATE REMOVAL IS A SECOND WRITE AGAINST A MOVED ROSTER");
  // A network throw must be UNKNOWN, not failed: the request may have reached the API.
  if (/catch \(e\) \{[\s\S]{0,240}verdict = "unknown"/.test(run)) ok("  a network throw is UNKNOWN, never FAILED");
  else bad("a thrown request is UNKNOWN", "CALLING IT FAILED CLAIMS THE WRITE DID NOT HAPPEN");
  // Simulated: feed the halting check the sequence a timeout would produce.
  const seq: RemovalResult["verdict"][] = ["landed", "landed", "unknown", "landed"];
  const sent: RemovalResult["verdict"][] = [];
  for (const v of seq) { sent.push(v); if (HALTS_RUN(v)) break; }
  is("  simulated timeout: 3 of 4 sent, the 4th untouched", sent, ["landed", "landed", "unknown"]);
}

console.log("\n7. A ROW ALREADY ABSENT IS NEVER REPORTED LANDED");
{
  /* ── MEASURED ON STAGING 2026-08-31, AND IT IS NOT WHAT THE BRIEF ASSUMED ────────────────────
   * Re-firing DELETE /admin/matches/user-matches/5531 on a row that had just been removed returned
   * HTTP 404, body {"message":"User has not joined..."}. apiWrite raises WriteFailedError, and
   * outcomeForThrow maps that to FAILED — not NOT APPLIED.
   *
   * BOTH ARE CORRECT AND THEY ARE DIFFERENT FACTS. FAILED means "cleanly rejected, definitely did
   * not happen". NOT APPLIED is reserved for a 2xx whose read-back shows no change — which is
   * exactly what the WRONG endpoint produces, so the distinction is load-bearing. What matters for
   * a path with no undo is the half the brief got right: an absent row is NEVER reported LANDED.
   * This asserts the measured behaviour, not the assumed one. */
  const { outcomeForThrow } = require("../src/lib/changeLogModel");
  is("  a 404 on an already-absent row maps to FAILED", outcomeForThrow("WriteFailedError"), "failed");
  is("  control: an ambiguous error maps to UNKNOWN instead", outcomeForThrow("AmbiguousWriteError"), "unknown");
  if (outcomeForThrow("WriteFailedError") !== "landed") ok("  and it is NEVER landed — the half that matters");
  else bad("an absent row is never LANDED", "THE OPERATOR WOULD BE TOLD A REMOVAL WORKED WHEN NOTHING HAPPENED");
  /* The verdict is the SERVER'S read-back. The roster route's `applied` for remove is
   *     (_b, a) => !plOf(a).some((p) => p.id === op.userMatchId)
   * which is true when the row is gone — including when it was ALREADY gone. That is why the
   * route reads BEFORE as well: outcomeForOk maps a 2xx with no observed change to notapplied. */
  const ROUTE = readFileSync("src/app/api/matchday/[env]/roster/[matchId]/route.ts", "utf8");
  if (/op\.kind === "remove" \? \(_b, a\) => !plOf\(a\)\.some\(\(p\) => p\.id === op\.userMatchId\)/.test(ROUTE))
    ok("  remove's read-back asks whether the row is gone from the LIVE roster");
  else bad("remove has a read-back", "A 2xx WOULD BE REPORTED AS LANDED WITHOUT EVIDENCE");
  const CLM = readFileSync("src/lib/changeLogModel.ts", "utf8");
  if (/outcomeForOk = \(appliedReadback: boolean\)[^\n]*appliedReadback \? "landed" : "notapplied"/.test(CLM))
    ok("  a 2xx with no observed change is NOT APPLIED, never LANDED");
  else bad("outcomeForOk distinguishes landed from notapplied");
  const VIEW = readFileSync("src/components/LapsedSpotsView.tsx", "utf8");
  if (/verdict = j\.outcome as RemovalVerdict/.test(VIEW)) ok("  the client takes the SERVER's outcome verbatim");
  else bad("the client uses the server's outcome", "A CLIENT-DERIVED VERDICT IS AN INTENT, NOT A READ-BACK");
  if (!/verdict = "landed"/.test(VIEW)) ok("  …and never sets LANDED itself");
  else bad("the client never assigns landed", "THAT IS REPORTING INTENT AS FACT");
  // CONTROL: the four verdicts are distinct and all reachable in the result table.
  const results: RemovalResult[] = (["landed", "failed", "notapplied", "unknown"] as const)
    .map((v, i) => ({ spot: { ...bySpotUser("LAPSED", 1)!, spotId: 6000 + i }, verdict: v, detail: null }));
  const csv = removalCsv(results, "2026-08-31T12:00:00Z");
  for (const v of ["LANDED", "FAILED", "NOTAPPLIED", "UNKNOWN"]) {
    if (csv.includes(v)) ok(`  control: ${v} renders in the CSV`); else bad(`${v} renders`, "A VERDICT THAT CANNOT BE SHOWN CANNOT BE ACTED ON");
  }
}

console.log("\n8. EVERY REMOVAL IS LOGGED, WITH NO PHONE BEYOND LAST-4");
{
  const ROUTE = readFileSync("src/app/api/matchday/[env]/roster/[matchId]/route.ts", "utf8");
  if (/await recordWrite\(/.test(ROUTE)) ok("  the write goes through recordWrite");
  else bad("removal goes through recordWrite", "AN UNLOGGED PRODUCTION DELETE");
  if (!/apiWrite\(env, method, path, body, actor\)[\s\S]{0,40}\)\s*;\s*$/m.test(ROUTE.replace(/write: \(\) => /g, "")))
    ok("  …and apiWrite is only reachable as recordWrite's write callback");
  else bad("apiWrite is only called inside recordWrite", "A BARE apiWrite IS AN UNLOGGED WRITE");
  // The logged `changes` for a remove are built from the NAME only.
  if (/key: "remove", field: "Remove from match", before: nameOf\(mover\)/.test(ROUTE))
    ok("  the logged change carries the player's NAME and nothing else");
  else bad("the remove change is name-only", "change_log HAS DIFFERENT ACCESS RULES AND A LONGER LIFE");
  if (!/phoneNumber/.test(ROUTE.slice(ROUTE.indexOf("export async function POST"))))
    ok("  the POST half never touches phoneNumber at all");
  else bad("the POST half is phone-free", "A PHONE IN change_log IS A SECOND COPY OF PLAYER PII");
  // The suite that already guards this estate-wide must still cover this route.
  const WRL = readFileSync("scripts/write-routes-logged-test.ts", "utf8");
  if (/roster/.test(WRL)) ok("  write-routes-logged-test still covers the roster route");
  else bad("write-routes-logged-test covers roster", "THIS WOULD BE THE ONLY GUARD");
  // The client must not send anything but the three fields the route needs.
  const VIEW = readFileSync("src/components/LapsedSpotsView.tsx", "utf8");
  const body = /body: JSON\.stringify\(\{([^}]*)\}\)/.exec(VIEW)?.[1] ?? "";
  if (body && !/phone|email|message/i.test(body)) ok(`  the request body carries no PII: {${body.trim().slice(0, 90)}}`);
  else bad("the request body is PII-free", body || "(body not found — the regex matched nothing)");
}

console.log("\n9. THE RESULT TABLE SURVIVES UNTIL DISMISSED, AND IS DOWNLOADABLE");
{
  const VIEW = readFileSync("src/components/LapsedSpotsView.tsx", "utf8");
  if (/data-testid="ls-results"/.test(VIEW)) ok("  a results section renders");
  else bad("a results section renders", "THE OPERATOR WOULD HAVE NO RECORD AND THERE IS NO ROLLBACK");
  if (/data-testid="ls-dismiss"/.test(VIEW) && /setResults\(null\)/.test(VIEW)) ok("  …and only an explicit Dismiss clears it");
  else bad("results persist until dismissed");
  if (/data-testid="ls-csv"/.test(VIEW) && /removalCsv\(results/.test(VIEW)) ok("  …and it downloads as CSV");
  else bad("results download as CSV");
  const csv = removalCsv([{ spot: bySpotUser("LAPSED", 1)!, verdict: "landed", detail: null }], "2026-08-31T12:00:00Z");
  const header = csv.split("\n")[1];
  is("  the CSV names the row id it acted on", header.includes("userMatchId"), true);
  if (!/phone/i.test(csv)) ok("  control: the CSV carries no phone column");
  else bad("the CSV is phone-free");
  // The env is a constant, not a control.
  if (/const WRITE_ENV = "production"/.test(VIEW)) ok("  the write environment is a constant, not a picker");
  else bad("WRITE_ENV is a constant", "READING PRODUCTION AND DELETING STAGING BY THE SAME IDS IS THE WORST FAILURE AVAILABLE");
}

console.log("\n12. THE FIVE CHANGES OF 2026-09-01");
{
  const VIEW = readFileSync("src/components/LapsedSpotsView.tsx", "utf8");
  const ROUTE = readFileSync("src/app/api/lapsed-spots/route.ts", "utf8");
  const code = VIEW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  console.log("  -- today is in, started rows are shown but never ticked --");
  {
    /* Built at 19:30 so the 14:00 match has started and the 21:00 one has not. */
    const M: MatchRow[] = [
      { api_id: 910, name: "Earlier today", start_date: `${TODAY}T14:00:00Z`, is_cancelled: false, city_name: "Austin", field_title: "NEMP" },
      { api_id: 911, name: "Later today", start_date: `${TODAY}T21:00:00Z`, is_cancelled: false, city_name: "Austin", field_title: "NEMP" },
      { api_id: 912, name: "Yesterday", start_date: "2026-08-30T19:00:00Z", is_cancelled: false, city_name: "Austin", field_title: "NEMP" },
      { api_id: 913, name: "Next week", start_date: "2026-09-07T19:00:00Z", is_cancelled: false, city_name: "Austin", field_title: "NEMP" },
    ];
    const S: SpotRow[] = [
      spot({ user_id: 20, match_api_id: 910, user_email: "e@gmail.com", user_first_name: "Earlier" }),
      spot({ user_id: 21, match_api_id: 911, user_email: "l@gmail.com", user_first_name: "Later" }),
      spot({ user_id: 22, match_api_id: 912, user_email: "y@gmail.com", user_first_name: "Yesterday" }),
      spot({ user_id: 23, match_api_id: 913, user_email: "n@gmail.com", user_first_name: "NextWeek" }),
    ];
    const U: SubRow[] = [20, 21, 22, 23].map((u) => ({ user_id: u, status: "CANCELED", canceled_at: "2026-08-02T10:00:00Z", member_email: `x${u}@gmail.com` }));
    const V2 = buildLapsedSpots(M, S, U, TODAY, "19:30");
    const rows = V2.groups.find((g) => g.state === "LAPSED")!.rows;
    const byName = (n: string) => rows.find((r) => r.name.startsWith(n));
    is("    a match starting LATER today is in the list", !!byName("Later"), true);
    is("    …and is ticked", defaultChecked(byName("Later")!.guard), true);
    is("    a match that started EARLIER today is in the list", !!byName("Earlier"), true);
    is("    …but is NOT ticked", defaultChecked(byName("Earlier")!.guard), false);
    is("    …with the chip", byName("Earlier")!.guard.reason, "Already started");
    is("    YESTERDAY is NOT in the list", !!byName("Yesterday"), false);
    // CONTROL: yesterday's spot exists in the fixture, so the absence is a filter, not an empty input.
    is("    control: yesterday's spot IS in the input", S.some((x) => x.match_api_id === 912), true);
    is("    the kickoff is carried per row", [byName("Earlier")!.kickoff, byName("Later")!.kickoff], ["14:00", "21:00"]);
    is("    the funnel counts today's spots", V2.todaySpots, 2);
    // TODAY FIRST, and within today by kickoff.
    is("    today sorts first, earliest kickoff first", rows.map((r) => r.name.split(" ")[0]), ["Earlier", "Later", "NextWeek"]);
    // CONTROL: the default nowHm is end-of-day, which marks every today row started — the SAFE
    // default. A caller that forgets to pass the clock under-ticks; it never over-ticks.
    const safe = buildLapsedSpots(M, S, U, TODAY);
    is("    control: with no clock supplied, today's rows are all unticked (safe default)",
      safe.groups.find((g) => g.state === "LAPSED")!.rows.filter((r) => r.isToday && defaultChecked(r.guard)).length, 0);
  }

  console.log("  -- only two groups render, but four are still classified --");
  {
    if (/RENDERED_STATES = SELECTABLE_STATES/.test(code)) ok("    RENDERED_STATES is the two selectable ones");
    else bad("    ACTIVE and NEVER_A_MEMBER are not rendered", "THEY ARE NOISE BESIDE A LIVE CHECKBOX");
    if (/data\.groups\.filter\(\(g\) => RENDERED_STATES\.has\(g\.state\)\)\.map/.test(code)) ok("    …and the group map filters on it");
    else bad("    the group render is filtered");
    is("    control: the MODEL still returns all four groups", V.groups.map((g) => g.state), ["LAPSED", "PAST_DUE", "ACTIVE", "NEVER_A_MEMBER"]);
    is("    control: …and ACTIVE still has rows to classify", V.groups.find((g) => g.state === "ACTIVE")!.rows.length > 0, true);
    if (/ls-unrendered/.test(code) && /never-a-member \(not listed\)/.test(code)) ok("    the funnel still counts both, and says they are not listed");
    else bad("    the funnel counts the unrendered groups", "DROPPING THEM FROM THE COUNT WOULD WEAKEN THE CLASSIFICATION");
  }

  console.log("  -- the amber box is gone, element, class and all --");
  {
    is("    no FREE_IS_NOT_MEMBER_NOTE, no ls-free-note, no ls-note", /FREE_IS_NOT_MEMBER_NOTE|ls-free-note|ls-note/.test(VIEW), false);
    // CONTROL: the scan can see a class that IS still there, so "absent" is not a dead regex.
    is("    control: the scan still finds a live class (ls-denom)", /ls-denom/.test(VIEW), true);
    const LIB = readFileSync("src/lib/lapsedSpots.ts", "utf8");
    const FACTS = readFileSync("docs/matchday-api-facts.md", "utf8");
    is("    the caveat is in the lib header", /FREE DOES NOT MEAN "MEMBER BENEFIT"/.test(LIB), true);
    is("    …and in the facts doc", /FREE IS NOT "MEMBER BENEFIT"/.test(FACTS), true);
    /* CHANGED 2026-09-01: first-match is a CHIP now, not a column — as a column it read "—" on
     * every row. The signal is kept; only the empty column went. */
    is("    first-match is kept, as a chip", /data-testid="ls-firstmatch"/.test(code), true);
    is("    …rendered only where it is true", /r\.isFirstMatch \? \(/.test(code), true);
  }

  console.log("  -- two tabs, and the Removed one is durable --");
  {
    if (/data-testid="ls-tab-live"/.test(code) && /data-testid="ls-tab-removed"/.test(code)) ok("    both tabs render");
    else bad("    two tabs render");
    if (/useState<"live" \| "removed">\("live"\)/.test(code)) ok("    …and 'To remove' is the default");
    else bad("    the live tab is the default");
    if (/from\("change_log"\)/.test(ROUTE) && /eq\("source", "Lapsed spots"\)/.test(ROUTE))
      ok("    Removed is read from change_log, scoped to this page's source — durable across a reload");
    else bad("    the Removed tab reads change_log", "SESSION STATE WOULD LOSE THE HISTORY ON RELOAD");
    if (/removedUmIds/.test(ROUTE) && /r\.outcome === "landed"/.test(ROUTE))
      ok("    …and a LANDED removal is suppressed from the live list, so a row leaves one tab and appears in the other");
    else bad("    a removed row leaves the live list", "THE MIRROR IS NIGHTLY — IT WOULD LINGER ALL AFTERNOON, STILL TICKED");
    if (/filter\(\(r\) => r\.outcome === "landed"\)/.test(ROUTE)) ok("    …and ONLY landed — a FAILED removal keeps its spot in the list");
    else bad("    only landed removals suppress");
    // The counts read the live tab only.
    if (/To remove <span className="ls-tabn">\{num\(candidates\.length\)\}/.test(code)) ok("    the header count is the live candidates");
    else bad("    the header count reads the live tab");
    // The button text is a TEMPLATE LITERAL, not a JSX expression — match ${selected.length}.
    if (/Remove \$\{selected\.length\} spot/.test(code) && /disabled=\{selected\.length === 0/.test(code))
      ok("    …and the Remove button counts and gates on the live selection");
    else bad("    the Remove button counts the live selection", "IT WOULD BE INFLATED BY HISTORY");
    // CONTROL: `selected` is derived from `candidates`, which is the live groups only.
    if (/candidates\.filter\(\(r\) => picked\.has\(r\.spotId\)/.test(code)) ok("    control: the selection derives from the live candidates, not from data.removed");
    else bad("    control: the selection derives from candidates");
    if (/data-testid="ls-csv"/.test(code) && /removalCsv\(results/.test(code)) ok("    the per-run CSV download is untouched");
    else bad("    the CSV download survives");
  }

  console.log("  -- what must NOT have changed --");
  {
    is("    paid > $0 is still BLOCKED", guardFor({ amountCents: 1, isStaff: false, state: "LAPSED" }).selectability, "blocked");
    is("    staff is still caution", guardFor({ amountCents: 0, isStaff: true, state: "LAPSED" }).selectability, "caution");
    /* ── INVERTED 2026-09-01 (assertion body, itemised): the guest guard is GONE. Proven on
     * staging that removing a host leaves every guest row live, so a row on a match with guests
     * is ticked like any other. */
    is("    a row on a match with guests is now OK — the guard is gone", guardFor({ amountCents: 0, isStaff: false, state: "LAPSED" }).selectability, "ok");
    is("    guardFor no longer accepts a guest count", "guestsOnMatch" in guardFor({ amountCents: 0, isStaff: false, state: "LAPSED" }), false);
    is("    a clean row is still ok", guardFor({ amountCents: 0, isStaff: false, state: "LAPSED" }).selectability, "ok");
    is("    paid still outranks already-started", guardFor({ amountCents: 500, isStaff: false, state: "LAPSED", alreadyStarted: true }).selectability, "blocked");
  }
}

console.log("\n13. THE GUEST GUARD IS GONE, AND THE TABLE FITS");
{
  const VIEW = readFileSync("src/components/LapsedSpotsView.tsx", "utf8");
  const LIB = readFileSync("src/lib/lapsedSpots.ts", "utf8");
  const code = VIEW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const libCode = LIB.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  console.log("  -- no guest chip, nothing held back for guests --");
  {
    is("    the view has no guest chip", /ls-guests|guestsOnMatch/.test(code), false);
    is("    the model has no guest count", /guestsOnMatch|guestsByMatch/.test(libCode), false);
    // CONTROL: the scans see a class and a field that ARE still there.
    is("    control: the scans still find ls-guard-chip and isStaff", [/ls-guard-chip/.test(code), /isStaff/.test(libCode)], [true, true]);
    /* THE TICK MOVED. A row that a guest count used to hold back is now ok. */
    is("    a row on a guest-carrying match is OK", guardFor({ amountCents: 0, isStaff: false, state: "LAPSED" }).selectability, "ok");
    /* AND THE FILTER THAT DID NOT MOVE: a GUEST row is still never listed at all. */
    const guestRow = buildLapsedSpots(MATCHES, [spot({ user_id: 99, match_api_id: 900, user_type: "GUEST", user_email: "g@gmail.com" })],
      [{ user_id: 99, status: "CANCELED", canceled_at: "2026-08-02T10:00:00Z", member_email: "g@gmail.com" }], TODAY, "12:00");
    is("    control: a GUEST row is still never listed", guestRow.groups.flatMap((g) => g.rows).length, 0);
    // The finding is written down where the next reader will look.
    const FACTS = readFileSync("docs/matchday-api-facts.md", "utf8");
    is("    the staging measurement is in the facts doc", /REMOVING A HOST DOES NOT TOUCH THEIR GUESTS/.test(FACTS), true);
    is("    …and the old unproven belief is retired by name", /THIS RETIRES THE OLD BELIEF FOR GOOD/.test(FACTS), true);
  }

  console.log("  -- four columns dropped, nothing truncates --");
  {
    for (const gone of ["Kick-off", "First match"]) {
      if (!new RegExp(`<div>${gone}</div>`).test(code)) ok(`    the ${gone} column is gone`);
      else bad(`the ${gone} column is gone`, "IT WAS THE SAME VALUE ON EVERY ROW");
    }
    is("    no SPOT column, and no money() call in a row", /className="r ls-amt"/.test(code), false);
    is("    the header is the six that remain",
      /<div>Player<\/div><div>When<\/div><div>Match<\/div><div>City<\/div><div>Membership<\/div>/.test(code), true);
    /* NOTHING TRUNCATES — the rule the old sheet broke on every cell. SCANNED ON THE STRIPPED
     * SOURCE: the comment explaining this rule contains the word "ellipsis" and an unstripped
     * scan flagged the sentence promising the thing it was checking for. Third time in this
     * estate; the fix is always the same. */
    is("    no text-overflow / ellipsis anywhere", /text-overflow|ellipsis/.test(code), false);
    // CONTROL: the scan fires on real CSS, so the absence is not a dead regex.
    is("    control: the ellipsis scan fires on real CSS", /text-overflow|ellipsis/.test(".x{text-overflow:ellipsis}"), true);
    is("    cells wrap instead", /overflow-wrap:anywhere/.test(code), true);
    is("    …and no grid carries a min-width that would force a sideways scroll", /min-width:1\d{3}px/.test(code), false);
    is("    the table container no longer scrolls horizontally", /\.ls-tbl\{overflow-x:visible\}/.test(code), true);
    // CONTROL: a min-width scan that WOULD fire, so the absence is not a dead regex.
    is("    control: the min-width scan fires on a string that has one", /min-width:1\d{3}px/.test(".x{min-width:1330px}"), true);
    // THE FULL EMAIL IS A TEXT NODE, not a title attribute.
    is("    the email renders as text", /<span className="ls-mail">\{r\.email\}<\/span>/.test(code), true);
    is("    …and is selectable", /user-select:all/.test(code), true);
    is("    control: no title= carries the email any more", /title=\{r\.email\}/.test(code), false);
  }

  console.log("  -- the bar is pinned, and Copy takes the visible tab --");
  {
    is("    the action bar is pinned to the viewport", /\.ls-bar\{position:sticky;bottom:12px/.test(code), true);
    is("    the page cannot scroll sideways", /\.ls\{max-width:100%;overflow-x:hidden/.test(code), true);
    is("    a Copy button exists", /data-testid="ls-copy"/.test(code), true);
    is("    …and it branches on the visible tab", /tab === "removed"\s*\?/.test(code), true);
    is("    …reading the same arrays the tables render", /candidates\.map\(\(r\) =>/.test(code) && /data\.removed\.map\(\(r\) =>/.test(code), true);
    is("    tab-separated", /join\("\\t"\)/.test(code), true);
    is("    the CSV download is untouched", /data-testid="ls-csv"/.test(code) && /removalCsv\(results/.test(code), true);
  }

  console.log("  -- and the guards that must not have moved --");
  {
    is("    paid > $0 still BLOCKED", guardFor({ amountCents: 1, isStaff: false, state: "LAPSED" }).selectability, "blocked");
    is("    staff still caution", guardFor({ amountCents: 0, isStaff: true, state: "LAPSED" }).selectability, "caution");
    is("    already-started still caution", guardFor({ amountCents: 0, isStaff: false, state: "LAPSED", alreadyStarted: true }).selectability, "caution");
    is("    PAST_DUE still ticked", defaultChecked(guardFor({ amountCents: 0, isStaff: false, state: "PAST_DUE" })), true);
    is("    …and still its own group", V.groups.map((g) => g.state).includes("PAST_DUE"), true);
    is("    a paid row shows the paid chip", guardFor({ amountCents: 1299, isStaff: false, state: "LAPSED" }).reason, "Paid $12.99 — cannot be removed here");
  }
}

console.log(`\nlapsed-removal: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
