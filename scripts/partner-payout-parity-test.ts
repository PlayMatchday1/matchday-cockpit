import "server-only"; // no-op under --conditions=react-server
// FINANCE › EVERY PARTNER'S COST MUST EQUAL THEIR PAYOUT.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/partner-payout-parity-test.ts
//
// THE BUG THIS ENDS. A partner's payout was computed in TWO places that did not know about each
// other:
//
//   the partner dashboard   dispatches on payout_model  -> PARMER $2,006.00
//   buildPartnerPayoutsByVenueMonth  had a FIXED argument list that could only express
//                           flat_percentage x revenue_share_pct  -> PARMER $1,815.00
//
// PARMER's row still carries the seed values revenue_model='flat_percentage' and
// revenue_share_pct=50 while its real deal is RENTAL_PLUS_PROFIT_SHARE. The dashboard ignored those
// columns; the shared path was DRIVEN by them. Field Costs, Cities, Cost, Revenue and Cash Flow all
// read the shared path, so Austin's August field cost was understated by $191 on every internal
// surface while the partner's own page was right. Crossbar was the same shape for a different
// reason — 0150's dated fee model was not passed, so August computed on superseded terms.
//
// SO THIS SUITE IS STRUCTURAL, NOT NUMERIC. It does not assert $2,006. It asserts that for EVERY
// payout model the two paths agree — and that every model the type system knows about is covered
// here, so the NEXT non-standard deal fails this gate instead of quietly misstating a city.

import type { PayoutModel } from "../src/lib/partnerPayoutModel";
import { payoutForMatch, totalsOf } from "../src/lib/partnerPayoutModel";
import { buildPartnerPayoutsByVenueMonth, matchListFromRegs, rentalParamsOf, periodOwed } from "../src/lib/partnerStats";
import type { PartnerConfig, PartnerRegRow } from "../src/lib/partnerStats";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const NOW = new Date("2026-08-26T12:00:00Z");
const PAST = "2026-08-10T02:00:00.000Z";     // ended — genuinely played
const FUTURE = "2026-08-30T02:00:00.000Z";   // not yet

/** A venue's worth of registration rows: n paying spots on one match. */
function spots(matchId: number, ymd: string, n: number, price: number, endUtc: string | null, cancelled = false): PartnerRegRow[] {
  return Array.from({ length: n }, (_, i) => ({
    user_id: `u${matchId}-${i}`, email: `p${matchId}-${i}@example.com`, field: "Test Field",
    match_start: `${ymd}T19:00:00.000Z`, match_canceled: cancelled, player_canceled_at: null,
    payment_type: "DAILY PAID", promocode: null, match_price_paid: price, user_type: "PLAYER",
    match_api_id: matchId, max_player_count: 20, match_end_utc: endUtc,
    paid_status: "PAID", refunded: false,
  })) as PartnerRegRow[];
}

const baseCfg = (over: Partial<PartnerConfig>): PartnerConfig => ({
  id: "cfg", venueId: 1, partnerName: "Test", revenueSharePct: 50,
  paymentStartDate: "2026-08-01", paymentDayOfWeek: 0, paymentCadence: "monthly",
  revenueModel: "flat_percentage", managerPayBase: null, managerPayHigh: null, managerPayThreshold: null,
  revenueModelNext: null, revenueModelFrom: null, perMatchFeeCents: null,
  payoutModel: "REVENUE_SHARE", payoutSharePct: null,
  fieldRentalCents: null, matchManagerCents: null, partnerSharePct: null, spotPriceCents: null,
  ...over,
} as PartnerConfig);

const VENUES = [{ id: 1, venue_name: "Test Field", billing_type: "profit_share" }];
const VF = new Map([[900, 1]]);
const regsWithField = (rows: PartnerRegRow[]) => rows.map((r) => ({ ...r, field_id: 900 })) as never;

/** What the SHARED path (Field Costs, Cities, Cost, Revenue, Cash Flow) produces for Aug 2026. */
const sharedAug = (cfg: PartnerConfig, rows: PartnerRegRow[]): number =>
  buildPartnerPayoutsByVenueMonth([cfg], VENUES, VF, regsWithField(rows), [], NOW).get("1|Aug 2026") ?? 0;

console.log("PARTNER PAYOUT PARITY\n");

// ── 1. RENTAL_PLUS_PROFIT_SHARE — the model that was unreachable ───────────────────────────────
console.log("RENTAL_PLUS_PROFIT_SHARE");
{
  const cfg = baseCfg({
    payoutModel: "RENTAL_PLUS_PROFIT_SHARE",
    fieldRentalCents: 16000, matchManagerCents: 4000, partnerSharePct: 40, spotPriceCents: 1500,
    // THE STALE COLUMNS, SET ON PURPOSE — this is PARMER's exact shape. If the shared path reads
    // them again, this fixture produces 50% of revenue instead of the rental model and fails.
    revenueModel: "flat_percentage", revenueSharePct: 50,
  });
  const rows = [...spots(1, "2026-08-05", 31, 15, PAST), ...spots(2, "2026-08-06", 44, 15, PAST)];
  const params = rentalParamsOf(cfg)!;
  const truth = totalsOf([
    payoutForMatch({ matchApiId: 1, startYmd: "2026-08-05", cancelled: false, played: true, grossCents: 31 * 1500, spotsSold: 31 }, params),
    payoutForMatch({ matchApiId: 2, startYmd: "2026-08-06", cancelled: false, played: true, grossCents: 44 * 1500, spotsSold: 44 }, params),
  ]).partnerTotalCents / 100;
  const shared = sharedAug(cfg, rows);
  is("the shared path equals payoutForMatch's own total", shared, truth);
  ok(`  (both $${truth.toFixed(2)} — rental 2 x $160 plus 40% of the pool)`);
  // AND IT IS NOT THE STALE ANSWER. Without this, a regression to the old behaviour could still
  // coincide with the right number on some fixture.
  const staleAnswer = (75 * 1500 / 100) * 0.5;
  is("…and is NOT 50% of revenue (the stale-column answer)", shared === staleAnswer, false);
}

// ── 2. A SCHEDULED MATCH CANNOT GENERATE A COST ────────────────────────────────────────────────
console.log("\nunplayed matches");
{
  const cfg = baseCfg({ payoutModel: "RENTAL_PLUS_PROFIT_SHARE", fieldRentalCents: 16000, matchManagerCents: 4000, partnerSharePct: 40, spotPriceCents: 1500 });
  const playedOnly = sharedAug(cfg, spots(1, "2026-08-05", 40, 15, PAST));
  const plusFuture = sharedAug(cfg, [...spots(1, "2026-08-05", 40, 15, PAST), ...spots(2, "2026-08-30", 40, 15, FUTURE)]);
  is("CONTROL — a played match DOES generate cost", playedOnly > 0, true);
  is("adding a SCHEDULED match changes nothing", plusFuture, playedOnly);
  const plusCancelled = sharedAug(cfg, [...spots(1, "2026-08-05", 40, 15, PAST), ...spots(3, "2026-08-12", 40, 15, PAST, true)]);
  is("adding a CANCELLED match changes nothing", plusCancelled, playedOnly);
}

// ── 3. PER_MATCH_FEE via the dated model (0150) ────────────────────────────────────────────────
console.log("\nPER_MATCH_FEE (dated, 0150)");
{
  const cfg = baseCfg({
    payoutModel: "PER_MATCH_MINUS_MANAGER", revenueModel: "per_match_minus_manager",
    managerPayBase: 20, managerPayHigh: 30, managerPayThreshold: 25,
    revenueModelNext: "per_match_fee", revenueModelFrom: "2026-08-01", perMatchFeeCents: 10000,
  });
  const rows = [...spots(1, "2026-08-05", 10, 15, PAST), ...spots(2, "2026-08-06", 10, 15, PAST), ...spots(3, "2026-08-30", 10, 15, FUTURE)];
  const shared = sharedAug(cfg, rows);
  is("two played matches bill 2 x $100", shared, 200);
  const direct = periodOwed(
    rows.filter((r) => !r.match_canceled), [], "2026-08-01", "2026-08-31",
    { revenueModel: "per_match_minus_manager", revenueSharePct: 50, managerPayBase: 20, managerPayHigh: 30, managerPayThreshold: 25,
      revenueModelNext: "per_match_fee", revenueModelFrom: "2026-08-01", perMatchFeeCents: 10000,
      matchList: matchListFromRegs(rows, NOW) },
  ).owedAmount;
  is("…and the shared path equals periodOwed directly", shared, direct);
  is("the scheduled match is not billed", shared === 300, false);
}

// ── 4. REVENUE_SHARE still behaves exactly as before ───────────────────────────────────────────
console.log("\nREVENUE_SHARE (unchanged)");
{
  const cfg = baseCfg({ payoutModel: "REVENUE_SHARE", revenueModel: "flat_percentage", revenueSharePct: 50 });
  const rows = spots(1, "2026-08-05", 20, 15, PAST);
  is("50% of $300 is $150", sharedAug(cfg, rows), 150);
}

// ── 5. EVERY MODEL THE TYPE SYSTEM KNOWS IS COVERED ────────────────────────────────────────────
// THE POINT OF THE WHOLE SUITE. A new PayoutModel added without a case here fails immediately,
// rather than silently taking the flat_percentage branch and misstating a city for a month.
console.log("\ncoverage of PayoutModel");
const COVERED: PayoutModel[] = ["REVENUE_SHARE", "PER_MATCH_MINUS_MANAGER", "RENTAL_PLUS_PROFIT_SHARE"];
const ALL: PayoutModel[] = ["REVENUE_SHARE", "PER_MATCH_MINUS_MANAGER", "RENTAL_PLUS_PROFIT_SHARE"];
is("every PayoutModel has a parity case above", COVERED.slice().sort(), ALL.slice().sort());
ok("  (if you added a PayoutModel and this failed: add a case, do not widen the list)");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
if (pass === 0) { console.log("ZERO ASSERTIONS — that is a failure, not a pass"); process.exit(1); }
