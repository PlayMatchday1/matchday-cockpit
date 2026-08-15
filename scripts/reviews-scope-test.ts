import "server-only"; // no-op under --conditions=react-server
// Phase 29 Part B — reviews scoped on the SERVER.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/reviews-scope-test.ts

import { readFileSync } from "node:fs";
import { rawCityNamesFor } from "../src/app/api/reviews/route";
import { cityManagerGate } from "../src/lib/cityManagerAuth";
import { adminGate } from "../src/lib/adminAuth";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) => (got === want ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const eq = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);

console.log("\nTHE IDENTIFIER → city_name JOIN (mdapi_reviews stores the name, the scope is an abbr)");
eq("DFW resolves to the platform's own label, which is NOT the cockpit display name",
  rawCityNamesFor("DFW"), ["Dallas / Fort Worth"]);
eq("OKC likewise", rawCityNamesFor("OKC"), ["Oklahoma City"]);
eq("ATX", rawCityNamesFor("ATX"), ["Austin"]);
eq("STL", rawCityNamesFor("STL"), ["St. Louis"]);
eq("an unknown identifier maps to NO city names — which filters to nothing, never everything",
  rawCityNamesFor("NOPE"), []);
is("every one of the seven scopes maps to at least one city_name",
  ["ATL", "ATX", "DFW", "HOU", "OKC", "SATX", "STL"].every((i) => rawCityNamesFor(i).length > 0), true);

console.log("\nTHE SCOPE COMES FROM THE SESSION — the gates that decide it");
{
  const CM = { is_city_manager: true, city_identifier: "DFW" };
  const g = cityManagerGate(CM, "cm@x.com");
  is("a city manager's scope is read from their row", g.ok && g.cityIdentifier, "DFW");
  is("a city manager is NOT an admin", adminGate(CM).ok, false);
  is("an admin is not a city manager — the gate refuses them (no city to scope to)",
    cityManagerGate({ is_admin: true }, "a@x.com").ok, false);
  is("a city manager with NO city is refused, not given everything",
    cityManagerGate({ is_city_manager: true, city_identifier: null }, "cm@x.com").ok, false);
  is("...and a blank city likewise", cityManagerGate({ is_city_manager: true, city_identifier: "  " }, "cm@x.com").ok, false);
  is("the E2E service account is refused", cityManagerGate({ is_city_manager: true, city_identifier: "DFW" }, "clubhouse-e2e@playmatchday.com").ok, false);
}

console.log("\nTHE ROUTE — read the source for the rules a unit test cannot execute");
{
  const src = readFileSync("src/app/api/reviews/route.ts", "utf8");
  is("the session row is read FRESH on every request (no JWT caching)", /resolveSessionUser\(req\)/.test(src), true);
  is("neither admin nor city manager is refused", /Admin or the City Manager tier/.test(src), true);
  is("a CITY MANAGER's scope is taken from the gate, not the query string",
    /scopeIdentifier = cm\.ok \? cm\.cityIdentifier : null/.test(src), true);
  is("...and a mismatched ?city= is REFUSED with a 403", /asked !== scopeIdentifier[\s\S]{0,400}status: 403/.test(src), true);
  is("...naming what they are scoped to, so the refusal is legible", /You are scoped to \$\{scopeIdentifier\}/.test(src), true);
  is("an admin may ask for ONE city", /scopeIdentifier = asked;/.test(src), true);
  is("...and gets everything when they do not", /scopeIdentifier = null;/.test(src), true);
  is("an admin's unknown ?city= is refused rather than widened back to everything",
    /is not a known city[\s\S]{0,80}status: 400/.test(src), true);
  is("the filter is pushed into the QUERY, not applied after fetching", /q\.in\("city_name", names\)/.test(src), true);
  is("...and an unmapped scope filters to NOTHING, stated so nobody 'fixes' it",
    /must return NOTHING, never everything/.test(src), true);
  is("pagination happens SERVER-side, over the scoped rows only", /q\.range\(from, from \+ PAGE - 1\)/.test(src), true);
  is("the counts are computed from the SCOPED rows", src.indexOf("q.in(\"city_name\"") < src.indexOf("const rated ="), true);
  is("...including the leaderboard", /byCity: \[\.\.\.byCity\.entries\(\)\]/.test(src), true);
  is("the answered/unanswered split is derived here too", /withComment[\s\S]{0,120}withoutComment/.test(src), true);
  is("the rows are ordered by match start", /order\("start_date", \{ ascending: true \}\)/.test(src), true);
}

console.log("\nTHE ADMIN PAGE NO LONGER PULLS THE WHOLE TABLE");
{
  // The seam is useCleanReviews — repointing it moves the ADMIN page and every other consumer at
  // once, which is why the assertion is on the data module rather than one component.
  const data = readFileSync("src/lib/reviewsData.ts", "utf8");
  is("the reviews data path calls the scoped endpoint", /fetch\(`\/api\/reviews\$\{qs\}`/.test(data), true);
  is("...and useCleanReviews no longer sources rows from useReviewData's full-table read",
    /useCleanReviews\(\): CleanReviews \{\s*const \{ rows[^}]*\} = useScopedReviews\(\)/.test(data), true);
  is("...so the ~23k-row client pagination is off this path", /= useReviewData\(\);/.test(data), false);
  const client = readFileSync("src/app/(internal)/match-ops/reviews/ReviewsClient.tsx", "utf8");
  is("the admin page still derives everything from useCleanReviews (unchanged contract)",
    /useCleanReviews\(\)/.test(client), true);
}

// PHASE 29c REWROTE THIS BLOCK, and it is a behaviour change, not a selector-path edit — four of
// the assertions below used to describe things that are now deliberately gone:
//   • CityNav.tsx (the bespoke top pill row) is DELETED; the tier renders the app's own rail.
//   • the city Reviews page no longer calls useScopedReviews itself — it renders the REAL
//     ReviewsClient, which reaches the same scoped endpoint through useCleanReviews.
//   • "Scoped on the server to your city…" was REMOVED on purpose (the brief: the city is already
//     in the heading and the locked control).
//   • Manager Pay no longer renders <CityNav /> — the layout carries navigation for all three.
// What has NOT changed is what these assertions are for: the tier is navigable, its Reviews page
// is server-scoped, and a non-tier account is refused. Those are re-asserted against the new shape.
console.log("\nTHE NAV — the app's own rail, not a bespoke one");
{
  const secs = readFileSync("src/app/(internal)/city/citySections.tsx", "utf8");
  is("the city-manager nav carries a Reviews item", /href: "\/city\/reviews"/.test(secs), true);
  is("...alongside Manager Pay, which was the tier's only page before", /href: "\/city\/manager-pay"/.test(secs), true);
  is("...and Gameday Ops", /href: "\/city\/gameday"/.test(secs), true);
  is("...with icons taken from MATCH_OPS_SECTIONS by key, never copied path data",
    /iconFor\("manager-pay"\)/.test(secs) && !/<svg/.test(secs), true);

  const layout = readFileSync("src/app/(internal)/city/layout.tsx", "utf8");
  is("the tier mounts the app's SHARED rail, not a second implementation", /<ChatsRail\b/.test(layout), true);
  is("...with the Daily Ops / Back Office switch OFF, because it has one section",
    /showSwitch=\{false\}/.test(layout), true);
  // On the JSX, not the name: the file's header explains WHY the provider is absent, and a bare
  // text search counts that explanation as the thing it forbids. (This exact trap bit twice in one
  // sitting — a source-text assertion must target something only real code can produce.)
  is("...and NO CRM provider is MOUNTED, since this tier holds no chats grant",
    /<CrmConversationProvider/.test(layout), false);

  const page = readFileSync("src/app/(internal)/city/reviews/page.tsx", "utf8");
  is("the city Reviews page renders the REAL ReviewsClient, not a rebuild", /<ReviewsClient\b/.test(page), true);
  is("...locked to one city in the UI", /lockedCity=\{lockedCity\}/.test(page), true);
  is("...and holds no city filter of its own to be bypassed", /\?city=/.test(page), false);
  // Asserted on the ELEMENT, not on the phrase: the file's header comment explains why the line
  // was removed, and a text search cannot tell a comment from rendered copy. The rendered text is
  // checked for real in verify-city-confinement, against the actual page.
  is("...and no longer explains its own scoping in prose", /data-testid="cr-scope-note"/.test(page), false);
  is("a non-city-manager, non-admin is refused by the page too", /data-testid="cr-denied"/.test(page), true);

  // THE LOCK IS NOT THE SECURITY, and the page must not read as though it were: scoping is the
  // endpoint's job. This pins that the page never passes a city to the DATA layer.
  const client = readFileSync("src/app/(internal)/match-ops/reviews/ReviewsClient.tsx", "utf8");
  is("lockedCity drives the CONTROL only — the data hook is still called with no city",
    /useCleanReviews\(\)/.test(client), true);
}

console.log("\nMUTATION — prove the payload assertion can fail");
{
  // The check the browser suite makes: every returned row belongs to the scoped city. Here it is
  // as data, run against a correct payload and against one with the scope check removed.
  const scopedNames = rawCityNamesFor("DFW");
  const dfwOnly = [{ city_name: "Dallas / Fort Worth" }, { city_name: "Dallas / Fort Worth" }];
  const unscoped = [{ city_name: "Dallas / Fort Worth" }, { city_name: "Houston" }];
  const allOneCity = (rows: { city_name: string }[]) => rows.every((r) => scopedNames.includes(r.city_name));
  is("a correctly scoped payload contains exactly one city", allOneCity(dfwOnly), true);
  is("MUTATION — with the scope check removed, the payload carries another city and the assertion FAILS",
    allOneCity(unscoped), false);
  is("...and the leak is a real one: the extra row is a different city's review",
    unscoped.filter((r) => !scopedNames.includes(r.city_name)).map((r) => r.city_name).join(","), "Houston");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
