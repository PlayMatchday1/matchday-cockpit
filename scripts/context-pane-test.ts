import "server-only"; // no-op under --conditions=react-server
/* THE CONTEXT PANE'S SUMMARIES AND SEARCH REASONS.
 *
 * EVERY SECTION HEADER CARRIES ITS OWN ANSWER, so a shut section still tells you something — and
 * that is only true if the summary is DERIVED from the section's own data. A header written beside
 * the rows rather than from them is a caption, and a caption goes stale the first time the data
 * moves, silently, on a pane whose whole job is answering a billing question correctly.
 *
 * COLOUR IS RATIONED and that is asserted both ways: a player with failed charges must read red,
 * and a player with nothing wrong must have no red anywhere. The second one is the assertion that
 * catches a pane that decorates.
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/context-pane-test.ts
 */
import { readFileSync } from "node:fs";
import {
  SECTION_IDS, accountSummary, creditsSummary, matchReason, matchesSummary, membershipSummary,
  paymentsSummary, readSectionState, sectionStorageKey, strikesSummary, REASON_LABEL,
  type PaymentLike, type Tone,
} from "../src/lib/paneSections";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const yes = (n: string, c: boolean, d = "") => (c ? ok(n) : bad(n, d));

console.log("— the six sections, in the order the brief sets —");
is("credits, match history, membership, payments, strikes, account history",
  [...SECTION_IDS], ["credits", "matches", "membership", "payments", "strikes", "account"]);

console.log("\n— every summary comes from its own section's data —");
is("credits print the balance", creditsSummary(1624).text, "$16.24");
is("…and a missing balance is not a zero dollars", creditsSummary(null).text, "$0.00");
is("match history counts the three states it renders",
  matchesSummary([{ state: "played" }, { state: "played" }, { state: "upcoming" }, { state: "cancelled" }]).text,
  "2 played · 1 upcoming · 1 cancelled");
is("…and says so plainly when there are none", matchesSummary([]).text, "None on record");
is("…and omits a count that is zero rather than printing it",
  matchesSummary([{ state: "played" }, { state: "played" }]).text, "2 played");

console.log("\n— membership, with the timezone split the card already makes —");
is("a plain member says when it renews",
  membershipSummary({ status: "ACTIVE", canceledAt: null, renews: "2026-10-01T04:59:59.000Z" }).text,
  "Member · renews Oct 1");
// canceledAt is a TRUE instant → Central. currentPeriodEnd is a BOUNDARY → the date the API names.
is("a cancelled member says both dates, cancellation in Central",
  membershipSummary({ status: "ACTIVE", canceledAt: "2026-08-09T01:06:52.168Z", renews: "2026-10-01T04:59:59.000Z" },
    Date.parse("2026-09-06T00:00:00Z")).text,
  "Cancelled Aug 8, runs to Oct 1");
is("…and once the period has run out it drops the runs-to", 
  membershipSummary({ status: "ACTIVE", canceledAt: "2026-08-09T01:06:52.168Z", renews: "2026-10-01T04:59:59.000Z" },
    Date.parse("2026-11-01T00:00:00Z")).text, "Cancelled Aug 8");
is("not a member says so", membershipSummary(null).text, "Not a member");
is("a cancellation is AMBER — worth a look, not wrong",
  membershipSummary({ status: "ACTIVE", canceledAt: "2026-08-09T01:06:52.168Z", renews: null }).tone, "amber");
is("past due is red", membershipSummary({ status: "PAST_DUE", canceledAt: null, renews: null }).tone, "red");

console.log("\n— payments, and the rationing of red —");
const P = (status: PaymentLike["status"], isMembership = false): PaymentLike => ({ status, amount: 1450, isMembership });
is("two paid reads as two paid", paymentsSummary([P("succeeded"), P("succeeded")]).text, "2 paid");
is("three failed charges read RED", paymentsSummary([P("failed"), P("failed"), P("failed")]).tone, "red");
is("…and say how many", paymentsSummary([P("failed"), P("failed"), P("failed")]).text, "3 failed");
is("a dispute is red too", paymentsSummary([P("succeeded"), P("disputed")]).tone, "red");
is("a refund is amber, not red", paymentsSummary([P("succeeded"), P("refunded")]).tone, "amber");
is("nothing on file is plain", paymentsSummary([]).tone, "plain");
is("…and says so", paymentsSummary([]).text, "Nothing on file");
is("a Stripe failure is amber and names itself", paymentsSummary(null, "boom").text, "Could not read Stripe");

console.log("\n— strikes and account history —");
is("no strikes is plain", strikesSummary({ activeCount: 0, limit: 4, isSuspended: false }), { text: "0 of 4", tone: "plain" });
is("some strikes is amber", strikesSummary({ activeCount: 2, limit: 4, isSuspended: false }).tone, "amber");
is("at the limit is red", strikesSummary({ activeCount: 4, limit: 4, isSuspended: false }).tone, "red");
is("suspended is red and says so", strikesSummary({ activeCount: 4, limit: 4, isSuspended: true }).text, "Suspended · 4 of 4");
is("a clean record says clean record", accountSummary("ok", []), { text: "Clean record", tone: "plain" });
is("an expelled player is red", accountSummary("expelled", []).tone, "red");

/* THE WHOLE-PANE RULE: a player with nothing wrong has NO red anywhere. Asserted over the actual
 * summary set for a clean casual, because red on a clean pane is the failure that makes red stop
 * meaning anything on the panes where it matters. */
console.log("\n— a clean player has no red anywhere on the pane —");
{
  const clean: Tone[] = [
    creditsSummary(1624).tone,
    matchesSummary([{ state: "played" }, { state: "played" }, { state: "cancelled" }]).tone,
    membershipSummary(null).tone,
    paymentsSummary([P("succeeded"), P("succeeded")]).tone,
    strikesSummary({ activeCount: 0, limit: 4, isSuspended: false }).tone,
    accountSummary("ok", []).tone,
  ];
  is("every section on a clean pane is plain", clean, ["plain", "plain", "plain", "plain", "plain", "plain"]);
  // CONTROL: the same six, for a player with things wrong, DO go red — so the emptiness above is
  // the rationing working and not a palette that never fires.
  const wrong: Tone[] = [
    creditsSummary(0).tone,
    matchesSummary([{ state: "cancelled" }]).tone,
    membershipSummary({ status: "PAST_DUE", canceledAt: null, renews: null }).tone,
    paymentsSummary([P("failed"), P("failed"), P("failed")]).tone,
    strikesSummary({ activeCount: 4, limit: 4, isSuspended: true }).tone,
    accountSummary("expelled", []).tone,
  ];
  yes("control — a player with things wrong turns several of them red", wrong.filter((t) => t === "red").length >= 4, JSON.stringify(wrong));
}

console.log("\n— section state is a preference, keyed on the OPERATOR —");
yes("the key names the operator", sectionStorageKey("op-1") !== sectionStorageKey("op-2"));
yes("…and never the thread", !/thread/i.test(sectionStorageKey("op-1")));
is("everything starts shut", Object.values(readSectionState(null)).filter(Boolean).length, 0);
is("a stored preference is restored", readSectionState(JSON.stringify({ payments: true })).payments, true);
is("…and junk in storage is not a crash", readSectionState("{{{").payments, false);
is("…and an unknown key is ignored", (readSectionState(JSON.stringify({ nope: true })) as Record<string, boolean>).nope, undefined);

console.log("\n— why a search result matched —");
const row = { id: 85796, name: "Jose Villanueva", email: "jose2653987@icloud.com", phone: "+18627633288" };
is("a full phone says full phone", matchReason("+18627633288", row), "phone");
is("…however it is punctuated", matchReason("(862) 763-3288", row), "phone");
is("the last seven digits say so, and are NOT dressed up as a full match", matchReason("7633288", row), "last7");
is("an email says email", matchReason("jose2653987@icloud.com", row), "email");
is("a name says name", matchReason("jose villanueva", row), "name");
is("…in either order", matchReason("villanueva jose", row), "name");
is("a player id says player id", matchReason("85796", row), "id");
is("and something that matched for no visible reason says only that", matchReason("zzz", row), "unclear");
is("every reason has a label", Object.keys(REASON_LABEL).sort(), ["email", "id", "last7", "name", "phone", "unclear"]);

console.log("\n— the contracts the pane and the route keep —");
const noComments = (x: string) => x.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const PANE = readFileSync("src/app/(internal)/match-ops/player-chats/components/ContextPane.tsx", "utf8");
const PANE_C = noComments(PANE);
const CTX = noComments(readFileSync("src/app/api/crm/threads/[id]/context/route.ts", "utf8"));

// ONE REQUEST PER THREAD SWITCH. The pane must not also call /api/lookup for the profile.
!/\/api\/lookup\/\$\{ENV\}\?id=/.test(PANE_C)
  ? ok("the pane does not fetch the profile separately — the context route carries it")
  : bad("the pane calls /api/lookup for the profile: two round trips per thread switch");
(PANE_C.match(/authFetch\(`\/api\/crm\/threads/g) ?? []).length === 1
  ? ok("…and it makes exactly one context call")
  : bad("more than one context call in the pane");

// LOOKING UP IS NOT LINKING. Nothing in the pane may write player_id.
!/player_id/.test(PANE_C) && !/method:\s*"(POST|PATCH|PUT)"[\s\S]{0,200}threads/.test(PANE_C)
  ? ok("the pane never writes crm_threads.player_id — looking up is not linking")
  : bad("the pane appears to link a thread");
// And nothing in the repo can, which is why linking is a separate decision.
{
  const routes = readFileSync("src/app/api/crm/threads/[id]/context/route.ts", "utf8");
  void routes;
  const anyWrites = ["assign", "follow-up", "mark-read", "no-reply", "status", "context"]
    .filter((r) => { try { return /player_id\s*:/.test(readFileSync(`src/app/api/crm/threads/[id]/${r}/route.ts`, "utf8")); } catch { return false; } });
  is("no crm thread route writes player_id", anyWrites, []);
}

// THE ONE WRITE, and the four that stay on the full page.
/\/api\/matchday\/\$\{ENV\}\/players\/\$\{playerId\}\/credits/.test(PANE_C)
  ? ok("the credit adjustment posts to the existing guarded route")
  : bad("the credit write does not use the existing route");
/validateAdjustment\(/.test(PANE_C) && /expectedBeforeCents: balanceCents/.test(PANE_C)
  ? ok("…with the same validation and the same optimistic-concurrency guard")
  : bad("the credit write dropped a guard");
!/\b(Suspend|Expel|Remove from|Add to a match)\b/.test(PANE_C)
  ? ok("Suspend, Expel, Remove and Add appear nowhere in the pane")
  : bad("a severe action leaked into the pane");
// CONTROL for that absence: the words DO appear where they belong.
/Suspend/.test(readFileSync("src/components/PlayerLookup.tsx", "utf8"))
  ? ok("control — those words are findable on the full page, so the absence above is real")
  : bad("control failed: the matcher finds Suspend nowhere at all");

// The pane widened, and the hide/toggle breakpoint is untouched.
/w-\[392px\]/.test(PANE_C) ? ok("the pane is 392px") : bad("the pane is not 392px");
/min-\[1260px\]:flex/.test(PANE_C) ? ok("…and still hides below min-[1260px] with the toggle") : bad("the breakpoint moved");

// The route carries the boundary the page enforces.
/auth\.confinedCity/.test(CTX) && /CONFINED_CITY_ERROR/.test(CTX)
  ? ok("the context route repeats the city refusal /api/lookup makes on ?id=")
  : bad("a confined account could read an out-of-city player through the chat pane");
/buildProfile\(/.test(CTX) ? ok("…and uses the SAME profile mapping as Player Lookup") : bad("the pane's profile is a second mapping");
/buildProfile\(/.test(noComments(readFileSync("src/app/api/lookup/[env]/route.ts", "utf8")))
  ? ok("…which is the one Player Lookup uses too, so they cannot drift")
  : bad("Player Lookup no longer uses the shared mapping");

/* THE WALL-CLOCK TRAP, IN THE ONE PLACE THIS PANE COULD FALL INTO IT. MatchDay's startDate carries
 * a Z it does not mean; startDateUtc is the genuine instant. Printed as a DATE in UTC, only the
 * first gives the day the match was played. Preferring startDateUtc put Jose's cancelled Parmer
 * match — 2026-09-05T20:00 local, 2026-09-06T01:00Z — on Sunday Sep 6, and shifted every other
 * date in the pane by a day with it. */
/dayOf\(m\.startDate \?\? m\.startDateUtc\)/.test(PANE_C)
  ? ok("match dates print the WALL CLOCK, not the true-UTC field")
  : bad("the pane prints match dates from startDateUtc — every date is a day out");
/timeZone: "UTC"/.test(PANE_C)
  ? ok("…formatted in UTC, so the characters come back out as they went in")
  : bad("a wall-clock value is being formatted in a local zone");
// The merge that puts a club-cancelled match back on the pane.
/match_history/.test(CTX) && /apiIds\.has\(m\.match_api_id\)/.test(CTX)
  ? ok("the route merges the mirror's cancelled bookings into the API's match list")
  : bad("the cancelled-match bookings the API omits are not merged back in");
/findIndex\(\(x\) => x\.match_api_id === m\.match_api_id\)/.test(CTX)
  ? ok("…de-duplicated on match id, since the mirror holds one row per registration")
  : bad("the merge can list the same match twice");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
