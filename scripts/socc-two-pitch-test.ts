import "server-only"; // no-op under --conditions=react-server
// SOCCER CENTRAL — THE TWO-PITCH RULE, AND THE ONE PLACE THE DOUBLING LIVES.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/socc-two-pitch-test.ts
//
// THE WHOLE RISK IN THIS CHANGE IS DOUBLE-DOUBLING. Cost is rate × charged units. The rate carries
// the doubling ($180 on fin_venues 53); the charged unit count stays 1; the MATCH COUNT is 2 and
// feeds counts and denominators only. Double the rate AND the units and a tournament bills $360.
//
// So this suite asserts the SEPARATION, not the numbers: matchUnits must never appear in a cost
// expression, and the cost path must never see the two-pitch rule.

import {
  SOCC_TWO_PITCH_MIN_CAPACITY, SOCC_TWO_PITCH_FIELD_IDS, SOCC_EXCLUDED_FIELD_IDS,
  isSoccerCentralTwoPitchField, isTwoPitchCapacity, isSoccerCentralTwoPitch, matchUnits, survivesEventDrop,
} from "../src/lib/soccerCentralTwoPitch";
import { readFileSync } from "node:fs";
import { aggregateFieldPnL, type ShareCosts } from "../src/lib/fieldPnL";
import type { MatchPnLRow } from "../src/lib/matchPnL";
import type { FinVenue } from "../src/lib/useFinanceData";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

console.log("SOCCER CENTRAL · TWO PITCHES\n");

// ── 1. THE DOUBLING IS IN THE RATE, AND NOWHERE ELSE ─────────────────────────────────────────
console.log("the doubling lives in exactly one place");
{
  /* $180 IS NOT PRODUCED BY A MULTIPLICATION. Every cost path is rate × charged-units, and for a
   * two-pitch match the units are 1 — so the $180 comes out of the RATE COLUMN on fin_venues 53.
   * These assertions pin that no cost expression has learned about matchUnits. */
  const mp = readFileSync("src/lib/matchPnL.ts", "utf8");
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  const mpc = code(mp);
  is("matchUnits is carried on the row", /matchUnits: matchUnits\(/.test(mpc), true);
  is("…and the cost is the venue's own rate, never multiplied by it",
     /fieldCost: cost \* matchUnits|cost \* matchUnits|matchUnits \* cost/.test(mpc), false);
  for (const f of ["src/lib/financeCosts.ts", "src/lib/financeStats.ts", "src/lib/fieldEconomics.ts", "src/lib/fieldIdAdmin.ts"]) {
    const src = code(readFileSync(f, "utf8"));
    if (!/matchUnits|soccerCentralTwoPitch|SOCC_TWO_PITCH/.test(src)) ok(`${f.split("/").pop()} never sees the two-pitch rule`);
    else bad(`${f.split("/").pop()} never sees the two-pitch rule`, "A COST PATH COULD DOUBLE A DOUBLED RATE");
  }
  // POSITIVE CONTROL: the pattern does fire on a file that DOES import it.
  is("control — the pattern finds the import where it IS present",
     /matchUnits|soccerCentralTwoPitch/.test(code(readFileSync("src/lib/matchPnL.ts", "utf8"))), true);
  // chargedUnitCount / venueMatchCount must stay per-row counts.
  const fc = code(readFileSync("src/lib/financeCosts.ts", "utf8"));
  is("chargedUnitCount still counts one per schedule row", /if \(slots\) slots\.add\(slotKey\(s\)\); else n \+= 1;/.test(fc), true);
  is("…and nothing there multiplies a count by 2", /\* 2\b/.test(fc), false);
}

// ── 2. THE BOUNDARY IS A CONSTANT, AND IT DID NOT MOVE ───────────────────────────────────────
console.log("\nthe capacity boundary");
{
  is("the constant is 23", SOCC_TWO_PITCH_MIN_CAPACITY, 23);
  /* BEHAVIOURALLY IDENTICAL TO THE `> 22` THAT SHIPPED. Asserted across the whole integer range so
   * a future edit to the constant fails here rather than silently re-pricing history. */
  for (let c = 0; c <= 60; c++) is(`capacity ${c}: >= 23 matches the old > 22`, isTwoPitchCapacity(c), c > 22);
  is("a null capacity is not two-pitch", isTwoPitchCapacity(null), false);
  is("…nor undefined", isTwoPitchCapacity(undefined), false);
}

// ── 3. THE FIELD LIST IS EXPLICIT, AND 1123 IS OUT ───────────────────────────────────────────
console.log("\nthe fields");
{
  is("three fields carry the rule", [...SOCC_TWO_PITCH_FIELD_IDS], [102, 199, 1354]);
  is("1123 is excluded by NAME, not by a test that could drag it back", [...SOCC_EXCLUDED_FIELD_IDS], [1123]);
  is("…and it is not in the rule's list", isSoccerCentralTwoPitchField(1123), false);
  /* 1123 HAS CAPACITY 0 ON ALL 33 OF ITS MATCHES. A capacity test would exclude it today and
   * include it the moment someone set a capacity — which is exactly why the list is by id. */
  is("…even at a two-pitch capacity", isSoccerCentralTwoPitch(1123, 36), false);
  is("1552 is NOT Soccer Central — it is Tourney ATH Katy, city HOU", isSoccerCentralTwoPitchField(1552), false);
  for (const f of [102, 199, 1354]) is(`field ${f} is in`, isSoccerCentralTwoPitchField(f), true);
  is("a foreign field is out", isSoccerCentralTwoPitchField(22), false);
}

// ── 4. COUNTS DOUBLE, COSTS DO NOT ───────────────────────────────────────────────────────────
console.log("\ntwo pitches is two matches — for counts only");
{
  is("a two-pitch match counts as 2", matchUnits(199, 36), 2);
  is("a one-pitch match counts as 1", matchUnits(102, 18), 1);
  is("a capacity-22 match counts as 1", matchUnits(102, 22), 1);
  is("a capacity-24 match counts as 2", matchUnits(102, 24), 2);
  is("1123 counts as 1 whatever its capacity", matchUnits(1123, 36), 1);
  is("a foreign field counts as 1", matchUnits(22, 36), 1);
  /* THE ARITHMETIC THE RULE HAS TO PRODUCE, spelled out so a future edit cannot quietly change it:
   * eleven one-pitch nights and seven two-pitch nights is 11 + 14 = 25 matches, and
   * 11×$90 + 7×$180 = $2,250 of cost — NOT 25 × anything, and never 7 × $360. */
  const one = 11, two = 7;
  is("line match count = one + two×2", one + two * 2, 25);
  is("line cost = one×90 + two×180", one * 90 + two * 180, 2250);
  is("…which is NOT the double-doubled figure", one * 90 + two * 360, 3510);
  is("…and not the old, uncosted figure", one * 90 + two * 0, 990);
}

// ── 5. THE EVENT DROP IS NARROWED, NOT DELETED ───────────────────────────────────────────────
console.log("\nthe event drop");
{
  is("a Soccer Central two-pitch match survives it", survivesEventDrop(199, 36), true);
  is("a Soccer Central one-pitch match does not — it was never dropped anyway", survivesEventDrop(102, 18), false);
  is("field 1123 keeps being dropped", survivesEventDrop(1123, 36), false);
  is("ATH Pearland's tournaments keep being dropped", survivesEventDrop(22, 36), false);
  is("NEMP's tournaments keep being dropped", survivesEventDrop(17, 36), false);
  is("Tourney ATH Katy keeps being dropped", survivesEventDrop(1552, 36), false);
  const mp = readFileSync("src/lib/matchPnL.ts", "utf8");
  is("the guard is narrowed with an AND, not replaced",
     /isEventByCategory && !survivesEventDrop\(/.test(mp), true);
  is("venueCategory is still what decides an event in the first place", /venueCategory\(m\.field_title\) === "event"/.test(mp), true);
}

// ── 6. THE MERGE IS PRESENTATION-ONLY, AND SOCCER CENTRAL ONLY ───────────────────────────────
console.log("\none line for Soccer Central");
{
  const v = readFileSync("src/components/SlateFieldPnL.tsx", "utf8");
  /* ITEMISED (2026-10-08) — PATH EDIT ONLY. The grouping moved out of SlateFieldPnL.tsx into
   * src/lib/fieldPnL.ts (shared with Finance › Revenue). The five pairing assertions below read that
   * file now; their bodies are unchanged. The two testid checks still read the view (`v`). */
  const code = readFileSync("src/lib/fieldPnL.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/^\s*\/\/.*$/gm, " ");
  is("venues 11 and 53 share one group key", /isSocc \? `v:\$\{SOCC_BASE\}`/.test(code), true);
  is("…named for the base venue, never 'Soccer Central Tournament'", /venueById\.get\(SOCC_BASE\)\?\.venue_name/.test(code), true);
  is("the two ids are named constants, not literals in a condition", /const SOCC_BASE = 11, SOCC_TOURNEY = 53/.test(code), true);
  /* SCOPE, HARD. No generic grouping helper — Finance already has one (COMBINE_BY_NAME) and this is
   * the same special case for the one panel that groups by venueId. If this ever becomes a map or a
   * config list, it has stopped being one venue's special case. */
  is("no generic grouping helper crept in", /groupFieldsByPartner|partnerGroups|GROUP_BY_PARTNER/.test(code), false);
  is("the count uses matchUnits", /g\.matches \+= r\.matchUnits/.test(code), true);
  is("…and the cost does not", /g\.cost = \(g\.cost \?\? 0\) \+ \(r\.fieldCost \?\? 0\)/.test(code), true);
  is("the split is on screen", /data-testid="fp-split"/.test(v), true);
  is("…and beside the count", /data-testid="fp-matches"/.test(v), true);
  // fin_venues 53 must stay a real row — the merge must not fold its rate into venue 11.
  is("nothing rewrites venue 11's rate", /venue_name: "Soccer Central"[\s\S]{0,80}per_match_rate/.test(code), false);
}

// ── 7. THE TWO SURFACES AGREE ON THE COUNT, AND ONLY ON THE COUNT ────────────────────────────
console.log("\nmatch-count parity: Slate Review and Field Cost");
{
  const fc = readFileSync("src/components/FieldCostsView.tsx", "utf8");
  const code = fc.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/^\s*\/\/.*$/gm, " ");
  /* THE DISPLAYED COUNT DOUBLES; THE COST DOES NOT. Field Cost showed 1 for a match Slate Review
   * showed as 2, so the two pages disagreed about how many matches Soccer Central ran. The slot
   * count is computed IN THE VIEW, where nothing computes a cost — financeCosts must never see the
   * rule, because a charged unit count of 2 against a rate of $180 bills $360. */
  is("the displayed count adds the two-pitch extras", /row\.matchCount \+ slotExtra\.extra/.test(code), true);
  is("…and the split is beside it", /data-testid="fc-two-pitch"/.test(fc), true);
  is("the slot count is computed in the view, not in financeCosts", /const slotCountByVenue = useMemo/.test(code), true);
  is("…from the schedule's own capacity", /isSoccerCentralTwoPitch\(s\.mdapi_field_id, s\.max_spots\)/.test(code), true);
  /* THE COST CELL AND THE FORMULA MUST NOT SEE IT. Soccer Central is a combined group, so its
   * formula renders autoFormula, which financeCosts builds per leg from each leg's charged count. */
  is("no cost expression reads slotExtra", /amount[\s\S]{0,40}slotExtra|slotExtra[\s\S]{0,40}\* *rate/.test(code), false);
  is("the amount still comes from the row", /row\.amount/.test(code), true);
  const fcosts = readFileSync("src/lib/financeCosts.ts", "utf8");
  is("financeCosts still knows nothing about it", /slotExtra|slotCount|isSoccerCentralTwoPitch/.test(fcosts), false);
  is("…and its per-leg formula is untouched", /parts\.push\(`\$\{info\.matchCount\} \$\{label\} × \$\$\{group\.legs\[i\]\.per_match_rate \?\? 0\}`\)/.test(fcosts), true);
  // POSITIVE CONTROL: the pattern does fire where the rule IS imported.
  is("control — the pattern finds the import in the view", /isSoccerCentralTwoPitch/.test(fc), true);
  // Cancelled matches are counted exactly where they are charged, never more widely.
  is("a cancelled match counts only when the venue charges for it", /v\?\.charge_on_cancel\) add\(s\)/.test(code), true);
}

// ── 8. THE MERGE WORKS WHEN THE TOURNAMENT ROW IS INACTIVE (Ryan, 2026-10-08) ───────────────────
/* A RUNTIME CHECK, not a source one: aggregateFieldPnL is pure, so the bug is reproduced with rows.
 * fin_venues 53 is is_active=false in production, and the grouping used to test is_active BEFORE it
 * merged, so every two-pitch match fell into Unmapped and Soccer Central read 16 matches, not 108. */
console.log("\nthe two-pitch match joins Soccer Central even with venue 53 inactive");
{
  const venue = (id: number, name: string, active: boolean) =>
    ({ id, venue_name: name, raw_venue_name: name, city: "San Antonio", billing_type: "per_match", is_active: active }) as unknown as FinVenue;
  const venues = new Map([[11, venue(11, "Soccer Central", true)], [53, venue(53, "Soccer Central Tournament", false)],
    [99, venue(99, "Somewhere Closed", false)]]);
  const row = (venueId: number, start: string, cost: number, units: number) => ({
    venueId, venueRawName: venues.get(venueId)!.raw_venue_name, city: "San Antonio", matchStartIso: start, isEvent: false,
    matchUnits: units, fieldCost: cost, grossRevenue: 100, allocatedMemberRev: 0, promoRevenue: 0, promoSpots: 0,
  }) as unknown as MatchPnLRow;
  const share: ShareCosts = { byMatch: new Map(), extraByVenue: new Map(), modelOnly: new Map(), termsByVenue: new Map() };
  const out = aggregateFieldPnL([row(11, "2026-09-08T19:00", 90, 1), row(53, "2026-09-09T19:00", 180, 2),
    row(99, "2026-09-10T19:00", 70, 1)], venues, share);
  const sc = out.find((g) => g.key === "v:11");
  is("one Soccer Central line", out.filter((g) => g.fullName === "Soccer Central" || g.fullName === "Soccer Central Tournament").length, 1);
  is("…which is a flat-rate line, not Unmapped", sc?.bucket, "flat");
  is("…counting the two-pitch match as two", [sc?.matches, sc?.onePitchMatches, sc?.twoPitchMatches], [3, 1, 1]);
  is("…and costing it once at $180", [sc?.cost, sc?.twoPitchCost], [270, 180]);
  is("…so cost per match is $90", sc?.costPM, 90);
  // CONTROL: an inactive venue that is NOT Soccer Central is still Unmapped — the test is not vacuous.
  is("control — another inactive venue is still Unmapped", out.find((g) => g.venueIds.includes(99))?.bucket, "unmapped");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
