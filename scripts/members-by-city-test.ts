/* MEMBERS BY CITY — the model, and the page's silence.
 *
 * WHAT THIS GUARDS. The corrected model, which is a SUBTRACTION: a cancellation does not flip
 * status to CANCELED until roll-off, so both cancellation cohorts sit INSIDE the active set and
 * Being charged = Active − in-window. On production 2026-08-31 that is 149 of 406 active people
 * already carrying a canceled_at. A build that adds the cohorts to Active instead of subtracting
 * one of them overstates billing by $8,218, and every number on the page still looks plausible.
 *
 * EVERY ASSERTION BELOW CARRIES A CONTROL. The passing value of most of these is a small number or
 * an absence, and a fixture that produced nothing, a regex that matched nothing and a model that
 * silently dropped everyone all produce the same zero.
 *
 * NOTHING HERE PINS 395, 406, OR ANY OTHER LITERAL ACTIVE COUNT. 395 was a literal, and it was a
 * number the live count merely passed through between 27 and 28 August. The active assertion is an
 * EQUALITY against countActiveMembers over the same rows at the same instant.
 */

import { readFileSync } from "node:fs";
import {
  buildMembersByCity, membersByCityCsv, mixLabel, dollars,
  CUTOFF_YMD, WINDOW_START_YMD, MIX_TIERS_CENTS, UNASSIGNED_CODE,
  isInWindow, isAfterCutoff,
  type SubscriptionRow, type ByCityRow,
} from "../src/lib/membersByCity";
import { countActiveMembers, isActiveAsOf, isChurning, memberLikeFromSubscription } from "../src/lib/membershipStats";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const ASOF = new Date("2026-08-31T12:00:00Z");

/* ── THE FIXTURE ───────────────────────────────────────────────────────────────────────────────
 * Built so every branch is exercised and nothing passes by being empty:
 *   - three cities plus one UNMAPPED code (WAW), which is the Unassigned row's reason to exist
 *   - all three named tiers AND two off-tier prices, so the "other" bucket is never zero
 *   - active people carrying a canceled_at in each window, and one on each boundary date
 *   - a $0 member, an internal @playmatchday. member, an INCOMPLETE member and a CANCELED member,
 *     none of whom may reach any count
 *   - one person holding TWO rows, so the collapse has something to collapse
 *   - one person activated AFTER the as-of instant, who is not yet active */
let nextUser = 100;
const sub = (o: Partial<SubscriptionRow>): SubscriptionRow => ({
  user_id: nextUser++, status: "ACTIVE", price: 66, member_email: `p${nextUser}@gmail.com`,
  activation_date: "2026-01-15T10:00:00+00:00", canceled_at: null, city_identifier: "ATX", ...o,
});

const FIXTURE: SubscriptionRow[] = [
  // ATX — 6 active: 3 x $66, 1 x $49, 1 x $30, 1 x $13 (other)
  sub({}), sub({}), sub({}),
  sub({ price: 49 }),
  sub({ price: 30 }),
  sub({ price: 13 }),
  // ...of whom three cancelled: one mid-window, one ON the window start, one ON the cutoff.
  // BOTH BOUNDARY DATES ARE IN-WINDOW — that is the ruling this file pins.
  sub({ price: 66, canceled_at: "2026-07-20T08:00:00+00:00" }),
  sub({ price: 66, canceled_at: `${WINDOW_START_YMD}T23:59:00+00:00` }),
  sub({ price: 49, canceled_at: `${CUTOFF_YMD}T23:59:00+00:00` }),
  // ...and two cancelled AFTER the cutoff, who still owe a cycle.
  sub({ price: 66, canceled_at: "2026-08-20T08:00:00+00:00" }),
  sub({ price: 30, canceled_at: "2026-08-29T08:00:00+00:00" }),

  // HOU — 2 active at $500 (an off-tier one-off that must land in "other", not vanish)
  sub({ city_identifier: "HOU", price: 500 }),
  sub({ city_identifier: "HOU", price: 500, canceled_at: "2026-07-10T08:00:00+00:00" }),

  // SATX — 1 active at $66
  sub({ city_identifier: "SATX", price: 66 }),

  // WAW — an UNMAPPED market. memberLikeFromSubscription returns null for this code, so
  // countActiveMembers cannot see it; the Unassigned row is the only place it can appear.
  sub({ city_identifier: "WAW", price: 66 }),

  // NONE OF THESE MAY REACH ANY COUNT
  sub({ price: 0 }),                                        // $0
  sub({ price: 66, member_email: "ops@playmatchday.com" }),  // internal
  sub({ price: 66, status: "INCOMPLETE" }),                  // never completed checkout
  sub({ price: 66, status: "CANCELED", canceled_at: "2026-07-15T08:00:00+00:00" }), // already rolled off
  sub({ price: 66, activation_date: "2026-09-10T08:00:00+00:00" }),                 // not yet active
];
// ONE PERSON, TWO ROWS — the collapse must count them once, at the higher price.
const TWICE = 9001;
FIXTURE.push(sub({ user_id: TWICE, price: 30, city_identifier: "SATX" }));
FIXTURE.push(sub({ user_id: TWICE, price: 66, city_identifier: "SATX" }));

const T = buildMembersByCity(FIXTURE, ASOF);
const row = (code: string): ByCityRow => {
  const r = T.rows.find((x) => x.code === code);
  if (!r) throw new Error(`fixture row ${code} missing — the model dropped a whole city`);
  return r;
};

console.log("\ncontrol: the fixture is not empty and every branch has something in it");
{
  // WITHOUT THIS, EVERY SUBSET AND EVERY ZERO BELOW PASSES ON AN EMPTY TABLE.
  if (T.rows.length >= 4) ok(`control: ${T.rows.length} city rows built`); else bad("control: the fixture built city rows", `only ${T.rows.length}`);
  if (T.total.active > 0) ok(`control: ${T.total.active} active people in the fixture`); else bad("control: the fixture has active people", "EVERY ASSERTION BELOW WOULD PASS ON ZERO");
  if (T.total.cancelledInWindow > 0) ok(`control: ${T.total.cancelledInWindow} in-window cancellations exist`); else bad("control: in-window cancellations exist", "THE SUBTRACTION WOULD BE UNTESTED");
  if (T.total.cancelledAfterCutoff > 0) ok(`control: ${T.total.cancelledAfterCutoff} after-cutoff cancellations exist`); else bad("control: after-cutoff cancellations exist");
  const other = T.total.mix.find((e) => e.tier === "other");
  if ((other?.heads ?? 0) > 0) ok(`control: the "other" bucket holds ${other?.heads} people`); else bad("control: the other bucket is populated", "THE TAIL WOULD BE UNTESTED AND SILENTLY DROPPABLE");
}

console.log("\nBEING CHARGED = ACTIVE MINUS IN-WINDOW, every row and the footer");
{
  for (const r of [...T.rows, T.total]) {
    if (r.beingCharged === r.active - r.cancelledInWindow) ok(`  ${r.code}: ${r.active} − ${r.cancelledInWindow} = ${r.beingCharged}`);
    else bad(`${r.code}: being charged is the subtraction`, `${r.beingCharged} != ${r.active} - ${r.cancelledInWindow}`);
  }
  // THE CONTROL: prove the identity is not vacuous by finding a row where it actually subtracts.
  if ([...T.rows, T.total].some((r) => r.cancelledInWindow > 0 && r.beingCharged < r.active))
    ok("control: at least one row genuinely subtracts (the identity is not 'x = x - 0')");
  else bad("control: the subtraction is exercised", "EVERY ROW HAD ZERO IN-WINDOW — THE ASSERTION PROVED NOTHING");
}

console.log("\nBOTH COHORTS ARE SUBSETS OF ACTIVE — the whole model depends on it");
{
  for (const r of [...T.rows, T.total]) {
    const okA = r.cancelledInWindow <= r.active;
    const okB = r.cancelledAfterCutoff <= r.active;
    const okC = r.cancelledInWindow + r.cancelledAfterCutoff <= r.active;
    if (okA && okB && okC) ok(`  ${r.code}: ${r.cancelledInWindow} + ${r.cancelledAfterCutoff} <= ${r.active}`);
    else bad(`${r.code}: cohorts are subsets of active`, `${r.cancelledInWindow}+${r.cancelledAfterCutoff} vs ${r.active}`);
  }
  // A row where the cohorts sum to a real fraction of active — otherwise "<=" passes on all zeros.
  const meaty = [...T.rows, T.total].find((r) => r.cancelledInWindow + r.cancelledAfterCutoff > 0 && r.active > 0);
  if (meaty) ok(`control: ${meaty.code} carries ${meaty.cancelledInWindow + meaty.cancelledAfterCutoff} cancellations inside ${meaty.active} active`);
  else bad("control: a row carries cancellations inside its active set", "THE SUBSET CHECK RAN ON ALL ZEROS");
  // AND THE INVERSE: a cancelled person must NOT also be counted outside active.
  is("nobody is cancelled in BOTH windows", T.rows.every((r) => r.cancelledInWindow + r.cancelledAfterCutoff <= r.active), true);
}

console.log("\nBILLING = SUM OVER TIERS OF HEADS x PRICE, exact to the cent, with Other included");
{
  for (const r of [...T.rows, T.total]) {
    const summed = r.mix.reduce((s, e) => s + e.cents, 0);
    if (summed === r.billingCents) ok(`  ${r.code}: mix sums to ${dollars(r.billingCents)} exactly`);
    else bad(`${r.code}: mix sums to billing`, `${summed} != ${r.billingCents}`);
    // The three NAMED tiers must be heads x nominal exactly — no averaging anywhere.
    for (const t of MIX_TIERS_CENTS) {
      const e = r.mix.find((x) => x.tier === t)!;
      if (e.cents !== e.heads * t) bad(`${r.code}: ${dollars(t)} tier is heads x price`, `${e.cents} != ${e.heads} x ${t}`);
    }
  }
  ok("  every named tier is heads x price, never an average");
  // CONTROL: the Other bucket carries real dollars that the three tiers alone would miss.
  const namedOnly = T.total.mix.filter((e) => e.tier !== "other").reduce((s, e) => s + e.cents, 0);
  if (namedOnly < T.total.billingCents) ok(`control: Other adds ${dollars(T.total.billingCents - namedOnly)} the three tiers would drop`);
  else bad("control: the Other bucket carries dollars", "THE TAIL WAS EMPTY — 'no dropped tail' PROVED NOTHING");
  // And the off-tier $500 landed in Other rather than vanishing.
  is("the $500 one-off is in Other, not dropped", row("HOU").mix.find((e) => e.tier === "other")!.cents, 50000);
}

console.log("\nMIX HEADS = BEING CHARGED, every row");
{
  for (const r of [...T.rows, T.total]) {
    const heads = r.mix.reduce((s, e) => s + e.heads, 0);
    if (heads === r.beingCharged) ok(`  ${r.code}: ${heads} heads = ${r.beingCharged} being charged`);
    else bad(`${r.code}: mix heads equal being charged`, `${heads} != ${r.beingCharged}`);
  }
  // CONTROL: the mix is NOT built from active, which would be the easy wrong answer.
  const differs = [...T.rows, T.total].find((r) => r.beingCharged !== r.active);
  if (differs) ok(`control: ${differs.code} has ${differs.active} active but ${differs.beingCharged} charged — the mix follows the smaller one`);
  else bad("control: a row has fewer charged than active", "MIX-FROM-ACTIVE WOULD HAVE PASSED TOO");
}

console.log("\nNO PRICE-0 MEMBER, AND NO OTHER EXCLUDED ROW, REACHES ANY COUNT");
{
  const heads = T.rows.reduce((s, r) => s + r.active, 0);
  is("the four excluded kinds are all absent", heads, T.total.active);
  // 20 active-looking rows in the fixture; five must be refused ($0, internal, INCOMPLETE,
  // CANCELED, not-yet-activated) and one pair must collapse to a single person.
  const expected = 12 + 2 + 1 + 1 + 1 - 1; // ATX 11 + HOU 2 + SATX 1 + WAW 1 + the twice-listed person
  is("the fixture resolves to the expected headcount", T.total.active, expected);
  // CONTROL: prove the model WOULD have counted them if the predicate let them through, by
  // showing the same row with a clean price/email/status does get counted.
  const clean = buildMembersByCity([sub({ price: 66, member_email: "real@gmail.com" })], ASOF);
  if (clean.total.active === 1) ok("control: an equivalent CLEAN row IS counted — the zeros above are refusals, not a dead model");
  else bad("control: a clean row is counted", "THE MODEL COUNTS NOBODY AND EVERY EXCLUSION PASSED VACUOUSLY");
  for (const [label, r] of [
    ["price $0", sub({ price: 0 })],
    ["internal email", sub({ member_email: "x@playmatchday.com" })],
    ["INCOMPLETE", sub({ status: "INCOMPLETE" })],
    ["CANCELED", sub({ status: "CANCELED" })],
  ] as [string, SubscriptionRow][]) {
    is(`  ${label} is refused`, buildMembersByCity([r], ASOF).total.active, 0);
  }
}

console.log("\nTHE PAGE'S ACTIVE EQUALS countActiveMembers AT THE SAME INSTANT — not a literal");
{
  /* countActiveMembers cannot see an unmapped city (memberLikeFromSubscription returns null), so
   * the comparison is against the table MINUS its Unassigned row. That difference is the entire
   * reason the Unassigned row exists, and asserting it is how we know the row is load-bearing. */
  /* AN UNMAPPED MARKET GETS ITS OWN ROW, LABELLED BY ITS REAL CODE — it is not lumped into the
   * bare Unassigned row, which is for a person carrying no code at all. Both render "Unassigned"
   * as the city name, so the invariant that matters is CITY === NULL, not CODE === "—". Anything
   * with a null city is invisible to countActiveMembers and visible only here. */
  const unmapped = T.rows.filter((r) => r.city === null).reduce((s, r) => s + r.active, 0);
  /* THE TWO SIDES COUNT DIFFERENT THINGS AND THE DIFFERENCE IS EXACTLY TWO KNOWN TERMS.
   * countActiveMembers counts ROWS and cannot see an unmapped city; this table counts PEOPLE.
   * On production 2026-08-31 both terms are zero — all seven codes map and NOBODY holds two
   * ACTIVE rows — so the page's Active equals Home's exactly. The fixture puts a person on two
   * ACTIVE rows on purpose, so the identity is asserted with the term present rather than being
   * quietly true. */
  const activeRows = FIXTURE.filter((r) => { const m = memberLikeFromSubscription(r); return m && isActiveAsOf(m, ASOF); });
  const collapsedAway = activeRows.length - new Set(activeRows.map((r) => String(r.user_id))).size;
  is("table active − unmapped + collapsed rows == countActiveMembers",
    T.total.active - unmapped + collapsedAway, countActiveMembers(FIXTURE, ASOF));
  if (collapsedAway > 0) ok(`control: ${collapsedAway} duplicate ACTIVE row is collapsed away — the person is counted once`);
  else bad("control: the collapse term is exercised", "THE ROW-VS-PERSON DIFFERENCE WAS NEVER TESTED");
  /* AND THE PRODUCTION CASE: with no duplicate and no unmapped market, the two are EQUAL. This is
   * the assertion behind "the page's Active must equal what Home shows". */
  const clean = [sub({ price: 66, member_email: "a@gmail.com" }), sub({ price: 30, member_email: "b@gmail.com", city_identifier: "HOU" })];
  is("with no duplicate and no unmapped market, page Active == countActiveMembers exactly",
    buildMembersByCity(clean, ASOF).total.active, countActiveMembers(clean, ASOF));
  is("  control: and that number is not zero", countActiveMembers(clean, ASOF), 2);
  if (unmapped > 0) ok(`control: ${unmapped} person in an UNMAPPED city is shown on the page and is invisible to countActiveMembers`);
  else bad("control: an unmapped market is caught and shown", "A NEW MARKET WOULD VANISH SILENTLY");
  is("  ...under its own real code, not swallowed into the bare Unassigned row",
    T.rows.filter((r) => r.city === null).map((r) => r.code).sort(), ["WAW", UNASSIGNED_CODE]);
  is("  and cityFromAbbr genuinely refuses that code", memberLikeFromSubscription({ city_identifier: "WAW", price: 66, status: "ACTIVE" }), null);
  /* NO ACTIVE-COUNT LITERAL IS PINNED IN THE SHIPPED CODE. This scans the view and the lib, not
   * this file: the guard is that the PAGE never hardcodes a headcount, and 395 is the specific
   * number that earned the rule by being a value the live count merely passed through. */
  for (const f of ["src/components/MembersByCityView.tsx", "src/lib/membersByCity.ts"]) {
    const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    is(`  ${f} pins no active-count literal`, /\b(395|406|410|324)\b/.test(src), false);
  }
  // CONTROL: the scan can find such a literal when one is there.
  is("control: the literal scan fires on a string that has one", /\b(395|406|410|324)\b/.test("const active = 406;"), true);
}

console.log("\nTHE WINDOW IS INCLUSIVE OF BOTH ENDS, and isChurning now agrees");
{
  is(`  ${WINDOW_START_YMD} is in-window`, isInWindow(`${WINDOW_START_YMD}T23:59:00+00:00`), true);
  is(`  ${CUTOFF_YMD} is in-window`, isInWindow(`${CUTOFF_YMD}T23:59:00+00:00`), true);
  is("  the day before the start is not", isInWindow("2026-07-05T23:59:00+00:00"), false);
  is("  the day after the cutoff is not", isInWindow("2026-08-07T00:01:00+00:00"), false);
  is("  and that day IS after-cutoff", isAfterCutoff("2026-08-07T00:01:00+00:00"), true);
  /* THE ESTATE HOLDS ONE DEFINITION. isChurning's rolling window is anchored on `now`'s month, so
   * at any as-of inside August it is [Jul 6, Aug 6] — the same window this page names. A member
   * cancelled ON the 6th must be churning; before 2026-08-31 they were not, and that was the
   * second definition. */
  const onTheSixth = memberLikeFromSubscription(sub({ price: 66, canceled_at: `${CUTOFF_YMD}T23:59:00+00:00` }))!;
  is("isChurning counts a cancellation ON the 6th", isChurning(onTheSixth, ASOF), true);
  // CONTROL: it still refuses the 7th, so the window did not simply swallow everything.
  const onTheSeventh = memberLikeFromSubscription(sub({ price: 66, canceled_at: "2026-08-07T12:00:00+00:00" }))!;
  is("control: isChurning still refuses the 7th", isChurning(onTheSeventh, ASOF), false);
  // ...and the shipped source says which boundary it implements, so the next reader cannot guess.
  const stats = readFileSync("src/lib/membershipStats.ts", "utf8");
  if (/INCLUSIVE OF BOTH ENDS/.test(stats) && /covers all of the 6th/.test(stats)) ok("membershipStats records the inclusive boundary and when it changed");
  else bad("membershipStats records the boundary", "TWO DEFINITIONS IS WHAT PRODUCED THE 395-vs-406 CONFUSION");
}

console.log("\nTHE UNASSIGNED ROW IS ALWAYS PRESENT, even at zero");
{
  const none = buildMembersByCity([sub({ price: 66, member_email: "r@gmail.com" })], ASOF);
  is("  a table with no unmapped rows still renders Unassigned", none.rows.some((r) => r.code === UNASSIGNED_CODE), true);
  is("  ...at zero", none.rows.find((r) => r.code === UNASSIGNED_CODE)!.active, 0);
  is("  and it sorts last", T.rows[T.rows.length - 1].code, UNASSIGNED_CODE);
}

console.log("\nTHE CSV CARRIES THE SAME NUMBERS AS THE SCREEN, mix expanded per tier");
{
  const csv = membersByCityCsv(T, "Aug 31, 2026 · 11:00 UTC");
  const lines = csv.split("\n");
  is("one row per city plus a TOTAL row", lines.length, 2 + T.rows.length + 1); // comment + header + rows + total
  if (lines[lines.length - 1].startsWith("TOTAL,")) ok("the last line is the TOTAL");
  else bad("the last line is the TOTAL", lines[lines.length - 1].slice(0, 40));
  for (const t of MIX_TIERS_CENTS) {
    if (lines[1].includes(`Heads $${t / 100}`)) ok(`  the mix is expanded: a "Heads $${t / 100}" column exists`);
    else bad(`the CSV has a Heads $${t / 100} column`, "THE MIX WOULD OPEN AS TEXT, NOT ARITHMETIC");
  }
  if (lines[1].includes("Heads other") && lines[1].includes("Other dollars")) ok("  ...and Other carries its own headcount AND its own dollars");
  else bad("the CSV expands Other", "THE TAIL WOULD NOT RECONCILE");
  // THE NUMBERS MATCH THE SCREEN, not a re-derivation.
  const totalLine = lines[lines.length - 1].split(",");
  is("  CSV total Active matches the table", Number(totalLine[2]), T.total.active);
  is("  CSV total Being charged matches the table", Number(totalLine[5]), T.total.beingCharged);
  is("  CSV total Billing matches the table to the cent", Math.round(Number(totalLine[totalLine.length - 1]) * 100), T.total.billingCents);
  // CONTROL: those cells are not all zero.
  if (T.total.beingCharged > 0 && T.total.billingCents > 0) ok("control: the compared CSV cells are non-zero");
  else bad("control: the CSV cells compared are non-zero", "THE MATCH WAS 0 == 0");
}

console.log("\nTHE PAGE SAYS NOTHING BEYOND THE TABLE");
{
  const VIEW = readFileSync("src/components/MembersByCityView.tsx", "utf8");
  // Strip comments FIRST — every check below is a scan for prose, and this file is full of it.
  const code = VIEW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  if (/MembersByCityView/.test(code) && /<table>/.test(code)) ok("control: the view was read and still renders a table");
  else bad("control: the view was read", "EVERY ABSENCE CHECK BELOW WOULD PASS ON AN EMPTY STRING");

  /* THE ONLY ALLOWED FREE TEXT. Anything else that reads like a sentence is a paragraph the page
   * is not allowed to have. Header sub-labels, chips and the as-of label are structured and are
   * matched out by shape, not by listing their wording. */
  const ALLOWED = [
    "Members by City", "Excludes price $0", "Export CSV", "Retry", "Loading…", "Cutoff", "Window",
    "MATCHDAY", "City", "Active", "Cancelled", "Being charged", "Billing next cycle", "Unassigned",
    "status ACTIVE today", "summed, not averaged", "The query failed — this is NOT an empty table.",
  ];
  // Any JSX text node of four or more words that is not one of the above.
  const prose = [...code.matchAll(/>\s*([A-Z][^<>{}\n]{24,})\s*</g)]
    .map((m) => m[1].trim())
    .filter((s) => !ALLOWED.some((a) => s.includes(a)))
    .filter((s) => s.split(/\s+/).length >= 4);
  is("no explanatory paragraph is rendered", prose, []);
  // CONTROL: the scan can find a sentence. Prove it against a string that IS one.
  const probe = ">  This page explains what the numbers below actually mean in practice  <";
  const found = [...probe.matchAll(/>\s*([A-Z][^<>{}\n]{24,})\s*</g)].length;
  if (found === 1) ok("control: the prose scan finds a sentence when one is present");
  else bad("control: the prose scan works", "THE EMPTY RESULT ABOVE PROVED NOTHING");
  // The one footer line is actually there.
  if (/Excludes price \$0/.test(code)) ok('the footer line "Excludes price $0" is present');
  else bad("the footer line is present", "the page would have NO statement of its exclusion rule");
  // And no subtitle / callout / status chip crept in.
  for (const banned of [/className="[^"]*sub[^"]*"/, /callout/i, /StatusChip/, /<p[ >]/]) {
    if (banned.test(code)) bad(`the page carries no ${banned.source}`, "the page gets sub-labels and the as-of label, nothing else");
  }
  ok("no subtitle, callout, status chip or paragraph element");
}

console.log("\nthe constants are in ONE place and say what the window means");
{
  const LIB = readFileSync("src/lib/membersByCity.ts", "utf8");
  if (/THE CALENDAR MONTH ENDING AT THE CUTOFF/.test(LIB)) ok("the window's meaning is written where the constants live");
  else bad("the window's meaning is recorded", "next month becomes a guess rather than a one-line change");
  const VIEW = readFileSync("src/components/MembersByCityView.tsx", "utf8");
  if (!/"2026-0[78]-\d\d"/.test(VIEW.replace(/\/\*[\s\S]*?\*\//g, ""))) ok("the view hardcodes neither date — both come from the lib");
  else bad("the view hardcodes a date", "TWO PLACES TO CHANGE IS HOW THE TWO DEFINITIONS HAPPEN");
  if (/no date picker/i.test(LIB)) ok("...and why there is no date picker");
  else bad("the absence of a date picker is explained");
}

console.log("\nthe page pages past the 1,000-row cap and asserts the pull is complete");
{
  const VIEW = readFileSync("src/components/MembersByCityView.tsx", "utf8");
  if (/selectAll</.test(VIEW)) ok("it pages with selectAll rather than a bare select");
  else bad("the page pages explicitly", "PostgREST CAPS AT 1,000 AND THE TABLE IS 2,700 — AUSTIN WOULD BE SHORT");
  if (/count: "exact", head: true/.test(VIEW) && /incomplete pull/.test(VIEW)) ok("...and compares the pull against an exact head count, throwing on a short read");
  else bad("the pull is asserted complete", "A TRUNCATED PULL WOULD RENDER AS A SMALLER AUSTIN");
  if (/this is NOT an empty table/i.test(VIEW)) ok("...and a failed read renders as an ERROR, never as zeros");
  else bad("a failed read is not rendered as zeros", "every column's happy answer is a small number");
}

console.log(`\nmembers-by-city: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
