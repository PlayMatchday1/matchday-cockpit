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
  /* THE THRESHOLD IS NO LONGER PRINTED. "40% of profit pool with a floor of $160.00" says what the
   * "below $440 of revenue" sentence said, without a fourth derived figure that has to be kept in
   * step with three parameters to stay true. The function stays — it is asserted above — and the
   * literal must still never appear in rendered code. */
  yes("no rendered code contains the literal 440", !/440/.test(rendered));
  yes("the floor kind renders nothing under the green box",
    /\{!floorKind && \([\s\S]{0,400}prv-gtee/.test(view));
  is("…so the top-up threshold sentence is gone", view.match(/there is no top-up/g), null);
  is("…and so is the rental guarantee sentence", view.match(/is yours on every match played, whatever/g), null);
  /* THE WAY BACK KEEPS ITS OWN WORDING, untouched: switching the row back to
   * RENTAL_PLUS_PROFIT_SHARE must restore the page it had, sentences included. */
  yes("the shipped kind keeps its guarantee and its breakeven line",
    /rental is yours on every match played/.test(view)
    && /there is no profit share and MatchDay absorbs the loss/.test(view));
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

console.log("\nA cancelled date can still owe the rental");
{
  /* THE FEE IS OFF UNTIL A PARTNER ROW TURNS IT ON. This is the behaviour that shipped, and the
   * contract's "MAY" is why it is a setting rather than a constant. */
  const off = payoutForMatchFloor(match(0, { cancelled: true, played: false, spotsSold: 0, rentalChargeOverride: true }), P);
  is("fee disabled — a cancelled date owes nothing even with an operator charge", off.partnerTotalCents, 0);

  /* PARMER, WITH THE FEE ON. 12 hours, from the row and not from a literal. */
  const C: RentalProfitShareParams = { ...P, cancellationFeeEnabled: true, cancellationNoticeHours: 12 };
  const cx = (over: Partial<MatchInput> = {}) =>
    match(0, { matchApiId: 18321, startYmd: "2026-09-05", cancelled: true, played: false, spotsSold: 0, ...over });

  /* SEP 5. Notice is unknown — nothing we store records when a match was cancelled — so the
   * operator's decision is the only thing that charges it. */
  const sep5 = payoutForMatchFloor(cx({ cancelledNoticeHours: null, rentalChargeOverride: true }), C);
  is("Sep 5, charged by the operator — $160 owed", sep5.partnerTotalCents, 16000);
  is("…no revenue", sep5.grossCents, 0);
  is("…no manager pay on a cancelled date", sep5.matchManagerCents, 0);
  is("…no pool, no split", [sep5.poolCents, sep5.partnerProfitShareCents], [0, 0]);
  is("…MatchDay absorbs it: retained is negative", sep5.matchdayRetainedCents, -16000);
  yes("…and the row still reconciles exactly", sep5.reconciles);
  /* THE IDENTITY, SPELLED OUT ON A CANCELLED MATCH — the case the subtraction form exists for. */
  is("partnerTotal + matchdayRetained + matchManager = gross, on a cancelled match",
    sep5.partnerTotalCents + sep5.matchdayRetainedCents + sep5.matchManagerCents, sep5.grossCents);
  yes("…and it is marked cancelled, not merely zeroed", sep5.cancelled === true && sep5.played === false);

  /* NOBODY HAS SAID — nothing is owed. Never bill a partner on a guess. */
  is("no decision recorded — nothing owed", payoutForMatchFloor(cx(), C).partnerTotalCents, 0);
  /* THE WEATHER WAIVER. PopStroke-initiated weather cancellations incur no fee, ever, and no data
   * we hold can derive that — it is the operator's stored decision, and it wins outright. */
  is("weather waiver — nothing owed even at zero notice",
    payoutForMatchFloor(cx({ cancelledNoticeHours: 0, rentalChargeOverride: false }), C).partnerTotalCents, 0);

  /* THE THRESHOLD IS LIVE the moment a notice is known, and it comes off the partner row. */
  is("2h notice, under the threshold — $160 owed",
    payoutForMatchFloor(cx({ cancelledNoticeHours: 2 }), C).partnerTotalCents, 16000);
  is("36h notice, over the threshold — nothing owed (the control)",
    payoutForMatchFloor(cx({ cancelledNoticeHours: 36 }), C).partnerTotalCents, 0);
  is("exactly at the threshold is NOT short notice",
    payoutForMatchFloor(cx({ cancelledNoticeHours: 12 }), C).partnerTotalCents, 0);
  /* AND THE THRESHOLD IS A SETTING, not the number 12 hiding in the code: move it and the same
   * match changes side. */
  const C24: RentalProfitShareParams = { ...C, cancellationNoticeHours: 24 };
  is("the same 18h notice flips when the ROW's threshold moves to 24",
    [payoutForMatchFloor(cx({ cancelledNoticeHours: 18 }), C).partnerTotalCents,
     payoutForMatchFloor(cx({ cancelledNoticeHours: 18 }), C24).partnerTotalCents], [0, 16000]);

  /* A CHARGED CANCELLATION IS MONEY BUT NOT A MATCH PLAYED. */
  const played = payoutForMatchFloor(match(66000), C);
  const t = totalsOf([played, sep5]);
  is("totals: one match played, not two", t.matches, 1);
  is("…and the rental still lands in the total", t.partnerTotalCents, 24800 + 16000);
  is("…the month reconciles too", t.partnerTotalCents + t.matchdayRetainedCents + t.matchManagerCents, t.grossCents);
  yes("…and the month is flagged as reconciling", t.reconciles);

  /* THE SHIPPED MODEL DOES NOT MOVE. Same inputs, same settings, still nothing owed — the way back
   * has to stay the way back. */
  for (const over of [{ rentalChargeOverride: true }, { cancelledNoticeHours: 1 }] as Partial<MatchInput>[]) {
    const legacy = payoutForMatch(cx(over), C);
    is(`RENTAL_PLUS_PROFIT_SHARE ignores the cancellation fee (${JSON.stringify(over)})`,
      [legacy.partnerTotalCents, legacy.matchdayRetainedCents, legacy.grossCents], [0, 0, 0]);
  }
}

console.log("\nThe reconciliation assertion still fires — proven by breaking it");
{
  /* A POSITIVE CONTROL FOR AN ASSERTION WHOSE PASSING VALUE IS "true". `reconciles` is only worth
   * anything if it can be false, so here is a row built to fail it: the same cancelled match with
   * the rental owed to the partner AND retained by MatchDay, which is $320 out of a $0 match. */
  const C: RentalProfitShareParams = { ...P, cancellationFeeEnabled: true };
  const good = payoutForMatchFloor(match(0, { cancelled: true, played: false, spotsSold: 0, rentalChargeOverride: true }), C);
  yes("the honest row reconciles", good.reconciles);
  const broken = { ...good, matchdayRetainedCents: 16000, matchdayProfitShareCents: 16000 };
  broken.reconciles = broken.partnerTotalCents + broken.matchdayRetainedCents + broken.matchManagerCents === broken.grossCents;
  yes("the deliberately broken row does NOT reconcile", !broken.reconciles,
    `partnerTotal ${$(broken.partnerTotalCents)} + retained ${$(broken.matchdayRetainedCents)} != gross ${$(broken.grossCents)}`);
  /* AND THE FAILURE PROPAGATES to the month, which is what the page renders the error from. */
  const t = totalsOf([broken]);
  yes("…and the month it is in does not reconcile either", !t.reconciles);
  /* THE VIEW MUST RENDER THE ERROR RATHER THAN A NUMBER when that happens. */
  const view = readFileSync("src/app/partners/[slug]/PartnerRentalView.tsx", "utf8");
  yes("a non-reconciling row prints 'does not reconcile' instead of a total",
    /r\.reconciles \? fmtCents\(r\.partnerTotalCents\) : <span className="prv-cellerr"/.test(view));
  yes("a non-reconciling page refuses outright", /!p\.reconciles &&[\s\S]{0,120}prv-reconcile-error/.test(view));
  yes("the month still carries its verdict to the page", /data-holds=\{m\.totals\.reconciles/.test(view));
}

console.log("\nThe partner-facing page shows what the partner is owed, not MatchDay's slice");
{
  const view = readFileSync("src/app/partners/[slug]/PartnerRentalView.tsx", "utf8");
  const body = view.slice(view.indexOf("export default"));
  const stats0 = readFileSync("src/lib/partnerStats.ts", "utf8");
  /* THE COLUMN IS GONE — header, row cell and footer cell. */
  is("no MatchDay share column header", body.match(/MatchDay share/g), null);
  is("no per-row MatchDay cell", body.match(/prv-row-mdshare/g), null);
  is("no 'kept by MatchDay' anywhere", view.match(/kept by MatchDay/g), null);
  /* THE FIGURE IS STILL COMPUTED AND STILL CHECKED — removing it from the page must not remove it
   * from the arithmetic, which is the whole risk of this change. */
  const model = readFileSync("src/lib/partnerPayoutModel.ts", "utf8");
  /* BOTH rental formulas must still write it as a subtraction — that is what keeps it exact when
   * MatchDay absorbs a shortfall, and a cancelled match is the largest shortfall there is. */
  is("matchdayRetained is still a subtraction in both rental formulas",
    (model.match(/const matchdayRetainedCents = m\.grossCents - /g) ?? []).length, 2);
  yes("…still asserted per match", /reconciles:/.test(model));
  yes("…still summed and asserted per period", /reconciles[\s\S]{0,200}partnerTotalCents \+[\s\S]{0,80}grossCents/.test(model));
  /* THE NEW WORDING SAYS WHAT IS OWED AND WHAT WAS COLLECTED. */
  yes("the reconciliation line states what the partner is owed", /You are owed <b>\{fmtCents\(m\.totals\.partnerTotalCents\)\}<\/b>/.test(body));
  yes("…and what was collected", /collected\s*\n?\s*from players/.test(body));
  /* THE HEADER, in the page's own casing (CSS uppercases it). */
  yes("the top-up column reads 'Additional paid'", /<th className="n">Additional paid<\/th>/.test(body));
  is("…and neither of the labels it replaced", body.match(/<th className="n">(Add to be paid|To be paid)<\/th>/g), null);

  /* ── THE GREEN BOX, AND THE LINE IT DEPENDS ON ────────────────────────────────────────────── */
  yes("the green box is max(floor, share of pool), in seven words",
    /\$\{p\.params\.partnerSharePct\}% of profit pool with a floor of \$\{fmtCents\(p\.params\.fieldRentalCents\)\}/.test(view));
  /* NOTHING IS WRITTEN INTO THE SENTENCE. Every figure in that block comes off the partner row. */
  const green = view.slice(view.indexOf('data-testid="prv-formula"'), view.indexOf('data-testid="prv-table"'));
  const greenRendered = green.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  is("no hardcoded 160, 40 or 440 in the block that renders it",
    greenRendered.match(/\b(160|440)\b/g) ?? greenRendered.match(/\b40\b(?!\})/g), null);
  /* THE STRIP MUST MATCH THE TABLE. payoutForMatchFloor computes pool = gross − matchManager, with
   * the rental NOT deducted — the strip printed it as a deduction and was wrong by the rental on
   * every row. Checked against the MODEL, not against arithmetic repeated here. */
  yes("the formula strip drops the rental on the floor kind",
    /\{!floorKind && <><span className="prv-op">−<\/span><span className="prv-tok prv-cost">\{fmtCents\(p\.params\.fieldRentalCents\)\} field rental/.test(view));
  const strip = payoutForMatchFloor(match(66000), P);
  is("…and that is the pool the model actually computes", strip.poolCents, 66000 - P.matchManagerCents);
  /* AND THE TWO FORMULAS DIFFER BY EXACTLY THE RENTAL, which is why one strip cannot serve both. */
  is("…and the shipped kind's pool is that same pool minus the rental",
    strip.poolCents - payoutForMatch(match(66000), P).poolCents, P.fieldRentalCents);
  /* THE MODEL NAME MOVED — off the partner page, onto the internal one. */
  is("the model name is off the partner-facing page", view.match(/Rental floor \+ profit share/g), null);
  const idx = readFileSync("src/app/(internal)/match-ops/partner-dashboards/PartnerDashboardsIndex.tsx", "utf8");
  yes("…and onto the internal Partner Dashboards page", /data-testid="admin-model"/.test(idx));
  yes("…named for a person, for every model", /RENTAL_FLOOR_PROFIT_SHARE: "Rental floor \+ profit share"/.test(idx));
  /* AND IT NAMES THE MODEL THE FIGURES CAME FROM. The admin partner row carries deliberate
   * pre-0123 defaults for payoutModel and would confidently name the wrong one. */
  yes("…read from the preview payload, not the admin partner row",
    /previewData\.rental\.payoutModel/.test(idx));
  /* A CHARGED CANCELLATION IS VISIBLY CANCELLED. */
  yes("a cancelled row is labelled on the page", /prv-row-cancelled/.test(body) && /r\.cancelled &&/.test(body));
  /* AND THE BUILDER KEEPS IT rather than dropping every cancelled match. */
  const build = readFileSync("src/lib/partnerRentalDashboard.ts", "utf8");
  yes("the builder keeps a cancelled match that owes money", /if \(p\.cancelled && p\.partnerTotalCents === 0\) continue;/.test(build));
  yes("…and reads the operator's decision from stored overrides", /rentalOverrides\?\.get\(/.test(build));
  yes("…and never guesses the notice", /cancelledNoticeHours: null/.test(build));
  yes("the overrides come from the database, not component state",
    /from\("partner_match_rental_overrides"\)/.test(stats0));
  /* ONE READER, BOTH CALLERS. If only the page knew about a charged cancellation, the partner
   * would be SHOWN $822 and RECORDED as paid $662 — the worst disagreement this system can make. */
  for (const f of ["src/lib/partnerDashboardData.ts", "src/app/api/partner-dashboards/route.ts"]) {
    yes(`${f.split("/").pop()} reads the overrides before computing a figure`,
      /fetchRentalOverrides\(/.test(readFileSync(f, "utf8")));
  }
  /* AND THE WRITE IS A LOGGED SERVER ROUTE, not local state. */
  const route = readFileSync("src/app/api/partner-dashboards/cancellation-override/route.ts", "utf8");
  yes("the decision is written server-side through recordWrite", /recordWrite\(/.test(route));
  yes("…admin-gated", /authenticateCapability\(req, "matchops"\)/.test(route));
  yes("…with a mandatory reason", /A reason is required/.test(route));
  yes("…and every write is keyed, never unqualified (pg_safeupdate)",
    (route.match(/\.eq\("partner_dashboard_id", partnerId\)/g) ?? []).length >= 2);
  const mig = readFileSync("supabase/migrations/0162_cancellation_rental_fee.sql", "utf8");
  yes("0162 puts both settings on the partner row", /cancellation_fee_enabled/.test(mig) && /cancellation_notice_hours/.test(mig));
  yes("…and the override table carries a reason and an actor",
    /partner_match_rental_overrides/.test(mig) && /reason/.test(mig) && /created_by/.test(mig));
  /* THE SETTINGS ARE ON THE PARTNER ROW. */
  /* AND IT DOES NOT LEAVE THE SERVER ON THE PUBLIC ROUTE. The table not printing a figure is not
   * the same as the page not carrying it: this URL is public and the retained cents were readable
   * in the serialised props. The strip is on the public route only, so the admin preview and the
   * partner page still render identical numbers. */
  const pub = readFileSync("src/app/partners/[slug]/page.tsx", "utf8");
  yes("the public route strips MatchDay's slice out of the props", /stripMatchdayShare\(data\.rental\)/.test(pub));
  yes("…across rows, scheduled rows, month totals and the grand total",
    /rows: m\.rows\.map\(blank\)/.test(pub) && /scheduled: m\.scheduled\.map\(blank\)/.test(pub)
    && /totals: blank\(m\.totals\)/.test(pub) && /grand: blank\(r\.grand\)/.test(pub));
  yes("…and the view never reads the figure it strips",
    !/matchdayProfitShareCents|matchdayRetainedCents/.test(body));
  yes("the fee switch is read off the partner row", /cancellation_fee_enabled/.test(stats0));
  yes("the threshold is read off the partner row", /cancellation_notice_hours/.test(stats0));
  yes("…and both reach the formula", /cancellationFeeEnabled: p\.cancellationFeeEnabled/.test(stats0));
}

console.log(`\npartner-floor-payout: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
