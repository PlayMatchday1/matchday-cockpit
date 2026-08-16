import "server-only"; // no-op under --conditions=react-server
// The Parmer payout model, tested where the arithmetic lives.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/partner-payout-model-test.ts

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  payoutForMatch, totalsOf, breakevenSpots, grossCentsFromRows, newVsReturning, fmtCents,
  type RentalProfitShareParams, type MatchInput,
} from "../src/lib/partnerPayoutModel";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) => (got === want ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const eq = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);

// PARAMETERS COME FROM THE PARTNER ROW. Declared once here as the stand-in for that row; the
// grep assertion at the bottom proves no other file hardcodes them.
const PARMER: RentalProfitShareParams = { fieldRentalCents: 16000, matchManagerCents: 4000, partnerSharePct: 40 };
const M = (gross: number, extra: Partial<MatchInput> = {}): MatchInput =>
  // `played: true` by default — every existing assertion below describes a match that HAPPENED,
  // and the payout of one that has not is a separate question asserted on its own further down.
  // Helper signature only; no assertion body changed.
  ({ matchApiId: 1, startYmd: "2026-08-05", cancelled: false, played: true, grossCents: gross, spotsSold: Math.round(gross / 1500), ...extra });

const isnt = (n: string, got: unknown, want: unknown) => (got !== want ? ok(n) : bad(n, `got ${JSON.stringify(got)} — expected it to DIFFER`));

console.log("\nTHE TWO WORKED EXAMPLES, to the cent");
{
  const r = payoutForMatch(M(60000), PARMER);
  eq("gross 60000c → pool 40000, partner share 16000, partner total 32000, matchday retained 24000", {
    pool: r.poolCents, share: r.partnerProfitShareCents, partnerTotal: r.partnerTotalCents, retained: r.matchdayRetainedCents,
  }, { pool: 40000, share: 16000, partnerTotal: 32000, retained: 24000 });
  is("...and 32000 + 24000 + 4000 = 60000", r.partnerTotalCents + r.matchdayRetainedCents + r.matchManagerCents, 60000);
  is("...so it reconciles", r.reconciles, true);
}
{
  // 13 spots x $15 — the below-cost case the brief calls out
  const r = payoutForMatch(M(19500), PARMER);
  eq("gross 19500c → pool −500, partner share 0, partner total 16000, matchday retained −500", {
    pool: r.poolCents, share: r.partnerProfitShareCents, partnerTotal: r.partnerTotalCents, retained: r.matchdayRetainedCents,
  }, { pool: -500, share: 0, partnerTotal: 16000, retained: -500 });
  is("...and 16000 + (−500) + 4000 = 19500", r.partnerTotalCents + r.matchdayRetainedCents + r.matchManagerCents, 19500);
  is("...so it reconciles even underwater", r.reconciles, true);
  is("the partner is owed the FULL rental whatever the revenue — it is a cost of playing", r.partnerTotalCents >= PARMER.fieldRentalCents, true);
  is("...and MatchDay's retained figure is NEGATIVE, not hidden or floored", r.matchdayRetainedCents < 0, true);
}

console.log("\nTHE BELOW-COST BOUNDARY — the pool turns at $200, not $160");
{
  is("13 spots ($195.00) is underwater", payoutForMatch(M(19500), PARMER).poolCents < 0, true);
  is("14 spots ($210.00) clears it", payoutForMatch(M(21000), PARMER).poolCents > 0, true);
  is("exactly $200.00 yields a pool of zero — and therefore NO profit share", payoutForMatch(M(20000), PARMER).partnerProfitShareCents, 0);
  is("...its pool is exactly 0", payoutForMatch(M(20000), PARMER).poolCents, 0);
  is("one cent over $200 produces a share of 0 (rounds down from 0.4c)", payoutForMatch(M(20001), PARMER).partnerProfitShareCents, 0);
  is("...and still reconciles", payoutForMatch(M(20001), PARMER).reconciles, true);
  is("BREAKEVEN at $15 a spot is 14 spots", breakevenSpots(1500, PARMER), 14);
  // 16 spots = $240.00 = exactly the $200+$40 cost, pool 0, NO share. It takes 17.
  is("...derived from the parameters, not stated: a $200 rental needs 17, not 16", breakevenSpots(1500, { ...PARMER, fieldRentalCents: 20000 }), 17);
  is("...and a $20 spot price needs 11", breakevenSpots(2000, PARMER), 11);
  is("an unknown spot price yields no breakeven rather than a wrong one", breakevenSpots(0, PARMER), null);
}

console.log("\nRECONCILIATION on 100 randomised gross values (deterministic LCG — no Math.random)");
{
  // A seeded generator: the same 100 cases every run, so a failure is reproducible.
  let seed = 20260814;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const cases: number[] = [0, 1500, 19500, 20000, 20001, 21000, 60000];  // zero, one spot, either side of $200
  while (cases.length < 100) cases.push(Math.round(next() * 120000));
  let allOk = true, worst = "";
  for (const gross of cases) {
    const r = payoutForMatch(M(gross), PARMER);
    const lhs = r.partnerTotalCents + r.matchdayRetainedCents + r.matchManagerCents;
    if (lhs !== gross || !r.reconciles) { allOk = false; worst = `gross=${gross} lhs=${lhs}`; break; }
    if (!Number.isInteger(r.partnerProfitShareCents)) { allOk = false; worst = `non-integer share at ${gross}`; break; }
  }
  is(`reconciliation holds EXACTLY on all ${cases.length} cases (incl. 0, one spot, and either side of $200)`, allOk, true);
  if (!allOk) console.log("      first failure:", worst);
  is("...the set really does include zero", cases.includes(0), true);
  is("...one spot", cases.includes(1500), true);
  is("...and values either side of $200", cases.includes(19500) && cases.includes(21000), true);
}

console.log("\nA CANCELLED MATCH CONTRIBUTES NOTHING");
{
  const c = payoutForMatch(M(60000, { cancelled: true }), PARMER);
  eq("every figure on a cancelled match is zero — no rental, no manager cost, no share", {
    gross: c.grossCents, spots: c.spotsSold, rental: c.fieldRentalCents, mgr: c.matchManagerCents,
    pool: c.poolCents, share: c.partnerProfitShareCents, total: c.partnerTotalCents, retained: c.matchdayRetainedCents,
  }, { gross: 0, spots: 0, rental: 0, mgr: 0, pool: 0, share: 0, total: 0, retained: 0 });
  is("...and it still reconciles (0 + 0 + 0 = 0)", c.reconciles, true);
  const t = totalsOf([payoutForMatch(M(60000), PARMER), c, payoutForMatch(M(60000, { matchApiId: 2 }), PARMER)]);
  is("a cancelled match does not count toward the MATCH COUNT", t.matches, 2);
  is("...nor the rental owed", t.fieldRentalCents, 32000);
  is("...nor the gross", t.grossCents, 120000);
}

console.log("\nAGGREGATES sum the per-match results, and are checked in their own right");
{
  // one profitable, one underwater — the case where summing gross first would give a DIFFERENT answer
  const rows = [payoutForMatch(M(60000), PARMER), payoutForMatch(M(19500, { matchApiId: 2 }), PARMER)];
  const t = totalsOf(rows);
  is("the monthly reconciliation holds", t.partnerTotalCents + t.matchdayRetainedCents + t.matchManagerCents, t.grossCents);
  is("...and is reported as reconciling", t.reconciles, true);
  is("partner total = 32000 + 16000", t.partnerTotalCents, 48000);
  is("matchday retained = 24000 + (−500)", t.matchdayRetainedCents, 23500);
  // the floor is PER MATCH: a combined pool would have been 79500-40000 = 39500 → share 15800
  const combined = payoutForMatch(M(79500), { ...PARMER, fieldRentalCents: 32000, matchManagerCents: 8000 });
  is("the max(0,pool) floor is applied PER MATCH, not to a combined pool", t.partnerProfitShareCents !== combined.partnerProfitShareCents, true);
  is("...per-match gives 16000, combined would have given 15800", `${t.partnerProfitShareCents}/${combined.partnerProfitShareCents}`, "16000/15800");
}

console.log("\nROUNDING happens ONCE, at the end, in cents");
{
  // a pool that does not divide evenly by the share percentage
  const r = payoutForMatch(M(20003), PARMER);   // pool 3 → 40% = 1.2 → 1
  is("a fractional share rounds to whole cents", r.partnerProfitShareCents, 1);
  is("...and the reconciliation still holds exactly", r.partnerTotalCents + r.matchdayRetainedCents + r.matchManagerCents, 20003);
  const r2 = payoutForMatch(M(20007), PARMER);  // pool 7 → 2.8 → 3
  is("...half-up, not truncated", r2.partnerProfitShareCents, 3);
  is("...and that reconciles too", r2.reconciles, true);
  is("every output is an integer number of cents", [r, r2].every((x) =>
    [x.poolCents, x.partnerProfitShareCents, x.partnerTotalCents, x.matchdayRetainedCents].every(Number.isInteger)), true);
}

console.log("\nGROSS REVENUE — every spot at what was actually paid");
{
  const rows = [
    { paymentType: "DAILY PAID", amountCents: 1500, userType: "PLAYER" },
    { paymentType: "PROMOCODE", amountCents: 750, userType: "PLAYER" },   // discounted, and it COUNTS
    { paymentType: "MEMBER", amountCents: 0, userType: "PLAYER" },        // free member spot, $0
    { paymentType: "DAILY PAID", amountCents: 1500, userType: "STAFF" },  // MatchDay staff — excluded
    { paymentType: null, amountCents: 1500, userType: "PLAYER" },         // WAITING — never a spot
  ];
  const g = grossCentsFromRows(rows);
  is("a promo spot counts at its DISCOUNTED price, not zero and not full", g.grossCents, 2250);
  is("...staff spots are excluded from revenue", g.grossCents < 3750, true);
  is("...and from the spot count", g.spotsSold, 3);
  is("a free member spot is a SPOT at $0, not a dropped row", grossCentsFromRows([{ paymentType: "MEMBER", amountCents: 0, userType: "PLAYER" }]).spotsSold, 1);
  is("an unsettled (WAITING) row is not a spot", grossCentsFromRows([{ paymentType: null, amountCents: 1500, userType: "PLAYER" }]).spotsSold, 0);
}

console.log("\nNEW vs RETURNING — against ALL venue history, not the displayed window");
{
  const history = [
    { userId: "early", ymd: "2026-07-01" },   // first Parmer match BEFORE the window
    { userId: "early", ymd: "2026-08-06" },   // ...and again inside it
    { userId: "fresh", ymd: "2026-08-05" },   // first ever Parmer match, inside the window
    { userId: "fresh", ymd: "2026-08-12" },
    { userId: "gone", ymd: "2026-07-02" },    // only ever appeared before the window
  ];
  const r = newVsReturning(history, "2026-08-01", "2026-08-31");
  is("a player whose FIRST Parmer match predates the window is RETURNING, not new", r.returning, 1);
  eq("...and only the genuinely first-time player is new", r.newUserIds, ["fresh"]);
  is("new count", r.newPlayers, 1);
  is("someone who never appeared in the window is in neither bucket", r.newPlayers + r.returning, 2);
  // the failure this exists to prevent: a window-only computation calls `early` new every month
  const windowOnly = newVsReturning(history.filter((a) => a.ymd >= "2026-08-01"), "2026-08-01", "2026-08-31");
  is("MUTATION — computing against the WINDOW ONLY wrongly calls the returning player new", windowOnly.newPlayers, 2);
  is("...which is exactly the bug the all-history version avoids", r.newPlayers !== windowOnly.newPlayers, true);
}

console.log("\nA BROKEN RECONCILIATION IS REPORTED, not rendered as a number");
{
  const good = payoutForMatch(M(60000), PARMER);
  is("a sound row reports reconciles=true", good.reconciles, true);
  // MUTATION: corrupt one figure the way a bad edit would, and prove the flag flips.
  const broken = { ...good, partnerTotalCents: good.partnerTotalCents + 1 };
  const check = broken.partnerTotalCents + broken.matchdayRetainedCents + broken.matchManagerCents === broken.grossCents;
  is("MUTATION — one cent out of place makes the identity FAIL", check, false);
  const brokenTotals = totalsOf([broken]);
  is("...and the aggregate catches it too, independently of the row flag", brokenTotals.reconciles, false);
}

console.log("\nNOTHING IS HARDCODED OUTSIDE THE PARAMETER ROW");
{
  // The rule is about the PAYOUT PARAMETERS, so the sweep is scoped to the payout surface — every
  // file that computes or renders a partner payout. A bare 4000 elsewhere in the app is a message
  // limit or a timeout, not Parmer's manager cost, and flagging those would train us to ignore this.
  const files: string[] = [];
  (function walk(d: string) { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(e)) files.push(p); } })("src");
  const payoutSurface = files.filter((f) => /partner|payout/i.test(f));
  is("the payout surface is a real set of files", payoutSurface.length >= 5, true);

  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const offenders: string[] = [];
  for (const f of payoutSurface) {
    const code = strip(readFileSync(f, "utf8"));
    if (/\b16000\b/.test(code)) offenders.push(`${f}: hardcodes 16000`);
    if (/\b4000\b/.test(code)) offenders.push(`${f}: hardcodes 4000`);
    if (/partnerSharePct\s*[:=]\s*40\b/.test(code)) offenders.push(`${f}: hardcodes a 40 share`);
    if (/\*\s*0\.4\b|\b0\.4\s*\*/.test(code)) offenders.push(`${f}: hardcodes 0.4`);
  }
  eq("no payout file hardcodes 16000 / 4000 / a 40 share / 0.4", offenders, []);

  // The partner NAME must not steer the payout either. venueResolver is the pre-existing place a
  // venue's canonical name lives (it mapped "Parmer" long before this model existed) and is not
  // payout logic, so it is named as the one allowed site rather than silently skipped.
  const ALLOWED_TO_NAME_A_VENUE = ["src/lib/venueResolver.ts", "src/lib/venueResolver.test.ts"];
  const namers = files.filter((f) => /\bparmer\b/i.test(strip(readFileSync(f, "utf8"))))
    .filter((f) => !ALLOWED_TO_NAME_A_VENUE.includes(f.split("\\").join("/")));
  eq("no file outside venueResolver names Parmer — the payout is selected by the partner row, not by who the partner is", namers, []);
  is("...and venueResolver really does name it, so the exception is not vacuous",
    /\bparmer\b/i.test(readFileSync("src/lib/venueResolver.ts", "utf8")), true);
}

console.log("\nTHE EXISTING THREE PARTNERS CANNOT MOVE — proven on the migration's own text");
{
  const sql = readFileSync("supabase/migrations/0123_partner_payout_models.sql", "utf8");
  // periodOwed() reads exactly these columns. If the migration wrote to any of them, an existing
  // partner's figures could change; it must only ADD columns and backfill the new selector.
  const INPUTS_TO_THE_OLD_MATH = ["revenue_model", "revenue_share_pct", "manager_pay_base", "manager_pay_high", "manager_pay_threshold", "payment_start_date", "payment_cadence"];
  const writes = sql.split("\n").filter((l) => /^\s*(update|alter table .*(drop column|alter column|rename))/i.test(l));
  const updateTargets = (sql.match(/update\s+partner_dashboards[\s\S]*?(?=;)/gi) ?? []).join("\n");
  const touched = INPUTS_TO_THE_OLD_MATH.filter((c) => new RegExp(`set[\\s\\S]*\\b${c}\\s*=`, "i").test(updateTargets));
  eq("the migration writes to NONE of the columns periodOwed reads", touched, []);
  is("...it does not drop or retype any column", /drop column|alter column|rename column/i.test(sql.replace(/--.*$/gm, "")), false);
  is("...and it really does contain UPDATEs (so the check is not vacuous)", writes.length > 0, true);
  is("the legacy revenue_model column is left in place, still driving the two old models",
    /revenue_model is LEFT EXACTLY AS IT IS|left on its default/i.test(sql), true);
  is("Crossbar is recognised as ALREADY on a second model, not folded into REVENUE_SHARE",
    /per_match_minus_manager.*then 'PER_MATCH_MINUS_MANAGER'/s.test(sql), true);
  // Comments EXPLAIN the numbers; that is not a second place they live. Strip them and count.
  const sqlCode = sql.replace(/--.*$/gm, "");
  is("Parmer's rental appears exactly ONCE in the executable SQL — one parameter row", (sqlCode.match(/16000/g) ?? []).length, 1);
  is("...and the manager cost likewise", (sqlCode.match(/\b4000\b/g) ?? []).length, 1);
  is("...and the share percentage is on that same row", (sqlCode.match(/\b40,\s*1500\b/g) ?? []).length, 1);
  is("a partner cannot be saved on a model without its parameters", /payout_params_present/.test(sql), true);
  is("the venue is created first, because partner_dashboards.venue_id is a FK to fin_venues",
    sql.indexOf("insert into fin_venues") < sql.indexOf("insert into partner_dashboards"), true);
}

console.log("\nFORMATTING");
is("cents render as dollars", fmtCents(16000), "$160.00");
is("a negative retained figure renders with its sign", fmtCents(-500), "-$5.00");
is("...and is not shown as zero", fmtCents(-500) !== "$0.00", true);
is("an odd cent survives", fmtCents(20003), "$200.03");


// ── AN OPEN MONTH IS NOT A BILL ────────────────────────────────────────────────────────────────
// The live page booked MatchDay a −$185.00 loss on Aug 19, a match that had not been played, and
// credited Parmer $160.00 of rental for a field that had not been rented. $1,368.00 "owed" was
// really $1,208.00 earned. A scheduled match contributes NOTHING — and is still listed.
console.log("\nA MATCH THAT HAS NOT BEEN PLAYED CONTRIBUTES NOTHING");
{
  const scheduled = payoutForMatch(M(1500, { played: false }), PARMER);
  is("no rental is owed on a field that has not been rented", scheduled.fieldRentalCents, 0);
  is("...no manager cost either", scheduled.matchManagerCents, 0);
  is("...no loss is booked against MatchDay", scheduled.matchdayRetainedCents, 0);
  is("...and no revenue is claimed", scheduled.grossCents, 0);
  is("...it is still marked scheduled, so the page can LIST it rather than hide it", scheduled.played, false);
  is("...and it is NOT marked cancelled — 'has not happened yet' is a different fact", scheduled.cancelled, false);

  // The exact shape of the bug: one unplayed match among played ones must not move any total.
  const played = [payoutForMatch(M(46500), PARMER), payoutForMatch(M(66000), PARMER)];
  const withScheduled = totalsOf([...played, scheduled]);
  const withoutIt = totalsOf(played);
  is("a scheduled match changes NO total", JSON.stringify(withScheduled), JSON.stringify(withoutIt));
  is("...and does not inflate the match count", withScheduled.matches, 2);

  // POSITIVE CONTROL — the same match, played, DOES move the totals. Without this the assertion
  // above would pass just as well if payoutForMatch always returned zeros.
  const nowPlayed = totalsOf([...played, payoutForMatch(M(1500, { played: true }), PARMER)]);
  isnt("...while the SAME match, once played, does move them", JSON.stringify(nowPlayed), JSON.stringify(withoutIt));
  is("...and a played match under cost still pays the full rental", payoutForMatch(M(1500, { played: true }), PARMER).partnerTotalCents, 16000);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);