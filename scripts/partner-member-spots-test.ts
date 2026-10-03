/* MEMBER SPOTS IN QUALIFYING REVENUE — the guards on a partner payment.
 *
 * Every assertion here is on money that reaches a real person. The live-data figures ($808.00 of
 * qualifying revenue, $404.00 of payment for Hattrick in September) are verified separately
 * against production; this file guards the RULES that produce them, offline and deterministically.
 */
import { computeWeeklyPayments, dppPriceToCents, type PartnerRegRow, type PartnerWeeklyPaymentRecord } from "../src/lib/partnerStats";

let pass = 0; const fails: string[] = [];
const is = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok  ${name}`); }
  else { fails.push(`${name} — got ${g} want ${w}`); console.log(`  XX  ${name} — got ${g} want ${w}`); }
};

const reg = (over: Partial<PartnerRegRow>): PartnerRegRow => ({
  user_id: "u1", email: "a@b.com", field: "Hattrick", match_start: "2026-09-10T19:00:00Z",
  match_canceled: false, player_canceled_at: null, payment_type: "MEMBER", promocode: null,
  match_price_paid: 0, user_type: "PLAYER", match_api_id: 1, ...over,
});
const CFG = {
  revenueSharePct: 50, paymentStartDate: "2026-09-01", paymentDayOfWeek: 0,
  paymentCadence: "monthly" as const, revenueModel: "flat_percentage" as const,
  revenueModelNext: "flat_percentage_with_members" as const, revenueModelFrom: "2026-09-01",
  memberSpotRateCents: 800,
};
const NOW = new Date("2026-09-30T12:00:00Z");
const sep = (rows: PartnerRegRow[], over: Record<string, unknown> = {}, recs: PartnerWeeklyPaymentRecord[] = []) =>
  computeWeeklyPayments(rows, [], { ...CFG, ...over }, recs, NOW)
    .weeklyPayments.find((w) => w.weekStartDate === "2026-09-01")!;

console.log("\nthe rate converts dollars to cents, and refuses anything that is not a price");
{
  is("8 dollars is 800 cents", dppPriceToCents(8), 800);
  is("a string price still converts", dppPriceToCents("8"), 800);
  is("a fractional price rounds to the cent", dppPriceToCents(7.995), 800);
  /* ZERO IS NOT A PRICE. Returning 0 would value every member spot at nothing and pay the partner
   * for none of them, silently — the exact failure the unvalued path exists to prevent. */
  is("zero is NOT a rate", dppPriceToCents(0), null);
  is("null is not a rate", dppPriceToCents(null), null);
  is("a negative price is not a discount, it is a bug", dppPriceToCents(-8), null);
  is("nonsense is not a rate", dppPriceToCents("free"), null);
}

console.log("\nPLAYED, not booked");
{
  const rows = [
    reg({ user_id: "a", match_api_id: 1 }),
    reg({ user_id: "b", match_api_id: 2 }),
    reg({ user_id: "c", match_api_id: 3, player_canceled_at: "2026-09-08T10:00:00Z" }),
    reg({ user_id: "d", match_api_id: 4, user_type: "GUEST" }),
  ];
  const p = sep(rows);
  is("a player-cancelled booking is not a spot", p.memberSpots, 2);
  is("  …so the money follows the played count", p.memberRevenue, 16);
  /* THE CONTROL THAT LETS THIS ASSERTION FAIL. Four rows went in; if the filter were removed the
   * count would be 4 and this pins the difference rather than the absolute. */
  is("CONTROL — booked and played genuinely differ in this fixture", rows.length !== (p.memberSpots ?? 0), true);
  is("CONTROL — a GUEST row is one of the two excluded", rows.filter((r) => r.user_type === "GUEST").length, 1);
  const noCancel = sep(rows.map((r) => ({ ...r, player_canceled_at: null, user_type: "PLAYER" })));
  is("CONTROL — with nothing excluded the same fixture counts 4", noCancel.memberSpots, 4);
}

console.log("\nthe model gates the term, and the date gates the model");
{
  const rows = [reg({}), reg({ user_id: "b", match_api_id: 2 })];
  is("no successor model means no member term", sep(rows, { revenueModelNext: null, revenueModelFrom: null }).memberSpots ?? null, null);
  /* A HALF-CONFIGURED SUCCESSOR IS TREATED AS ABSENT, the same rule 0150 put in the DB. */
  is("a successor with no date does nothing", sep(rows, { revenueModelFrom: null }).memberSpots ?? null, null);
  is("a date with no successor does nothing", sep(rows, { revenueModelNext: null }).memberSpots ?? null, null);
  is("a date AFTER the period leaves it on the old model", sep(rows, { revenueModelFrom: "2026-10-01" }).memberSpots ?? null, null);
  is("CONTROL — the same rows DO count when the model is in force", sep(rows).memberSpots, 2);
}

console.log("\na missing rate is NOT zero revenue");
{
  const rows = [reg({}), reg({ user_id: "b", match_api_id: 2 })];
  const p = sep(rows, { memberSpotRateCents: null });
  is("the spots are still counted", p.memberSpots, 2);
  is("but no money is invented", p.memberRevenue, null);
  is("and the qualifying revenue does not move", p.qualifyingRevenue, 0);
  is("the period says WHY", (p.memberUnvalued ?? "").includes("could not be valued"), true);
  const zero = sep(rows, { memberSpotRateCents: 0 });
  is("a zero rate is refused the same way", zero.memberRevenue, null);
  /* CHANGED 2026-10-02 (the rate rule changed): a zero price is now simply no price, with the same
   * reason as a missing one; it used to have its own "zero or invalid" wording. */
  is("  …with the same reason as a missing price", (zero.memberUnvalued ?? "").includes("could not be valued"), true);
  is("CONTROL — with a real rate there is no complaint", sep(rows).memberUnvalued ?? null, null);
}

console.log("\nTHE FREEZE: a paid period is paid at the rate it was paid at");
{
  const rows = [reg({}), reg({ user_id: "b", match_api_id: 2 }), reg({ user_id: "c", match_api_id: 3 })];
  const rec: PartnerWeeklyPaymentRecord = {
    id: "r1", partner_dashboard_id: "d1", week_start_date: "2026-09-01",
    calculated_amount: 12, paid_amount: null, status: "paid", paid_at: "2026-10-05",
    paid_notes: null, dispute_note: null, disputed_at: null, is_pre_system_settlement: false,
    member_spot_rate_cents: 800, member_spots: 3,
  } as PartnerWeeklyPaymentRecord;

  const live = sep(rows, { memberSpotRateCents: 800 });
  is("open, at the live rate: 3 x $8", live.memberRevenue, 24);

  /* THE ASSERTION THIS WHOLE FEATURE TURNS ON. Somebody edits fin_venues.dpp_price from $8 to $20
   * in Field Costs. An OPEN period must move with it; a period already paid must not. */
  const openAfterEdit = sep(rows, { memberSpotRateCents: 2000 });
  is("an OPEN period moves when the list price is edited", openAfterEdit.memberRevenue, 60);

  const frozenAfterEdit = sep(rows, { memberSpotRateCents: 2000 }, [rec]);
  is("a PAID period does NOT move", frozenAfterEdit.memberRevenue, 24);
  is("  …it reports the rate it was paid at", frozenAfterEdit.memberRateCents, 800);
  is("  …and says the figure is frozen", frozenAfterEdit.memberFrozen, true);
  is("  …and the payment follows the frozen figure", frozenAfterEdit.owedAmount, 12);
  is("CONTROL — the live and frozen answers genuinely differ", openAfterEdit.memberRevenue !== frozenAfterEdit.memberRevenue, true);
  is("CONTROL — an open period is not marked frozen", openAfterEdit.memberFrozen ?? false, false);

  /* THE COUNT IS FROZEN TOO, so a late-arriving cancellation cannot restate a paid month. */
  const fewerRows = sep([reg({})], { memberSpotRateCents: 2000 }, [rec]);
  is("a paid period keeps its frozen SPOT COUNT as well as its rate", fewerRows.memberSpots, 3);
}

console.log("\nTHE RATE IS THE PERIOD'S AVERAGE ACTUAL DROP-IN CHARGE, NOT A TYPED PRICE (Ryan, 2026-10-02)");
{
  const dp = (over: Partial<PartnerRegRow>) => reg({ payment_type: "DAILY PAID", ...over });
  const members = [reg({ user_id: "m1", match_api_id: 1 }), reg({ user_id: "m2", match_api_id: 2 })];
  /* A host's $16 row and its guest's $0 row ARE TWO SPOTS AT $8, so guests stay in the average. */
  const dropIns = [
    dp({ user_id: "a", match_price_paid: 9, match_api_id: 1 }),
    dp({ user_id: "b", match_price_paid: 16, match_api_id: 2 }),
    dp({ user_id: "b", match_price_paid: 0, match_api_id: 2, user_type: "GUEST" }),
    dp({ user_id: "c", match_price_paid: 30, match_api_id: 3, player_canceled_at: "2026-09-09T10:00:00Z" }),
  ];
  const p = sep([...members, ...dropIns], { memberSpotRateCents: 2000 });
  is("rate = played drop-in revenue / played drop-in spots: (9+16+0)/3 = $8.33", p.memberRateCents, 833);
  is("  …and says so: the average of 3 drop-ins", p.memberRateSource, { kind: "avg", dropIns: 3 });
  is("  …applied to the member spots: 2 x $8.33", p.memberRevenue, 16.66);
  is("CONTROL — the cancelled $30 drop-in is NOT in the average (it would make it $13.75)",
    Math.round(((9 + 16 + 0 + 30) / 4) * 100) !== p.memberRateCents, true);
  is("CONTROL — the $20 fallback was available and NOT used", p.memberRateCents !== 2000, true);

  const outside = [dp({ user_id: "z", match_price_paid: 50, match_start: "2026-08-20T19:00:00Z" })];
  const noDrops = sep([...members, ...outside], { memberSpotRateCents: 800 });
  is("no drop-ins IN THE PERIOD → the venue's current match price", noDrops.memberRateCents, 800);
  is("  …and says so", noDrops.memberRateSource, { kind: "current" });
  is("CONTROL — an August drop-in does not price September", noDrops.memberRateCents !== 5000, true);

  const neither = sep(members, { memberSpotRateCents: null });
  is("neither → not valued, not $0", [neither.memberRevenue, neither.memberRateCents, neither.memberRateSource ?? null], [null, null, null]);
  is("  …with the reason on the period", (neither.memberUnvalued ?? "").includes("could not be valued"), true);

  /* ALL-FREE DROP-INS ARE NO PRICE. A period whose drop-ins all came to $0 has no average to use,
   * so it falls back rather than valuing members at nothing. */
  const freeOnly = sep([...members, dp({ user_id: "f", match_price_paid: 0 })], { memberSpotRateCents: 800 });
  is("drop-ins that all cost $0 fall back to the current price", [freeOnly.memberRateCents, freeOnly.memberRateSource], [800, { kind: "current" }]);

  /* PAID STAYS PAID: the frozen rate wins over the average, and says it is the paid rate. */
  const rec = {
    id: "r2", partner_dashboard_id: "d1", week_start_date: "2026-09-01", calculated_amount: 8, paid_amount: null,
    status: "paid", paid_at: "2026-10-05", paid_notes: null, dispute_note: null, disputed_at: null,
    is_pre_system_settlement: false, member_spot_rate_cents: 800, member_spots: 2,
  } as PartnerWeeklyPaymentRecord;
  const frozen = sep([...members, ...dropIns], { memberSpotRateCents: 2000 }, [rec]);
  is("a PAID period keeps its frozen rate, not the average", [frozen.memberRateCents, frozen.memberRevenue], [800, 16]);
  is("  …and its source says so", frozen.memberRateSource, { kind: "frozen" });
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { fails.forEach((f) => console.log(`  XX  ${f}`)); process.exit(1); }
if (pass === 0) { console.log("ZERO ASSERTIONS — that is a failure, not a pass"); process.exit(1); }
