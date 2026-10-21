/* THE PAYING-MEMBER RULE — the guard on who counts as a member (2026-10-14; "above $0" since 2026-10-21).
 *
 * Member classification decides which FREE spots are member spots, and member spots are what a
 * partner payout values. So this rule moves money, and it lives in TWO places the gate can reach
 * only one of: membershipStats.ts (TypeScript, asserted at runtime below) and migration 0229's
 * paid_member_subscription view (SQL, which no node suite can execute).
 *
 * THE SQL HALF IS A SOURCE ASSERTION, and that is deliberate — a database boundary makes it
 * unobservable inside the gate. Per CLAUDE.md it is narrowed to the PAIRING (the floor written
 * beside its PAID_MEMBER_MIN_PRICE_CENTS label) and asserts the NEGATIVE too: no `price > 0` and no
 * other floor in the view body, because a drifted copy arrives as an added line, not a changed one.
 */
import { readFileSync } from "node:fs";
import {
  PAID_MEMBER_MIN_PRICE_CENTS, PAID_MEMBER_RULE_LABEL, isPaidMemberSubscription, isPaidExternalMember, isLegacyLowPlan,
} from "../src/lib/membershipStats";

let pass = 0; const fails: string[] = [];
const is = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok  ${name}`); }
  else { fails.push(`${name} — got ${g} want ${w}`); console.log(`  XX  ${name} — got ${g} want ${w}`); }
};

const floorDollars = PAID_MEMBER_MIN_PRICE_CENTS / 100;
const sub = (over: Record<string, unknown>) =>
  isPaidMemberSubscription({ status: "ACTIVE", price: 66, member_email: "player@gmail.com", ...over });

console.log("\nthe price floor is the plan's monthly price, in dollars on the row");
{
  is("a $66 plan is a member", sub({ price: 66 }), true);
  is("the floor itself is a member", sub({ price: floorDollars }), true);
  is("one cent under the floor is not", sub({ price: floorDollars - 0.01 }), false);
  is("a legacy $1 plan is a member", sub({ price: 1 }), true);
  is("the rule is above $0", PAID_MEMBER_MIN_PRICE_CENTS, 1);
  is("a legacy $1 plan is labelled legacy", isLegacyLowPlan({ status: "ACTIVE", price: 1, member_email: "p@gmail.com" }), true);
  is("a $66 plan is not legacy", isLegacyLowPlan({ status: "ACTIVE", price: 66, member_email: "p@gmail.com" }), false);
  is("a $0 comp is not legacy (not a member at all)", isLegacyLowPlan({ status: "ACTIVE", price: 0, member_email: "p@gmail.com" }), false);
  is("a $0 comp is not a member", sub({ price: 0 }), false);
  is("a null price is not a member", sub({ price: null }), false);
  is("a numeric(10,2) string price converts", sub({ price: "18.00" }), true);
  is("an unparseable price is not a member", sub({ price: "n/a" }), false);
  is("the label says the rule", PAID_MEMBER_RULE_LABEL, "plan above $0");
}

console.log("\nstaff and unfinished checkouts are out at any price");
{
  is("@playmatchday.com staff at $66 is not a member", sub({ member_email: "a@playmatchday.com" }), false);
  is("@matchday.com fill at $66 is not a member", sub({ member_email: "x1@matchday.com" }), false);
  is("INCOMPLETE is not a member", sub({ status: "INCOMPLETE" }), false);
  is("INCOMPLETE_EXPIRED is not a member", sub({ status: "INCOMPLETE_EXPIRED" }), false);
  is("CANCELED still passes the rule (windows need it)", sub({ status: "CANCELED" }), true);
}

console.log("\nthe raw-row helper and the MemberLike predicate are one rule");
{
  const like = (price_cents: number) => isPaidExternalMember({
    status: "ACTIVE", price_cents, email: "p@gmail.com", activation_date: null, canceled_at: null, city: "",
  });
  is("MemberLike at the floor", like(PAID_MEMBER_MIN_PRICE_CENTS), true);
  is("MemberLike one cent under", like(PAID_MEMBER_MIN_PRICE_CENTS - 1), false);
}

console.log("\nthe SQL mirror (0229) carries the same floor, and no other");
{
  const sql = readFileSync("supabase/migrations/0229_paid_member_above_zero.sql", "utf8");
  const sql0223 = readFileSync("supabase/migrations/0223_paid_member_subscription.sql", "utf8");
  const view = sql.match(/CREATE OR REPLACE VIEW public\.paid_member_subscription[\s\S]*?;/)?.[0] ?? "";
  is("the view body was found (positive control)", view.length > 0, true);
  is("the floor is written beside its constant's name",
    new RegExp(`price \\* 100 >= ${PAID_MEMBER_MIN_PRICE_CENTS}\\s+-- PAID_MEMBER_MIN_PRICE_CENTS`).test(view), true);
  const floors = [...view.matchAll(/price[^\n]*?(>=|>)\s*(\d+)/g)].map((m) => `${m[1]} ${m[2]}`);
  is("exactly one price comparison in the view, and it is the floor", floors, [`>= ${PAID_MEMBER_MIN_PRICE_CENTS}`]);
  is("the internal-email pattern matches INTERNAL_EMAIL_RX", view.includes("!~* '@matchday\\.|@playmatchday\\.'"), true);
  const fn = sql0223.match(/CREATE OR REPLACE FUNCTION public\.fin_member_spots_by_venue_month[\s\S]*?\$\$;/)?.[0] ?? "";
  is("member spots read the rule, not the raw table",
    [fn.includes("from paid_member_subscription s"), /from mdapi_subscriptions/.test(fn)], [true, false]);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { fails.forEach((f) => console.log(`  XX  ${f}`)); process.exit(1); }
if (pass === 0) { console.log("ZERO ASSERTIONS — that is a failure, not a pass"); process.exit(1); }
