import "server-only"; // no-op under --conditions=react-server
// THE MEMBERS PAGE — its rules, tested where they live (src/lib/membersPageModel.ts).
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/members-page-test.ts
//
// A money-and-membership screen: it ends memberships, re-prices them and sets city prices. Every
// assertion below is on a COMPUTED value; the three source checks at the end exist only where an
// HTTP boundary makes the behaviour unobservable here, and each asserts the negative as well.

import { readFileSync } from "node:fs";
import {
  searchMembers, searchSummary, tabCounts, inTab, tabRows, pageOf, nextCell, statusChip, isCustomPrice,
  listPriceLabel, nextFirstLabel, membersCsv, planPriceRefusal, strikeFineRefusal, strikeFineTaxLine,
  membersStrikeControl, gateStrikeRemove, commentRefusal, twoFacts, factsFromVerdict, endConfirmCopy,
  STRIKE_BACKEND_FIX_LIVE, STRIKE_REMOVE_OFF_REASON, type MemberRow, type RowStripe,
} from "../src/lib/membersPageModel";
import { priceRefusal, endRefusal, centsFromDollars } from "../src/lib/membershipAdminModel";
import { strikeControl } from "../src/lib/playerLookupModel";
import { planSubEnds, endRowFrom, isEndCandidate } from "../src/lib/stripeSubEnds";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const yes = (n: string, c: boolean, d = "") => (c ? ok(n) : bad(n, d));

// 2026-11-13 18:00 Chicago (CST, UTC-6).
const NOW = Date.parse("2026-11-14T00:00:00Z");
const M = (o: Partial<MemberRow>): MemberRow => ({
  membershipId: 1, userId: 1, city: "ATX", slug: "ATX1", firstName: "Kofi", lastName: "Mensah", email: "kofi.m@example.com",
  phone: "+15125550142", status: "ACTIVE", priceDollars: 66, activationDate: "2024-03-01T15:00:00Z", canceledAt: null,
  cancelReason: null, comment: null, suspendedTo: null, strikePoints: 0, absentOwed: 0, ...o,
});

const ROWS: MemberRow[] = [
  M({ membershipId: 1, userId: 1 }),
  M({ membershipId: 2, userId: 2, firstName: "David", lastName: "Garcia", email: "dgarcia@example.com", priceDollars: 59, phone: "+19565550119" }),
  M({ membershipId: 3, userId: 3, city: "HOU", slug: "HOU3", firstName: "Maria", lastName: "Garcia", email: "maria.g@example.com", phone: "+17135550100" }),
  M({ membershipId: 4, userId: 4, city: "HOU", slug: "HOU4", firstName: "Luis", lastName: "Garcia", email: "luis.garcia@example.com", status: "CANCELED", canceledAt: "2026-08-31T20:00:00Z" }),
  M({ membershipId: 5, userId: 5, firstName: "Hudson", lastName: "Reyes", email: "hudson.r@example.com", canceledAt: "2026-10-31T21:00:00Z", strikePoints: 1, absentOwed: 12 }),
  M({ membershipId: 6, userId: 6, firstName: "Blake", lastName: "Turner", status: "PAST_DUE", email: "blake.t@example.com" }),
  M({ membershipId: 7, userId: 7, firstName: "Bryan", lastName: "Ortiz", suspendedTo: "2026-11-20T00:00:00Z", strikePoints: 4, email: "bryan.o@example.com" }),
  M({ membershipId: 8, userId: 8, firstName: "Comp", lastName: "Player", status: "ADDED_FROM_ADMIN", email: "comp@example.com" }),
  // A rejoin: user 9 holds a CANCELED row and a newer ACTIVE one.
  M({ membershipId: 9, userId: 9, city: "DFW", firstName: "Ana", lastName: "Lopez", email: "ana@example.com", status: "CANCELED", activationDate: "2024-01-01T00:00:00Z", canceledAt: "2024-06-01T00:00:00Z" }),
  M({ membershipId: 10, userId: 9, city: "DFW", firstName: "Ana", lastName: "Lopez", email: "ana@example.com", activationDate: "2025-02-01T00:00:00Z" }),
];

console.log("\n— search covers every city and every status, whatever the picker says (frame 6) —");
const g = searchMembers(ROWS, "garcia");
is("'garcia' finds the three Garcias", g.map((r) => r.membershipId).sort(), [2, 3, 4]);
is("  and they span two cities", [...new Set(g.map((r) => r.city))].sort(), ["ATX", "HOU"]);
yes("  and a PAST member is among them", g.some((r) => r.status === "CANCELED"));
is("the summary line names counts and the picked city", searchSummary(g, "Austin"), "3 members in 2 cities · Austin selected");
is("CONTROL: a city other than the picker's is reachable on its own", searchMembers(ROWS, "maria").map((r) => r.city), ["HOU"]);
is("two words must both match (first and last name)", searchMembers(ROWS, "luis garcia").map((r) => r.membershipId), [4]);
is("a phone fragment matches the digits whatever the formatting", searchMembers(ROWS, "(956) 555").map((r) => r.membershipId), [2]);
is("email matches", searchMembers(ROWS, "hudson.r@").map((r) => r.membershipId), [5]);
is("a rejoined player appears once, as the live membership", searchMembers(ROWS, "lopez").map((r) => r.membershipId), [10]);
is("no match is an empty list…", searchMembers(ROWS, "zzzzqq"), []);
yes("  …CONTROL: the same function on a real name in the same rows is not empty", searchMembers(ROWS, "kofi").length === 1);
is("one character is not a search", searchMembers(ROWS, "g"), []);
is("a comped member is findable (nothing hides ADDED_FROM_ADMIN)", searchMembers(ROWS, "comp player").map((r) => r.status), ["ADDED_FROM_ADMIN"]);

console.log("\n— tabs: Cancelling, Past due and Suspended are views inside Current —");
const atx = ROWS.filter((r) => r.city === "ATX");
is("counts for Austin (rows 1, 2, 5, 6, 7, 8)", tabCounts(atx, NOW), { current: 6, cancelling: 1, pastdue: 1, suspended: 1, past: 0 });
yes("a cancelling member is also Current (frame 1 lists Hudson there)", inTab(ROWS[4], "current", NOW) && inTab(ROWS[4], "cancelling", NOW));
yes("CONTROL: a member without a cancel date is not Cancelling", !inTab(ROWS[0], "cancelling", NOW));
yes("a suspension in the past is not Suspended", !inTab(M({ suspendedTo: "2026-11-01T00:00:00Z" }), "suspended", NOW));
yes("a comped member is Current", inTab(ROWS[7], "current", NOW));
yes("Past is CANCELED only", inTab(ROWS[3], "past", NOW) && !inTab(ROWS[3], "current", NOW));
is("a tab is one city", tabRows(ROWS, "HOU", "current", NOW).map((r) => r.membershipId), [3]);
const pg = pageOf(Array.from({ length: 51 }, (_, i) => i), 3);
is("paging: page 3 of 51 rows is the last row", [pg.rows, pg.page, pg.pages, pg.total], [[50], 3, 3, 51]);
is("paging: a page past the end is clamped", pageOf([1, 2], 9).page, 1);

console.log("\n— the Next column comes from evidence only —");
is("the billing rule: the 1st of next month in Chicago", nextFirstLabel(NOW), "Dec 1");
is("  across a year end", nextFirstLabel(Date.parse("2026-12-15T18:00:00Z")), "Jan 1, 2027");
is("  CONTROL: 23:30 on Nov 30 in Chicago is still November", nextFirstLabel(Date.parse("2026-12-01T05:30:00Z")), "Dec 1");
is("an active member: Dec 1 at the plan price", nextCell(ROWS[0], undefined, NOW, 6650), { main: "Dec 1", sub: "$66.50", tone: "plain" });
is("a custom price shows whole dollars", nextCell(ROWS[1], undefined, NOW, 6650).sub, "$59");
yes("…and is marked Custom price", isCustomPrice(ROWS[1], 6650) && statusChip(ROWS[1], NOW, 6650)?.label === "Custom price");
yes("CONTROL: a plan-priced member is not", !isCustomPrice(ROWS[0], 6650) && statusChip(ROWS[0], NOW, 6650) === null);
is("with no plan read, the list does not guess cents", listPriceLabel(ROWS[0], null), "$66");
const sched: RowStripe = { cancelAtPeriodEnd: true, currentPeriodEnd: "2026-12-01T05:59:59Z", endReadAt: "2026-11-13T09:15:00Z" };
is("cancelling with Stripe scheduled: Ends Nov 30 (the last second of November, Chicago)", nextCell(ROWS[4], sched, NOW, 6650).main, "Ends Nov 30");
is("cancel_at wins when set", nextCell(ROWS[4], { cancelAt: "2026-12-15T12:00:00Z" }, NOW, 6650).main, "Ends Dec 15");
is("cancelling, read but not scheduled: says so, no date", nextCell(ROWS[4], { cancelAtPeriodEnd: false, endReadAt: "2026-11-13T09:15:00Z" }, NOW, 6650),
  { main: "Cancelling", sub: "Stripe not scheduled yet", tone: "warn" });
is("cancelling, never read: says so, no date", nextCell(ROWS[4], undefined, NOW, 6650).sub, "end not read from Stripe yet");
is("past due: the failed charge from Stripe", nextCell(ROWS[5], { failedAt: "2026-11-01T11:00:00Z", failedAmountCents: 7199 }, NOW, 6650),
  { main: "Failed Nov 1", sub: "$71.99", tone: "bad" });
is("past: Stripe's end date beats MatchDay's", nextCell(ROWS[3], { endedAt: "2026-09-01T04:59:59Z" }, NOW, 6650).main, "Ended Aug 31");
is("past, another year: the year is shown", nextCell(ROWS[8], undefined, NOW, 6650).main, "Ended May 31, 2024");
is("a comp has not joined", nextCell(ROWS[7], undefined, NOW, 6650).main, "Not joined");

console.log("\n— no write without a reason —");
const live = { id: 5, statusRaw: "ACTIVE", stripeSubscriptionId: "sub_x", canceledAt: null, price: 6650 };
yes("End refuses an empty reason", endRefusal(live, "") !== null);
yes("End refuses whitespace", endRefusal(live, "   ") !== null);
is("CONTROL: End accepts a real reason", endRefusal(live, "Moving"), null);
yes("a comment cannot be cleared", commentRefusal("", "Asked to cancel") !== null);
yes("…or blanked with spaces", commentRefusal("   ", "Asked to cancel") !== null);
yes("an unchanged comment is not sent", commentRefusal("Asked to cancel", "Asked to cancel ") !== null);
is("CONTROL: a new comment is allowed", commentRefusal("Moved to Dallas", "Asked to cancel"), null);
is("CONTROL: a first comment on an empty one is allowed", commentRefusal("First note", null), null);

console.log("\n— strike Remove is built and switched off —");
const removable = strikeControl({ id: 38035, penaltyPoint: 1, active: true }, "2026-12-30T00:00:00Z", NOW);
yes("PRECONDITION: Player Lookup's own rule would allow this strike", removable.enabled);
const gated = membersStrikeControl(removable);
yes("the switch is off in this build", STRIKE_BACKEND_FIX_LIVE === false);
yes("so Remove is disabled on the Members page", gated.enabled === false);
is("  and says why", gated.why, STRIKE_REMOVE_OFF_REASON);
yes("an expired strike stays disabled for its own reason", membersStrikeControl(strikeControl({ id: 1, penaltyPoint: 1, active: true }, "2026-11-01T00:00:00Z", NOW)).enabled === false);
const pl = gateStrikeRemove(removable);
is("Player Lookup: the same switch disables Remove and keeps its own label", [pl.enabled, pl.label, pl.why], [false, "Remove 1", STRIKE_REMOVE_OFF_REASON]);
is("CONTROL: the gate changes nothing but enabled and why", { ...pl, enabled: removable.enabled, why: removable.why }, removable);
is("the same switch keeps the fine's tax line honest", strikeFineTaxLine(8.25), "plus 8.25% tax · clears strikes and suspension");

console.log("\n— price edits refuse invalid input —");
is("dollars to cents", centsFromDollars("66.50"), 6650);
is("three decimals is not a price", centsFromDollars("66.505"), null);
is("letters are not a price", centsFromDollars("abc"), null);
yes("member price: fractional cents refused", priceRefusal(live, 6650.5) !== null);
yes("member price: negative refused", priceRefusal(live, -100) !== null);
yes("member price: the same price refused", priceRefusal(live, 6650) !== null);
yes("member price: a closed membership refused", priceRefusal({ ...live, statusRaw: "CANCELED" }, 5900) !== null);
is("CONTROL: member price: a real change allowed", priceRefusal(live, 5900), null);
yes("city price: below the floor refused", planPriceRefusal(400, 6650) !== null);
yes("city price: above the ceiling refused (the $4,900 typo)", planPriceRefusal(490000, 6650) !== null);
yes("city price: unchanged refused", planPriceRefusal(6650, 6650) !== null);
yes("city price: no number refused", planPriceRefusal(null, 6650) !== null);
is("CONTROL: city price: $69.00 allowed", planPriceRefusal(6900, 6650), null);
is("strike fine: $20 is 2000 cents", strikeFineRefusal("20", 1500), { cents: 2000, why: null });
is("strike fine: a leading $ is fine", strikeFineRefusal("$25", 2000).cents, 2500);
for (const v of ["20.50", "0", "101", "-5", "abc", "", "1e2"]) yes(`strike fine: "${v}" refused`, strikeFineRefusal(v, 2000).why !== null);
yes("strike fine: unchanged refused", strikeFineRefusal("20", 2000).why !== null);
is("CONTROL: strike fine: the bounds themselves are allowed", [strikeFineRefusal("1", 2000).why, strikeFineRefusal("100", 2000).why], [null, null]);

console.log("\n— two facts after end and change price (frame 5) —");
const endOk = factsFromVerdict("end", { status: "LANDED", verdict: { row: "moved", stripe: "moved", subscriptionId: "sub_1PxQ7Hd" } }, { reason: "Moving" });
is("end, both moved: two ✓ facts", endOk.facts.map((f) => [f.who, f.state]), [["MatchDay", "ok"], ["Stripe", "ok"]]);
is("  titled as done", endOk.title, "Membership ended");
yes("  MatchDay says CANCELED and the reason was saved", /CANCELED · reason saved/.test(endOk.facts[0].text));
const endSwallowed = factsFromVerdict("end", { status: "LANDED", verdict: { row: "moved", stripe: "unchanged", subscriptionId: "sub_live" } });
is("end, Stripe swallowed: MatchDay ✓ and Stripe ✕", endSwallowed.facts.map((f) => f.state), ["ok", "bad"]);
yes("  the Stripe fact names the subscription to fix by hand", endSwallowed.facts[1].text.includes("sub_live") && /STILL LIVE/.test(endSwallowed.facts[1].text));
yes("  and the whole result is not good", endSwallowed.allGood === false);
is("end, row did not move: MatchDay ✕", factsFromVerdict("end", { status: "NOT APPLIED", verdict: { row: "unchanged", stripe: "unchanged", subscriptionId: "sub_x" } }).facts[0].state, "bad");
is("end on a comp: Stripe is absent, not a failure", factsFromVerdict("end", { status: "LANDED", verdict: { row: "moved", stripe: "absent", subscriptionId: null } }).allGood, true);
is("end, Stripe unreadable: unknown, not ✓", factsFromVerdict("end", { status: "LANDED", verdict: { row: "moved", stripe: "unreadable", subscriptionId: "sub_x" } }).facts[1].state, "unknown");
is("end, no verdict at all: MatchDay unknown", factsFromVerdict("end", { status: "UNKNOWN" }).facts[0].state, "unknown");
const priceOk = factsFromVerdict("price", { status: "LANDED", verdict: { row: "moved", stripe: "moved", subscriptionId: "sub_p" } }, { cents: 5900 });
is("price, both moved: two ✓", priceOk.facts.map((f) => f.state), ["ok", "ok"]);
yes("  MatchDay names the new amount", priceOk.facts[0].text.includes("$59.00"));
const priceSwallowed = factsFromVerdict("price", { status: "LANDED", verdict: { row: "moved", stripe: "unchanged", subscriptionId: "sub_p" } }, { cents: 5900 });
yes("price, Stripe still old: ✕ with the id", priceSwallowed.facts[1].state === "bad" && priceSwallowed.facts[1].text.includes("sub_p"));
is("a strike fine has one fact, MatchDay's", twoFacts("fine", "moved", "absent", null, { cents: 2500 }).facts.map((f) => f.who), ["MatchDay"]);
is("the city plan has two", twoFacts("plan", "moved", "moved", "price_new", { cents: 6900 }).facts.map((f) => f.who), ["MatchDay", "Stripe"]);
yes("end confirm says immediate and no refund", /immediately/.test(endConfirmCopy("Hudson Reyes", false, null)) && /No refund/.test(endConfirmCopy("Hudson Reyes", false, null)));
yes("  and names the player's own end date when they already cancelled", endConfirmCopy("Hudson Reyes", true, "2026-12-01T05:59:59Z").includes("ends Nov 30"));

console.log("\n— CSV is the filter, every page, and cannot run a formula —");
const csv = membersCsv([M({ firstName: "=HYPERLINK(1)", comment: 'said "hi", left' })], new Map(), NOW, 6650);
const lines = csv.trim().split("\r\n");
is("a header and one row", lines.length, 2);
yes("a cell starting with = is neutralised", lines[1].includes("'=HYPERLINK(1)"));
yes("quotes and commas are escaped", lines[1].includes('"said ""hi"", left"'));

console.log("\n— the nightly job also reads cancelling members (0272) —");
yes("ACTIVE with a cancel date is a candidate", isEndCandidate({ status: "ACTIVE", canceled_at: "2026-10-31T21:00:00Z" }));
yes("CONTROL: ACTIVE without one is not", !isEndCandidate({ status: "ACTIVE", canceled_at: null }));
yes("CONTROL: CANCELED still is", isEndCandidate({ status: "CANCELED" }));
const plan = planSubEnds(
  [{ membership_id: 5, user_id: 5, status: "ACTIVE", canceled_at: "2026-10-31T21:00:00Z" }, { membership_id: 1, user_id: 1, status: "ACTIVE", canceled_at: null }],
  [{ md_membership_id: 5, subscription_id: "sub_5", created_at_utc: "2026-11-01T11:00:00Z" }, { md_membership_id: 1, subscription_id: "sub_1", created_at_utc: "2026-11-01T11:00:00Z" }],
  [], new Date(NOW));
is("the plan asks Stripe about the cancelling member only", plan.map((c) => c.membership_id), [5]);
const row = endRowFrom(plan[0], {
  id: "sub_5", status: "active", cancel_at: null, cancel_at_period_end: true, canceled_at: null, ended_at: null,
  start_date: 1709301600, trial_end: null, metadata: { userSubscriptionId: "5" },
  items: { data: [{ current_period_end: 1764568799 }] },
} as never, null, new Date(NOW));
is("the row stores Stripe's schedule", [row.stripe_cancel_at_period_end, row.stripe_current_period_end, row.stripe_cancel_at], [true, "2025-12-01T05:59:59.000Z", null]);

console.log("\n— source checks, only where an HTTP boundary hides the behaviour —");
/* WHY THESE ARE SOURCE ASSERTIONS. Whether the search text reaches MatchDay is a property of what the
 * route sends over HTTP, which no pure function here can show. Each pairs a positive with a negative. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
const data = strip(readFileSync("src/lib/membersPageData.ts", "utf8"));
const route = strip(readFileSync("src/app/api/membership/members/route.ts", "utf8"));
const view = strip(readFileSync("src/components/MembersView.tsx", "utf8"));
// The parameter object of every list-endpoint call in the data layer, however it is wrapped.
const listCalls = [...data.matchAll(/apiGet<[\s\S]*?>\(env, "\/admin\/subscriptions", \{([\s\S]*?)\}\)/g)].map((m) => m[1]);
yes("POSITIVE: the staging walk calls the list endpoint, with sortColumn membershipId", listCalls.length === 1 && /sortColumn: "membershipId"/.test(listCalls[0]));
yes("NEGATIVE: no list-endpoint call carries email or q", listCalls.length > 0 && listCalls.every((c) => !/\b(email|q)\b/.test(c)));
yes("NEGATIVE: the members route makes no MatchDay call of its own", !/\bapiGet\(|\bapiWrite\(/.test(route));
yes("POSITIVE: the route searches in memory", /searchMembers\(pool, q\)/.test(route));
yes("POSITIVE: the Remove button's state comes from membersStrikeControl", /membersStrikeControl\(strikeControl\(/.test(view) && /data-testid="strike-remove" disabled=\{!ctl\.enabled\}/.test(view));
yes("NEGATIVE: no strike DELETE is wired on the Members page", !/\/strikes\/\$\{/.test(view));

const lookup = strip(readFileSync("src/components/PlayerLookup.tsx", "utf8"));
const strikeRoute = strip(readFileSync("src/app/api/matchday/[env]/strikes/[strikeLogId]/route.ts", "utf8"));
yes("POSITIVE: Player Lookup's Remove state goes through the switch", /gateStrikeRemove\(strikeControl\(/.test(lookup));
yes("NEGATIVE: Player Lookup has no ungated strikeControl call", !/(?<!gateStrikeRemove\()strikeControl\(\{/.test(lookup));
const gateAt = strikeRoute.indexOf("if (!STRIKE_BACKEND_FIX_LIVE)"), firstCall = strikeRoute.search(/\bapi(Get|Write)\(/);
yes("POSITIVE: the strikes route refuses while the switch is off", gateAt > 0);
yes("NEGATIVE: and no MatchDay call comes before that refusal", firstCall > gateAt, `gate ${gateAt}, first call ${firstCall}`);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0 || pass === 0) process.exit(1);
