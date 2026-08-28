/* ACTIVE MEMBERS — ONE PREDICATE, TWO PAGES, ASSERTED.
 *
 * WHY THIS EXISTS. On 2026-08-28 three surfaces showed three numbers under one label: Home 391,
 * the Membership tile 387, the all-time chart 455. The 4 were @playmatchday.com staff accounts
 * priced at $66 that Home's `status='ACTIVE' AND price>0` kept and isPaidExternalMember drops;
 * the 64 were subscriptions priced at 0. Nothing was broken — three code paths had each decided
 * separately what "member" meant, which is the same shape as per_match_rate and cost_per_match
 * sitting $36 apart.
 *
 * WHAT IT ASSERTS. Not "does countActiveMembers return a number" — that cannot fail. It runs
 * HOME'S FOLD (homeStats.activeMembersFromRows) and the SNAPSHOT'S FOLD
 * (membershipStats.computeMonthlySnapshot -> active_count, the function that writes
 * members_monthly_snapshots) over the SAME fixture and requires the same answer. Those are two
 * separate call chains with separate mapping code; editing either one alone turns this red.
 *
 * PROVEN FAILABLE, not assumed failable: with homeStats reverted to its old
 * `status==='ACTIVE' && price>0` form this file reports the staff row as a divergence and exits 1.
 * A check that cannot fail proves nothing — a readiness check once counted a deleted card's digits
 * for months. */

import { readFileSync } from "node:fs";
import {
  memberLikeFromSubscription, countActiveMembers, computeMonthlySnapshot, isActiveAsOf,
  type MemberLike,
} from "../src/lib/membershipStats";

/* NOT IMPORTED FROM homeStats. That module opens with `import { supabase } from "@/lib/supabase"`,
 * which is "use client" and builds a Supabase client at module scope from NEXT_PUBLIC_* env — a
 * node suite that imports it hangs rather than fails, which is worse. Home's side is asserted by
 * reading the file (bottom block); the FOLDS compared here are the two that can genuinely drift:
 * the shared predicate and the snapshot builder's own use of it. */
const activeMembersFromRows = countActiveMembers;

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const ASOF = new Date(2026, 7, 28);   // 28 Aug 2026, local — the same shape refreshMembershipSnapshots uses

/* THE FIXTURE IS THE PRODUCTION SHAPE, ROW FOR ROW. Every exclusion below was measured on
 * production this phase, so each row here stands for real rows, not an invented edge case. */
const ROWS = [
  // 3 ordinary paying members — the only ones that should count.
  { membership_id: 1, status: "ACTIVE", price: 66, member_email: "a@gmail.com", activation_date: "2026-07-01", canceled_at: null, city_identifier: "ATX" },
  { membership_id: 2, status: "ACTIVE", price: 66, member_email: "b@gmail.com", activation_date: "2026-08-21", canceled_at: null, city_identifier: "HOU" },
  { membership_id: 3, status: "ACTIVE", price: 45, member_email: "c@yahoo.com", activation_date: "2026-01-15", canceled_at: null, city_identifier: "ATL" },
  // THE FOUR. Staff at a real price — this is membership 37795/37951/38148/39339's shape, and the
  // whole 391-vs-387 gap. Home used to count them.
  { membership_id: 4, status: "ACTIVE", price: 66, member_email: "ops@playmatchday.com", activation_date: "2026-07-20", canceled_at: null, city_identifier: "SATX" },
  { membership_id: 5, status: "ACTIVE", price: 66, member_email: "x@matchday.io", activation_date: "2026-07-24", canceled_at: null, city_identifier: "HOU" },
  // COMPED — price exactly 0. 64 of these in production, 57 of them ATX.
  { membership_id: 6, status: "ACTIVE", price: 0, member_email: "d@gmail.com", activation_date: "2026-06-01", canceled_at: null, city_identifier: "ATX" },
  // CANCELED — 2,225 in production, the bulk of the table.
  { membership_id: 7, status: "CANCELED", price: 66, member_email: "e@gmail.com", activation_date: "2026-02-01", canceled_at: "2026-07-09", city_identifier: "ATX" },
  // NOT YET ACTIVATED as of ASOF.
  { membership_id: 8, status: "ACTIVE", price: 66, member_email: "f@gmail.com", activation_date: "2026-09-15", canceled_at: null, city_identifier: "ATX" },
  // NO activation_date at all.
  { membership_id: 9, status: "ACTIVE", price: 66, member_email: "g@gmail.com", activation_date: null, canceled_at: null, city_identifier: "ATX" },
  // CITY OUTSIDE THE COCKPIT MAP. Zero ACTIVE rows are in this state today; Warsaw was, once.
  { membership_id: 10, status: "ACTIVE", price: 66, member_email: "h@gmail.com", activation_date: "2026-05-01", canceled_at: null, city_identifier: "ZZZ" },
  // INCOMPLETE — never completed checkout, never charged.
  { membership_id: 11, status: "INCOMPLETE", price: 66, member_email: "i@gmail.com", activation_date: "2026-05-01", canceled_at: null, city_identifier: "ATX" },
];
const EXPECTED = 3;

console.log("\nthe two pages fold to the same number");
{
  // PATH A — what the Home tile renders.
  const home = activeMembersFromRows(ROWS, ASOF);
  // PATH B — what members_monthly_snapshots.active_count is written from, via the same mapping
  // the snapshot builder uses.
  const members: MemberLike[] = [];
  for (const r of ROWS) { const m = memberLikeFromSubscription(r); if (m) members.push(m); }
  const snapshot = computeMonthlySnapshot(members, [], ["Austin", "Houston", "Atlanta", "San Antonio"], ASOF).active_count;

  is("Home's fold and the snapshot's fold agree", home, snapshot);
  is("…and both equal the hand-counted answer", [home, snapshot], [EXPECTED, EXPECTED]);

  /* THE CONTROL. If this fixture cannot tell the two predicates apart, agreement above is
   * meaningless. Home's OLD rule — status ACTIVE and price > 0, nothing else — must give a
   * DIFFERENT answer on these same rows, or the fixture is not exercising the gap. */
  const oldHome = ROWS.filter((r) => r.status === "ACTIVE" && Number(r.price) > 0).length;
  if (oldHome !== EXPECTED) ok(`control: the OLD Home rule gives ${oldHome}, not ${EXPECTED} — the fixture does exercise the gap`);
  else bad("control: the fixture exercises the gap", "the old and new rules agree here, so parity above proves nothing");
  /* THE GAP IS 5 HERE, NOT 4. In production the whole Home-vs-Membership difference was staff
   * (4 rows), because no ACTIVE row today has a future activation_date, a null activation_date or
   * an unmapped city. The fixture carries one of each anyway — they are reachable states the old
   * rule also got wrong, and a fixture that only covers today's data stops testing the moment the
   * data changes. So: 2 staff + 3 others. */
  is("…and the gap is 5: two staff accounts plus three the old rule also missed", oldHome - EXPECTED, 5);
  const staffOnly = ROWS.filter((r) => /@matchday\.|@playmatchday\./i.test(r.member_email ?? "")).length;
  is("…of which the staff accounts — the production gap — are 2 of the fixture's rows", staffOnly, 2);
}

console.log("\neach exclusion, named");
{
  const only = (id: number) => activeMembersFromRows(ROWS.filter((r) => r.membership_id === id), ASOF);
  is("an ordinary paying member counts", only(1), 1);
  is("a @playmatchday.com staff account does NOT", only(4), 0);
  is("a @matchday.io staff account does NOT", only(5), 0);
  is("a comped member (price 0) does NOT", only(6), 0);
  is("a CANCELED member does NOT", only(7), 0);
  is("a member activating after asOf does NOT", only(8), 0);
  is("a member with no activation_date does NOT", only(9), 0);
  is("a member in a city outside cityFromAbbr does NOT", only(10), 0);
  is("an INCOMPLETE checkout does NOT", only(11), 0);
  is("the mapper returns null for the unmapped city rather than a zero-price member",
    memberLikeFromSubscription(ROWS[9]), null);
}

console.log("\nprice is DOLLARS in the table and CENTS in the predicate");
{
  const m = memberLikeFromSubscription({ status: "ACTIVE", price: 66, member_email: "a@gmail.com", activation_date: "2026-01-01", canceled_at: null, city_identifier: "ATX" })!;
  is("66 dollars becomes 6600 cents", m.price_cents, 6600);
  /* A caller that forgot the x100 gets no type error, just a smaller number that still looks like
   * money. The mapper is the only place this conversion happens. */
  is("a 0.50 price survives as 50 cents, not 0",
    memberLikeFromSubscription({ status: "ACTIVE", price: 0.5, member_email: "a@gmail.com", activation_date: "2026-01-01", canceled_at: null, city_identifier: "ATX" })!.price_cents, 50);
  is("…and is therefore counted, not dropped as unpaid",
    isActiveAsOf(memberLikeFromSubscription({ status: "ACTIVE", price: 0.5, member_email: "a@gmail.com", activation_date: "2026-01-01", canceled_at: null, city_identifier: "ATX" })!, ASOF), true);
}

console.log("\nthe server-side narrowing is free");
{
  /* HOME FETCHES ONLY status='ACTIVE' ROWS — 455 instead of 2,680, one page instead of three.
   * That is sound ONLY because isActiveAsOf returns false for anything else. Asserted, because
   * "it cannot matter" is exactly the kind of claim that stops being true when someone adds
   * PAST_DUE to the definition. */
  const all = activeMembersFromRows(ROWS, ASOF);
  const narrowed = activeMembersFromRows(ROWS.filter((r) => r.status === "ACTIVE"), ASOF);
  is("folding the ACTIVE-only subset equals folding everything", narrowed, all);
  // CONTROL: the discarded rows are not empty, so the equality above is not trivially true.
  is("control: the narrowing actually discards rows", ROWS.length - ROWS.filter((r) => r.status === "ACTIVE").length, 2);
}

console.log("\nthe wiring, so the folds above are the ones that ship");
{
  /* COMMENTS ARE STRIPPED BEFORE ANY "the code must not contain X" CHECK. This suite failed on its
   * first run because homeStats.ts explains, in a comment, that it must not carry the old
   * `.gt("price", 0)` rule — and the grep found the explanation. That false positive has hit this
   * repo before; a check that reads prose as code is a check that goes red for being well
   * documented, and the fix people reach for is deleting the comment. */
  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const home = stripComments(readFileSync("src/lib/homeStats.ts", "utf8"));
  const route = stripComments(readFileSync("src/app/api/membership/route.ts", "utf8"));
  const view = stripComments(readFileSync("src/components/MembershipView.tsx", "utf8"));
  // CONTROL: the stripper must actually remove a comment AND leave code alone, or every "must not
  // contain" check below silently passes on an over-stripped file.
  is("control: the stripper removes a block comment", stripComments('/* .gt("price", 0) */ const a = 1;').trim(), "const a = 1;");
  is("control: …and a line comment", stripComments('// .gt("price", 0)\nconst a = 1;').trim(), "const a = 1;");
  is("control: …and leaves real code intact", stripComments('const q = x.gt("price", 0);').trim(), 'const q = x.gt("price", 0);');
  // POSITIVE CONTROLS: we are reading the files we think we are.
  if (/fetchActiveMembers/.test(home)) ok("control: homeStats.ts was actually read"); else bad("control: homeStats.ts was actually read");
  if (/activeMembers/.test(route)) ok("control: the membership route was actually read"); else bad("control: the membership route was actually read");

  if (/countActiveMembers/.test(home)) ok("the Home tile calls the shared predicate");
  else bad("the Home tile calls the shared predicate", "it has its own again");
  if (!/\.gt\("price", 0\)/.test(home)) ok("…and no longer carries the old price>0 rule");
  else bad("…and no longer carries the old price>0 rule", "THE 391 IS BACK");
  if (/countActiveMembers/.test(route)) ok("the membership route calls the shared predicate");
  else bad("the membership route calls the shared predicate");
  if (/activeMembersPaid/.test(view)) ok("the Membership tile renders the paid-external count");
  else bad("the Membership tile renders the paid-external count", "it is back on the nightly snapshot row");
  if (!/k="Active members"[^/]*partSuffix/.test(view)) ok("the Active members KPI carries no partial-days suffix");
  else bad("the Active members KPI carries no partial-days suffix", "a headcount is not 28/31ths of anything");
  if (/partSuffix/.test(view)) ok("…and partSuffix still exists for the KPIs where a period is real");
  else bad("…and partSuffix still exists elsewhere", "it was deleted rather than removed from one tile");

  const snaps = readFileSync("src/lib/membershipSnapshots.ts", "utf8");
  if (/captured_at: new Date\(\)\.toISOString\(\)/.test(snaps)) ok("captured_at is written on every snapshot upsert");
  else bad("captured_at is written on every snapshot upsert", "it will record first insert again");
  if (/memberLikeFromSubscription/.test(snaps)) ok("the snapshot builder uses the shared mapper too");
  else bad("the snapshot builder uses the shared mapper too", "the mapping can drift again");
}

console.log(`\nmembership-parity: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
