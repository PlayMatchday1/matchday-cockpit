// fin_txn ATTRIBUTION — the type and the city a Stripe payment is reported under (Ryan, 2026-11-16).
//   type: the backend's metadata.revenueType when present, else the positive rules (classifyCharge)
//   city: metadata.cityIdentifier when present; a membership charge without one takes the city of the
//         membership it paid for (by payment intent); the email guess only when neither exists
// Pure: no Stripe, no database. Run: npx tsx scripts/fin-txn-attribution-test.ts
import type Stripe from "stripe";
// financeImport builds a browser Supabase client when it loads. Placeholders let it load; nothing here
// calls it, and the suite never reads a real credential.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://placeholder.invalid";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= "placeholder";
void main();
async function main() {
const { classifyCharge, typeFromRevenueType, cityFromIdentifier, DELETED_ACCOUNT_CITY } = await import("../src/lib/financeImport");
const { allocateCity } = await import("../src/lib/finTxnSync");
const { mapBalanceTxn } = await import("../src/lib/finTxnMap");

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d: string) => { fail++; console.log(`  FAIL ${n} — ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

console.log("— type: the label wins, older payments keep the old rules —");
is("booking is DPP", typeFromRevenueType("booking"), "DPP");
is("event is its own type (Ryan, 2026-11-16)", typeFromRevenueType("event"), "Event");
is("membership is Membership", typeFromRevenueType("membership"), "Membership");
is("strike is Strike", typeFromRevenueType("Strike "), "Strike");
is("an unknown label is no label", typeFromRevenueType("gift"), null);
is("a labelled membership with a match id is still Membership", classifyCharge({ stripeType: null, description: null, hasMatchId: true, revenueType: "membership" }), "Membership");
is("a labelled event team fee (no match id, type special_event_team) is Event, not Unclassified",
  classifyCharge({ stripeType: "special_event_team", description: "Team fee", hasMatchId: false, revenueType: "event" }), "Event");
is("a labelled booking on an EVENT match (it has a match id) is Event, not DPP",
  classifyCharge({ stripeType: "match", description: null, hasMatchId: true, revenueType: "event" }), "Event");
is("CONTROL: an unlabelled booking on an EVENT match keeps the old rule, DPP",
  classifyCharge({ stripeType: "match", description: null, hasMatchId: true }), "DPP");
is("CONTROL: the same fee unlabelled stays Unclassified", classifyCharge({ stripeType: "special_event_team", description: "Team fee", hasMatchId: false }), "Unclassified");
is("CONTROL: an unlabelled booking is DPP by match id", classifyCharge({ stripeType: "match", description: null, hasMatchId: true, revenueType: null }), "DPP");
is("CONTROL: an unlabelled renewal is Membership by description", classifyCharge({ stripeType: null, description: "Subscription update", hasMatchId: false }), "Membership");

console.log("\n— the city list —");
/* CHANGED 2026-11-17 (Ryan): NYC and WAW are not MatchDay cities; their codes resolve to Unassigned. */
is("NYC is not a MatchDay city: Unassigned", cityFromIdentifier("NYC"), DELETED_ACCOUNT_CITY);
is("WAW is not a MatchDay city: Unassigned", cityFromIdentifier("WAW"), DELETED_ACCOUNT_CITY);
is("CONTROL: ATX is still Austin", cityFromIdentifier("ATX"), "Austin");
is("PHL is Philadelphia, our own city (2026-11-16)", cityFromIdentifier("PHL"), "Philadelphia");
is("CONTROL: an unknown code is Unassigned", cityFromIdentifier("SDG"), DELETED_ACCOUNT_CITY);

console.log("\n— membership city: label, then the membership, then the email —");
const maps = {
  emailToCity: new Map([["pat@example.com", "Austin"]]),
  matchToCity: new Map([["17516", "Houston"]]),
  piToMemberCity: new Map([["pi_mem", "San Antonio"], ["pi_phl", "Philadelphia"]]),
};
const mem = (o: Partial<Parameters<typeof allocateCity>[1]>): string => allocateCity(maps, { type: "Membership", cityIdentifier: null, matchId: null, email: null, paymentIntentId: null, ...o });
is("the label wins over the membership and the email", mem({ cityIdentifier: "DFW", paymentIntentId: "pi_mem", email: "pat@example.com" }), "Dallas");
is("no label: the membership wins over the email", mem({ paymentIntentId: "pi_mem", email: "pat@example.com" }), "San Antonio");
is("a Philadelphia membership lands in Philadelphia", mem({ paymentIntentId: "pi_phl" }), "Philadelphia");
is("no label, no membership: the email guess", mem({ paymentIntentId: "pi_unknown", email: "pat@example.com" }), "Austin");
is("nothing at all: Unassigned", mem({ paymentIntentId: "pi_unknown", email: "who@example.com" }), DELETED_ACCOUNT_CITY);
is("a blank label is no label", mem({ cityIdentifier: "-", paymentIntentId: "pi_mem" }), "San Antonio");
is("CONTROL: a booking still uses its label, then its match", allocateCity(maps, { type: "DPP", cityIdentifier: null, matchId: "17516", email: null, paymentIntentId: "pi_mem" }), "Houston");

console.log("\n— the mapper passes the label and the payment intent through —");
const bt = (meta: Record<string, string>, pi: string | { id: string } = "pi_mem") => ({
  id: "txn_1", object: "balance_transaction", amount: 7199, fee: 239, net: 6960, created: 1763337600,
  reporting_category: "charge", description: null,
  source: { id: "ch_1", object: "charge", metadata: meta, payment_intent: pi, customer: "cus_1", billing_details: { email: null }, receipt_email: null, description: "Subscription update" },
}) as unknown as Stripe.BalanceTransaction;
const run = (b: Stripe.BalanceTransaction) => mapBalanceTxn(b, {
  classify: classifyCharge, cityOf: (a) => allocateCity(maps, a), customerEmail: () => "pat@example.com", venueOfField: () => null,
});
const r1 = run(bt({}));
is("an unlabelled renewal: Membership in its membership's city, not the email's", [r1?.type, r1?.city, r1?.payment_intent_id], ["Membership", "San Antonio", "pi_mem"]);
const r2 = run(bt({ revenueType: "membership", cityIdentifier: "HOU" }));
is("a labelled renewal: the label's city", [r2?.type, r2?.city], ["Membership", "Houston"]);
const r3 = run(bt({}, { id: "pi_phl" }));
is("an expanded payment intent is read by its id", [r3?.city, r3?.payment_intent_id], ["Philadelphia", "pi_phl"]);

console.log("\n— the Revenue page's five lines add up to net —");
const { totalsOf, bucketOf } = await import("../src/lib/revenueTxn");
is("bucket per type", ["DPP", "Membership", "Event", "Strike", "Private Rental", "Unclassified"].map(bucketOf), ["dpp", "membership", "event", "strike", "other", "other"]);
const row = (type: string, kind: "charge" | "refund", cents: number) => ({ period: "2026-11-17", kind, source: "Stripe", type, city: "Austin", fin_venue_id: null, excluded: false, n: 1, gross_cents: cents, fee_cents: 0, tax_cents: 0 });
const T = totalsOf([row("DPP", "charge", 1000), row("Membership", "charge", 7199), row("Event", "charge", 2500), row("Event", "refund", -500), row("Strike", "charge", 2000), row("Private Rental", "charge", 30000)]);
is("each line after its own refunds", [T.dpp, T.membership, T.event, T.strike, T.other], [1000, 7199, 2000, 2000, 30000]);
is("DPP + Membership + Event + Strike + Other = net", T.dpp + T.membership + T.event + T.strike + T.other, T.net);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail || pass === 0) process.exit(1);
}
