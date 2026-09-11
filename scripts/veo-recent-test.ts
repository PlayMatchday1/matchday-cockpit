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
  lagLabel, lagWorthSaying, recentState, tabOf, waitDays, waitLabel, type RecentState,
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
/}, \[limit, tab, city, nonce\]\);/.test(PAGE)
  ? ok("the section refetches on the tab and the city, and NOT on the day")
  : bad("the recent section's fetch depends on the selected day");
/<RecentlyUploaded city=\{city\}/.test(PAGE)
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
/* THE ROW NO LONGER LINKS AWAY. View day was removed — the week strip reaches any day in one
 * chip without leaving the queue you are working. Inverted, not deleted. */
!/href=\{`\/match-ops\/veo\?date=\$\{day\}`\}/.test(PAGE)
  ? ok("a row no longer links away to its own day")
  : bad("the View day link is back");
/r\.state === "queued" && \(/.test(PAGE)
  ? ok("only a queued row offers Assign")
  : bad("a resolved row is offered an action");
// NO ETA ANYWHERE. Nothing knows Veo's processing time and a prediction reads as a commitment.
!/\bETA\b|expected by|expected arrival/i.test(PAGE)
  ? ok("no ETA and no predicted arrival anywhere on the page")
  : bad("the page predicts when a film will arrive");

console.log("\n— two tabs, and the counts are the point —");
{
  /* THE GROUPING, AND IT IS TOTAL AND EXCLUSIVE. Every state lands in exactly one tab; nothing is
   * unclassified and nothing is in both. A sixth state added later fails to compile before it can
   * quietly go missing from the page. */
  const STATES: RecentState[] = ["posted", "flagged", "assigned", "queued", "dismissed"];
  is("Needs you holds queued and flagged, and only those",
    STATES.filter((x) => tabOf(x) === "needs"), ["flagged", "queued"].sort() as RecentState[]);
  is("Done holds the other three, and all three",
    STATES.filter((x) => tabOf(x) === "done"), ["posted", "assigned", "dismissed"]);
  is("every state is in exactly one tab", STATES.length,
    STATES.filter((x) => tabOf(x) === "needs").length + STATES.filter((x) => tabOf(x) === "done").length);
  /* FLAGGED IS IN NEEDS YOU ONLY BECAUSE THERE IS NOW A BUTTON. A tab of flagged rows with no way
   * to clear the flag is a list that can only grow — so this pair of assertions belongs together. */
  is("flagged is work, not done", tabOf("flagged"), "needs");
  yes("…and the row carries a Confirm", /data-testid="veo-recent-confirm"/.test(PAGE));
  yes("…and the day view's Confirm is no longer disabled",
    /data-testid="veo-clear-flag" disabled=\{busy\}/.test(PAGE));

  /* THE COUNTS ARE COMPUTED AFTER THE SAME SCOPING THE ROWS GO THROUGH. A second COUNT query would
   * have to re-implement the match-and-code city resolution, and the first time the two drifted a
   * confined operator would see a number that does not match their own list. */
  yes("the counts come off the scoped array, not a second query",
    /const scoped: RecentRow\[\] = \[\]/.test(ROUTE)
    && /for \(const r of scoped\) counts\[tabOf\(r\.state\)\]\+\+/.test(ROUTE));
  yes("…and the session scope still runs BEFORE any of it",
    ROUTE.indexOf("auth.confinedCity && cityCode !== auth.confinedCity") < ROUTE.indexOf("for (const r of scoped)"));
  yes("…and the tab is applied after the counts, so it cannot change them",
    ROUTE.indexOf("for (const r of scoped) counts") < ROUTE.indexOf("scoped.filter((r) => tabOf(r.state) === tab)"));
  yes("the page never counts the tabs itself from its own page of rows",
    /setCounts\(\(j\.counts/.test(PAGE) && !/counts\[tabOf/.test(PAGE));
  yes("a truncated scan says so rather than printing a window as a total", /truncated: raw\.length >= SCAN_CAP/.test(ROUTE));

  /* NEEDS YOU IS THE DEFAULT, in the route and on the page. */
  yes("the route defaults to Needs you", /=== "done" \? "done" : "needs"/.test(ROUTE));
  yes("…and so does the page, with a URL parameter so a Done link survives a refresh",
    /get\("veo"\) === "done" \? "done" : "needs"/.test(PAGE) && /searchParams\.set\("veo", "done"\)/.test(PAGE));

  /* THE ZERO STATE SAYS NOTHING. The count on the tab is the whole message. */
  yes("the empty list renders no sentence",
    /data-testid="veo-recent-empty" \/>/.test(PAGE));
  yes("…and the count badge is not styled as an alarm",
    /\.tcount\{[^}]*color:var\(--ink3\)/.test(PAGE) && !/\.tcount\{[^}]*var\(--look\)/.test(PAGE));

  /* VIEW DAY IS GONE. Ryan: "we can completely remove the view day which is crap" — it full-page
   * navigated away from the queue you were working, and the week strip now reaches any day in one
   * chip without leaving the page. The assertion is INVERTED rather than deleted, so re-adding the
   * link fails here.
   *
   * NOT THE SAME TESTID AS THE DAY PICKER. veo-recent-day-<date> are the buttons inside an open
   * Assign panel that choose which day's candidates to show, and those stay — hence the boundary
   * on the regex, which would otherwise match them and pass for the wrong reason. */
  is("the View day link is gone", PAGE.match(/data-testid="veo-recent-day"[^-]/g), null);
  is("…and so is its href", PAGE.match(/href=\{`\/match-ops\/veo\?date=\$\{day\}`\}/g), null);
  /* CONTROL: the day PICKER survives, so the assertion above removed one thing and not both. */
  yes("…while the day picker inside Assign survives", /data-testid=\{`veo-recent-day-\$\{d\}`\}/.test(PAGE));

  /* A DONE ROW IS QUIETER, AND ITS LATENESS IS GREY — scoped, so a Needs you row is untouched. */
  yes("a Done row is marked as one", /tabOf\(r\.state\) === "done" \? " done" : ""/.test(PAGE));
  yes("…its title is lighter", /\.rrow\.done \.rwhat b\{font-weight:600;color:var\(--ink2\)\}/.test(PAGE));
  yes("…and its lateness is grey", /\.rrow\.done \.rwhen em\{color:var\(--ink3\)\}/.test(PAGE));
  yes("CONTROL: the unscoped lateness rule is still amber for a Needs you row",
    /\.veo \.rwhen em\{[^}]*color:var\(--flag\)\}/.test(PAGE));
  yes("no action button wraps", /\.ractions \.btn\{[^}]*white-space:nowrap/.test(PAGE));
  /* THE ROW GREW A POSTER COLUMN. 88px leads the track list now; the rest is unchanged, and the
   * actions track still sizes to its content — which is what this assertion is actually about. */
  yes("…and the actions track sizes to its content, after the 88px poster",
    /grid-template-columns:88px 150px minmax\(0,1fr\) 118px 128px auto/.test(PAGE));
  /* THE POSTER BOX IS THE SAME HEIGHT WITH OR WITHOUT A PICTURE — it is 16:9 by aspect-ratio on a
   * fixed width, not sized by the image. A ragged column is worse than no posters. */
  yes("the poster is 88px and takes its height from aspect-ratio",
    /\.veo \.qpo\{width:88px/.test(PAGE) && /\.veo \.thumb\{[^}]*aspect-ratio:16\/9/.test(PAGE));
  /* INVERTED 2026-09-11, ON PURPOSE. This was "no play glyph on a collapsed row's poster" — the
   * poster was a picture that silently opened Assign, and Ryan pressed it and concluded the queue
   * could not play anything. It now plays the film in the row, so the triangle is honest and the
   * rule that hid it is gone. Inverted rather than deleted, so hiding it again fails here. */
  yes("the queue poster's triangle is no longer hidden", !/\.veo \.qpo \.play\{display:none\}/.test(PAGE));
  yes("…the poster that has a film is a <button> carrying the triangle",
    /<button type="button" className="qpo thumb live" data-testid="veo-recent-poster"/.test(PAGE) && /data-testid="veo-recent-play"/.test(PAGE));
  yes("CONTROL: the film stage still has its play button", /data-testid="veo-play"/.test(PAGE));
  /* FULLSCREEN IS ONE ATTRIBUTE AWAY FROM BEING LOST by someone tidying up. The row's film keeps
   * `controls` and carries neither attribute that removes the fullscreen or picture-in-picture
   * button. Read off the element's own tag, so an attribute elsewhere on the page cannot pass it. */
  {
    const tag = PAGE.match(/<video data-testid="veo-recent-film"[^>]*>/)?.[0] ?? "";
    yes("the row's film is on the page", tag.length > 0);
    yes("…with the browser's controls", /\scontrols\s/.test(tag), tag);
    yes("…nothing suppresses fullscreen or picture-in-picture", !/nofullscreen|disablePictureInPicture|controlsList/.test(tag), tag);
    yes("…and it preloads nothing", /preload="none"/.test(tag), tag);
  }
}

console.log("\n— Confirm clears one flag and CANNOT post —");
{
  /* COMMENTS STRIPPED. The route's own header explains that it cannot post and names the poster
   * while doing so; what must not exist is a reachable call in CODE. Explaining an absence is the
   * opposite of shipping it. */
  const FLAG = noComments(readFileSync("src/app/api/veo/[id]/flag/route.ts", "utf8"));
  /* STRUCTURAL, NOT CAREFUL. The proof is what the file cannot reach, not what it happens to do. */
  is("the route cannot post: it does not import the poster", FLAG.match(/postVeoLinkToMatch/g), null);
  is("…nor anything that reaches a chat", FLAG.match(/veoPost|firestore|chat/gi), null);
  /* ONE UPDATE, TWO COLUMNS. Every other column on the row is named here and must NOT appear in it. */
  const upd = /\.update\(\{([\s\S]*?)\}\)/.exec(FLAG)?.[1] ?? "";
  yes("the only write sets flagged and updated_at", /flagged: false/.test(upd) && /updated_at/.test(upd));
  is("…and touches nothing else",
    upd.match(/video_url|matched_api_id|status:|posted_by_user_id|posted_at|parsed_match_date|queue_reason|candidate_api_ids/g), null);
  /* THE BODY IS EXACTLY THE FLAG CLEAR — not "contains" it, so a second field cannot ride along. */
  yes("a body that is not exactly { flagged: false } is refused",
    /body\?\.flagged !== false \|\| keys\.length !== 1 \|\| keys\[0\] !== "flagged"/.test(FLAG));
  /* AND ONLY A FLAGGED, POSTED ROW IS REACHABLE. */
  yes("only a posted, still-flagged row can be confirmed",
    /\.eq\("status", "posted"\)/.test(FLAG) && /\.eq\("flagged", true\)/.test(FLAG));
  yes("the operator is credited through change_log", /recordWrite\(/.test(FLAG) && /actorEmail/.test(FLAG));
  /* posted_by_user_id IS DELIBERATELY NOT SET: recentState reads it as "a person placed this film",
   * so setting it would move the row to Assigned by hand — a false statement about who posted. */
  yes("…and NOT by writing posted_by_user_id, which would misstate who posted it",
    !/posted_by_user_id:/.test(FLAG));
  is("confirming makes it Posted, not Assigned",
    recentState({ status: "posted", flagged: false, postedByUserId: null }), "posted");
  is("CONTROL: before the confirm it is flagged",
    recentState({ status: "posted", flagged: true, postedByUserId: null }), "flagged");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
