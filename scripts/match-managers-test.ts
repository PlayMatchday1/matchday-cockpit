import "server-only"; // no-op under --conditions=react-server
// MATCH MANAGERS — the fold, the relay label, the disabled control, and the NAME.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/match-managers-test.ts
//
// WHY A SUITE AT ALL, on a read-only admin section. Four of these are not visible by eye:
//
//   1. THE FOLD. 107 assignments folding to 87 people is right; 107 rows is also "right" and looks
//      identical to Retool. Nothing on screen says which one you are looking at.
//   2. THE NAME. "city manager" means THREE different things in this codebase — a Clubhouse login
//      with confinement (5 rows), a directory table (6 rows), and this roster (87 people). The
//      populations barely overlap: 6 of 87 hold an app_users row and 3 of those carry the flag. A
//      label reading "city manager" on this section would look correct forever and be wrong now.
//   3. THE DISABLED CONTROL. The API has no add and no remove. Enabling the button costs nothing at
//      compile time and ships a control that does nothing — which is the one thing we never ship.
//   4. AN APPLE RELAY TOKEN rendered as an address reads as corrupt data, and there is no assertion
//      on a screenshot that catches it.
//
// THE POSITIVE CONTROLS. Two assertions here are ABSENCE assertions ("no rendered text says city
// manager", "no relay token is printed"), and a zero from a regex that matches nothing looks exactly
// like a zero from a page that is clean. So each is paired with the SAME pattern proven to fire on
// a string where the thing definitely IS present, in this run.

import { readFileSync } from "node:fs";
import {
  foldToPeople, counts, neverRan, filterPeople, emailDisplay, isRelayEmail, isFindableEmail,
  CAN_ADD_MATCH_MANAGER, CAN_REMOVE_MATCH_MANAGER, NO_MUTATION_REASON,
  ADD_MATCH_MANAGER_ENDPOINT, REMOVE_MATCH_MANAGER_ENDPOINT, ENDPOINTS_PROOF,
  type ApiAssignment,
} from "../src/lib/matchManagers";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

console.log("MATCH MANAGERS\n");

/* ── THE FIXTURE ───────────────────────────────────────────────────────────────────────────────
 * Shaped like the production payload measured on 2026-08-25: 107 assignments held by 87 people
 * across 10 cities, one person in eight cities, 14 relay addresses, every person with a phone.
 * Built here rather than fetched — a suite that needs the network is a suite that goes red for a
 * reason that is not the code. */
const CITIES = ["ATX", "DFW", "HOU", "SATX", "STL", "ATL", "OKC", "NYC", "WAW", "ELP"];
const PER_CITY = [28, 19, 17, 15, 9, 8, 5, 4, 1, 1];   // = 107
const rows: ApiAssignment[] = [];
let nextUser = 1000, rowId = 1;
const city = (i: number) => ({ id: i + 1, name: `City ${CITIES[i]}`, abbr: CITIES[i] });
const add = (userId: number, ci: number, over: Partial<NonNullable<ApiAssignment["user"]>> = {}) => {
  rows.push({
    id: rowId++, userId, cityId: ci + 1, city: city(ci),
    user: { id: userId, firstName: `First${userId}`, lastName: `Last${userId}`,
            email: `mm${userId}@example.com`, phoneNumber: `+1512555${String(userId).padStart(4, "0")}`, ...over },
  });
};
// THE THREE MULTI-CITY PEOPLE, measured: exactly 3 of the 87 work more than one city, and the
// busiest works 8. 8 + 8 + 7 cities is 20 assignments held by 3 people — which is precisely the
// 107 − 87 gap the header has to explain.
const MULTI = nextUser++;
for (let i = 0; i < 8; i++) add(MULTI, i, { firstName: "Zelfine", lastName: "Nick" });
const MULTI_B = nextUser++;
for (let i = 0; i < 8; i++) add(MULTI_B, i);
const MULTI_C = nextUser++;
for (let i = 0; i < 7; i++) add(MULTI_C, i);
// Fill each city up to its measured count with single-city people; 14 of them on Apple relay.
let relayLeft = 14;
for (let ci = 0; ci < CITIES.length; ci++) {
  const have = rows.filter((r) => r.cityId === ci + 1).length;
  for (let n = have; n < PER_CITY[ci]; n++) {
    const u = nextUser++;
    const relay = relayLeft > 0 && u % 3 === 0;
    if (relay) relayLeft--;
    add(u, ci, relay ? { firstName: null, lastName: null, email: `a1b2c3d4e5${u}@privaterelay.appleid.com` } : {});
  }
}
is("fixture holds 107 assignments", rows.length, 107);

// Matches run — enough people with runs to exercise the sort and the "never ran" tile.
const runs = new Map<number, { matchesRun: number; lastMatch: string | null }>();
runs.set(MULTI, { matchesRun: 214, lastMatch: "2026-08-22" });
const withRuns = [...new Set(rows.map((r) => r.userId))].slice(1, 41);
withRuns.forEach((u, i) => runs.set(u, { matchesRun: 40 - i, lastMatch: `2026-0${(i % 8) + 1}-15` }));

const people = foldToPeople(rows, runs);
const c = counts(people);

// ── 1. ONE ROW PER PERSON, AND BOTH COUNTS ON SCREEN ──────────────────────────────────────────
console.log("\nthe fold: 107 assignments become 87 people, and the header says both");
is("people", c.people, 87);
is("assignments", c.assignments, 107);
is("people === folded row count", people.length, c.people);
is("assignments === the raw API row count", c.assignments, rows.length);
is("the multi-city person is ONE row", people.filter((p) => p.userId === MULTI).length, 1);
is("…carrying eight chips", people.find((p) => p.userId === MULTI)!.cities.length, 8);
is("chips are deduped", new Set(people.find((p) => p.userId === MULTI)!.cities.map((x) => x.cityId)).size, 8);
is("city chip counts reconcile to the assignment total", c.byCity.reduce((s, x) => s + x.n, 0), 107);
is("ten cities", c.byCity.length, 10);
is("ATX is the biggest", c.byCity[0], { label: "ATX", n: 28 });
// A DUPLICATE ROW MUST NOT GROW A CHIP. The API has no ORDER BY and no uniqueness we have proven.
{
  const dup = foldToPeople([...rows, rows[0]], runs);
  is("a repeated assignment row adds no person", counts(dup).people, 87);
  is("…and no chip", counts(dup).assignments, 107);
}
is("busiest first", people[0].userId, MULTI);
is("exactly three people work more than one city", people.filter((p) => p.cities.length > 1).length, 3);
is("the busiest works eight", Math.max(...people.map((p) => p.cities.length)), 8);
is("never ran a match", neverRan(people), 87 - runs.size);

// ── 2. THE NAME. NOTHING RENDERED SAYS "CITY MANAGER" EXCEPT THE BANNER ───────────────────────
console.log("\nthe name: MATCH MANAGERS everywhere, and the API's word only in the banner");
{
  const SRC = "src/components/MatchManagersPanel.tsx";
  const src = readFileSync(SRC, "utf8");
  // The rendered text: JSX text nodes and the string literals inside them. Comments are stripped —
  // this file's own comments discuss the collision at length and SHOULD.
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  const NEEDLE = /city[\s-]?manager/i;

  // POSITIVE CONTROL: the same regex, on text where the phrase definitely is present.
  if (NEEDLE.test("they are not the city managers in Clubhouse permissions")) ok("control: the pattern finds the phrase when it is there");
  else bad("control: the pattern finds the phrase when it is there", "THE REGEX MATCHES NOTHING — every result below is meaningless");

  // The banner is the one sanctioned occurrence. Cut it out, then nothing may be left.
  const banner = noComments.match(/data-testid="mm-naming-banner"[\s\S]*?<\/div>/);
  if (banner) ok("the naming banner is on the page");
  else bad("the naming banner is on the page", "no mm-naming-banner in the component");
  if (banner && NEEDLE.test(banner[0])) ok("…and it is the banner that explains the API's naming");
  else bad("…and it is the banner that explains the API's naming", "the banner does not mention the API's word at all");

  /* THE ENDPOINT PATH IS NOT A LABEL. /city-managers is the API's own URL and the disabled-controls
   * reason quotes it on purpose; stripping it keeps this assertion about what these PEOPLE are
   * called. The control beneath proves the strip removed something. */
  const rest = (banner ? noComments.replace(banner[0], " ") : noComments).replace(/\/city-managers/g, " ");
  const hits = rest.split("\n").map((l, i) => [i + 1, l] as const).filter(([, l]) => NEEDLE.test(l));
  if (hits.length === 0) ok("no other rendered text in the panel CALLS these people 'city managers'");
  else bad("no other rendered text in the panel calls them that", hits.map(([n, l]) => `L${n}: ${l.trim()}`).join(" | "));

  // The SECTION HEADING, the testids and the route are the names an operator and the next dev see.
  if (/MATCH MANAGERS/.test(src)) ok("the section heading reads MATCH MANAGERS");
  else bad("the section heading reads MATCH MANAGERS");
  const route = readFileSync("src/app/api/match-managers/route.ts", "utf8");
  const routeNoComments = route.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  const routeHits = routeNoComments.split("\n").filter((l) => NEEDLE.test(l) && !l.includes('"/city-managers"'));
  if (routeHits.length === 0) ok("the route names the API's path and nothing else 'city manager'");
  else bad("the route names the API's path and nothing else 'city manager'", routeHits.join(" | "));
  if (/\/city-managers/.test(route)) ok("control: the API path IS in the route (so the exclusion above excluded something)");
  else bad("control: the API path IS in the route", "the route does not call /city-managers at all");
}

// ── 3. APPLE PRIVATE RELAY IS LABELLED, NEVER PRINTED ─────────────────────────────────────────
console.log("\napple private relay: labelled with the ID, and the token never rendered");
{
  const relays = people.filter((p) => p.relay);
  is("14 people on a relay address", relays.length, 14);
  const rendered = people.map(emailDisplay);
  const TOKEN = /privaterelay\.appleid\.com/i;
  // POSITIVE CONTROL: the pattern fires on the raw address it is meant to keep off the screen.
  if (TOKEN.test(relays[0].email!)) ok("control: the pattern finds a relay address in the raw data");
  else bad("control: the pattern finds a relay address in the raw data", "THE REGEX MATCHES NOTHING");
  const leaked = rendered.filter((t) => TOKEN.test(t));
  if (leaked.length === 0) ok("no relay token reaches the email column");
  else bad("no relay token reaches the email column", leaked.slice(0, 2).join(" | "));
  is("the label carries the ID instead", emailDisplay(relays[0]), `Apple private relay · ID ${relays[0].userId}`);
  is("a real address renders as itself", emailDisplay({ userId: 7, email: "a@b.com", relay: false }), "a@b.com");
  is("a missing address says so, with the ID", emailDisplay({ userId: 7, email: null, relay: false }), "No email on file · ID 7");
  is("a relay address is not findable", isFindableEmail(relays[0].email), false);
  is("a real one is", isFindableEmail("a@b.com"), true);
  is("case does not fool the relay test", isRelayEmail("X@PrivateRelay.AppleID.com"), true);
  is("a lookalike domain is NOT a relay", isRelayEmail("x@privaterelay.appleid.com.evil.com"), false);
  is("every person has a phone, which is why the ID is enough", people.filter((p) => !p.phone).length, 0);
  // The ID is the only handle a relay person has, so the filter must accept it.
  is("a relay person is findable by ID", filterPeople(people, String(relays[0].userId), null).length, 1);
}

// ── 4. THE CONTROLS ARE DISABLED, AND THE REASON IS THE API ───────────────────────────────────
console.log("\nadd and remove: off because Clubhouse has not built them — NOT because the API can't");
{
  /* THIS ASSERTION USED TO RECORD A FALSE FINDING, AND IT IS THE POINT OF KEEPING IT.
   *
   * It read "REMOVE is off — the MatchDay API exposes no remove endpoint", and that was wrong. The
   * claim came from grepping the Retool export for `createCityManager` and `deleteCityManager` —
   * names I invented. Retool's queries are called exactly that, so the grep should have hit; it
   * missed because I searched for a guessed name instead of tracing the button. Following
   * addCityManagerBtn's own click handler found it immediately:
   *
   *   addCityManagerBtn    "ADD CITY MANAGER" -> POST   /city-managers  {userId, cityId}
   *   deleteCityManagerBtn "DELETE"           -> DELETE /city-managers?userId=&cityId=
   *
   * Both proven on staging by reading the list back — POST 19 rows -> 20, DELETE 20 -> 19.
   *
   * AN ABSENCE PROVED BY GREP IS NOT AN ABSENCE. The controls stay off because CLUBHOUSE has not
   * built the writes, and the reason on screen must say that: "the API has no endpoint" would stop
   * the next person looking. */
  is("REMOVE is off — Clubhouse has not built it", CAN_REMOVE_MATCH_MANAGER, false);
  is("ADD is off — Clubhouse has not built it", CAN_ADD_MATCH_MANAGER, false);
  if (!/no endpoint to add or remove/i.test(NO_MUTATION_REASON)) ok("the reason no longer blames the API for a limit it does not have");
  else bad("the reason no longer blames the API", NO_MUTATION_REASON);
  if (/POST \/city-managers/.test(NO_MUTATION_REASON)) ok("…it names the add endpoint that does exist");
  else bad("…it names the add endpoint that does exist", NO_MUTATION_REASON);
  if (/DELETE \/city-managers/.test(NO_MUTATION_REASON)) ok("…and the remove endpoint");
  else bad("…and the remove endpoint", NO_MUTATION_REASON);
  if (/Clubhouse has not built/i.test(NO_MUTATION_REASON)) ok("…and says whose gap it actually is");
  else bad("…and says whose gap it actually is", NO_MUTATION_REASON);
  if (/Retool|MatchDay app/i.test(NO_MUTATION_REASON)) ok("…and where the change can be made today");
  else bad("…and where the change can be made today", NO_MUTATION_REASON);
  is("the add endpoint is recorded verbatim", ADD_MATCH_MANAGER_ENDPOINT, "POST /city-managers {userId, cityId}");
  is("the remove endpoint is recorded verbatim", REMOVE_MATCH_MANAGER_ENDPOINT, "DELETE /city-managers?userId=&cityId=");
  if (/staging/i.test(ENDPOINTS_PROOF) && /19/.test(ENDPOINTS_PROOF)) ok("the proof names the staging probe and its row counts");
  else bad("the proof names the staging probe", ENDPOINTS_PROOF);

  const src = readFileSync("src/components/MatchManagersPanel.tsx", "utf8");
  for (const [id, cap] of [["mm-remove", "canRemove"], ["mm-add", "canAdd"]] as const) {
    const btn = src.match(new RegExp(`<button[^>]*data-testid="${id}"[\\s\\S]{0,10}?>`)) ??
                src.match(new RegExp(`<button[\\s\\S]{0,400}?data-testid="${id}"`));
    if (btn && /disabled=\{!data\.\w+\}/.test(btn[0])) ok(`${id} is disabled from the server's ${cap}, not from a local constant`);
    else bad(`${id} is disabled from the server's ${cap}`, btn ? btn[0].replace(/\s+/g, " ").slice(0, 120) : "button not found");
    if (btn && /title=\{[^}]*mutationReason\}/.test(btn[0])) ok(`${id} carries the reason as its tooltip`);
    else bad(`${id} carries the reason as its tooltip`, btn ? btn[0].replace(/\s+/g, " ").slice(0, 120) : "button not found");
  }
  // NO SECOND SEARCH BOX. Retool's add modal searches EMAIL ONLY (GET /admin/players?email=), which
  // cannot find any of the 14 relay people. The filter box here filters the roster.
  const boxes = (src.match(/<input\b/g) ?? []).length;
  is("exactly one input in the section — the roster filter", boxes, 1);
}

// ── 5. THE FILTER, AND THE CITY SCOPE ─────────────────────────────────────────────────────────
console.log("\nfilter and city scope");
{
  is("empty query returns everyone", filterPeople(people, "", null).length, 87);
  is("ATX chip returns ATX's 28 people", filterPeople(people, "", "ATX").length, 28);
  is("WAW has exactly one", filterPeople(people, "", "WAW").length, 1);
  is("a city nobody serves returns none", filterPeople(people, "", "MARS").length, 0);
  // POSITIVE CONTROL for that zero: the same call with a city that exists finds someone.
  if (filterPeople(people, "", "STL").length === 9) ok("control: the same filter finds STL's 9");
  else bad("control: the same filter finds STL's 9", String(filterPeople(people, "", "STL").length));
  is("the multi-city person appears under each of their cities",
     CITIES.slice(0, 8).every((l) => filterPeople(people, "", l).some((p) => p.userId === MULTI)), true);
  is("name search", filterPeople(people, "zelfine", null).length, 1);
  is("case-insensitive", filterPeople(people, "ZELFINE", null).length, 1);
  is("query and city compose", filterPeople(people, "zelfine", "ATX").length, 1);
  is("…and a city they do not serve excludes them", filterPeople(people, "zelfine", "WAW").length, 0);
  is("phone search", filterPeople(people, "512555", null).length, 87);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
