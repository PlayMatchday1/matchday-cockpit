/* CREDIT EVERYONE WHO PAID — the plan, pinned. This decides who receives money and how much, so
 * every rule that could quietly pay the wrong person or the wrong amount is asserted here.
 *
 * The fixtures are REAL ROWS from production, not invented shapes: the wallet-only payer is match
 * 16990 user 77796 (amount 1200, totalAmount 0, creditAmount 1200 — 40 such rows exist since
 * August), and the WAITING/GUEST/cancelled shapes are the ones 18519, 19068 and 18952 carry.
 */
import {
  MAX_RUN_CENTS, MAX_RUN_PLAYERS, creditOwedCents, planCreditRun, rosterUserId, type MoneyRosterRow,
} from "@/lib/creditsModel";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const yes = (n: string, c: boolean, d = "") => (c ? ok(n) : bad(n, d));

// The shapes, from the live roster payloads.
const paid = (userId: number, amount: number, totalAmount: number, creditAmount = 0): MoneyRosterRow =>
  ({ id: userId, userId, amount, totalAmount, creditAmount, paidStatus: "PAID", isCancelled: false, userType: "PLAYER" });
const waiting = (userId: number, amount: number, totalAmount: number): MoneyRosterRow =>
  ({ id: userId, userId, amount, totalAmount, creditAmount: 0, paidStatus: "WAITING", isCancelled: false, userType: "PLAYER" });
const member = (userId: number): MoneyRosterRow =>
  ({ id: userId, userId, amount: 0, totalAmount: 0, creditAmount: 0, paidStatus: "FREE", isCancelled: false, userType: "PLAYER" });
const guest = (userId: number): MoneyRosterRow =>
  ({ id: userId, userId, amount: 0, totalAmount: 0, creditAmount: 0, paidStatus: "PAID", isCancelled: false, userType: "GUEST" });

console.log("\n— RULE C: the card charge PLUS the wallet credit they spent —");
is("a straight card payment is refunded its charge", creditOwedCents(paid(1, 1200, 1299)), 1299);
/* THE ROW THAT MAKES RULE C NECESSARY — match 16990 user 77796, real. Under the card-charge rule
 * this player receives NOTHING for a match they turned up to, because their card was never
 * charged: they paid entirely from their wallet. */
is("a player who paid entirely from the wallet is refunded in full", creditOwedCents(paid(77796, 1200, 0, 1200)), 1200);
is("…and a part-wallet payment adds the two", creditOwedCents(paid(3, 1200, 400, 866)), 1266);
is("nothing paid, nothing owed", creditOwedCents(member(4)), 0);
/* credit_amount IS CREDIT SPENT. An earlier draft skipped these rows as "already credited", which
 * would have denied a refund to exactly the players whose balance had already been spent down. */
yes("a row carrying credit_amount is CREDITED, never skipped",
  planCreditRun([paid(77796, 1200, 0, 1200)]).pay.length === 1);
is("…and it is flagged as having paid with credit",
  planCreditRun([paid(77796, 1200, 0, 1200)]).paidWithCreditCents, 1200);

console.log("\n— who is left out, and every reason is its own fact —");
const roster: MoneyRosterRow[] = [
  paid(11, 1200, 1299), paid(12, 2400, 2598), paid(13, 1200, 0, 1200),
  waiting(21, 1200, 1299), waiting(22, 1200, 1299),
  member(31), member(32), guest(41),
  { id: 51, userId: 51, amount: 1200, totalAmount: 1299, creditAmount: 0, paidStatus: "PAID", isCancelled: true, userType: "PLAYER" },
  { id: 61, userId: 61, amount: 1200, totalAmount: 1299, creditAmount: 0, paidStatus: "PAID", isCancelled: false, isFakePlayer: true, userType: "PLAYER" },
];
const plan = planCreditRun(roster);
is("only the settled payers are paid", plan.pay.map((p) => p.userId), [11, 12, 13]);
is("…and the total is their charges plus their wallet spend", plan.totalCents, 1299 + 2598 + 1200);
is("WAITING never settled and is excluded", plan.skips.find((s) => s.reason === "payment never settled")?.count, 2);
is("a member who paid nothing gets nothing", plan.skips.find((s) => s.reason === "member, paid nothing")?.count, 2);
is("an included guest gets nothing", plan.skips.find((s) => s.reason === "included, paid nothing")?.count, 1);
is("a cancelled row and a fake row hold no spot", plan.skips.find((s) => s.reason === "holds no spot")?.count, 2);
/* GROUPED, NEVER A ROSTER. The confirm has to be four or five lines — a count alone cannot tell you
 * the members were excluded, and eleven separate lines is a list nobody reads. */
yes("the skips are grouped by reason, not listed per player", plan.skips.length <= 5, JSON.stringify(plan.skips));
is("a member contributes nothing to the skipped money", plan.skips.find((s) => s.reason === "member, paid nothing")?.cents, 0);

console.log("\n— the second run credits only what the first one missed —");
/* OUR OWN LEDGER. change_log carries the match id and the player id (in the endpoint), so a second
 * run reads back what landed. The roster never could: credit_amount is credit spent. */
const second = planCreditRun(roster, { alreadyCreditedUserIds: [11, 12] });
is("the two that landed are skipped", second.pay.map((p) => p.userId), [13]);
is("…for the right reason", second.skips.find((s) => s.reason === "already credited for this match")?.count, 2);
is("…and the second run's total is only what is left", second.totalCents, 1200);
yes("a third run with everyone credited pays nobody",
  planCreditRun(roster, { alreadyCreditedUserIds: [11, 12, 13] }).pay.length === 0);

console.log("\n— the caps, which are typo guards —");
is("the run ceiling is $2,000", MAX_RUN_CENTS, 200000);
is("…and 60 players", MAX_RUN_PLAYERS, 60);
const big = Array.from({ length: 61 }, (_, i) => paid(1000 + i, 1200, 1200));
yes("61 players is refused", planCreditRun(big).overCap != null, String(planCreditRun(big).overCap));
const rich = Array.from({ length: 10 }, (_, i) => paid(2000 + i, 30000, 30000));
yes("$3,000 is refused", planCreditRun(rich).overCap != null, String(planCreditRun(rich).overCap));
yes("a normal match is not refused", planCreditRun(roster).overCap === null);
/* THE CAP IS ON THE RUN, NOT ON A PLAYER. MAX_ADJUSTMENT_CENTS ($200) still governs the
 * single-player route; a 40-player run of $12 refunds is $480 and must not trip it. */
yes("a 40-player run of $12 refunds is allowed",
  planCreditRun(Array.from({ length: 40 }, (_, i) => paid(3000 + i, 1200, 1200))).overCap === null);

console.log("\n— the row identity —");
is("the user id comes off the row", rosterUserId(paid(77796, 1200, 0, 1200)), 77796);
is("…or off the nested user", rosterUserId({ user: { id: 42 } }), 42);
is("a row with no user id cannot be paid", planCreditRun([{ amount: 1200, totalAmount: 1299 }]).pay.length, 0);

console.log("\n— WAITING is the difference between two totals, and it is not small —");
/* The brief's C column for 18519 / 19068 / 18952 ($816.54 / $917.16 / $907.40) was computed over
 * every non-cancelled row, WAITING included. Excluding WAITING — which never settled — gives
 * $702.87 / $706.04 / $696.28. The gap is exactly the WAITING money: $113.67 / $211.12 / $211.12. */
const withWaiting = [paid(1, 1200, 61138), waiting(2, 1200, 11367)];
const p2 = planCreditRun(withWaiting);
is("the plan pays the settled row only", p2.totalCents, 61138);
is("…and names the money it did not pay", p2.skips.find((s) => s.reason === "payment never settled")?.cents, 11367);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
