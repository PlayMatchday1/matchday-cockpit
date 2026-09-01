/* LAPSED-MEMBER SPOTS — the grouping, and the reason an empty page is not a broken one.
 *
 * THE PAGE WILL BE NEAR-EMPTY IN PRODUCTION. Today: 90 free future spots, 4 held by a lapsed
 * member. An assertion written against live data would therefore be asserting on 4 rows that may
 * be 0 tomorrow, and a filter that returned NOTHING would look identical to one that worked. So
 * the grouping is proven on a FIXTURE that has lapsed holders in it, and every count carries a
 * control showing the same check can fail.
 *
 * WHAT THIS EXISTS TO CATCH is the 1-September failure: Ryan opens the page, sees no rows, and
 * cannot tell "nobody lapsed" from "the query broke". The model returns the denominator and the
 * view prints it; both are asserted.
 */

import { readFileSync } from "node:fs";
import {
  buildLapsedSpots, membershipStateOf, lapseInfoOf, isFutureWall,
  hasStarted, kickoffOf, type SubRow, type SpotRow, type MatchRow,
} from "../src/lib/lapsedSpots";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const TODAY = "2026-08-31";
const match = (id: number, date: string, o: Partial<MatchRow> = {}): MatchRow =>
  ({ api_id: id, name: `Match ${id}`, start_date: `${date}T19:00:00.000Z`, is_cancelled: false,
     city_name: "Austin", field_title: "PARMER Stadium", ...o });
const spot = (id: number, matchId: number, userId: number, o: Partial<SpotRow> = {}): SpotRow =>
  ({ api_id: id, match_api_id: matchId, user_id: userId, user_email: `u${userId}@example.com`,
     user_first_name: "U", user_last_name: String(userId), paid_status: "FREE", user_type: "PLAYER",
     amount: 0, is_cancelled: false, user_is_fake_player: false, is_first_match: false, ...o });
const sub = (userId: number, status: string, canceled_at: string | null = null, cancel_reason: string | null = null): SubRow =>
  ({ user_id: userId, status, canceled_at, cancel_reason });

console.log("\nthe wall clock is TEXT, and September is not decided by a Date");
{
  is("tomorrow is in", isFutureWall("2026-09-01T19:00:00.000Z", TODAY), true);
  /* ── INVERTED 2026-09-01 (assertion body, itemised) ─────────────────────────────────────────
   * This asserted `today is NOT future`, which is what the `>` predicate did — and what hid 21
   * matches and 8 lapsed-member spots, including five people playing that evening. The SQL had
   * already fetched them; the model threw them away. TODAY IS NOW IN. A match that has already
   * kicked off is handled by hasStarted — shown, unticked — never by hiding the day. */
  is("TODAY is in — the SQL fetched it and the model no longer discards it", isFutureWall("2026-08-31T19:00:00.000Z", TODAY), true);
  is("yesterday is not", isFutureWall("2026-08-30T23:59:00.000Z", TODAY), false);
  /* THE TRAP IS UNCHANGED. start_date carries a Z it does not mean. A late-evening match read
   * through a Date in a US timezone shifts to the NEXT day; compared as text it cannot. The value
   * that would flip is now the one BEFORE the boundary: 23:30 yesterday must stay out. */
  is("23:30 YESTERDAY is still out — no Date shifts it forward", isFutureWall("2026-08-30T23:30:00.000Z", TODAY), false);
  is("a null start_date is not in", isFutureWall(null, TODAY), false);

  /* THE ALREADY-STARTED RULE, which is what replaced excluding the day. */
  is("a match earlier today HAS started", hasStarted("2026-08-31T14:00:00.000Z", TODAY, "19:30"), true);
  is("a match later today has NOT", hasStarted("2026-08-31T21:00:00.000Z", TODAY, "19:30"), false);
  is("on the minute counts as started", hasStarted("2026-08-31T19:30:00.000Z", TODAY, "19:30"), true);
  is("control: tomorrow is never 'started', whatever the clock says", hasStarted("2026-09-01T08:00:00.000Z", TODAY, "23:59"), false);
  is("the kickoff is read as text", kickoffOf("2026-08-31T19:30:00.000Z"), "19:30");
}

console.log("\nmembership state is ANY row ACTIVE — never the newest");
{
  const subs = new Map<string, SubRow[]>([
    // THE 153-PERSON CASE: an ACTIVE row and a CANCELED row at once. Newest-row logic would call
    // this person lapsed and remove a paying member's spot.
    ["1", [sub(1, "CANCELED", "2026-08-20", "Moving"), sub(1, "ACTIVE")]],
    ["2", [sub(2, "CANCELED", "2026-08-25", "Budget Concerns"), sub(2, "CANCELED", "2025-01-01", "Moving")]],
    ["3", []],
  ]);
  is("holds ACTIVE and CANCELED -> ACTIVE", membershipStateOf(1, subs), "ACTIVE");
  is("all rows CANCELED -> LAPSED", membershipStateOf(2, subs), "LAPSED");
  is("no rows at all -> NEVER_A_MEMBER", membershipStateOf(99, subs), "NEVER_A_MEMBER");
  is("an EMPTY array is also never-a-member, not lapsed", membershipStateOf(3, subs), "NEVER_A_MEMBER");
  /* CONTROL: the ACTIVE answer is not just what it always says — swap the ACTIVE row out and the
   * same user becomes LAPSED. Without this, "ACTIVE" could be a constant. */
  is("control: remove the ACTIVE row and the same user is LAPSED",
    membershipStateOf(1, new Map([["1", [sub(1, "CANCELED", "2026-08-20", "Moving")]]])), "LAPSED");
  /* THE LAPSE DATE IS THE MOST RECENT, and 644 CANCELED rows carry no date at all, so unknown is
   * a real answer rather than a bug. */
  is("the lapse date is the newest cancellation", lapseInfoOf(2, subs), { on: "2026-08-25", reason: "Budget Concerns" });
  is("no canceled_at anywhere -> unknown, not a crash",
    lapseInfoOf(4, new Map([["4", [sub(4, "CANCELED")]]])), { on: null, reason: null });
}

console.log("\nthe grouping, on a fixture that HAS lapsed holders");
{
  const matches = [
    match(100, "2026-09-05"),
    match(101, "2026-09-06"),
    match(200, "2026-08-30"),                       // past
    match(201, "2026-09-07", { is_cancelled: true }), // cancelled
  ];
  const spots: SpotRow[] = [
    spot(1, 100, 11),                                        // LAPSED, newest lapse
    spot(2, 100, 12),                                        // LAPSED, older lapse
    spot(3, 101, 13),                                        // ACTIVE
    spot(4, 101, 14),                                        // NEVER a member
    spot(5, 100, 15, { is_first_match: true }),              // NEVER, first match free
    spot(6, 100, 16, { paid_status: "PAID", amount: 1200 }), // PAID — never listed, whoever holds it
    spot(7, 100, 17, { user_type: "GUEST", paid_status: "PAID" }),
    spot(8, 100, 18, { user_is_fake_player: true }),         // fake padding
    spot(9, 100, 19, { is_cancelled: true }),                // already cancelled
    spot(10, 200, 11),                                       // past match
    spot(11, 201, 11),                                       // cancelled match
  ];
  const subs = [
    sub(11, "CANCELED", "2026-08-28", "Moving"),
    sub(12, "CANCELED", "2025-11-30", "Budget Concerns"),
    sub(13, "ACTIVE"), sub(13, "CANCELED", "2026-01-01", "Moving"),
    sub(16, "CANCELED", "2026-08-29", "Moving"),   // LAPSED but PAID — the protected case
  ];
  const v = buildLapsedSpots(matches, spots, subs, TODAY);

  is("the denominator counts future non-cancelled matches", v.futureMatches, 2);
  is("…live spots exclude the already-cancelled one", v.liveSpots, 8);
  is("…fakes are counted so the exclusion reads as a choice", v.fakeSpots, 1);
  is("…and free counts only FREE + PLAYER, not fakes or PAID or GUEST", v.freeSpots, 5);

  const g = (s: string) => v.groups.find((x) => x.state === s)!.rows;
  is("LAPSED holds the two lapsed holders", g("LAPSED").map((r) => r.email), ["u11@example.com", "u12@example.com"]);
  is("…newest lapse first, with no recency window", g("LAPSED").map((r) => r.lapsedOn), ["2026-08-28", "2025-11-30"]);
  is("…and the reason is carried", g("LAPSED")[0].lapseReason, "Moving");
  is("ACTIVE is its own group", g("ACTIVE").map((r) => r.email), ["u13@example.com"]);
  is("NEVER_A_MEMBER is separate from LAPSED", g("NEVER_A_MEMBER").map((r) => r.email).sort(), ["u14@example.com", "u15@example.com"]);
  /* CHANGED 2026-08-31 (assertion body, itemised): PAST_DUE was split out of LAPSED into its own
   * bucket, so the expected list grew from three to four. The ORDER property this pins is
   * unchanged — removal candidates first, context after. */
  is("groups are ordered lapsed-first", v.groups.map((x) => x.state), ["LAPSED", "PAST_DUE", "ACTIVE", "NEVER_A_MEMBER"]);

  /* THE RULE THAT PROTECTS EVERYONE: a PAID spot is never listed, and user 16 IS lapsed — so this
   * is the paid-lapsed-member case, not merely an active member being skipped. */
  const all = v.groups.flatMap((x) => x.rows).map((r) => r.email);
  is("a PAID spot is never listed, even for a LAPSED holder", all.includes("u16@example.com"), false);
  is("a GUEST is never listed", all.includes("u17@example.com"), false);
  is("a fake player is never listed", all.includes("u18@example.com"), false);
  is("a past match's spot is never listed", g("LAPSED").some((r) => r.matchId === 200), false);
  is("a cancelled match's spot is never listed", g("LAPSED").some((r) => r.matchId === 201), false);
  is("first-match-free is visible on the row", g("NEVER_A_MEMBER").find((r) => r.email === "u15@example.com")?.isFirstMatch, true);
  /* ── INVERTED 2026-09-01 (assertion body, itemised) ───────────────────────────────────────────
   * This asserted a per-match guest COUNT rode on every row, "beside the decision". Measured on
   * staging twice: DELETE /admin/matches/user-matches/{userMatchId} removes exactly the row it
   * names and guests survive untouched (3 of 3, then 1 of 1). So acting on a host IS a decision
   * only about the host, the count was never relevant, and it was match-level anyway — three
   * unrelated people on one match each read "4 guests". The field is gone.
   *
   * A GUEST ROW IS STILL NEVER LISTED (asserted above, u17) — that filter is untouched. */
  is("no row carries a guest count any more", "guestsOnMatch" in (g("LAPSED")[0] as object), false);
  // CONTROL: the row object is real and still carries the fields that DID survive.
  is("control: the row still carries isStaff and kickoff", ["isStaff", "kickoff"].every((k) => k in (g("LAPSED")[0] as object)), true);
  is("the spot cost is carried", g("LAPSED")[0].amountCents, 0);

  /* ── THE CONTROL THE BRIEF ASKED FOR ──────────────────────────────────────────────────────
   * This fixture must FAIL a filter that returns everyone. If a broken build dropped the
   * paid/guest/fake/past/cancelled exclusions, the LAPSED group would swell — so assert the exact
   * size AND that the everything-filter is a different, larger answer. Without this, "2 lapsed"
   * could be what any implementation returns for this fixture. */
  const everyone = spots.length;
  is("control: the fixture has more spots than the filter returns", everyone > g("LAPSED").length, true);
  is("control: a filter returning everyone would give 11, not 2", [everyone, g("LAPSED").length], [11, 2]);
  is("control: and would wrongly include the PAID lapsed member",
    spots.some((s) => s.user_id === 16), true);

  /* CONTROL: the grouping is doing work — make every holder lapsed and the shape changes. */
  const allLapsed = buildLapsedSpots(matches, spots,
    [11, 12, 13, 14, 15].map((u) => sub(u, "CANCELED", "2026-08-01", "Moving")), TODAY);
  is("control: with everyone lapsed the LAPSED group is 5, not 2",
    allLapsed.groups.find((x) => x.state === "LAPSED")!.rows.length, 5);
  is("control: …and NEVER_A_MEMBER empties", allLapsed.groups.find((x) => x.state === "NEVER_A_MEMBER")!.rows.length, 0);
}

console.log("\nan empty result still states its denominator");
{
  const matches = [match(300, "2026-09-05")];
  const spots = [spot(1, 300, 11, { paid_status: "PAID", amount: 1200 })];
  const v = buildLapsedSpots(matches, spots, [], TODAY);
  is("nothing is listed", v.groups.every((g) => g.rows.length === 0), true);
  /* AND THE FUNNEL SURVIVES. These three numbers are what separate "nobody lapsed" from "the
   * query broke" — an empty page that cannot state them is the failure this page exists to avoid. */
  is("…but the funnel is still reported", [v.futureMatches, v.liveSpots, v.freeSpots], [1, 1, 0]);
  /* CONTROL: a genuinely empty INPUT gives zeros everywhere — which is what a broken query would
   * look like, and why the numbers being NON-zero above is the signal. */
  const nothing = buildLapsedSpots([], [], [], TODAY);
  is("control: an empty input gives 0 matches — distinguishable from the above",
    [nothing.futureMatches, nothing.liveSpots, nothing.freeSpots], [0, 0, 0]);
}

console.log("\nthe page is READ ONLY, and the sentence stays");
{
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const view = strip(readFileSync("src/components/LapsedSpotsView.tsx", "utf8"));
  const route = strip(readFileSync("src/app/api/lapsed-spots/route.ts", "utf8"));
  const model = strip(readFileSync("src/lib/lapsedSpots.ts", "utf8"));
  if (/export default function LapsedSpotsView/.test(view) && /export async function GET/.test(route))
    ok("control: the view and the route were read");
  else bad("control: the view and the route were read", "THE ABSENCE CHECKS BELOW WOULD PASS ON EMPTY STRINGS");

  /* ── INVERTED 2026-08-31 (assertion body, itemised) ─────────────────────────────────────────
   * This used to assert the view makes NO non-GET request, because the first pass shipped
   * deliberately read-only. The removal control is now built, so that assertion would pin the
   * absence of a feature that exists. It is INVERTED rather than deleted: the property worth
   * holding is no longer "no writes" but "the ONLY write is the shared roster route".
   *
   * THAT IS THE STRONGER GUARD. A second write path would be one that does not go through
   * recordWrite, does not read back, and does not answer to the endpoint deny-list. */
  // Both quoting styles: the read is a plain string, the write a template literal.
  const posts = [...view.matchAll(/fetch\(\s*[`"']([^`"']+)[`"']/g)].map((m) => m[1]);
  is("the view's only fetch targets are the lapsed read and the roster route",
    posts.map((u) => u.replace(/\$\{[^}]+\}/g, "{}")).sort(),
    ["/api/lapsed-spots", "/api/matchday/{}/roster/{}"]);
  if (/method: "POST"/.test(view)) ok("…and the write is a POST of an op, never a client-supplied path");
  else bad("the view posts an op", "THE REMOVAL CONTROL IS NOT WIRED");
  // CONTROL: prove the scan can see a fetch at all, so an empty list is not a silent pass.
  if (posts.length >= 2) ok(`control: the scan found ${posts.length} fetch targets`);
  else bad("control: the fetch scan found targets", "THE ASSERTION ABOVE WOULD PASS ON AN EMPTY ARRAY");
  /* THE ROUTE ITSELF STAYS READ-ONLY. The removal goes through the roster route, which already
   * carries the capability check, the scope check, recordWrite and the read-back. A POST added
   * here would be a second write path with none of that. */
  if (!/export async function (POST|PUT|PATCH|DELETE)/.test(route)) ok("the lapsed-spots route still exposes only GET");
  else bad("the lapsed-spots route exposes a write handler", "THE REMOVAL MUST GO THROUGH THE ROSTER ROUTE, NOT A SECOND PATH");
  /* THE ENDPOINT SHAPE, not the word "players" — mdapi_match_players is a table this page reads
   * and matching it flagged the SELECT. What must be absent is /matches/{id}/players/{id} and the
   * refund path. */
  if (!/matches\/\$\{[^}]*\}\/players|refund-and-cancel/.test(view + route)) ok("nothing here names the removal endpoint");
  else bad("the removal endpoint is named in this pass");
  // CONTROL: the scan can match — the table name IS present, so an empty-string pass is ruled out.
  if (/mdapi_match_players/.test(route)) ok("control: the route really does mention players (the table)");
  else bad("control: the route mentions the players table");

  /* ── INVERTED 2026-09-01 (assertion body, itemised) ─────────────────────────────────────────
   * This asserted the page RENDERS the caveat as an amber box. The box was removed; the caveat
   * was not. Deleting the assertion would have let the fact quietly disappear, so it is inverted:
   * ABSENT from the page, PRESENT in the two places that outlive a screen. */
  if (!/FREE_IS_NOT_MEMBER_NOTE|ls-free-note|ls-note/.test(view)) ok("the amber box is gone from the page — element, testid and class");
  else bad("the amber callout is absent", "IT WAS REMOVED ON 2026-09-01 AND MUST NOT COME BACK BY ACCIDENT");
  const LIB_SRC = readFileSync("src/lib/lapsedSpots.ts", "utf8");
  const FACTS = readFileSync("docs/matchday-api-facts.md", "utf8");
  for (const phrase of ["FREE DOES NOT MEAN", "2026-05-12", "246,216", "NEAREST AVAILABLE SIGNAL"]) {
    if (LIB_SRC.toUpperCase().includes(phrase.toUpperCase())) ok(`the file header still carries “${phrase}”`);
    else bad(`the header carries “${phrase}”`, "THE CAVEAT WAS DELETED, NOT MOVED");
  }
  for (const phrase of ["match_registrations.payment_type", "2026-05-12", "246,216", "nearest available signal"]) {
    if (FACTS.includes(phrase)) ok(`the facts doc records “${phrase}”`);
    else bad(`the facts doc records “${phrase}”`, "OFF-SCREEN AND UNDOCUMENTED IS DELETED");
  }

  // THE DENOMINATOR IS RENDERED, not merely computed.
  if (/data-testid="ls-denominator"/.test(view)) ok("the denominator is on the page");
  else bad("the denominator is on the page", "AN EMPTY LIST WOULD LOOK LIKE A BROKEN ONE");
  if (/data-testid="ls-error"/.test(view) && /setData\(null\)/.test(view)) ok("a load error renders as an error, never as an empty list");
  else bad("a load error renders as an error");

  /* NO new Date() ON A MATCH DATE. The model may not construct a Date at all; the route builds
   * exactly one, for today, and never from start_date. */
  if (!/new Date\(/.test(model)) ok("the model constructs no Date at all");
  else bad("the model constructs a Date", "start_date CARRIES A Z IT DOES NOT MEAN");
  const dates = route.match(/new Date\(/g) ?? [];
  /* CHANGED 2026-09-01 (assertion body, itemised): the route now constructs TWO Dates — today's
   * date and the current HH:MM, both for the already-started rule, both in America/Chicago. The
   * property being guarded is unchanged and is the one that matters: neither is ever handed a
   * start_date. `new Date()` with no argument cannot re-shift a match across midnight; `new
   * Date(m.start_date)` would, and that is the trap. */
  is("every Date the route constructs is argument-free — none parses a start_date", (route.match(/new Date\(\)/g) ?? []).length, 2);
  is("…and no Date is ever given an argument", /new Date\([^)]/.test(route), false);
  if (/new Date\(\)\)/.test(route)) ok("…and it takes no argument, so no start_date is parsed");
  else bad("the route's Date takes an argument", "IT MAY BE PARSING A MATCH DATE");
}

console.log(`\nlapsed-spots: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
