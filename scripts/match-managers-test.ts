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
  CAN_ADD_MATCH_MANAGER, CAN_REMOVE_MATCH_MANAGER, SEARCH_NOTE,
  ADD_MATCH_MANAGER_ENDPOINT, REMOVE_MATCH_MANAGER_ENDPOINT, ENDPOINTS_PROOF,
  addBody, removePath, normalizeId, scopeOfCityId, cityLabel,
  addConfirmLines, removeConfirmLines,
  type ApiAssignment,
} from "../src/lib/matchManagers";
import { assertScope } from "../src/lib/cityConfinement";
import { CITY_IDENTIFIERS } from "../src/lib/cityScope";

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

  /* NO ENDPOINT STRIP HERE EITHER. It existed while the panel printed "POST /city-managers" in the
   * disabled-controls reason; the controls are live and that sentence is gone, so the strip would
   * now remove nothing and a zero from a vacuous strip proves nothing. The browser suite's positive
   * control is what caught that — see verify-match-managers.mjs. */
  const rest = banner ? noComments.replace(banner[0], " ") : noComments;
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
console.log("\nadd and remove: LIVE, because the endpoints exist and are proven");
{
  /* THIS ASSERTION HAS BEEN WRONG ONCE AND THAT IS WHY IT IS KEPT.
   *
   * It first read "REMOVE is off — the MatchDay API exposes no remove endpoint", from grepping the
   * Retool export for `createCityManager` and `deleteCityManager` — NAMES I INVENTED. Retool's
   * queries are called exactly that, so the grep should have hit; it missed because I searched for
   * a guessed name instead of tracing the button. AN ABSENCE PROVED BY GREP IS NOT AN ABSENCE.
   *
   * It now asserts the opposite, and it FAILS IF EITHER CONTROL IS DISABLED — the endpoints exist,
   * they are proven on staging by read-back, and a greyed button would now be a lie in the other
   * direction. */
  is("ADD is live", CAN_ADD_MATCH_MANAGER, true);
  is("REMOVE is live", CAN_REMOVE_MATCH_MANAGER, true);
  is("the add endpoint is recorded verbatim", ADD_MATCH_MANAGER_ENDPOINT, "POST /city-managers {userId, cityId}");
  is("the remove endpoint is recorded verbatim", REMOVE_MATCH_MANAGER_ENDPOINT, "DELETE /city-managers?userId=&cityId=");
  if (/staging/i.test(ENDPOINTS_PROOF) && /19/.test(ENDPOINTS_PROOF)) ok("the proof names the staging probe and its row counts");
  else bad("the proof names the staging probe", ENDPOINTS_PROOF);

  // ── THE BODIES. The diff IS the request body.
  is("add sends exactly userId and cityId", addBody(72729, 1), { userId: 72729, cityId: 1 });
  is("…and nothing else", Object.keys(addBody(72729, 1)), ["userId", "cityId"]);
  is("remove carries the pair in the query string", removePath(72729, 1), "/city-managers?userId=72729&cityId=1");
  is("remove sends NO body", removePath(1, 2).includes("{"), false);
  for (const raw of ["", "abc", null, undefined, 0, -1, 1.5, "1.5", NaN, "12x"])
    if (normalizeId(raw) !== null) bad(`${JSON.stringify(raw)} is not an id`, String(normalizeId(raw)));
  ok("nothing that is not a positive integer survives as an id");
  is("a numeric string is an id", normalizeId("72729"), 72729);

  // ── THE CITY IS RESOLVED BY ID FROM GET /cities, NEVER BY NAME.
  /* The API has TEN cities; CITY_SCOPES has eight and the finance estate seven. NYC and ELP exist
   * upstream and nowhere else here, so a mapping written from our own list would silently lose
   * them — which is why this maps from the endpoint's rows. */
  const API_CITIES = [
    { id: 1, name: "Austin", abbr: "ATX" }, { id: 2, name: "Houston", abbr: "HOU" },
    { id: 3, name: "San Antonio", abbr: "SATX" }, { id: 4, name: "Atlanta", abbr: "ATL" },
    { id: 5, name: "St. Louis", abbr: "STL" }, { id: 6, name: "New York", abbr: "NYC" },
    { id: 7, name: "Dallas", abbr: "DFW" }, { id: 8, name: "Oklahoma City", abbr: "OKC" },
    { id: 9, name: "El Paso", abbr: "ELP" }, { id: 10, name: "Warsaw", abbr: "WAW" },
  ];
  is("ten cities upstream", API_CITIES.length, 10);
  is("cityId 1 scopes to ATX", scopeOfCityId(API_CITIES, 1), "ATX");
  is("cityId 10 scopes to WAW", scopeOfCityId(API_CITIES, 10), "WAW");
  is("NYC resolves even though CITY_SCOPES has never heard of it", scopeOfCityId(API_CITIES, 6), "NYC");
  is("ELP too", scopeOfCityId(API_CITIES, 9), "ELP");
  is("a city id nobody serves resolves to nothing", scopeOfCityId(API_CITIES, 999), null);
  is("…and a string id is still matched numerically", scopeOfCityId(API_CITIES, Number("7")), "DFW");
  is("the label prefers the abbr", cityLabel({ id: 1, name: "Austin", abbr: "ATX" }), "ATX");
  is("…and falls back to the name, never to a guess", cityLabel({ id: 1, name: "Austin", abbr: null }), "Austin");
  is("…and to the id when there is neither", cityLabel({ id: 42 }), "42");
  // TWO of the API's cities are NOT in CITY_SCOPES. If that stops being true this suite should say
  // so, because the confinement compare below leans on the API's abbr and not on our list.
  is("NYC and ELP are the two the API has and CITY_SCOPES does not",
     API_CITIES.map((c) => c.abbr).filter((a) => !CITY_IDENTIFIERS.includes(a)).sort(), ["ELP", "NYC"]);

  // ── CONFINEMENT IS THE ROUTE'S, ON THE PARSED IDENTITY — NOT A HIDDEN PICKER.
  /* A confined WAW account may add and remove in WAW and nowhere else. The decision is assertScope
   * against the abbr resolved from the requested cityId, so naming another city is REFUSED rather
   * than quietly re-pointed — and hiding the picker would not have been a boundary at all. */
  is("a confined WAW account may act on WAW", assertScope("WAW", scopeOfCityId(API_CITIES, 10), true).ok, true);
  is("…and is REFUSED Austin", assertScope("WAW", scopeOfCityId(API_CITIES, 1), true).ok, false);
  is("…with a 403, not a silent re-point", (assertScope("WAW", scopeOfCityId(API_CITIES, 1), true) as { status: number }).status, 403);
  is("an UNCONFINED Match Ops user may act on any city",
     API_CITIES.every((c) => assertScope(null, scopeOfCityId(API_CITIES, c.id), false).ok), true);
  is("a confined account whose city is not on the allowlist is refused everything",
     assertScope(null, "ATX", true).ok, false);

  const route = readFileSync("src/app/api/match-managers/route.ts", "utf8");
  const routeCode = route.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  if (/export async function POST/.test(routeCode)) ok("the route exposes POST"); else bad("the route exposes POST");
  if (/export async function DELETE/.test(routeCode)) ok("the route exposes DELETE"); else bad("the route exposes DELETE");
  if (/authenticateMatchOpsRead/.test(routeCode)) ok("both writes are on the MATCH OPS gate, not the admin one");
  else bad("both writes are on the Match Ops gate", "a confined city manager could not reach them");
  if (!/authenticateAdmin/.test(routeCode)) ok("…and not on authenticateAdmin"); else bad("…and not on authenticateAdmin");
  if (/assertScope\(auth\.confinedCity/.test(routeCode)) ok("the city boundary is checked on auth.confinedCity");
  else bad("the city boundary is checked on auth.confinedCity", "confinement would be UI-only");
  if (/scopeOfCityId\(cityRows/.test(routeCode)) ok("…against the abbr resolved from GET /cities by id");
  else bad("…against the abbr resolved from GET /cities by id");
  if (!/CITY_SCOPES|cityNameFor/.test(routeCode)) ok("the route never maps a city from OUR list");
  else bad("the route never maps a city from our list", "NYC and ELP would be lost");
  if (/recordWrite\(/.test(routeCode)) ok("every write goes through recordWrite into change_log");
  else bad("recordWrite is wired");
  /* NO PII IN THE LOG LINE. change_log has different access rules from the roster and must not
   * become a second copy of player contact details. The body is two integers. */
  if (/body: sent, keys: \["userId", "cityId"\]/.test(routeCode)) ok("the change_log body is two integers — no name, email or phone");
  else bad("the change_log body is two integers", "PII may be reaching change_log");
  if (!/manager_email|phoneNumber|\bp\.email\b/.test(routeCode)) ok("…and no contact field is named anywhere in the write path");
  else bad("…and no contact field is named in the write path");
  // THE VERDICT COMES FROM A READ-BACK, NOT A STATUS CODE.
  if (/applied: \(_before, after\) => \(after\.present === true\)/.test(routeCode))
    ok("LANDED is decided by whether the PAIR is in the roster afterwards");
  else bad("LANDED is decided by a read-back", "a 2xx would be taken as proof");
  if (/verdict === "LANDED"/.test(routeCode) && /"NOT APPLIED"/.test(routeCode) && /"UNKNOWN"/.test(routeCode) && /"FAILED"/.test(routeCode))
    ok("all four verdicts are reachable");
  else bad("all four verdicts are reachable");
  if (/outcome === "unknown" \? "UNKNOWN" : "FAILED"/.test(routeCode))
    ok("an ambiguous write reports UNKNOWN, so nobody retries it into a duplicate row");
  else bad("an ambiguous write reports UNKNOWN");

  // ── THE CONTROLS ARE ENABLED, AND BOTH CONFIRM FIRST.
  const panel = readFileSync("src/components/MatchManagersPanel.tsx", "utf8");
  const card = readFileSync("src/components/MatchManagerRosterCard.tsx", "utf8");
  for (const [file, src, ids] of [
    ["MatchManagersPanel", panel, ["mm-add", "mm-remove", "mm-confirm-go", "mm-confirm-cancel"]],
    ["MatchManagerRosterCard", card, ["mmr-add", "mmr-remove", "mmr-go", "mmr-cancel"]],
  ] as const) for (const id of ids)
    if (src.includes(`data-testid="${id}"`)) ok(`${file}: ${id} is on the page`); else bad(`${file}: ${id} is on the page`);
  /* A DISABLED CONTROL WOULD NOW BE THE BUG. These must be gated on the SERVER's canAdd/canRemove
   * and on `busy` — never on a local constant, and never hardcoded off. */
  if (/disabled=\{!data\?\.canAdd \|\| busy \|\| pickCity === ""\}/.test(card)) ok("the card's Add is gated on the server's canAdd, not disabled outright");
  else bad("the card's Add is gated on the server's canAdd");
  if (/disabled=\{!data\?\.canRemove \|\| busy\}/.test(card)) ok("the card's Remove is gated on the server's canRemove");
  else bad("the card's Remove is gated on the server's canRemove");
  if (/disabled=\{!data\.canRemove \|\| busy\}/.test(panel)) ok("the panel's Remove is gated on the server's canRemove");
  else bad("the panel's Remove is gated on the server's canRemove");
  if (/disabled=\{!data\.canAdd\}/.test(panel)) ok("the panel's Add is gated on the server's canAdd");
  else bad("the panel's Add is gated on the server's canAdd");
  // NOTHING MAY FIRE WITHOUT A CONFIRMATION: the fetch lives in commit(), and commit() is reached
  // only from the confirm button.
  for (const [file, src] of [["panel", panel], ["card", card]] as const) {
    const goes = (src.match(/onClick=\{\(\) => \{ void commit\(\); \}\}/g) ?? []).length;
    is(`${file}: exactly one control calls commit()`, goes, 1);
    if (/setPending\(\{\s*\n?\s*op: "remove"/.test(src) || /op: "remove", userId/.test(src)) ok(`${file}: Remove opens a confirmation instead of writing`);
    else bad(`${file}: Remove opens a confirmation`);
    if (/setPending\(null\)/.test(src)) ok(`${file}: Cancel clears it and sends nothing`);
    else bad(`${file}: Cancel clears it`);
  }
  if (/setPending\(\{ op: "add"/.test(card)) ok("card: Add opens a confirmation instead of writing");
  else bad("card: Add opens a confirmation");
  /* THE CARD MUST NOT CLAIM AN ABSENCE IT HAS NOT VERIFIED. `me` is null both when the person is
   * on no roster AND while the fetch is in flight; the first version rendered "Not a match manager
   * anywhere" for both, telling the operator something false about a real person. The browser
   * suite caught it by waiting for the card to have decided and finding it had already decided
   * wrong. `loaded` is what separates the two. */
  if (/const loaded = data !== null/.test(card)) ok("card: it distinguishes 'not loaded yet' from 'on no roster'");
  else bad("card: it distinguishes not-loaded from on-no-roster", "it would claim an absence before the fetch returns");
  if (/!loaded \? <span className="mmr-none" data-testid="mmr-loading"/.test(card)) ok("card: …and says it is still reading rather than 'not a match manager'");
  else bad("card: …and says it is still reading");

  // ── THE CONFIRMATIONS NAME THE PERSON, THE CITY AND THE CONSEQUENCE.
  const a = addConfirmLines({ name: "Marisol Reyes", cityLabel: "ATX" }).join(" ");
  const r = removeConfirmLines({ name: "Marisol Reyes", cityLabel: "ATX", matchesRun: 214 }).join(" ");
  for (const [what, txt] of [["add", a], ["remove", r]] as const) {
    if (txt.includes("Marisol Reyes")) ok(`${what} names the person`); else bad(`${what} names the person`, txt);
    if (txt.includes("ATX")) ok(`${what} names the city`); else bad(`${what} names the city`, txt);
    if (/never retried/i.test(txt)) ok(`${what} says it is never retried`); else bad(`${what} says it is never retried`, txt);
  }
  if (/Manager Pay pays them/i.test(a)) ok("add names the consequence — they become payable"); else bad("add names the consequence", a);
  if (/stop being assignable/i.test(r)) ok("remove names the consequence — they stop being assignable"); else bad("remove names the consequence", r);
  if (r.includes("214")) ok("remove says the matches already run stay paid"); else bad("remove says past matches stay paid", r);
  if (/have not run a match/i.test(removeConfirmLines({ name: "X", cityLabel: "ATX", matchesRun: 0 }).join(" ")))
    ok("…and says so plainly when there are none");
  else bad("…and says so plainly when there are none");

  // ── NO SECOND SEARCH BOX. This is the point of the whole feature.
  const boxes = (panel.match(/<input\b/g) ?? []).length;
  is("the panel still has exactly one input — the roster filter", boxes, 1);
  is("the CARD has no search box at all", (card.match(/<input\b/g) ?? []).length, 0);
  if (/privaterelay/i.test(SEARCH_NOTE) || /relay/i.test(SEARCH_NOTE)) ok("the on-screen note says why email-only search fails");
  else bad("the on-screen note says why email-only search fails", SEARCH_NOTE);
  if (/phone, email, name or ID/i.test(SEARCH_NOTE)) ok("…and names the four ways Player Lookup can find someone");
  else bad("…and names the four ways", SEARCH_NOTE);
  if (/admin\/players\?email=/.test(panel)) ok("the panel records WHICH Retool endpoint is email-only");
  else bad("the panel records which Retool endpoint is email-only");
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
