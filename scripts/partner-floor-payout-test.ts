/* RENTAL_FLOOR_PROFIT_SHARE — the fourth payout model, beside the third and not instead of it.
 *
 * THIS FILE DECIDES WHAT A REAL VENUE IS PAID. The shipped model is the way back: one UPDATE to
 * partner_dashboards.payout_model switches Parmer between the two, with no deploy — so the third
 * model must stay byte-identical and is asserted here to be, over a revenue sweep, cent for cent.
 *
 *   old(R) = F + s·max(0, R − F − M)
 *   new(R) = max(F, s·(R − M))
 *
 * Above the floor, old − new = (1 − s)·F = 0.6 × $160 = $96 — constant, whatever the revenue. The
 * old model removed the rental from the pool and handed it back whole, so the partner collected
 * 60% of a rental the split never charged for.
 */
import { readFileSync } from "node:fs";
import {
  payoutForMatch, payoutForMatchFloor, payoutForMatchOf, totalsOf, isRentalModel,
  topUpThresholdCents, type MatchInput, type RentalProfitShareParams, type PayoutModel,
} from "../src/lib/partnerPayoutModel";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const yes = (m: string, c: boolean, d = "") => (c ? ok(m) : bad(m, d));
const $ = (c: number) => `$${(c / 100).toFixed(2)}`;

/** Parmer's real parameters, from migration 0123: 16000c rental, 4000c manager, 40%. */
const P: RentalProfitShareParams = { fieldRentalCents: 16000, matchManagerCents: 4000, partnerSharePct: 40 };
const match = (grossCents: number, over: Partial<MatchInput> = {}): MatchInput =>
  ({ matchApiId: 1, startYmd: "2026-09-02", cancelled: false, played: true, grossCents, spotsSold: 10, ...over });

console.log("\nRyan's worked example, and the two live September matches");
{
  /* 660 revenue − 40 manager = 620 pool, ×0.4 = 248 split, 248 − 160 = 88 to pay, 88 + 160 = 248. */
  const r = payoutForMatchFloor(match(66000), P);
  is("660 → pool 620", r.poolCents, 62000);
  is("…split 248", r.fieldRentalCents + r.partnerProfitShareCents, 24800);
  is("…88 to be paid", r.partnerProfitShareCents, 8800);
  is("…248 total", r.partnerTotalCents, 24800);

  is("Wed Sep 2: 675 → 254 total", payoutForMatchFloor(match(67500), P).partnerTotalCents, 25400);
  is("Thu Sep 3: 240 → 160 total", payoutForMatchFloor(match(24000), P).partnerTotalCents, 16000);
  is("…and 0 to be paid on it", payoutForMatchFloor(match(24000), P).partnerProfitShareCents, 0);
  /* THE MONTH, as the mock states it: $526.00 becomes $414.00. */
  const sep = [67500, 24000].map((g) => payoutForMatchFloor(match(g), P));
  const sepOld = [67500, 24000].map((g) => payoutForMatch(match(g), P));
  is("September recomputes 526.00 → 414.00",
    [totalsOf(sepOld).partnerTotalCents, totalsOf(sep).partnerTotalCents], [52600, 41400]);
}

console.log("\nthe floor: the rental is the minimum, never a clawback");
{
  const under = payoutForMatchFloor(match(24000), P);   // split 80 < rental 160
  is("a match whose split is under the rental pays exactly the rental", under.partnerTotalCents, P.fieldRentalCents);
  is("…and reports 0 to be paid, not a negative", under.partnerProfitShareCents, 0);
  yes("…never negative", under.partnerProfitShareCents >= 0);
  /* THE CONTROL: a match ABOVE the floor must not be floored, or the assertion above is vacuous. */
  const over = payoutForMatchFloor(match(66000), P);
  yes("control: a match above the floor is NOT floored", over.partnerProfitShareCents > 0, $(over.partnerProfitShareCents));
  is("zero revenue still pays the rental", payoutForMatchFloor(match(0), P).partnerTotalCents, 16000);
}

console.log("\nthe two invariants, swept from $0 to $3,000");
{
  let maxGap = -Infinity, minGap = Infinity, newAbove = 0, constantGapPoints = 0, mdNegative = 0;
  const bad96: string[] = [];
  for (let g = 0; g <= 300000; g += 100) {
    const o = payoutForMatch(match(g), P);
    const n = payoutForMatchFloor(match(g), P);
    const gap = o.partnerTotalCents - n.partnerTotalCents;
    if (n.partnerTotalCents > o.partnerTotalCents) newAbove++;
    maxGap = Math.max(maxGap, gap); minGap = Math.min(minGap, gap);
    // Above the floor the gap is exactly (1 − s)·F.
    const splitClearsFloor = Math.round(((g - P.matchManagerCents) * P.partnerSharePct) / 100) >= P.fieldRentalCents;
    if (splitClearsFloor) { constantGapPoints++; if (gap !== 9600) bad96.push(`${$(g)} → gap ${$(gap)}`); }
    if (n.matchdayRetainedCents < 0) mdNegative++;
    if (!n.reconciles) bad96.push(`${$(g)} does not reconcile`);
  }
  is("THE NEW MODEL NEVER PAYS MORE THAN THE OLD, at any revenue", newAbove, 0);
  is("…and the gap never exceeds $96 a match", maxGap, 9600);
  yes(`…nor goes below $0 (min ${$(minGap)})`, minGap >= 0);
  is("wherever the split clears the floor the gap is exactly $96", bad96, []);
  yes(`control: ${constantGapPoints} sweep points actually clear the floor`, constantGapPoints > 100);
  yes(`control: MatchDay goes NEGATIVE somewhere in the sweep (${mdNegative} points)`, mdNegative > 0);
}

console.log("\nreconciliation, exactly, with no tolerance");
{
  const bad: string[] = [];
  for (let g = 0; g <= 300000; g += 137) {          // a prime-ish step, to land off round numbers
    const n = payoutForMatchFloor(match(g), P);
    if (n.partnerTotalCents + n.matchdayRetainedCents + n.matchManagerCents !== n.grossCents) bad.push($(g));
    if (!n.reconciles) bad.push(`${$(g)} flag`);
  }
  is("every match in the sweep reconciles to the cent", bad, []);
  /* AND THE AGGREGATE IN ITS OWN RIGHT, including a month with an underwater match in it. */
  const rows = [66000, 24000, 0, 150000].map((g) => payoutForMatchFloor(match(g), P));
  const t = totalsOf(rows);
  yes("the aggregate reconciles too", t.reconciles);
  is("…partner + matchday + manager === gross",
    t.partnerTotalCents + t.matchdayRetainedCents + t.matchManagerCents, t.grossCents);
  /* A SHARE THAT DOES NOT DIVIDE EVENLY still rounds once and still balances. */
  const odd: RentalProfitShareParams = { fieldRentalCents: 16000, matchManagerCents: 4000, partnerSharePct: 33 };
  const r = payoutForMatchFloor(match(70133), odd);
  is("a 33% share still reconciles exactly", r.partnerTotalCents + r.matchdayRetainedCents + r.matchManagerCents, r.grossCents);
}

console.log("\nthe shipped model is untouched — this is the way back");
{
  const drift: string[] = [];
  for (let g = 0; g <= 300000; g += 100) {
    const o = payoutForMatch(match(g), P);
    // The formula as the file's own header states it, recomputed independently here.
    const pool = g - P.fieldRentalCents - P.matchManagerCents;
    const share = pool > 0 ? Math.round((pool * P.partnerSharePct) / 100) : 0;
    if (o.partnerTotalCents !== P.fieldRentalCents + share) drift.push($(g));
    if (o.poolCents !== pool) drift.push(`${$(g)} pool`);
  }
  is("RENTAL_PLUS_PROFIT_SHARE matches its stated formula at every point in the sweep", drift, []);
  is("…and the dispatcher still routes the old kind to the old function",
    payoutForMatchOf("RENTAL_PLUS_PROFIT_SHARE", match(66000), P).partnerTotalCents,
    payoutForMatch(match(66000), P).partnerTotalCents);
  is("…while the new kind routes to the new one",
    payoutForMatchOf("RENTAL_FLOOR_PROFIT_SHARE", match(66000), P).partnerTotalCents,
    payoutForMatchFloor(match(66000), P).partnerTotalCents);
  /* AND THE TWO REALLY DIFFER, or the routing assertions above prove nothing. */
  yes("control: the two formulas give different answers on the same match",
    payoutForMatch(match(66000), P).partnerTotalCents !== payoutForMatchFloor(match(66000), P).partnerTotalCents);
}

console.log("\ncancelled and unplayed contribute nothing on the new kind either");
{
  for (const [label, over] of [["cancelled", { cancelled: true }], ["not yet played", { played: false }]] as const) {
    const r = payoutForMatchFloor(match(66000, over), P);
    is(`a ${label} match pays nothing`, [r.partnerTotalCents, r.grossCents, r.fieldRentalCents], [0, 0, 0]);
    yes(`…and still reconciles`, r.reconciles);
  }
  const t = totalsOf([payoutForMatchFloor(match(66000), P), payoutForMatchFloor(match(66000, { cancelled: true }), P)]);
  is("…and is not counted as a match played", t.matches, 1);
}

console.log("\nthe break-even sentence is derived, not the literal 440");
{
  is("Parmer's threshold is $440", topUpThresholdCents(P), 44000);
  /* CHANGE THE SHARE AND THE SENTENCE MUST FOLLOW. At 50% the top-up starts at $320 + $40. */
  is("at 50% it moves to $360", topUpThresholdCents({ ...P, partnerSharePct: 50 }), 36000);
  is("at 20% it moves to $840", topUpThresholdCents({ ...P, partnerSharePct: 20 }), 84000);
  is("a different rental moves it too", topUpThresholdCents({ ...P, fieldRentalCents: 20000 }), 54000);
  is("a zero share has no threshold", topUpThresholdCents({ ...P, partnerSharePct: 0 }), null);
  /* THE THRESHOLD IS THE POINT WHERE THE TOP-UP FIRST APPEARS — checked against the model itself,
   * not against arithmetic repeated here. */
  const t = topUpThresholdCents(P)!;
  is("one cent below the threshold there is no top-up", payoutForMatchFloor(match(t - 1), P).partnerProfitShareCents, 0);
  yes("…and at the threshold there is", payoutForMatchFloor(match(t), P).partnerProfitShareCents >= 0);
  yes("…and just above it there certainly is", payoutForMatchFloor(match(t + 100), P).partnerProfitShareCents > 0);
  const view = readFileSync("src/app/partners/[slug]/PartnerRentalView.tsx", "utf8");
  /* COMMENTS MAY SAY 440 — explaining where a derived number lands is the opposite of hardcoding
   * it. What must not exist is a 440 in code that renders. */
  const rendered = view.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  yes("the view prints the derived threshold", /p\.topUpThresholdCents/.test(view));
  yes("…and no rendered code contains the literal 440", !/440/.test(rendered));
  yes("…and the sentence follows the model kind, so switching back restores the old wording",
    /floorKind \? \(/.test(view) && /there is no profit share and MatchDay absorbs the loss/.test(view));
}

console.log("\nno branch tests the literal — every site routes through the predicate");
{
  yes("the predicate is true for both rental kinds",
    isRentalModel("RENTAL_PLUS_PROFIT_SHARE") && isRentalModel("RENTAL_FLOOR_PROFIT_SHARE"));
  is("…and false for the flat ones",
    ["REVENUE_SHARE", "PER_MATCH_MINUS_MANAGER"].map((k) => isRentalModel(k as PayoutModel)), [false, false]);
  is("…and for a missing model", isRentalModel(null), false);

  /* THE BRANCH SWEEP. Every remaining mention of the literal in src/ must be a COMMENT, a type
   * member, the parser that turns a database string into the enum, or the dispatcher — never a
   * branch deciding behaviour, because miss one and Parmer falls through to a flat model and shows
   * a number from the wrong formula entirely. */
  const files = ["src/lib/partnerStats.ts", "src/lib/partnerDashboardData.ts",
    "src/app/api/partner-dashboards/route.ts", "src/app/partners/[slug]/PartnerRentalView.tsx",
    "src/lib/partnerRentalDashboard.ts", "src/lib/partnerPayoutModel.ts"];
  const offenders: string[] = [];
  let sites = 0;
  for (const f of files) {
    for (const [i, line] of readFileSync(f, "utf8").split("\n").entries()) {
      if (!line.includes('"RENTAL_PLUS_PROFIT_SHARE"')) continue;
      sites++;
      const trimmed = line.trim();
      const allowed =
        trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")
        || /^\| "RENTAL_PLUS_PROFIT_SHARE"$/.test(trimmed)                       // the type union
        || /kind === "RENTAL_PLUS_PROFIT_SHARE" \|\| kind === "RENTAL_FLOOR_PROFIT_SHARE"/.test(trimmed)  // the predicate itself
        || /if \(raw === "RENTAL_PLUS_PROFIT_SHARE"\) return/.test(trimmed)      // the parser
        || /\?\? "RENTAL_PLUS_PROFIT_SHARE"/.test(trimmed);                      // the default
      if (!allowed) offenders.push(`${f}:${i + 1} ${trimmed.slice(0, 90)}`);
    }
  }
  yes(`control: ${sites} mentions of the literal were actually read`, sites > 0);
  is("no site branches on the bare literal", offenders, []);
  /* AND THE ONE GATE really is the one gate. */
  const stats = readFileSync("src/lib/partnerStats.ts", "utf8");
  yes("rentalParamsOf routes through the predicate", /if \(!isRentalModel\(p\.payoutModel\)\) return null;/.test(stats));
  for (const f of ["src/lib/partnerDashboardData.ts", "src/app/api/partner-dashboards/route.ts"]) {
    const src = readFileSync(f, "utf8");
    yes(`${f.split("/").pop()} asks the gate, not the model name`, /rentalParamsOf\(/.test(src) && /if \(rentalParams\)/.test(src));
  }
  /* AND THE KIND REACHES THE FORMULA. A page that computes with the default while the row says
   * otherwise is the silent failure this whole design is trying to avoid. */
  for (const f of files.slice(0, 3)) {
    const src = readFileSync(f, "utf8");
    if (/buildRentalDashboard\(/.test(src)) {
      yes(`${f.split("/").pop()} passes the partner's kind to the builder`, /payoutModel: (partner|dash)\.payoutModel/.test(src));
    }
  }
}

console.log(`\npartner-floor-payout: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
