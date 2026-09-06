import "server-only"; // no-op under --conditions=react-server
/* RECENTLY UPLOADED — the two clocks, and the arithmetic trap in both.
 *
 * `received_at` is a TRUE INSTANT: an email landed. A match's `start_date` is a WALL CLOCK WEARING
 * A Z: 8pm at the pitch. Subtracting one from the other is the mistake that made a Saturday match
 * read as Sunday on the player pane, and here it would silently turn "4 days late" into "3" for
 * every film that arrived in the small hours — which is most of them, because Veo processes
 * overnight. So the lag is computed on CALENDAR DAYS in one named zone, and this suite pins both
 * the zone and the boundary cases either side of midnight.
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/veo-recent-test.ts
 */
import { readFileSync } from "node:fs";
import {
  ARRIVAL_ZONE, RECENT_STATE_LABEL, WAIT_ALARM_DAYS, dayIn, daySourceOf, isResolved, lagDays,
  lagLabel, lagWorthSaying, recentState, waitDays, waitLabel,
} from "../src/lib/veoRecent";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const yes = (n: string, c: boolean, d = "") => (c ? ok(n) : bad(n, d));

console.log("— the zone, and the day an instant falls on —");
is("the arrival zone is named, not implied", ARRIVAL_ZONE, "America/Chicago");
// 2026-09-06T05:09:15Z is Sep 6 in UTC and Sep 6 00:09 in Central — the real Sep 5 arrival.
is("an early-morning UTC arrival keeps its Central day", dayIn("2026-09-06T05:09:15.000Z"), "2026-09-06");
// …and 04:59Z is still the PREVIOUS day in Central. This is the boundary the whole rule exists for.
is("…and one ten minutes earlier falls on the day before", dayIn("2026-09-06T04:59:00.000Z"), "2026-09-05");
is("no timestamp, no day", dayIn(null), null);
is("junk is not a day", dayIn("not a date"), null);

console.log("\n— VEO'S CLOCK: how late the film was —");
/* THE REAL ONE. SCISS | 1 sep | 8pm was played on 2026-09-01 and its email arrived 2026-09-06 —
 * five days, and invisible on a page indexed by Sep 1. */
is("a film five days late is five days late", lagDays("2026-09-06T05:00:00.000Z", "2026-09-01"), 5);
is("…and says so", lagLabel(lagDays("2026-09-06T05:00:00.000Z", "2026-09-01")), "5 days late");
is("the normal case is the same day", lagLabel(lagDays("2026-09-05T23:00:00.000Z", "2026-09-05")), "same day");
is("overnight is the next day", lagLabel(lagDays("2026-09-06T05:09:00.000Z", "2026-09-05")), "next day");
/* NEITHER OF THOSE EARNS ROOM ON THE ROW. Saying "same day" 60 times says nothing 60 times. */
is("same day and next day are quiet", [lagWorthSaying(0), lagWorthSaying(1)], [false, false]);
is("…and two or more is called out", [lagWorthSaying(2), lagWorthSaying(5)], [true, true]);
/* AN ARRIVAL BEFORE THE MATCH DAY NEVER PRINTS A NEGATIVE. */
is("an arrival the day BEFORE its match reads same day, not -1", lagLabel(lagDays("2026-09-04T12:00:00.000Z", "2026-09-05")), "same day");
is("…and the number is floored at zero", lagDays("2026-09-04T12:00:00.000Z", "2026-09-05"), 0);
is("no match day, no lag", lagDays("2026-09-06T05:00:00.000Z", null), null);

/* THE INSTANT TRAP, ASSERTED DIRECTLY. Subtracting instants gives 4.79 days → 4 by truncation for
 * a film that is 5 calendar days late. The calendar-day rule gives 5 either way. */
{
  /* 05:00Z is 00:00 Central — the arrival is on Sep 6 at the pitch, five calendar days after a
   * Sep 1 match. An hour earlier (01:00Z) is 20:00 on Sep 5 in Central and genuinely IS four days;
   * the first version of this fixture used it and the assertion caught me, not the code. */
  const arrived = "2026-09-06T05:00:00.000Z", matchDay = "2026-09-01";
  const naive = Math.floor((Date.parse(arrived) - Date.parse(`${matchDay}T20:00:00.000Z`)) / 86_400_000);
  is("the naive instant subtraction gets it wrong", naive, 4);
  is("…and the calendar-day rule gets it right", lagDays(arrived, matchDay), 5);
}

console.log("\n— OUR CLOCK: how long it has waited for a person —");
const NOW = Date.parse("2026-09-06T18:00:00.000Z");
is("arrived today, waiting since today", waitLabel(waitDays("2026-09-06T14:00:00.000Z", NOW)), "waiting since today");
is("one day reads singular", waitLabel(waitDays("2026-09-05T14:00:00.000Z", NOW)), "waiting 1 day");
is("five days reads plural", waitLabel(waitDays("2026-09-01T14:00:00.000Z", NOW)), "waiting 5 days");
is("it never runs backwards", waitDays("2026-09-09T14:00:00.000Z", NOW), 0);
is("the alarm is three days", WAIT_ALARM_DAYS, 3);

console.log("\n— the five states, and the one that must stay separate —");
is("an automatic post", recentState({ status: "posted", flagged: false, postedByUserId: null }), "posted");
is("a flagged automatic post", recentState({ status: "posted", flagged: true, postedByUserId: null }), "flagged");
/* ASSIGNED BY HAND IS NOT POSTED. Folding them together is what made "posted went 16 to 15"
 * unreadable, and it would make the matcher's hit rate unmeasurable from this section too. */
is("a hand assignment is NOT a post", recentState({ status: "posted", flagged: false, postedByUserId: "u1" }), "assigned");
is("…even when the decision was flagged", recentState({ status: "posted", flagged: true, postedByUserId: "u1" }), "assigned");
is("a queued row", recentState({ status: "queued", flagged: false, postedByUserId: null }), "queued");
is("a dismissed row", recentState({ status: "dismissed", flagged: false, postedByUserId: null }), "dismissed");
is("all five are labelled", Object.keys(RECENT_STATE_LABEL).length, 5);
is("…and Posted and Assigned by hand are different words",
  [RECENT_STATE_LABEL.posted, RECENT_STATE_LABEL.assigned], ["Posted", "Assigned by hand"]);
/* THE WAITING CLOCK IS ONLY MEANINGFUL WHERE SOMEBODY STILL HAS TO ACT. */
is("only a queued row is unresolved",
  (["posted", "flagged", "assigned", "queued", "dismissed"] as const).map(isResolved), [true, true, true, false, true]);

console.log("\n— a guess must not look like a fact —");
is("a matched recording's day came from its match", daySourceOf("2026-09-05", "2026-09-05"), "match");
/* THE ONE THIS EXISTS FOR. A live row reads 365 days late because the matcher resolved its title to
 * the prior year — a real number computed from a wrong date. Marked as coming from the title. */
is("an unmatched one's day came from the title", daySourceOf(null, "2025-07-30"), "title");
is("and a row with neither has no day at all", daySourceOf(null, null), "unknown");

console.log("\n— the contracts —");
const noComments = (x: string) => x.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const ROUTE = noComments(readFileSync("src/app/api/veo/recent/route.ts", "utf8"));
const PAGE = noComments(readFileSync("src/components/VeoDayOps.tsx", "utf8"));

/order\("received_at", \{ ascending: false \}\)/.test(ROUTE)
  ? ok("the route orders by arrival, descending")
  : bad("the route does not order by received_at desc");
/* THE SCOPE. A new route is exactly where confinement gets forgotten. */
/if \(auth\.confinedCity && cityCode !== auth\.confinedCity\) continue;/.test(ROUTE)
  ? ok("every row is scoped to the session's city before it is returned")
  : bad("the recent route does not apply city confinement");
/const cityWanted = url\.searchParams\.get\("city"\)/.test(ROUTE) && ROUTE.indexOf("auth.confinedCity && cityCode") < ROUTE.indexOf("cityWanted && (cityCode == null")
  ? ok("…and the operator's own city filter is applied AFTER it, so it can only narrow")
  : bad("the request's city parameter is not strictly subordinate to the session scope");
/* THE SAME RESOLVER THE MATCHER USES. An exact key lookup left every fuzzily-matched recording
 * unplaced — "SCISS" is not a veo_codes key, it reaches SCI by appearing inside "Scissortail Park"
 * — and for a confined operator unplaced means invisible. */
/const viaCode = cityOfCode\(/.test(ROUTE) && /resolveVeoCodeScored\(parsed, codeMap\)/.test(ROUTE)
  ? ok("an unmatched recording is placed by the venue its code resolves to, fuzzily")
  : bad("an unmatched recording has no scope resolution");

/* DAY-INDEPENDENT. The section must not be re-fetched by the day nav, or the film that arrived late
 * for last Tuesday goes back to being findable only from last Tuesday. */
/}, \[limit, unpostedOnly, city, nonce\]\);/.test(PAGE)
  ? ok("the section refetches on the filter and the city, and NOT on the day")
  : bad("the recent section's fetch depends on the selected day");
/<RecentlyUploaded city=\{city\} \/>/.test(PAGE)
  ? ok("…and it is on the same page, below the day list")
  : bad("the section is not rendered");
/wait = isResolved\(r\.state\) \? null : waitDays/.test(PAGE)
  ? ok("the waiting clock appears only on unresolved rows")
  : bad("the waiting clock shows on rows nobody needs to act on");
/lagWorthSaying\(lag\) && \(/.test(PAGE)
  ? ok("…and the lateness chip only when it is two days or more")
  : bad("the lag prints on every row");
/data-testid="veo-recent-count"/.test(PAGE) && /\{shown\.length\}/.test(PAGE)
  ? ok("the footer count is derived from the rows on screen")
  : bad("the footer count is not derived from the rows");
/href=\{`\/match-ops\/veo\?date=\$\{day\}`\}/.test(PAGE)
  ? ok("a row links back to its own day")
  : bad("no link back to the row's day");
/r\.state === "queued" && \(/.test(PAGE)
  ? ok("only a queued row offers Assign")
  : bad("a resolved row is offered an action");
// NO ETA ANYWHERE. Nothing knows Veo's processing time and a prediction reads as a commitment.
!/\bETA\b|expected by|expected arrival/i.test(PAGE)
  ? ok("no ETA and no predicted arrival anywhere on the page")
  : bad("the page predicts when a film will arrive");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
