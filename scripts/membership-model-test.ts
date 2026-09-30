import "server-only"; // no-op under --conditions=react-server
// 0195 — membership admin rules, tested where they live.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/membership-model-test.ts
//
// The second screen in Clubhouse where being wrong moves real money. Every rule here is either a
// fact read out of the Nest source (see docs/matchday-api-facts.md, "SUBSCRIPTIONS — the four admin
// writes") or a refusal the API does NOT make and we therefore have to.

import {
  memKind, actionsFor, priceRefusal, endRefusal, isComp, isEnded,
  centsFromDollars, dollarsFromCents, addPathFor, addApplied,
  verdictSentence, verdictLogValue, COMP_ADD_ENABLED,
  type MemFacts, type WriteVerdict,
} from "../src/lib/membershipAdminModel";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const yes = (n: string, c: boolean, d = "") => (c ? ok(n) : bad(n, d));

const M = (o: Partial<MemFacts>): MemFacts =>
  ({ id: 1, statusRaw: "ACTIVE", stripeSubscriptionId: "sub_x", canceledAt: null, price: 4900, ...o });

console.log("\n— a comp, a $0 subscription and a paying member are three different things —");
is("ADDED_FROM_ADMIN is the comp", memKind(M({ statusRaw: "ADDED_FROM_ADMIN", stripeSubscriptionId: null })), "comped");
is("a $0 ACTIVE row is a real subscription, not a comp", memKind(M({ price: 0 })), "free");
is("  CONTROL: and a priced ACTIVE row is neither", memKind(M({})), "paid");
is("CANCELED is ended", memKind(M({ statusRaw: "CANCELED" })), "ended");
/* A PLAYER CANCELLATION KEEPS status ACTIVE — cancelSubscriptions writes canceledAt only and sets
 * no status at all. It is not an ended membership and it is still endable. */
is("a player cancellation is its own state, not ended", memKind(M({ canceledAt: "2026-09-01T00:00:00Z" })), "selfcancel");
is("no row at all is none", memKind(null), "none");
yes("  CONTROL: isComp and isEnded do not both fire on one row",
  !(isComp(M({ statusRaw: "ADDED_FROM_ADMIN" })) && isEnded(M({ statusRaw: "ADDED_FROM_ADMIN" }))));

console.log("\n— which controls appear is the API's rule, not a guess —");
is("a live membership offers price and end", actionsFor(M({})), { add: false, price: true, end: true, why: null });
is("a comp offers both too — the rule is not 'Stripe only'",
  actionsFor(M({ statusRaw: "ADDED_FROM_ADMIN", stripeSubscriptionId: null })), { add: false, price: true, end: true, why: null });
/* unsubscribeForAdmin matches `status != CANCELED`, and a player-cancelled row is still ACTIVE. */
yes("a player-cancelled membership is STILL endable", actionsFor(M({ canceledAt: "2026-09-01T00:00:00Z" })).end);
/* Both adds block on `status in (ACTIVE, ADDED_FROM_ADMIN)` — CANCELED is in neither list. */
yes("a closed membership can be reopened, because CANCELED blocks neither add", actionsFor(M({ statusRaw: "CANCELED" })).add);
yes("  …and cannot be re-priced or re-ended",
  !actionsFor(M({ statusRaw: "CANCELED" })).price && !actionsFor(M({ statusRaw: "CANCELED" })).end);
yes("a non-member offers only add", actionsFor(null).add && !actionsFor(null).price && !actionsFor(null).end);
yes("  …and says why the others are absent", (actionsFor(null).why ?? "").includes("No membership on file"));

console.log("\n— the refusals the API does not make, so we must —");
/* update-subscription-dto is @IsNumber() and NOTHING else: no @Min, no @IsInt. */
yes("a negative price is refused", (priceRefusal(M({}), -1) ?? "").includes("negative"));
yes("  …and a fractional one", (priceRefusal(M({}), 10.5) ?? "").includes("whole number"));
is("  CONTROL: a sane price is allowed", priceRefusal(M({}), 5500), null);
/* updateSubscriptionPrice has NO status filter and NO deletedAt filter: it reprices a cancelled row
 * and answers true. Nothing upstream stops it. */
yes("a CANCELED row cannot be re-priced, which only we enforce",
  (priceRefusal(M({ statusRaw: "CANCELED" }), 100) ?? "").includes("closed"));
yes("a no-op re-price is refused rather than sent", (priceRefusal(M({ price: 4900 }), 4900) ?? "").includes("already the price"));
is("  CONTROL: one cent different is not a no-op", priceRefusal(M({ price: 4900 }), 4901), null);
/* cancel-subscription-dto is @IsString() only — "" passes the API. */
yes("an empty reason is refused", (endRefusal(M({}), "") ?? "").includes("reason is required"));
yes("  …and whitespace is not a reason", (endRefusal(M({}), "   \t ") ?? "").includes("reason is required"));
is("  CONTROL: a real reason is accepted", endRefusal(M({}), "Duplicate account"), null);

console.log("\n— dollars on screen, cents on the wire —");
// Retool's field is a bare number times 100 on send: 4900 meaning $49 becomes $4,900.
is("55 dollars is 5500 cents", centsFromDollars("55"), 5500);
is("  and 49.00 is 4900", centsFromDollars("49.00"), 4900);
is("  and 0.50 is 50", centsFromDollars("0.50"), 50);
is("an empty field is not zero", centsFromDollars(""), null);
is("  nor is a non-number", centsFromDollars("abc"), null);
is("  nor is a negative typed in", centsFromDollars("-5"), null);
is("  and three decimals are refused rather than rounded", centsFromDollars("1.234"), null);
is("cents render back as dollars", dollarsFromCents(4900), "49.00");
is("  CONTROL: a non-round value, so a 100x error could not pass", dollarsFromCents(1234), "12.34");

console.log("\n— the two adds are not variants of one thing —");
is("the comp has no suffix", addPathFor(43902, "comp"), "/admin/subscriptions/users/43902");
is("the free one does", addPathFor(43902, "free"), "/admin/subscriptions/users/43902/free");
is("a comp landed when the row reads ADDED_FROM_ADMIN",
  addApplied(M({ statusRaw: "ADDED_FROM_ADMIN" }), "comp"), true);
is("  CONTROL: and not when it reads ACTIVE", addApplied(M({ statusRaw: "ACTIVE" }), "comp"), false);
is("a free add landed when the row reads ACTIVE", addApplied(M({ statusRaw: "ACTIVE" }), "free"), true);
is("nothing landed when there is no row", addApplied(null, "free"), false);
/* MEASURED ON STAGING 2026-09-30: subscribeSpecificUser creates a row that NO read endpoint returns
 * — GET /admin/players/{id} filters userSubscriptions to `status in [ACTIVE] AND currentPeriodEnd
 * >= now`, and /admin/subscriptions returns it under no status and no email. It cannot be shown,
 * priced or ended afterwards. Disabled until that include is widened. */
is("the comp add is disabled, because its row cannot be read back", COMP_ADD_ENABLED, false);

console.log("\n— nothing claims a charge stopped on the strength of a row read —");
const V = (o: Partial<WriteVerdict>): WriteVerdict => ({ row: "moved", stripe: "moved", subscriptionId: "sub_x", ...o });
yes("a confirmed cancel names Stripe and says billing stopped",
  verdictSentence(V({}), "end").includes("Billing has stopped"));
/* THE SWALLOWED ERROR. cancelSubscriptionsForAdmin catches the Stripe failure into a bare TODO and
 * marks the row CANCELED anyway, so this state is reachable and must be loud. */
const swallowed = verdictSentence(V({ stripe: "unchanged" }), "end");
yes("a row that moved while Stripe did not is called out, with the id",
  swallowed.includes("STILL BEING CHARGED") && swallowed.includes("sub_x"));
yes("  …and does NOT say nothing further will be charged", !/nothing further will be charged/i.test(swallowed));
yes("an absent subscription is not reported as a Stripe failure",
  !/still being charged/i.test(verdictSentence(V({ stripe: "absent", subscriptionId: null }), "end")));
yes("an unreadable Stripe is called unconfirmed, not confirmed",
  verdictSentence(V({ stripe: "unreadable" }), "end").includes("unconfirmed"));
yes("a row that did not move says so before anything about Stripe",
  verdictSentence(V({ row: "unchanged" }), "end").includes("was not ended"));
/* THE WHOLE POINT: no branch of this may promise the charge stopped unless STRIPE said so. */
for (const st of ["unchanged", "unreadable"] as const) {
  for (const act of ["end", "price"] as const) {
    yes(`  CONTROL: ${act}/${st} never claims billing stopped`,
      !/billing has stopped/i.test(verdictSentence(V({ stripe: st }), act)));
  }
}
yes("the log carries the Stripe half too", verdictLogValue(V({ stripe: "unchanged" })).includes("UNCHANGED"));
yes("  …and names a comp as having no subscription", verdictLogValue(V({ stripe: "absent" })).includes("no Stripe"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
