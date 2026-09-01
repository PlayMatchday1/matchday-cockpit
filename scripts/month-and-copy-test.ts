/* THE MONTH VIEW AND THE COPY BUTTON.
 *
 * WHAT THESE GUARD. A copy that drops a field creates a LIVE, SELLABLE match with the wrong price
 * or the wrong capacity — production 18408 sold 44 spots at $0 because a nine-key copy body left
 * registrationPrice out and the API defaults an absent price to 0. And a month grid that buckets
 * dates through a Date drops a 9pm Sunday match into Monday, because start_date is local wall
 * clock despite the Z.
 *
 * Both failure modes render as a perfectly normal-looking screen. Hence the controls.
 */

import { readFileSync } from "node:fs";
import { buildCopyBody, droppedByCopy, copyConfirmLine, wallClockLabel, COPY_FIELDS } from "../src/lib/copyMatch";
import {
  buildMonthGrid, applyFilters, fieldsAvailable, reconcileFields, fieldCountLabel,
  defaultRange, rangeTitle, isoDow, mondayOnOrBefore, sundayOnOrAfter, type GridMatch,
} from "../src/lib/monthGrid";
import { EDITABLE_KEYS } from "../src/lib/matchEditModel";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ── THE SOURCE MATCH. Every editable field set to a DISTINCT, non-default value, so a copy that
 * silently drops one is visible rather than coincidentally right. */
const SRC = {
  id: 18408, name: "Parmer Stadium - Premier", description: "d", type: "REGULAR", category: "OPEN",
  startDate: "2026-09-04T19:30:00.000Z", endDate: "2026-09-04T21:00:00.000Z",
  fieldId: 1585, maxPlayerCount: 36, isFreeMember: false,
  managerId: 42, secondManagerId: 43, managerIntro: "intro",
  registrationPrice: 1500, additionalSpotPrice: 500, guestCount: 2,
  fakeSpotLeft36h: 1, fakeSpotLeft24h: 2, fakeSpotLeft12h: 3, fakeSpotLeft6h: 4, fakeSpotLeft3h: 5,
  autoCanceled: true, autoCanceledMinutes: 90, minPlayerCount: 8, isAutoBump: true,
  maxTeamSize2Team: 18, maxTeamSize4Team: 36,
  teams: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
  field: { title: "Parmer" },
  // Never copied — the roster and the instance's own identity.
  players: [{ id: 1 }], _count: { players: 44 }, starRating: 4.5, starRatingCount: 9,
  isCancelled: false, createdAt: "2026-08-25T17:00:03Z", updatedAt: "2026-08-26T00:00:00Z",
};

console.log("\nTHE COPY BODY CARRIES EVERY FIELD THE CREATE ROUTE ACCEPTS");
{
  const body = buildCopyBody(SRC);
  /* THE ONE THAT COST $660. registrationPrice was REFUSED by the old nine-key list, so a copy
   * landed at 0 and sold 44 spots against $15 siblings. */
  is("  registrationPrice is carried", body.registrationPrice, 1500);
  is("  …and every other money/capacity field",
    [body.additionalSpotPrice, body.maxPlayerCount, body.minPlayerCount, body.maxTeamSize2Team, body.maxTeamSize4Team],
    [500, 36, 8, 18, 36]);
  is("  managers are carried", [body.managerId, body.secondManagerId], [42, 43]);
  is("  teamNumbers is DERIVED from the teams array, not read off the match", body.teamNumbers, 4);
  is("  …and defaults to 2 when there is no teams array", buildCopyBody({ ...SRC, teams: undefined }).teamNumbers, 2);

  /* WALL CLOCK, PASSED THROUGH. The whole reason this file exists twice over. */
  is("  startDate is BYTE-IDENTICAL to the source", body.startDate, SRC.startDate);
  is("  endDate too", body.endDate, SRC.endDate);
  const LIB = readFileSync("src/lib/copyMatch.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  is("  and no Date is constructed anywhere in the copy model", /new Date\(/.test(LIB), false);
  // CONTROL: the scan fires on real code.
  is("  control: the Date scan fires on a string that has one", /new Date\(/.test("const d = new Date(x);"), true);

  /* NOTHING PLAYER-SHAPED. A copy is a new fixture, not a clone of who turned up. */
  for (const k of ["id", "players", "_count", "starRating", "starRatingCount", "isCancelled", "createdAt", "updatedAt", "teams", "field"]) {
    if (!(k in body)) ok(`  ${k} is NOT copied`);
    else bad(`${k} must not be copied`, "THE CREATE ROUTE REFUSES IT AND A COPY IS NOT A CLONE OF A ROSTER");
  }
  // CONTROL: those keys ARE on the source, so their absence is a decision and not an empty input.
  is("  control: the source really carries them", ["players", "_count", "starRating"].every((k) => k in SRC), true);

  /* EVERY EDITABLE KEY THE EDITOR CAN SET IS IN THE COPY SET. Derived, not listed — a key added to
   * EDITABLE_KEYS tomorrow is carried without anyone remembering to come back here. */
  const missing = EDITABLE_KEYS.filter((k) => !COPY_FIELDS.includes(k));
  is("  COPY_FIELDS covers every EDITABLE_KEY", missing, []);
  is("  …which is 27 fields in total", COPY_FIELDS.length, 27);
  // And the body actually carried them all, because the fixture sets them all.
  const carried = EDITABLE_KEYS.filter((k) => k in body).length;
  is("  the body carries all 18 editable fields the fixture sets", carried, EDITABLE_KEYS.length);

  // An absent optional stays ABSENT rather than being sent as null.
  const sparse = buildCopyBody({ id: 1, name: "n", startDate: "2026-09-04T19:30:00.000Z", fieldId: 2 });
  is("  an absent optional is not sent as null", "registrationPrice" in sparse, false);
  is("  droppedByCopy names what the route will not take", droppedByCopy(SRC).includes("players"), true);
}

console.log("\nTHE CONFIRM IS ONE LINE, AND IT READS THE WALL CLOCK AS TEXT");
{
  const line = copyConfirmLine(SRC);
  for (const part of ["Parmer Stadium - Premier", "Parmer", "Sep 4", "7:30 PM"]) {
    if (line.includes(part)) ok(`  it names ${part}`);
    else bad(`the confirm names ${part}`, line);
  }
  is("  19:30 reads as 7:30 PM — the pitch's clock, not the server's", wallClockLabel("2026-09-04T19:30:00.000Z"), "Sep 4, 7:30 PM");
  is("  midnight reads as 12:00 AM", wallClockLabel("2026-09-04T00:15:00.000Z"), "Sep 4, 12:15 AM");
  is("  noon reads as 12:00 PM", wallClockLabel("2026-09-04T12:00:00.000Z"), "Sep 4, 12:00 PM");
  is("  a missing date says so rather than inventing one", wallClockLabel(null), "date unknown");
  // CONTROL: a late-evening time is exactly where a Date would have shifted the day.
  is("  control: 11:30 PM stays on its own day", wallClockLabel("2026-09-04T23:30:00.000Z"), "Sep 4, 11:30 PM");
}

console.log("\nTHE COPY FLOW: confirm, create, then the editor — and nothing opens on a failure");
{
  const VIEW = readFileSync("src/components/VeoMasterSchedule.tsx", "utf8");
  const code = VIEW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  is("  it confirms with copyConfirmLine", /window\.confirm\(copyConfirmLine\(src\)\)/.test(code), true);
  is("  it posts the copy body to the create route", /buildCopyBody\(src\)/.test(code) && /matches\/create/.test(code), true);
  is("  it reads the SOURCE live, not off the week payload", /matches\/\$\{drawerId\}`, \{ headers, cache: "no-store" \}/.test(code), true);
  is("  a failed create opens nothing", /Nothing was opened/.test(code), true);
  is("  …and it checks the outcome, not just res.ok", /j\.outcome !== "LANDED"/.test(code), true);
  is("  the editor opens on the NEW id", /setDrawerId\(Number\(j\.id\)\)/.test(code), true);
  is("  a failed mirror insert is said, and the editor still opens", /will not show it until the next sync|not show it until the next sync/.test(code), true);
  /* THE VEO FLAG IS CLUBHOUSE-SIDE — veo_intent, keyed on match_api_id. MatchDay has no camera
   * field, so it cannot ride the create body and is copied by a second write. */
  is("  the Veo flag is copied by a POST to veo/intent", /\/api\/veo\/intent/.test(code) && /matchApiId: j\.id/.test(code), true);
  is("  …only when the source had it", /if \(drawerVeo\)/.test(code), true);
  // CONTROL: the old navigate-to-a-form behaviour is gone.
  is("  control: it no longer navigates to /matches/new", /matches\/new\?from=/.test(code), false);
}

console.log("\nEXPORT WORKLIST IS GONE FROM THE TOOLBAR");
{
  const VIEW = readFileSync("src/components/VeoMasterSchedule.tsx", "utf8");
  is("  the button is absent", /Export worklist/.test(VIEW), false);
  // CONTROL: the scan can see a button that IS still there.
  is("  control: the scan still finds Copy match", /Copy match/.test(VIEW), true);
  /* THE HANDLER IS NOT DEAD, so it stays. The Veo coverage panel's own "Export CSV" link uses it.
   * Deleting it would remove a working control in another view. */
  is("  exportWorklist survives because the Veo panel still calls it", /onExport=\{exportWorklist\}/.test(VIEW), true);
}

console.log("\nTHE MONTH GRID: whole weeks, Monday first, padding empty");
{
  const M = (id: number, date: string, minutes: number, venue: string, city = "Austin"): GridMatch =>
    ({ apiId: id, city, date, time: "7:00 PM", minutes, venue, name: `m${id}`, veo: false });
  const MS = [
    M(1, "2026-09-01", 1140, "NEMP"), M(2, "2026-09-01", 1110, "Hattrick"),
    M(3, "2026-09-30", 1200, "Parmer"), M(4, "2026-08-31", 1200, "NEMP"),
    M(5, "2026-09-05", 1200, "NEMP", "Houston"),
  ];
  const r = defaultRange("2026-09-15");
  is("  the default range is the calendar month", r, { from: "2026-09-01", to: "2026-09-30" });
  is("  …titled by it", rangeTitle(r.from, r.to), "September 2026");

  const g = buildMonthGrid(r.from, r.to, MS, "2026-09-15");
  is("  every row is exactly seven days", g.every((w) => w.length === 7), true);
  is("  it starts on a Monday", isoDow(g[0][0].iso), 1);
  is("  …and ends on a Sunday", isoDow(g[g.length - 1][6].iso), 7);
  is("  September 2026 is five rows", g.length, 5);
  const first = g[0][0];
  is("  the leading pad is out of range", [first.iso, first.inRange], ["2026-08-31", false]);
  /* AN OUT-OF-RANGE DAY HOLDS NO MATCHES even when one falls on it — a padding cell must be
   * genuinely empty, not merely styled as though it were. */
  is("  …and holds no matches, though match 4 is on that date", first.matches.length, 0);
  is("  control: match 4 IS in the input on that date", MS.some((m) => m.date === "2026-08-31"), true);
  const sep1 = g.flat().find((d) => d.iso === "2026-09-01")!;
  is("  a day's matches sort by time", sep1.matches.map((m) => m.minutes), [1110, 1140]);
  is("  today is marked", g.flat().find((d) => d.iso === "2026-09-15")!.isToday, true);

  /* A RANGE ACROSS A MONTH BOUNDARY KEEPS GOING AS CONSECUTIVE WEEKS. */
  const x = buildMonthGrid("2026-09-28", "2026-10-11", MS, "2026-09-15");
  is("  a cross-month range is consecutive weeks", [x.length, x[0][0].iso, x[x.length - 1][6].iso],
    [2, "2026-09-28", "2026-10-11"]);
  is("  …with no gap between them", mondayOnOrBefore("2026-10-05"), "2026-10-05");
  is("  control: sundayOnOrAfter of a Sunday is itself", sundayOnOrAfter("2026-10-11"), "2026-10-11");
}

console.log("\nTHE FILTERS: city single, field MULTI, count always honest");
{
  const M = (id: number, venue: string, city = "Austin"): GridMatch =>
    ({ apiId: id, city, date: "2026-09-01", time: "7:00 PM", minutes: 1140, venue, name: `m${id}`, veo: false });
  const MS = [M(1, "NEMP"), M(2, "Hattrick"), M(3, "Parmer"), M(4, "NEMP", "Houston")];

  is("  no selection means ALL", applyFilters(MS, null, new Set()).length, 4);
  is("  two fields shows both and nothing else",
    applyFilters(MS, null, new Set(["NEMP", "Parmer"])).map((m) => m.apiId), [1, 3, 4]);
  is("  deselecting one leaves the other",
    applyFilters(MS, null, new Set(["Parmer"])).map((m) => m.apiId), [3]);
  is("  clearing shows everything again", applyFilters(MS, null, new Set()).length, 4);
  is("  city narrows it too", applyFilters(MS, "Houston", new Set()).map((m) => m.apiId), [4]);

  /* THE CHIP ROW IS BUILT FROM WHAT IS THERE, so it can never offer an empty filter. */
  is("  the field list comes from the matches present", fieldsAvailable(MS, null), ["Hattrick", "NEMP", "Parmer"]);
  is("  …scoped by city", fieldsAvailable(MS, "Houston"), ["NEMP"]);

  /* A SELECTION THAT NO LONGER HAS MATCHES IS DROPPED AND SAID. */
  const rec = reconcileFields(new Set(["NEMP", "Gone", "Also Gone"]), ["NEMP", "Parmer"]);
  is("  a field with no matches is dropped", [...rec.kept], ["NEMP"]);
  is("  …and named, so it is not a silent change", rec.dropped, ["Also Gone", "Gone"]);
  is("  control: nothing is dropped when everything is still available",
    reconcileFields(new Set(["NEMP"]), ["NEMP", "Parmer"]).dropped, []);

  is("  the label says All when nothing is picked", fieldCountLabel(new Set(), ["a", "b", "c"]), "All fields (3)");
  is("  …and the subset when something is", fieldCountLabel(new Set(["a"]), ["a", "b", "c"]), "1 of 3 fields");
  is("  singular is handled", fieldCountLabel(new Set(["a"]), ["a"]), "1 of 1 field");
}

console.log("\nTHE MONTH VIEW SHARES THE WEEK VIEW'S EDITOR, AND ITS CELLS DO NOT STRETCH");
{
  const VIEW = readFileSync("src/components/VeoMasterSchedule.tsx", "utf8");
  const code = VIEW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  /* ONE DRAWER, MOUNTED ONCE AT PAGE LEVEL. Both views call the same openCard, so "the same editor
   * component" is structural rather than a promise. */
  is("  Month calls the same openCard the week view calls", /<MonthView[\s\S]{0,200}onOpen=\{openCard\}/.test(code), true);
  is("  …and there is exactly one MatchDrawer on the page", (code.match(/<MatchDrawer/g) ?? []).length, 1);
  is("  …mounted outside the view branch", code.indexOf("<MatchDrawer") > code.indexOf("view === \"month\""), true);
  // In-place update on save already exists and is shared.
  is("  saving patches the card in place", /onSaved=\{\(id, patch\) => patchCard\(id, patch\)\}/.test(code), true);

  /* FIXED HEIGHT, SCROLLS INSIDE. A Saturday with nine matches must not make every other Saturday
   * nine rows tall. */
  is("  a day cell has a fixed height", /\.vms-mcell\{height:126px/.test(VIEW), true);
  is("  …and its list scrolls inside itself", /\.vms-mlist\{flex:1;min-height:0;overflow-y:auto/.test(VIEW), true);
  is("  the day's count renders in the corner", /data-testid="month-daycount"/.test(code), true);
  is("  one compact line: time then field", /<b>\{m\.time\}<\/b>/.test(code), true);
  is("  …or the NAME when the filter is one field", /singleField \? m\.name : m\.venue/.test(code), true);

  // The range is fetched, the stamp follows the view, and Refresh re-pulls the range.
  is("  Month has its own range fetch", /\/api\/veo\/range\?from=/.test(code), true);
  is("  the freshness stamp follows the view", /view === "month" \? \(monthData\?\.dataAsOf/.test(code), true);
  is("  Refresh re-pulls the whole visible range", /if \(view === "month" && range\) \{ void loadRange\(range, true\); return; \}/.test(code), true);
  is("  the view and filters are persisted", /localStorage\.setItem\(VMS_PREFS/.test(code), true);
  // A failed range read is an error, never an empty grid.
  is("  a failed range is an ERROR, not an empty month", /this is not an empty month/i.test(VIEW), true);
}

console.log(`\nmonth-and-copy: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
