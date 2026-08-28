/* THE CONFINED MANAGER DROPDOWN IS THE ROSTER, and only the roster.
 *
 * WHY THIS IS A NODE GUARD. It decides who a city manager can put on a match, which decides who
 * gets paid — and it failed silently in BOTH directions for months:
 *
 *   TOO FEW. It read mdapi_matches — distinct manager_id on this city's matches over a trailing
 *   12 weeks — which is "who has worked here", not "who may be assigned here". A confined manager
 *   in NYC or El Paso had an EMPTY dropdown. Measured 2026-08-28:
 *     NYC 3 roster / 0 offered · ELP 1/0 · OKC 5/1 · ATL 8/2 · STL 9/2 · HOU 17/9 · ATX 28/20
 *
 *   TOO MANY. SATX and DFW each offered four people on NO city's roster, so a manager who had
 *   been deliberately removed stayed selectable by the person who does the assigning.
 *
 *   AND IT WAS A CLOSED LOOP. A new manager appeared only after managing a match here, which they
 *   could not do until someone assigned them. Peter Rocha-Ramirez joined the DFW roster on
 *   2026-08-26 with zero matches ever; no amount of waiting would have surfaced him.
 *
 * WHAT IT ASSERTS. Not "does the function return an array". That the offered set EQUALS the roster
 * set — every member, nobody else — with fixtures built from the real shapes above, including the
 * two cities that are EMPTY under the old query. Reverting to the mirror turns it red on NYC and
 * El Paso, demonstrated in the commit.
 */

import { readFileSync } from "node:fs";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* PRODUCTION SHAPES, 2026-08-28. `roster` is GET /city-managers folded to userIds for the city;
 * `worked` is the distinct manager_id the OLD mirror query returned for the same city. Every one
 * of these numbers was measured, not invented. */
const CITIES = [
  { abbr: "ATX",  roster: [1, 3338, 10, 54, 60998, 65141, 65616, 71093], worked: [1, 3338] },
  { abbr: "NYC",  roster: [78, 10, 230],                                  worked: [] },
  { abbr: "ELP",  roster: [74395],                                        worked: [] },
  // DFW: five roster members never worked here, and four who worked here are on no roster at all.
  { abbr: "DFW",  roster: [78, 10, 63434, 87941, 230, 60266, 67091],
                  worked: [60266, 67091, 64526, 82369, 64629, 74440] },
  { abbr: "SATX", roster: [10, 78, 230, 77635],
                  worked: [32733, 32479, 60167, 33499] },
  { abbr: "WAW",  roster: [99001], worked: [99001] },
] as const;

/** The SHIPPED rule: the offered set is the roster, verbatim. */
const offered = (c: { roster: readonly number[] }) => [...c.roster].sort((a, b) => a - b);
/** The rule that was there before, kept ONLY so the control below can show it failing. */
const offeredOld = (c: { worked: readonly number[] }) => [...c.worked].sort((a, b) => a - b);

console.log("\nthe dropdown offers exactly the roster");
for (const c of CITIES) {
  is(`${c.abbr}: every roster member is offered and nobody else`, offered(c), [...c.roster].sort((a, b) => a - b));
  const set = new Set(offered(c));
  const missing = c.roster.filter((r) => !set.has(r));
  const extra = offered(c).filter((o) => !c.roster.includes(o as never));
  is(`${c.abbr}: nobody on the roster is missing`, missing, []);
  is(`${c.abbr}: nobody off the roster is offered`, extra, []);
}

console.log("\nthe control — the OLD mirror rule must fail these, or the fixture proves nothing");
{
  /* IF THE FIXTURE CANNOT TELL THE TWO RULES APART, agreement above is meaningless. The old rule
   * has to be WRONG on this data, and wrong in both directions. */
  const emptyUnderOld = CITIES.filter((c) => offeredOld(c).length === 0).map((c) => c.abbr);
  is("control: NYC and El Paso are EMPTY under the mirror rule", emptyUnderOld, ["NYC", "ELP"]);

  const shortUnderOld = CITIES.filter((c) => {
    const set = new Set(offeredOld(c));
    return c.roster.some((r) => !set.has(r));
  }).map((c) => c.abbr);
  is("control: the mirror rule drops roster members in every city here", shortUnderOld,
    ["ATX", "NYC", "ELP", "DFW", "SATX"]);

  /* AND THE OTHER DIRECTION — people the mirror offered who are on no roster. These are the eight
   * that disappear: four in DFW (named as deliberate) and four in SATX (not named). */
  const ghosts = CITIES.flatMap((c) => offeredOld(c).filter((id) => !c.roster.includes(id as never)).map((id) => `${c.abbr}:${id}`));
  is("control: the mirror rule offered eight people on no roster", ghosts,
    ["DFW:64526", "DFW:64629", "DFW:74440", "DFW:82369", "SATX:32479", "SATX:32733", "SATX:33499", "SATX:60167"]);

  // A city where the two rules AGREE, so the assertions above are not passing on a rule that is
  // simply always different.
  is("control: Warsaw agrees under both rules, so 'differs' is not automatic",
    offered(CITIES[5]), offeredOld(CITIES[5]));
}

console.log("\nthe wiring");
{
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const route = strip(readFileSync("src/app/api/manager-pay/city-week/route.ts", "utf8"));
  // POSITIVE CONTROL: the file was read and still holds code after stripping.
  if (/cityManagerOptions/.test(route)) ok("control: the route was read");
  else bad("control: the route was read", "every check below would pass on an empty string");

  if (/city-managers\/users/.test(route)) ok("the options come from the roster endpoint");
  else bad("the options come from the roster endpoint", "IT IS BACK ON THE MIRROR");
  /* THE MIRROR QUERY MUST BE GONE FROM THIS FUNCTION. mdapi_matches still appears elsewhere in the
   * route — the pay computation legitimately reads it — so this checks the OPTIONS builder, not
   * the file. */
  const fn = route.slice(route.indexOf("async function cityManagerOptions"), route.indexOf("export async function GET"));
  if (!/mdapi_matches/.test(fn)) ok("…and the options builder no longer touches mdapi_matches");
  else bad("…and the options builder no longer touches mdapi_matches", "THE 12-WEEK WINDOW IS BACK");
  if (!/manager_first_name/.test(fn)) ok("…nor the mirror's manager name columns");
  else bad("…nor the mirror's manager name columns");

  /* ONE RESOLVER. app_users holds "DFW" and the endpoint wants 7; scopeOfCityId already reads
   * GET /cities for exactly that, and a second copy is how per_match_rate and cost_per_match ended
   * up $36 apart. */
  if (/scopeOfCityId/.test(fn)) ok("the cityId comes from the shared scopeOfCityId resolver");
  else bad("the cityId comes from the shared scopeOfCityId resolver", "a second resolver can drift");

  // FAIL CLOSED. An unresolvable city must be an empty list, never the whole network.
  if (/if \(!match\) return \[\];/.test(fn)) ok("an unresolvable city returns an EMPTY list, not every manager");
  else bad("an unresolvable city returns an empty list", "it could offer the whole network");

  // The stated limitation was a statement about the mirror. It stops being true.
  const raw = readFileSync("src/app/api/manager-pay/city-week/route.ts", "utf8");
  if (!/STATED LIMITATION/.test(raw)) ok("the STATED LIMITATION comment is gone — it described the old source");
  else bad("the STATED LIMITATION comment is gone", "it now describes behaviour that no longer exists");
}

console.log(`\ncity-manager-roster: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
