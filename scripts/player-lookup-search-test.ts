import "server-only"; // no-op under --conditions=react-server
// PLAYER LOOKUP — THE SEARCH. The assertion that was never written, and the two it protects.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/player-lookup-search-test.ts
//
// WHY THIS EXISTS. For as long as Player Lookup has had a search, its own comment claimed
// /admin/players?email= was "a UNIVERSAL fuzzy match (it hits email, name AND phone-digits —
// confirmed live)". It hits email and phone. It does not hit name. Measured on production over
// anderson (18), smith (29), maria (37) and king (69): all 153 hits contain the term in their
// EMAIL, and there were ZERO name-only hits.
//
// It looked confirmed because most people's email contains their own name. Anderson King, id 395,
// email kinga11592@gmail.com, is the counterexample: his email holds "king" and not "anderson", so
// the app could never find him by his first name and always found him by his last.
//
// THE ONE ASSERTION THAT WOULD HAVE CAUGHT IT — a player whose NAME contains the term and whose
// EMAIL does not — is the first block below. There was never one. A comment asserting something
// nobody tested is what let this survive for the life of the feature.
//
// Two more things this pins, both of which were live bugs on the same screen:
//   · A TWO-WORD QUERY. One substring against an email; emails have no spaces, so "anderson king",
//     "john smith", "maria garcia" and "de la" returned exactly zero, always.
//   · THE HEADER. `${results.length} matches` over a hardcoded page of 15 — "15 matches" for terms
//     with 18, 69, 299 and 396 real hits. A false statement, not a rounding.

import {
  detectKind, serverQuery, usesMirror, splitNameTerms, matchesNameTerms, nameOrFilter,
  sanitizeNameTerm, resultHeader, pageCount, SEARCH_PAGE_SIZE,
} from "../src/lib/playerLookupModel";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

console.log("PLAYER LOOKUP · SEARCH\n");

/* THE FIXTURE IS THE REAL SHAPE. Every row here is a real production account, with the property
 * that broke the search preserved: a name that contains the term and an email that does not. */
type P = { id: number; first: string; last: string; email: string };
const PEOPLE: P[] = [
  // ── NAME-ONLY. The old search could not reach any of these. ──
  { id: 395, first: "Anderson", last: "King", email: "kinga11592@gmail.com" },
  { id: 7242, first: "anderson", last: "r", email: "aredd123123@gmail.com" },
  { id: 42778, first: "Anderson", last: "", email: "chele0626mejia@icloud.com" },
  // AND THE TWO THAT MATTER MOST: an Apple relay address contains NOTHING searchable at all, so a
  // name search is the only way anyone will ever find them.
  { id: 60580, first: "Anderson", last: "Salmeron", email: "cpvsj5vsf2@privaterelay.appleid.com" },
  { id: 6484, first: "Anderson", last: "Tercero", email: "jmv6v75b87@privaterelay.appleid.com" },
  // ── EMAIL-ONLY. These are what the old search actually returned, and they are NOT named Anderson.
  { id: 3021, first: "Colin", last: "", email: "colinbanderson2324@gmail.com" },
  { id: 7705, first: "Michael", last: "", email: "andersoncp25@gmail.com" },
  { id: 68201, first: "kael", last: "", email: "kaelwaanderson@gmail.com" },
  { id: 41256, first: "Ander", last: "Velasquez", email: "velasquez06anderson@gmail.com" },
  // ── BOTH, which is why the bug hid: most people's email contains their name.
  { id: 78299, first: "Anderson", last: "Moreno", email: "moreno.anderson1204@gmail.com" },
  { id: 72646, first: "wanderson", last: "vailante", email: "wandersonvailante2@gmail.com" },
];
const byName = (q: string) => PEOPLE.filter((p) => matchesNameTerms(p.first, p.last, splitNameTerms(q)));
const byEmail = (q: string) => PEOPLE.filter((p) => p.email.toLowerCase().includes(q.trim().toLowerCase()));

// ── 1. A NAME-ONLY MATCH. THIS IS THE ASSERTION THAT NEVER EXISTED. ──────────────────────────
console.log("the name-only match — a name that contains the term, an email that does not");
{
  const nameOnly = PEOPLE.filter((p) =>
    matchesNameTerms(p.first, p.last, ["anderson"]) && !p.email.toLowerCase().includes("anderson"));
  // POSITIVE CONTROL FIRST: the fixture genuinely contains such people, so the assertion below is
  // not passing over an empty set.
  is("control — the fixture holds name-only accounts", nameOnly.length, 5);
  for (const p of nameOnly) {
    if (byName("anderson").some((x) => x.id === p.id)) ok(`"anderson" finds ${p.first} ${p.last} (${p.id}) — email ${p.email} does NOT contain it`);
    else bad(`"anderson" finds ${p.first} ${p.last} (${p.id})`, "THE ORIGINAL BUG IS BACK");
  }
  // …and the old behaviour would have missed every one of them. This is the contrast, asserted.
  const oldWay = byEmail("anderson");
  for (const p of nameOnly)
    if (!oldWay.some((x) => x.id === p.id)) ok(`…and the email-only search would have missed ${p.id}`);
    else bad(`the email-only search would have missed ${p.id}`, "the fixture is not reproducing the bug");
  is("Anderson King is findable by his FIRST name", byName("anderson").some((p) => p.id === 395), true);
  is("…and by his LAST, which always worked", byName("king").some((p) => p.id === 395), true);
  /* AN APPLE RELAY ADDRESS HAS NOTHING SEARCHABLE IN IT. For those two accounts a name search is
   * not a convenience, it is the only route that exists. */
  for (const id of [60580, 6484]) {
    const p = PEOPLE.find((x) => x.id === id)!;
    is(`relay account ${id} is reachable by name`, byName("anderson").some((x) => x.id === id), true);
    is(`…and by nothing in its email`, /anderson/i.test(p.email), false);
  }
}

// ── 2. A NAME NEVER GOES TO ?email= AGAIN ────────────────────────────────────────────────────
console.log("\nrouting: a name is not an upstream question");
{
  is("a name uses the mirror", usesMirror(detectKind("anderson king").kind), true);
  is("an email does not", usesMirror(detectKind("a@b.com").kind), false);
  is("a phone does not", usesMirror(detectKind("+1 512 555 0000").kind), false);
  is("an id does not", usesMirror(detectKind("395").kind), false);
  is("an id still goes to the exact ?id=", serverQuery(detectKind("395")), { id: "395" });
  is("a phone still goes to ?email= as digits", serverQuery(detectKind("(512) 555-0000")), { email: "5125550000" });
  is("an email still goes to ?email=", serverQuery(detectKind("A@B.com")), { email: "a@b.com" });
  /* serverQuery USED TO END `return { email: d.norm }` FOR EVERYTHING — that fall-through IS the
   * bug. It throws on a name now, so the old behaviour cannot be reintroduced by accident. */
  let threw = false;
  try { serverQuery(detectKind("anderson king")); } catch { threw = true; }
  is("serverQuery REFUSES a name rather than falling through to ?email=", threw, true);

  const route = readFileSync("src/app/api/lookup/[env]/route.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  if (!/limit: 15/.test(route)) ok("the hardcoded limit: 15 is gone from the route");
  else bad("the hardcoded limit: 15 is gone", "it is still there");
  // POSITIVE CONTROL: the pattern does find that form when it is present.
  is("control — the pattern finds limit: 15 when it is there", /limit: 15/.test("{ ...q, limit: 15, page: 1 }"), true);
  if (/totalItems/.test(route)) ok("the route reads totalItems, which it never used to");
  else bad("the route reads totalItems");
  if (/usesMirror\(d\.kind\)/.test(route)) ok("the route branches on usesMirror");
  else bad("the route branches on usesMirror");
  if (/count: "exact"/.test(route)) ok("the mirror path counts exactly, so its total is real");
  else bad("the mirror path counts exactly");
  if (/if \(error\) return Response\.json/.test(route)) ok("a failed mirror query is an error, not an empty result");
  else bad("a failed mirror query is an error", "`?.length ?? 0` would render a swallowed error as zero");
}

// ── 3. THE SPACE ─────────────────────────────────────────────────────────────────────────────
console.log("\ntwo words: two predicates, not one impossible substring");
{
  is("a two-word query splits", splitNameTerms("anderson king"), ["anderson", "king"]);
  is("order does not matter", splitNameTerms("king anderson").sort(), ["anderson", "king"]);
  is("case does not matter", splitNameTerms("ANDERSON King"), ["anderson", "king"]);
  is("runs of whitespace collapse", splitNameTerms("  anderson \t  king  "), ["anderson", "king"]);
  is("a repeated word is not scanned twice", splitNameTerms("john john"), ["john"]);
  is("an empty query yields no terms", splitNameTerms("   "), []);
  is('"anderson king" finds exactly one person', byName("anderson king").map((p) => p.id), [395]);
  is('"king anderson" finds the same person', byName("king anderson").map((p) => p.id), [395]);
  is('"ANDERSON KING" too', byName("ANDERSON KING").map((p) => p.id), [395]);
  is("EVERY term must match — a wrong second word finds nobody", byName("anderson zzzz").length, 0);
  // POSITIVE CONTROL for that zero: drop the bad word and the same matcher finds him.
  is("control — the same matcher finds him without the bad word", byName("anderson").length > 0, true);
  is("no terms matches nobody, rather than everybody", matchesNameTerms("Anderson", "King", []), false);
  is("a substring of one name part is enough", byName("ander").length > 0, true);
  is("both parts are searched — a last name alone works", byName("salmeron").map((p) => p.id), [60580]);
}

// ── 4. THE QUERY FORM AGREES WITH THE SPEC ───────────────────────────────────────────────────
console.log("\nthe PostgREST filter says what the spec says");
{
  is("one term becomes an OR over both name columns", nameOrFilter("anderson"),
     "first_name.ilike.%anderson%,last_name.ilike.%anderson%");
  is("a term that sanitises to nothing produces no filter", nameOrFilter("%%"), null);
  is("a comma cannot break out of PostgREST's or()", sanitizeNameTerm("ander,son"), "anderson");
  is("nor a paren", sanitizeNameTerm("ander(son)"), "anderson");
  is("nor a wildcard", sanitizeNameTerm("%ander%"), "ander");
  is("nor a backslash", sanitizeNameTerm("ander\\son"), "anderson");
  is("an ordinary name is untouched", sanitizeNameTerm("o'brien-smith"), "o'brien-smith");
  // The filter is built from the SAME split the spec uses, so both halves see the same terms.
  is("both halves consume the same terms", splitNameTerms("anderson king").map(nameOrFilter), [
    "first_name.ilike.%anderson%,last_name.ilike.%anderson%",
    "first_name.ilike.%king%,last_name.ilike.%king%",
  ]);
}

// ── 5. THE HEADER SAYS THE TOTAL, NOT THE PAGE SIZE ──────────────────────────────────────────
console.log("\nthe header: a total, or an admission that there isn't one");
{
  /* THE EXACT SHAPE OF THE OLD LIE. A page of 15 over 18 real hits printed "15 matches". Every one
   * of fifteen common terms exceeds 15 — king 69, john 122, jose 299, ana 396 — so it was wrong on
   * all of them, and because results are ordered by first name the rows it dropped were always the
   * end of the alphabet. */
  is("a page that is smaller than the total says so", resultHeader(15, { known: true, total: 18 }, 1, 15), "Showing 1–15 of 18");
  is("…and never just the page size", resultHeader(15, { known: true, total: 18 }, 1, 15).startsWith("15 match"), false);
  // page 2 of 18 at a page size of 15 holds THREE rows, not fifteen — the range is built from what
  // is actually on screen, so a short last page cannot claim to be full.
  is("page 2 counts from where page 1 stopped", resultHeader(3, { known: true, total: 18 }, 2, 15), "Showing 16–18 of 18");
  is("a page 2 of 25 too", resultHeader(25, { known: true, total: 278 }, 2, 25), "Showing 26–50 of 278");
  is("a complete first page just states the total", resultHeader(18, { known: true, total: 18 }, 1, 25), "18 matches");
  is("one match is singular", resultHeader(1, { known: true, total: 1 }, 1, 25), "1 match");
  is("no matches says so", resultHeader(0, { known: true, total: 0 }), "No matches");
  /* WHEN THE TOTAL IS NOT KNOWN IT IS NOT INVENTED. A confined account's page is filtered AFTER
   * the API counts, so the API's totalItems is somebody else's number — printing it would tell a
   * Warsaw operator there are 69 matches when four are on screen. */
  is("an unknown total is admitted, not guessed", resultHeader(4, { known: false }), "Showing 4 matches — the total is not known");
  is("…and carries no invented figure", /\bof \d+/.test(resultHeader(4, { known: false })), false);
  is("…singular too", resultHeader(1, { known: false }), "Showing 1 match — the total is not known");

  is("there is more than one page when the total exceeds the page", pageCount(18, 15), 2);
  is("278 over 25 is twelve pages", pageCount(278, 25), 12);
  is("an exact fit is not an extra empty page", pageCount(50, 25), 2);
  is("zero results is still one page", pageCount(0, 25), 1);
  is("the page size is a named constant, not a literal in a route", SEARCH_PAGE_SIZE, 25);

  const ui = readFileSync("src/components/PlayerLookup.tsx", "utf8");
  const uiCode = ui.replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  if (!/\$\{results\.length\} match/.test(uiCode)) ok("the header no longer counts the rows on screen");
  else bad("the header no longer counts the rows on screen", "it still prints results.length");
  if (/resultHeader\(/.test(uiCode)) ok("…it asks resultHeader, which knows about totals");
  else bad("…it asks resultHeader");
  for (const t of ["res-count", "res-pager", "res-prev", "res-next", "res-mirror-note"])
    if (ui.includes(`data-testid="${t}"`)) ok(`${t} is on the page`); else bad(`${t} is on the page`);
  if (/runSearch\(q, meta\.page \+ 1\)/.test(uiCode)) ok("Next actually fetches the next page");
  else bad("Next fetches the next page");
  if (/runSearch\(q, 1\)/.test(uiCode)) ok("a new term restarts at page 1");
  else bad("a new term restarts at page 1", "a stale page would show an empty list");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
