// Offline suite: scripts/run-suites.mjs runs it with NODE_OPTIONS=--conditions=react-server.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/membership-history-test.ts
//
// MEMBERSHIP HISTORY (src/lib/membershipHistory.ts). It decides what a player is told they paid,
// when a membership ended and why — the card staff open during a billing argument — so it is
// guarded on computed values, from fixtures shaped like the three production players read on
// 2026-11-07 (docs/matchday-api-facts.md "Membership history sources"), plus the states the design
// names: Retool cancellation, cancelled with no date, PAST_DUE, never a member.
//
// Every "absent" assertion has a positive control: the same lookup finding the thing in a fixture
// where it does exist, in this run.

import {
  buildMembershipHistory, invoiceYm, ymChicago, isRetool, neverMemberLine,
  type History, type InvoiceRow, type LiveMembership, type RefundRow, type SubRow, type MembershipBlock,
} from "../src/lib/membershipHistory";

let pass = 0, fail = 0;
const is = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  XX  ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`); }
};

const NOW = new Date("2026-11-07T18:00:00Z");
const row = (id: number, status: string, price: number, act: string, canceled: string | null = null, reason: string | null = null): SubRow =>
  ({ membership_id: id, status, price, activation_date: act, canceled_at: canceled, cancel_reason: reason });
let piN = 0;
const inv = (mid: number, cents: number, reason: "subscription_create" | "subscription_cycle", iso: string, pi?: string): InvoiceRow =>
  ({ md_membership_id: mid, amount_paid_cents: cents, billing_reason: reason, created_at_utc: iso, payment_intent_id: pi ?? `pi_${++piN}` });
/** A renewal on the 1st of `ym`, created 05:xx or 06:xx UTC like all 7,715 production cycle invoices. */
const cyc = (mid: number, cents: number, ym: string, pi?: string) => {
  const m = Number(ym.slice(5, 7));
  const h = m >= 4 && m <= 11 ? "05" : "06"; // CDT months anchor at 05:00Z, CST months at 06:00Z
  return inv(mid, cents, "subscription_cycle", `${ym}-01T${h}:00:12Z`, pi);
};
const months = (from: string, n: number) => Array.from({ length: n }, (_, i) => {
  const [y, m] = from.split("-").map(Number); const k = y * 12 + (m - 1) + i;
  return `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, "0")}`;
});
const build = (rows: SubRow[], invoices: InvoiceRow[], live: LiveMembership, refunds: RefundRow[] = []): History =>
  buildMembershipHistory({ rows, invoices, refunds, live, now: NOW, syncedAt: "2026-11-07T10:40:48Z" });
const blocks = (h: History): MembershipBlock[] => h.items.flatMap((i) => (i.type === "membership" ? [i.block] : []));
const gaps = (h: History) => h.items.flatMap((i) => (i.type === "gap" ? [i.text] : []));
const ev = (b: MembershipBlock, key: string) => b.events.find((e) => e.key === key) ?? null;

// ── the clocks ──────────────────────────────────────────────────────────────────────────────────
console.log("\n— the two clocks —");
is("a renewal created Dec 1 05:30Z bills December (UTC month)", invoiceYm(inv(1, 7199, "subscription_cycle", "2026-12-01T05:30:00Z")), "2026-12");
is("CONTROL: read in Central the same instant is November — the trap the UTC rule avoids", ymChicago("2026-12-01T05:30:00Z"), "2026-11");
is("a signup is a person's action, in Central: Apr 1 03:00Z joined in March", invoiceYm(inv(1, 108, "subscription_create", "2026-04-01T03:00:00Z")), "2026-03");
is("Retool's reason is recognised whatever its case or spacing", [isRetool("Removed by Retool"), isRetool("  removed by retool "), isRetool("Moving"), isRetool(null)], [true, true, false, false]);

// ── 1. one membership, no gaps (shaped like the current member, 42922) ─────────────────────────
console.log("\n— 1. one membership with no gaps —");
const A_LIVE: LiveMembership = { id: 28677, statusRaw: "ACTIVE", canceledAt: null, renews: "2026-12-01T05:59:59.000Z", priceCents: 6650 };
const A = build(
  [row(28677, "ACTIVE", 66, "2026-01-31T18:00:00Z")],
  [inv(28677, 108, "subscription_create", "2026-01-31T18:00:05Z"), ...months("2026-02", 10).map((ym) => cyc(28677, 7199, ym))],
  A_LIVE,
);
const a1 = blocks(A)[0];
is("now: Active, the live plan price before tax and the period end as Stripe names it", [A.now.title, A.now.sub, A.now.badge], ["Active", "$66.50 plan · renews Dec 1", null]);
is("summary: since, memberships, months paid, months since joining", [A.summary.memberSince, A.summary.memberships, A.summary.monthsPaid, A.summary.monthsSinceJoining], ["Jan 2026", 1, 11, 11]);
is("total paid = every paid invoice, tax included: $1.08 + 10 × $71.99", A.summary.totalPaidCents, 108 + 10 * 7199);
is("the strip runs first to last invoice month: a first charge then 10 paid months", a1.strip.map((c) => c.kind), ["first", ...Array(10).fill("paid")]);
is("joined, with the promo labelled", [ev(a1, "joined")?.title, ev(a1, "joined")?.sub], ["Joined · first charge $1.08", "Jan 31, 2026 · signup promo"]);
is("renews, with none missed and the next date", [ev(a1, "renews")?.title, ev(a1, "renews")?.sub], ["Renews monthly at $71.99", "10 renewals paid, none missed · next Dec 1"]);
is("no price change on a constant charge (control: fixture 3 finds one)", a1.events.filter((e) => e.key.startsWith("price")).length, 0);
is("no gap line on one membership (control: fixture 3 has one)", gaps(A).length, 0);
is("badge and range", [a1.badge, a1.range], ["ACTIVE", "Jan 31, 2026 to now"]);
is("the footer says failed payments aren't shown and end dates are estimated",
  /Failed payments aren't shown yet/.test(A.footer) && /end dates are estimated/.test(A.footer), true);

// a membership with a month that carried no charge
const A2 = build([row(5, "ACTIVE", 66, "2026-05-02T18:00:00Z")],
  [inv(5, 7199, "subscription_create", "2026-05-02T18:00:00Z"), cyc(5, 7199, "2026-06"), cyc(5, 7199, "2026-08")], { ...A_LIVE, id: 5 });
is("a month with no invoice shows as no charge, never as missed or failed", blocks(A2)[0].strip.map((c) => c.kind), ["first", "paid", "none", "paid"]);
is("…and the renewals line counts it as a month with no charge", ev(blocks(A2)[0], "renews")?.sub, "2 renewals paid, 1 month with no charge · next Dec 1");
is("a first charge equal to the regular charge carries no promo label", ev(blocks(A2)[0], "joined")?.sub, "May 2, 2026");

// ── 2. one cancelled with a reason (shaped like 23802) ─────────────────────────────────────────
console.log("\n— 2. cancelled with a reason —");
const B = build(
  [row(11253, "CANCELED", 49, "2025-05-03T15:00:00Z", "2025-06-07T20:00:00Z", "Not enough time")],
  [inv(11253, 5304, "subscription_create", "2025-05-03T15:00:04Z"), cyc(11253, 5304, "2025-06"), cyc(11253, 5304, "2025-07")],
  null,
);
const b1 = blocks(B)[0];
is("now: ended about the 1st after the last paid month, with the reason", [B.now.title, B.now.badge, B.now.sub, B.now.sub2],
  ["Ended about Aug 1, 2025", "ENDED", "Asked to cancel on Jun 7, 2025: “Not enough time”", "3 months paid at $53.04"]);
is("asked to cancel, with the reason in quotes", [ev(b1, "cancel")?.title, ev(b1, "cancel")?.quote], ["Asked to cancel · Jun 7, 2025", "Not enough time"]);
is("ended, estimated, with the explanation line", [ev(b1, "ended")?.title, ev(b1, "ended")?.sub],
  ["Ended about Aug 1, 2025 (estimated)", "Last paid month was July; MatchDay doesn't record the end date"]);
is("range runs to the estimated end", b1.range, "May 3, 2025 to about Aug 1, 2025");
is("no renewals line on an ended membership (control: fixture 1 has one)", ev(b1, "renews"), null);
is("total paid, 3 × $53.04", B.summary.totalPaidCents, 3 * 5304);
is("a cancel date at 20:00Z on Jun 7 is Jun 7 in Central; one at 03:00Z is the evening before",
  [ev(b1, "cancel")?.title, ev(blocks(build([row(9, "CANCELED", 49, "2025-05-03T15:00:00Z", "2025-06-08T03:00:00Z", "Moving")], [], null))[0], "cancel")?.title],
  ["Asked to cancel · Jun 7, 2025", "Asked to cancel · Jun 7, 2025"]);

// ── 3. cancelled and rejoined, with a price change and a refund (shaped like 60178) ────────────
console.log("\n— 3. cancelled and rejoined, with a price change —");
const C_LIVE: LiveMembership = { id: 33067, statusRaw: "ACTIVE", canceledAt: null, renews: "2026-12-01T04:59:59.000Z", priceCents: 6650 };
const C_ROWS = [
  row(20759, "CANCELED", 66, "2025-09-08T16:00:00Z", "2026-01-24T22:00:00Z", "The price went up too much"),
  row(33067, "ACTIVE", 66, "2026-04-19T17:00:00Z"),
];
const C_INV = [
  inv(20759, 108, "subscription_create", "2025-09-08T16:00:03Z"),
  ...months("2025-10", 3).map((ym) => cyc(20759, 5304, ym)),
  ...months("2026-01", 2).map((ym) => cyc(20759, 7199, ym)),
  inv(33067, 2639, "subscription_create", "2026-04-19T17:00:03Z"),
  ...months("2026-05", 7).map((ym) => cyc(33067, 7199, ym, ym === "2026-06" ? "pi_c_jun" : undefined)),
];
const C_REFUNDS: RefundRow[] = [
  { payment_intent_id: "pi_c_jun", cents: 7199, created_at_utc: "2026-06-03T15:00:00Z" },
  { payment_intent_id: "pi_someone_else", cents: 500, created_at_utc: "2026-06-03T15:00:00Z" },
];
const C = build(C_ROWS, C_INV, C_LIVE, C_REFUNDS);
const [c2, c1] = blocks(C);
is("newest first: Membership 2, a gap line, Membership 1", C.items.map((i) => (i.type === "gap" ? "gap" : `m${i.block.n}`)), ["m2", "gap", "m1"]);
is("the gap line", gaps(C), ["Not a member for about 2 months (Mar to mid-Apr 2026)"]);
is("summary: since, memberships, months paid of months since joining", [C.summary.memberSince, C.summary.memberships, C.summary.monthsPaid, C.summary.monthsSinceJoining], ["Sep 2025", 2, 14, 15]);
is("price change found on the regular charge, from the first invoice at the new amount",
  [ev(c1, "price-3")?.title, ev(c1, "price-3")?.sub], ["Price went up: $53.04 → $71.99 a month", "From the Jan 2026 charge (includes tax)"]);
is("…once, not on every renewal after it", c1.events.filter((e) => e.key.startsWith("price")).length, 1);
{
  const full = build([row(21, "CANCELED", 66, "2025-09-08T16:00:00Z", "2026-01-24T22:00:00Z", "x")],
    [inv(21, 5304, "subscription_create", "2025-09-08T16:00:03Z"), cyc(21, 5304, "2025-10"), cyc(21, 7199, "2025-11")], null);
  is("a full-price signup before a price rise is not 'discounted' (compared with the first renewal, not the latest)",
    ev(blocks(full)[0], "joined")?.sub, "Sep 8, 2025");
  is("CONTROL: the same signup below its first renewal IS discounted",
    ev(blocks(build([row(22, "ACTIVE", 66, "2025-09-08T16:00:00Z")], [inv(22, 5304, "subscription_create", "2025-09-08T16:00:03Z"), cyc(22, 7199, "2025-10")], null))[0], "joined")?.sub,
    "Sep 8, 2025 · first month discounted");
}
is("the old membership ended about the 1st after its last paid month", ev(c1, "ended")?.title, "Ended about Mar 1, 2026 (estimated)");
is("joined again, first month discounted (above the promo, below the regular charge)",
  [ev(c2, "joined")?.title, ev(c2, "joined")?.sub], ["Joined again · first charge $26.39", "Apr 19, 2026 · first month discounted"]);
is("the period end at 04:59:59Z still names Dec 1", ev(c2, "renews")?.sub, "7 renewals paid, none missed · next Dec 1");
is("the refunded month is red, and only that one", c2.strip.filter((c) => c.kind === "refunded").map((c) => c.ym), ["2026-06"]);
is("CONTROL: the refunded month is otherwise a paid month in the same fixture without refunds",
  blocks(build(C_ROWS, C_INV, C_LIVE))[0].strip.find((c) => c.ym === "2026-06")?.kind, "paid");
const gross = C_INV.reduce((s, v) => s + v.amount_paid_cents, 0);
is("total paid takes off the linked refund, and ignores a refund on someone else's payment", [C.summary.totalPaidCents, C.summary.refundedCents], [gross - 7199, 7199]);
is("the caption says refunds are taken off", C.summary.totalCaption, "incl. tax, refunds taken off");

// ── 4. a Retool cancellation ───────────────────────────────────────────────────────────────────
console.log("\n— 4. cancelled in Retool —");
const R = build(
  [row(500, "CANCELED", 49, "2025-05-03T15:00:00Z", "2025-07-03T15:00:00Z", "Removed by Retool")],
  [inv(500, 5304, "subscription_create", "2025-05-03T15:00:04Z"), cyc(500, 5304, "2025-06"), cyc(500, 5304, "2025-07")],
  null,
);
const r1 = blocks(R)[0];
is("shown as removed by staff in Retool, no reason recorded", [ev(r1, "cancel")?.title, ev(r1, "cancel")?.sub, ev(r1, "cancel")?.quote],
  ["Removed by staff in Retool · Jul 3, 2025", "No reason was recorded.", undefined]);
is("…and never quoted as if the player said it (control: fixture 2 quotes)", JSON.stringify(R).includes("“Removed by Retool”"), false);
is("the state card (frame 20865:285)", [R.now.title, R.now.badge, R.now.sub, R.now.sub2],
  ["Ended about Aug 1, 2025", "ENDED", "Removed by staff in Retool on Jul 3, 2025. No reason was recorded.", "3 months paid at $53.04"]);

// ── 5. cancelled with no date ──────────────────────────────────────────────────────────────────
console.log("\n— 5. cancelled with no date —");
const U = build(
  [row(600, "CANCELED", 66, "2026-05-08T16:00:00Z")],
  [inv(600, 5341, "subscription_create", "2026-05-08T16:00:02Z"), cyc(600, 7199, "2026-06")],
  null,
);
const u1 = blocks(U)[0];
is("says no date is on record", ev(u1, "cancel")?.title, "Cancelled, with no date on record");
is("the end month is inferred the same way, and says so", [ev(u1, "ended")?.title, ev(u1, "ended")?.sub],
  ["Ended about Jul 1, 2026 (estimated)", "No cancel date on record, so this is estimated the same way: last paid month was June 2026"]);
is("the state card says there is no date or reason", [U.now.title, U.now.sub], ["Ended about Jul 1, 2026", "No cancel date or reason on record."]);
const U0 = build([row(601, "CANCELED", 66, "2026-05-08T16:00:00Z")], [], null);
is("with no invoice at all the end is unknown, not guessed", [ev(blocks(U0)[0], "ended")?.title, U0.now.title], ["End date unknown", "Ended"]);

// ── 6. PAST_DUE ────────────────────────────────────────────────────────────────────────────────
console.log("\n— 6. past due —");
const P_ROWS = [row(700, "PAST_DUE", 66, "2026-06-10T16:00:00Z")];
const P_INV = [inv(700, 7199, "subscription_create", "2026-06-10T16:00:02Z"), ...months("2026-07", 4).map((ym) => cyc(700, 7199, ym))];
const P = build(P_ROWS, P_INV, null);
const p1 = blocks(P)[0];
is("the past-due state, current state only: no attempts claimed", [P.now.title, P.now.tone, P.now.badge, P.now.sub],
  ["Payment overdue", "bad", "PAST DUE", "The November renewal hasn't been paid. Failed payment attempts aren't shown."]);
is("the block carries it too, with no end estimate (control: fixture 2 has one)", [p1.badge, ev(p1, "pastdue")?.title, ev(p1, "ended")], ["PAST DUE", "Payment overdue", null]);
is("the same when the live record says PAST_DUE", build(P_ROWS, P_INV, { id: 700, statusRaw: "PAST_DUE", canceledAt: null, renews: null, priceCents: 6650 }).now.title, "Payment overdue");

// ── 7. never a member ──────────────────────────────────────────────────────────────────────────
console.log("\n— 7. never a member —");
const N = build([], [], null);
is("never a member, nothing else drawn", [N.never, N.now.title, N.items.length, N.summary.memberships], [true, "Never been a member", 0, 0]);
is("the pays-per-match line, with the first match's month from its wall clock", neverMemberLine(23, "2026-03-04T19:00:00Z"), "Pays per match. 23 matches played since Mar 2026.");
is("…singular, and with no matches", [neverMemberLine(1, null), neverMemberLine(0, null)], ["Pays per match. 1 match played.", "Pays per match. No matches played yet."]);
const K = build([], [], { id: 9001, statusRaw: "ADDED_FROM_ADMIN", canceledAt: null, renews: null, priceCents: 6600 });
is("CONTROL: a live comp with no records is NOT 'never a member', and says why there is no history",
  [K.never, K.now.title, K.notices], [false, "Comped", ["The current comp (#9001) isn't in our membership records, so it has no history here."]]);
is("a live membership newer than last night's sync is named, not dropped",
  build([], [], { ...A_LIVE, id: 9002 }).notices, ["The current membership (#9002) isn't in our membership records yet, so it has no history here. They sync nightly."]);

// ── a player cancelling at period end (ACTIVE with canceled_at) ───────────────────────────────
console.log("\n— cancelling, still active —");
const X = build([row(800, "ACTIVE", 66, "2026-03-02T16:00:00Z", "2026-10-20T14:00:00Z", "Moving")],
  [inv(800, 7199, "subscription_create", "2026-03-02T16:00:00Z"), ...months("2026-04", 8).map((ym) => cyc(800, 7199, ym))],
  { id: 800, statusRaw: "ACTIVE", canceledAt: "2026-10-20T14:00:00Z", renews: "2026-12-01T05:59:59.000Z", priceCents: 6650 });
const x1 = blocks(X)[0];
is("now: cancelling, runs to the period end", [X.now.title, X.now.badge, X.now.sub], ["Cancelling", "CANCELLING", "$66.50 plan · runs to Dec 1"]);
is("the block says it runs to the period end, not that it ended", [x1.badge, ev(x1, "ending")?.title, ev(x1, "ended")], ["CANCELLING", "Runs to Dec 1", null]);
is("…and the renewals line carries no next date on a cancelling membership", ev(x1, "renews")?.sub, "8 renewals paid, none missed");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
