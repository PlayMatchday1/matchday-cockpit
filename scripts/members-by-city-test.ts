/* MEMBERS BY CITY — the month-end model, the rolling cutoff, and the page's silence.
 *
 * WHAT THIS GUARDS. The report answers two questions: who pays on the 1st of next month, and how
 * much of that drops off the month after. It is a SUBTRACTION from a base of status ACTIVE TODAY —
 * a cancellation does not flip status until it rolls off, so the cancelled cohorts sit INSIDE the
 * active set. A build that adds them instead of subtracting one double-counts, and every number
 * still looks plausible.
 *
 * AND THE DATES. They were two literal strings, CUTOFF_YMD and WINDOW_START_YMD, with a comment
 * calling the rollover "a one-line change to each". Nobody made the change, and on 2026-09-30 the
 * page still named a window that had closed 55 days earlier — rendering Being charged 393 = Active
 * with nothing subtracted, because every cancellation in that window had already left the base.
 * A stale window does not look stale; it looks like a month with no churn. The cutoff is calculated
 * now, and the block that pins it SETS THE CLOCK so it cannot itself go stale.
 *
 * EVERY ASSERTION BELOW CARRIES A CONTROL. The passing value of most of these is a small number or
 * an absence, and a fixture that produced nothing, a regex that matched nothing and a model that
 * silently dropped everyone all produce the same zero.
 *
 * NOTHING HERE PINS 393, 406, OR ANY OTHER LITERAL ACTIVE COUNT. 395 was a literal, and it was a
 * number the live count merely passed through between 27 and 28 August.
 */

import { readFileSync } from "node:fs";
import {
  buildMembersByCity, membersByCityCsv, mixLabel, dollars, prettyDate, prettyDateShort, reportDatesFor,
  isCancelledBefore, isCancelledOnOrAfter, CUTOFF_DAY, MIX_TIERS_CENTS,
  type SubscriptionRow, type ByCityRow, type ReportDates,
} from "../src/lib/membersByCity";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ── THE CUTOFF ROLLS FORWARD ON ITS OWN ──────────────────────────────────────────────────────
 * THE CLOCK IS SET for every case. No assertion here reads the real date, so this block says the
 * same thing in November as it does today — which is precisely what the old constants could not. */
console.log("THE CUTOFF IS THE MOST RECENT 6th ON OR BEFORE TODAY, CALCULATED");
{
  const at = (iso: string) => reportDatesFor(new Date(iso));
  const trio = (d: ReportDates) => [d.cutoffYmd, d.billingYmd, d.runRateYmd];

  // The four cases from the brief. Noon UTC is mid-morning in Chicago, so the calendar day is
  // unambiguous and these read as the plain dates they are named for.
  is("2026-09-30 -> Sep 6, bills Oct 1, run rate Nov 1", trio(at("2026-09-30T12:00:00Z")), ["2026-09-06", "2026-10-01", "2026-11-01"]);
  is("2026-10-05 -> still Sep 6, the 6th has not come round", trio(at("2026-10-05T12:00:00Z")), ["2026-09-06", "2026-10-01", "2026-11-01"]);
  is("2026-10-06 -> Oct 6, bills Nov 1, run rate Dec 1", trio(at("2026-10-06T12:00:00Z")), ["2026-10-06", "2026-11-01", "2026-12-01"]);
  is("2026-12-10 -> Dec 6, bills Jan 1 2027, run rate Feb 1 2027", trio(at("2026-12-10T12:00:00Z")), ["2026-12-06", "2027-01-01", "2027-02-01"]);

  // THE BOUNDARY, BOTH SIDES. The 6th is its own cutoff; the 5th is still the previous one.
  is("the 5th is still last month's cutoff", trio(at("2026-10-05T12:00:00Z"))[0], "2026-09-06");
  is("CONTROL: and the 6th is this month's", trio(at("2026-10-06T12:00:00Z"))[0], "2026-10-06");

  // THE YEAR ROLLS, FORWARD AND BACK.
  is("Jan 3 2027 -> Dec 6 2026, bills Jan 1 2027", trio(at("2027-01-03T12:00:00Z")), ["2026-12-06", "2027-01-01", "2027-02-01"]);
  is("Jan 6 2027 -> Jan 6, bills Feb 1 2027", trio(at("2027-01-06T12:00:00Z")), ["2027-01-06", "2027-02-01", "2027-03-01"]);

  /* BUSINESS_TZ, NOT UTC. 2026-10-06T02:00Z is still Oct 5 in Chicago (21:00 CDT on the 5th), so
   * the cutoff must NOT have rolled yet. Reading this instant in UTC rolls the page a day early
   * every month, at 7pm Central. */
  is("02:00Z on the 6th is still the 5th in Chicago, so the cutoff has not rolled",
     trio(at("2026-10-06T02:00:00Z"))[0], "2026-09-06");
  is("CONTROL: 14:00Z the same day IS the 6th in Chicago, and it has",
     trio(at("2026-10-06T14:00:00Z"))[0], "2026-10-06");

  // DERIVED RELATIONSHIPS, over a year of month starts, rather than ten more pinned triples.
  for (let m = 0; m < 12; m++) {
    const d = at(new Date(Date.UTC(2026, m, 20, 12)).toISOString());
    const [cy, cm, cd] = d.cutoffYmd.split("-").map(Number);
    const [by, bm, bd] = d.billingYmd.split("-").map(Number);
    const [ry, rm, rd] = d.runRateYmd.split("-").map(Number);
    const monthsApart = (a: number[], b: number[]) => (b[0] - a[0]) * 12 + (b[1] - a[1]);
    is(`  ${d.cutoffYmd}: cutoff on the ${CUTOFF_DAY}th, billing and run rate on the 1st, each one month on`,
       [cd, bd, rd, monthsApart([cy, cm], [by, bm]), monthsApart([by, bm], [ry, rm])],
       [CUTOFF_DAY, 1, 1, 1, 1]);
  }

  // THE 6th AGREES WITH membershipStats' CHURN WINDOW. Asserted, not imported — see CUTOFF_DAY's
  // note. A divergence is caught here instead of being made impossible by a binding.
  const stats = readFileSync("src/lib/membershipStats.ts", "utf8");
  is(`membershipStats still anchors its churn window on the ${CUTOFF_DAY}th`,
     stats.includes(`getMonth() - 1, ${CUTOFF_DAY})`), true);
  is("CONTROL: that scan fires on the expression it is looking for",
     "new Date(now.getFullYear(), now.getMonth() - 1, 6);".includes(`getMonth() - 1, ${CUTOFF_DAY})`), true);

  // AND NO DATE CONSTANT MAY COME BACK. A declaration, not a mention: the file's history comment
  // names both dead constants, and a scan that cannot tell the two apart would be satisfied by
  // deleting the note.
  const DECL = /^\s*(export\s+)?const\s+(CUTOFF_YMD|WINDOW_START_YMD)\s*=/m;
  const src = readFileSync("src/lib/membersByCity.ts", "utf8") + readFileSync("src/components/MembersByCityView.tsx", "utf8");
  is("no CUTOFF_YMD / WINDOW_START_YMD constant survives in src", DECL.test(src), false);
  is("CONTROL: that scan fires on a declaration", DECL.test('export const CUTOFF_YMD = "2026-08-06";'), true);
  is("CONTROL: and NOT on a mention of one in prose", DECL.test(" * it was CUTOFF_YMD = \"2026-08-06\" and it never rolled"), false);
}

/* ── THE FIXTURE ───────────────────────────────────────────────────────────────────────────────
 * The cutoff is stated here rather than imported, so the fixture's arithmetic is fixed while the
 * page's cutoff moves. Built so every branch is exercised and nothing passes by being empty:
 *   - three cities plus one UNMAPPED code (WAW), which is the unassigned line's reason to exist
 *   - all three named tiers AND two off-tier prices, so the "other" bucket is never zero
 *   - active people cancelled on each side of the cutoff, and one ON it
 *   - a $0 member, an internal @playmatchday member, an INCOMPLETE member and a CANCELED member,
 *     none of whom may reach any count
 *   - one person holding TWO rows, so the collapse has something to collapse */
const DATES: ReportDates = { cutoffYmd: "2026-09-06", billingYmd: "2026-10-01", runRateYmd: "2026-11-01" };

let nextUser = 100;
const sub = (o: Partial<SubscriptionRow>): SubscriptionRow => ({
  user_id: nextUser++, status: "ACTIVE", price: 66, member_email: `p${nextUser}@gmail.com`,
  activation_date: "2026-01-15T10:00:00+00:00", canceled_at: null, city_identifier: "ATX", ...o,
});

const FIXTURE: SubscriptionRow[] = [
  // ATX — 6 never-cancelled: 3 x $66, 1 x $49, 1 x $30, 1 x $13 (other)
  sub({}), sub({}), sub({}),
  sub({ price: 49 }),
  sub({ price: 30 }),
  sub({ price: 13 }),
  // ...two cancelled BEFORE the cutoff — out of paying entirely.
  sub({ price: 66, canceled_at: "2026-08-20T08:00:00+00:00" }),
  sub({ price: 66, canceled_at: "2026-09-05T23:59:00+00:00" }),
  // ...and two cancelled ON or AFTER it — they pay once more, then drop off.
  sub({ price: 49, canceled_at: `${DATES.cutoffYmd}T00:01:00+00:00` }),
  sub({ price: 30, canceled_at: "2026-09-29T08:00:00+00:00" }),

  // HOU — 2 at $500 (an off-tier one-off that must land in "other", not vanish), one cancelled before
  sub({ city_identifier: "HOU", price: 500 }),
  sub({ city_identifier: "HOU", price: 500, canceled_at: "2026-07-10T08:00:00+00:00" }),

  // SATX — 1 at $66
  sub({ city_identifier: "SATX", price: 66 }),

  // WAW — an UNMAPPED market. It must appear on the unassigned line and in NO city row.
  sub({ city_identifier: "WAW", price: 66 }),

  // NONE OF THESE MAY REACH ANY COUNT
  sub({ price: 0 }),                                         // $0
  sub({ price: 66, member_email: "ops@playmatchday.com" }),  // internal
  sub({ price: 66, status: "INCOMPLETE" }),                  // never completed checkout
  sub({ price: 66, status: "CANCELED", canceled_at: "2026-07-15T08:00:00+00:00" }), // already rolled off
  sub({ price: 66, status: "CANCELED", canceled_at: null }), // THE 683: cancelled, no date, not ACTIVE
];
// ONE PERSON, TWO ROWS — the collapse must count them once, at the higher price.
const TWICE = 9001;
FIXTURE.push(sub({ user_id: TWICE, price: 30, city_identifier: "SATX" }));
FIXTURE.push(sub({ user_id: TWICE, price: 66, city_identifier: "SATX" }));

const T = buildMembersByCity(FIXTURE, DATES);
const row = (code: string): ByCityRow => {
  const r = T.rows.find((x) => x.code === code);
  if (!r) throw new Error(`fixture row ${code} missing — the model dropped a whole city`);
  return r;
};

console.log("\ncontrol: the fixture is not empty and every branch has something in it");
{
  // WITHOUT THIS, EVERY SUBSET AND EVERY ZERO BELOW PASSES ON AN EMPTY TABLE.
  if (T.rows.length >= 3) ok(`control: ${T.rows.length} city rows built`); else bad("control: the fixture built city rows", `only ${T.rows.length}`);
  if (T.total.totalActive > 0) ok(`control: ${T.total.totalActive} active people in the fixture`); else bad("control: the fixture has active people", "EVERY ASSERTION BELOW WOULD PASS ON ZERO");
  if (T.total.cancelledBefore > 0) ok(`control: ${T.total.cancelledBefore} cancelled before the cutoff`); else bad("control: pre-cutoff cancellations exist", "THE SUBTRACTION WOULD BE UNTESTED");
  if (T.total.cancelledAfter > 0) ok(`control: ${T.total.cancelledAfter} cancelled on or after it`); else bad("control: post-cutoff cancellations exist", "THE RUN RATE WOULD BE UNTESTED");
  if (T.unassigned.members > 0) ok(`control: ${T.unassigned.members} unassigned member(s)`); else bad("control: an unmapped member exists", "THE EXCLUSION WOULD BE UNTESTED");
  const other = T.total.mix.find((e) => e.tier === "other");
  if ((other?.heads ?? 0) > 0) ok(`control: the "other" bucket holds ${other?.heads} people`); else bad("control: the other bucket is populated", "THE TAIL WOULD BE UNTESTED AND SILENTLY DROPPABLE");
}

console.log("\nPAYING = TOTAL ACTIVE MINUS CANCELLED BEFORE, every row and the footer");
{
  for (const r of [...T.rows, T.total]) {
    if (r.paying === r.totalActive - r.cancelledBefore) ok(`  ${r.code}: ${r.totalActive} − ${r.cancelledBefore} = ${r.paying}`);
    else bad(`${r.code}: paying is the subtraction`, `${r.paying} != ${r.totalActive} - ${r.cancelledBefore}`);
  }
  // CONTROL: the subtraction actually removes somebody somewhere, so it is not trivially true.
  if (T.total.paying < T.total.totalActive) ok(`  control: the subtraction bites — ${T.total.totalActive} active, ${T.total.paying} paying`);
  else bad("control: paying is strictly below active", "A SUBTRACTION THAT REMOVES NOBODY IS NOT TESTED");
}

console.log("\nBOTH COHORTS ARE SUBSETS OF TOTAL ACTIVE — the whole model depends on it");
{
  for (const r of [...T.rows, T.total]) {
    if (r.cancelledBefore <= r.totalActive && r.cancelledAfter <= r.paying) ok(`  ${r.code}: before ${r.cancelledBefore} <= active ${r.totalActive}, after ${r.cancelledAfter} <= paying ${r.paying}`);
    else bad(`${r.code}: cohorts are subsets`, `before ${r.cancelledBefore}/active ${r.totalActive}, after ${r.cancelledAfter}/paying ${r.paying}`);
  }
  // A CANCELLATION ON THE CUTOFF IS A PAYING MEMBER. On-or-after, so the 6th pays once more.
  is("cancelled ON the cutoff is NOT cancelled-before", isCancelledBefore(`${DATES.cutoffYmd}T00:01:00+00:00`, DATES.cutoffYmd), false);
  is("  ...it is cancelled on-or-after", isCancelledOnOrAfter(`${DATES.cutoffYmd}T00:01:00+00:00`, DATES.cutoffYmd), true);
  is("CONTROL: the day before IS cancelled-before", isCancelledBefore("2026-09-05T23:59:00+00:00", DATES.cutoffYmd), true);
  is("CONTROL: ...and is not on-or-after", isCancelledOnOrAfter("2026-09-05T23:59:00+00:00", DATES.cutoffYmd), false);
  is("no canceled_at is neither", [isCancelledBefore(null, DATES.cutoffYmd), isCancelledOnOrAfter(null, DATES.cutoffYmd)], [false, false]);
}

console.log("\nBILLING = SUM OVER TIERS OF HEADS x PRICE, exact to the cent, with Other included");
{
  for (const r of [...T.rows, T.total]) {
    const fromMix = r.mix.reduce((s, e) => s + e.cents, 0);
    if (fromMix === r.billingCents) ok(`  ${r.code}: ${dollars(r.billingCents)} = the mix, to the cent`);
    else bad(`${r.code}: billing equals the mix`, `${r.billingCents} != ${fromMix}`);
    // AND THE TAIL IS NOT DROPPED: every named tier is heads x its own price, exactly.
    for (const e of r.mix) {
      if (e.tier === "other" || e.heads === 0) continue;
      if (e.cents === e.heads * (e.tier as number)) continue;
      bad(`${r.code} tier ${e.tier}`, `${e.cents} != ${e.heads} x ${e.tier}`);
    }
  }
  // THE $500 MEMBER LANDS IN OTHER AT $500, not averaged into a tier and not dropped.
  const hou = row("HOU");
  const other = hou.mix.find((e) => e.tier === "other");
  is("an off-tier price lands in Other carrying its own dollars", [other?.heads, other?.cents], [1, 50000]);
  is("CONTROL: and HOU's billing is exactly that one member", hou.billingCents, 50000);
}

console.log("\nMIX HEADS = PAYING MEMBERS, every row");
{
  for (const r of [...T.rows, T.total]) {
    const heads = r.mix.reduce((s, e) => s + e.heads, 0);
    if (heads === r.paying) ok(`  ${r.code}: ${heads} heads = ${r.paying} paying`);
    else bad(`${r.code}: mix heads equal paying`, `${heads} != ${r.paying}`);
  }
  is("CONTROL: the label drops empty tiers rather than printing 0 x", /0 ×/.test(mixLabel(T.total.mix)), false);
  if (mixLabel(T.total.mix).length > 0) ok(`control: the label is non-empty — ${mixLabel(T.total.mix)}`); else bad("control: the mix label renders");
}

console.log("\nCANCELLED CUTOFF+ IS A COUNT, AND IT IS A SUBSET OF PAYING");
{
  for (const r of [...T.rows, T.total]) {
    if (r.cancelledAfter <= r.paying) ok(`  ${r.code}: ${r.cancelledAfter} leaving of ${r.paying} paying`);
    else bad(`${r.code}: leavers are a subset of paying`, `${r.cancelledAfter} > ${r.paying}`);
  }
  // CONTROL: somebody is actually leaving, so the column is not trivially zero everywhere.
  if (T.total.cancelledAfter > 0) ok(`  control: ${T.total.cancelledAfter} members are genuinely on their last charge`);
  else bad("control: the leavers cohort is populated", "THE COLUMN WOULD BE UNTESTED");
  // THE ATX FIXTURE PUTS EXACTLY TWO THERE: one cancelled ON the cutoff, one after it.
  is("a cancellation ON the cutoff counts as a leaver, not as cancelled-before", row("ATX").cancelledAfter, 2);
  /* NO DOLLARS ON THIS COHORT. The report carries ONE money figure — Billing — and a second one
   * beside it invites the two to be read as a difference the brief did not ask for. Asserted as an
   * absence on the row's own shape so a helpful re-addition is caught. */
  is("the row carries no dollar figure for the leavers",
     Object.keys(row("ATX")).some((k) => /cancelledAfterCents|runRateCents/.test(k)), false);
  is("CONTROL: that scan would fire if one were there",
     Object.keys({ cancelledAfterCents: 0 }).some((k) => /cancelledAfterCents|runRateCents/.test(k)), true);
}

console.log("\nNO $0, INTERNAL, INCOMPLETE OR CANCELED ROW REACHES ANY COUNT");
{
  const clean = buildMembersByCity([sub({ price: 66, member_email: "real@gmail.com" })], DATES);
  is("control: a clean row DOES count", clean.total.totalActive, 1);
  for (const [label, r] of [
    ["a $0 member", sub({ price: 0 })],
    ["an internal @playmatchday member", sub({ price: 66, member_email: "ops@playmatchday.com" })],
    ["an internal @matchday member", sub({ price: 66, member_email: "ops@matchday.io" })],
    ["an INCOMPLETE member", sub({ price: 66, status: "INCOMPLETE" })],
    ["an INCOMPLETE_EXPIRED member", sub({ price: 66, status: "INCOMPLETE_EXPIRED" })],
    ["a CANCELED member", sub({ price: 66, status: "CANCELED", canceled_at: "2026-07-15T08:00:00+00:00" })],
    ["a CANCELED member with NO canceled_at (one of the 683)", sub({ price: 66, status: "CANCELED", canceled_at: null })],
    ["a PAST_DUE member", sub({ price: 66, status: "PAST_DUE" })],
  ] as [string, SubscriptionRow][]) {
    is(`  ${label} is refused`, buildMembersByCity([r], DATES).total.totalActive, 0);
  }
  /* THE 683 ARE OUT BECAUSE THE BASE IS "status ACTIVE", not because anything inspects them. That
   * is the whole reason this page is immune to that data problem, so it is asserted directly. */
  const ghosts = Array.from({ length: 5 }, () => sub({ price: 66, status: "CANCELED", canceled_at: null }));
  is("five lost-cancellation rows contribute nothing at all",
     [buildMembersByCity(ghosts, DATES).total.totalActive, buildMembersByCity(ghosts, DATES).total.billingCents], [0, 0]);
}

console.log("\nUNASSIGNED MEMBERS ARE STATED, NOT COUNTED, AND NEVER A ROW");
{
  is("the unmapped member is on the unassigned line", [T.unassigned.members, T.unassigned.cents], [1, 6600]);
  is("  and in NO city row", T.rows.some((r) => r.code === "WAW" || r.city === null), false);
  // THE TOTAL EXCLUDES THEM — the city rows must sum to it exactly, which they cannot if it does not.
  const sum = (f: (r: ByCityRow) => number) => T.rows.reduce((s, r) => s + f(r), 0);
  is("city rows sum to the MatchDay row — active, before, paying, billing, leavers",
     [sum((r) => r.totalActive), sum((r) => r.cancelledBefore), sum((r) => r.paying), sum((r) => r.billingCents), sum((r) => r.cancelledAfter)],
     [T.total.totalActive, T.total.cancelledBefore, T.total.paying, T.total.billingCents, T.total.cancelledAfter]);
  // CONTROL: the unassigned member really would have changed the total had they been folded in.
  is("CONTROL: folding them in would have moved it", T.total.billingCents + T.unassigned.cents !== T.total.billingCents, true);
  // AND THE LINE DISAPPEARS WHEN THERE ARE NONE — no empty "Unassigned —" row, ever.
  const none = buildMembersByCity([sub({ price: 66, member_email: "r@gmail.com" })], DATES);
  is("no unmapped members means zero on the line", [none.unassigned.members, none.unassigned.cents], [0, 0]);
  is("  and still no Unassigned row", none.rows.some((r) => r.city === null), false);
}

console.log("\nTHE ROWS ARE ORDERED BY BILLING, HIGH TO LOW");
{
  const bills = T.rows.map((r) => r.billingCents);
  is("every row bills at least as much as the next", bills.every((b, i) => i === 0 || bills[i - 1] >= b), true);
  // CONTROL: the order is not trivially satisfied by every row being equal.
  is("CONTROL: and the rows do not all bill the same", new Set(bills).size > 1, true);
}

console.log("\nTHE CSV CARRIES THE SAME NUMBERS, ROWS AND DATES AS THE SCREEN");
{
  const csv = membersByCityCsv(T, "Sep 30, 2026 · 11:00 UTC", DATES);
  const lines = csv.split("\n");
  const [note, header, ...rest] = lines;
  const body = rest.filter((l) => !l.startsWith("#"));
  is("one row per city plus a TOTAL row", body.length, T.rows.length + 1);
  is("the last data line is the TOTAL", body[body.length - 1].startsWith("TOTAL,"), true);
  // THE DATES ARE THE SAME OBJECT THE PAGE RENDERS, so the file cannot name a different cutoff.
  is("the note states all three dates", note.includes(DATES.cutoffYmd) && note.includes(DATES.billingYmd) && note.includes(DATES.runRateYmd), true);
  is("the header names the cutoff and the billing date", header.includes(`Cancelled before ${DATES.cutoffYmd}`) && header.includes(`Billing ${DATES.billingYmd}`), true);
  is("  the note names the date the leavers stop paying", note.includes(DATES.runRateYmd), true);
  is("  and the header carries NO run-rate or leaver-dollar column",
     /run rate|\+ \(\$\)/.test(header), false);
  is("CONTROL: that scan fires on a header that has one", /run rate|\+ \(\$\)/.test("x,2026-11-01 run rate"), true);
  for (const c of MIX_TIERS_CENTS) is(`  the mix is expanded: a "Heads $${c / 100}" column exists`, header.includes(`Heads $${c / 100}`), true);
  is("  ...and Other carries its own headcount AND its own dollars", header.includes("Heads other") && header.includes("Other dollars"), true);
  const tot = body[body.length - 1].split(",");
  is("CSV TOTAL matches the table — active, cancelled-before, paying", [tot[2], tot[3], tot[4]], [String(T.total.totalActive), String(T.total.cancelledBefore), String(T.total.paying)]);
  is("CSV TOTAL matches the table — billing and the leaver count",
     [tot[5], tot[6]], [(T.total.billingCents / 100).toFixed(2), String(T.total.cancelledAfter)]);
  is("control: the compared CSV cells are non-zero", [tot[2], tot[4], tot[5]].every((c) => Number(c) > 0), true);
  // THE UNASSIGNED LINE RIDES ALONG, EXCLUDED FROM THE TOTAL EXACTLY AS ON THE PAGE.
  is("the CSV states the unassigned members outside the TOTAL", lines.some((l) => l.startsWith("# Not in totals: 1 unassigned member, $66.")), true);
  is("CONTROL: and omits the line entirely when there are none",
     membersByCityCsv(buildMembersByCity([sub({ price: 66, member_email: "r@gmail.com" })], DATES), "x", DATES).includes("Not in totals"), false);
  is("the footnote names both exclusions", note.includes("Excludes $0 members and internal accounts."), true);
}

console.log("\nTHE PAGE SAYS NOTHING BEYOND THE TABLE, and renders the dates it was given");
{
  const VIEW = readFileSync("src/components/MembersByCityView.tsx", "utf8");
  const noComments = VIEW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
  is("control: the view was read and still renders a table", /<table[ >]/.test(noComments), true);
  /* NO PARAGRAPH AT ALL — the original rule, restored. d658286 relaxed this to "exactly one, and it
   * is the mock's subtitle"; the subtitle is gone and so is the exception. The bar states the cutoff
   * and the billing date, so a sentence announcing that the page is a month-end report repeats what
   * is already on screen. The mock has one; the page deliberately does not. */
  is("no <p> paragraph element is rendered", /<p[ >]/.test(noComments), false);
  is("CONTROL: the prose scan finds a tag when one is present", /<p[ >]/.test("<p>explanatory sentence</p>"), true);
  // AND THE SUBTITLE'S OWN TEXT IS GONE, not merely re-tagged as something other than a <p>.
  is("the mock's subtitle text is absent", /Month-end membership/.test(noComments), false);
  is("CONTROL: that scan fires on the sentence itself",
     /Month-end membership/.test("Month-end membership: who pays on the 1st"), true);
  is("the footer line names both exclusions", /Excludes \$0 members and internal accounts\./.test(noComments), true);

  // THE WINDOW PILL AND THE PICKER ARE GONE, and must not come back: an earlier cutoff cannot be
  // reproduced from a base of today's status, so a control offering one renders a wrong month.
  is("no WINDOW pill", /Window<\/span>|>Window</.test(noComments), false);
  is("no cutoff picker — no input, select or date control anywhere on the page", /<input|<select|type="date"/.test(noComments), false);
  is("CONTROL: that scan fires on an input", /<input|<select|type="date"/.test('<input type="date" />'), true);
  // THE ONLY BUTTON IS THE EXPORT, and the retry on the error branch.
  is("the only controls are Export CSV and Retry", (noComments.match(/<button/g) ?? []).length, 2);

  /* SIX COLUMNS, IN THE MOCK'S ORDER, NAMED NOT COUNTED. A seventh inserted later would shift what
   * every positional assertion reads, so the names and their order are the contract. */
  const cols = [...noComments.matchAll(/<th[^>]*data-col="(\w+)"/g)].map((m) => m[1]);
  is("the header has the mock's six columns in order", cols, ["total", "before", "paying", "billing", "after"]);
  is("  and the body cells carry the same names in the same order",
     [...noComments.matchAll(/<td[^>]*data-col="(\w+)"/g)].map((m) => m[1]), ["total", "before", "paying", "billing", "after"]);
  is("Paying and Billing are the highlighted pair",
     /className="mbc-hl" data-col="paying"/.test(noComments) && /className="mbc-hl" data-col="billing"/.test(noComments), true);
  is("  CONTROL: and nothing else is highlighted",
     (noComments.match(/className="mbc-hl"/g) ?? []).length, 2);
  // THE MOCK'S SUB-LABELS, VERBATIM.
  for (const sub of ["status ACTIVE, over $0", "still active, won", "total minus cancelled before", "sum of each member"])
    is(`  sub-label present: ${sub}`, noComments.includes(sub), true);
  is("  the leaver column's sub-label names both dates",
     /pay \{prettyDateShort\(view\.dates\.billingYmd\)\}, not \{prettyDateShort\(view\.dates\.runRateYmd\)\}/.test(noComments), true);
  // THE MOCK'S ROW TESTIDS.
  is("rows are keyed by lowercased city code", /data-testid=\{`mbc-row-\$\{r\.code\.toLowerCase\(\)\}`\}/.test(noComments), true);
  is("  and the total row is mbc-row-total", /data-testid="mbc-row-total"/.test(noComments), true);
  is("  the unassigned line and the footnote are separate elements",
     /data-testid="mbc-unassigned"/.test(noComments) && /data-testid="mbc-footnote"/.test(noComments), true);

  // THE DATES COME FROM reportDatesFor AND NOT FROM A LITERAL IN THE VIEW.
  is("the view derives its dates", /reportDatesFor\(/.test(noComments), true);
  is("the view hardcodes no date", /"20\d\d-\d\d-\d\d"/.test(noComments), false);
  is("CONTROL: that scan fires on a hardcoded date", /"20\d\d-\d\d-\d\d"/.test('const d = "2026-09-06";'), true);
  // AND THE HEADER IS THE PLAIN SENTENCE THE BRIEF ASKED FOR.
  is("the bar carries a Cutoff and a Bills value, both from view.dates",
     /data-testid="mbc-cutoff">\{prettyDate\(view\.dates\.cutoffYmd\)\}/.test(noComments)
     && /data-testid="mbc-bills">\{prettyDate\(view\.dates\.billingYmd\)\}/.test(noComments), true);
  /* THE BAR CARRIES THE YEAR AND THE COLUMN LABELS DO NOT — the mock's split, pinned as a PAIRING
   * so a refactor of either formatter does not break it and a swap of one for the other does. */
  is("the column labels use the year-less formatter", /prettyDateShort\(view\.dates\.cutoffYmd\)/.test(noComments), true);
  is("  and the bar uses the one with the year", /prettyDate\(view\.dates\.cutoffYmd\)/.test(noComments), true);
  is("  NEGATIVE: no column label carries the full date", /Cancelled before \{prettyDate\(/.test(noComments), false);
  is("  NEGATIVE: the bar does not carry the short one", /data-testid="mbc-cutoff">\{prettyDateShort\(/.test(noComments), false);
}

console.log("\nthe page pages past the 1,000-row cap and asserts the pull is complete");
{
  const VIEW = readFileSync("src/components/MembersByCityView.tsx", "utf8");
  is("it pages with selectAll rather than a bare select", /selectAll</.test(VIEW), true);
  is("...and compares the pull against an exact head count, throwing on a short read", /incomplete pull/.test(VIEW), true);
  is("...and a failed read renders as an ERROR, never as zeros", /mbc-error/.test(VIEW), true);
}

console.log(`\nmembers-by-city: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  FAILED: ${f}`);
if (pass === 0) { console.log("ZERO ASSERTIONS — that is a failure, not a pass"); process.exit(1); }
process.exit(fails.length === 0 ? 0 : 1);
