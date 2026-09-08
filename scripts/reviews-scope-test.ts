/* REVIEWS: THE CITY SCOPE, AND THE ROW FILTER THAT WAS EATING A WHOLE CITY.
 *
 * WHAT HAPPENED. A Warsaw operator's Reviews page showed 0 everywhere. The route was innocent:
 * /api/reviews returned HTTP 200 with all 51 Warsaw rows, correctly scoped. The client then threw
 * every one of them away in reviewsData.ts, because it required normalizeCity(city_name) to be
 * non-null and CSV_TO_COCKPIT_CITY has no Warsaw entry. The admin lost the same 51 silently.
 *
 * Two properties are asserted here and they pull in opposite directions, which is the point:
 *   - a scope that maps to NO city name must return NOTHING (never everything);
 *   - a city name the cockpit map has never heard of must NOT be dropped.
 */
import { readFileSync } from "node:fs";
import { rawCityNamesFor } from "../src/app/api/reviews/route";
import { canonCity } from "../src/lib/reviewsDerive";
import { normalizeCity } from "../src/lib/cityMap";
import { cityNameFor } from "../src/lib/cityScope";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const yes = (m: string, c: boolean, d = "") => (c ? ok(m) : bad(m, d));

console.log("\nThe scope resolves, including for the city cityMap has never heard of");
is("WAW resolves to the stored spelling", rawCityNamesFor("WAW"), ["Warsaw"]);
is("...which is what mdapi_reviews actually stores", cityNameFor("WAW"), "Warsaw");
for (const [id, want] of [["ATX", ["Austin"]], ["HOU", ["Houston"]], ["SATX", ["San Antonio"]],
                          ["STL", ["St. Louis"]], ["ATL", ["Atlanta"]], ["OKC", ["Oklahoma City"]],
                          ["DFW", ["Dallas / Fort Worth"]]] as [string, string[]][]) {
  is(`${id} still resolves as before`, rawCityNamesFor(id), want);
}
/* THE PROPERTY THAT MUST SURVIVE ANY FIX: an unknown scope filters on an EMPTY set, which returns
 * nothing. A confined account must never fall back to every city's reviews. */
is("an identifier nothing knows maps to NO city names", rawCityNamesFor("ZZZ"), []);
is("...and so does an empty one", rawCityNamesFor(""), []);
const route = readFileSync("src/app/api/reviews/route.ts", "utf8");
yes("the empty set is expressed as .in(), which returns nothing rather than everything",
  /q = q\.in\("city_name", names\);/.test(route));
yes("...and there is no fallback that widens an empty scope",
  !/names\.length \? [\s\S]{0,80}: q\b/.test(route) && !/if \(names\.length\)/.test(route));
/* AND THE SCOPE IS SESSION-DERIVED, never taken from the request. */
yes("a confined account cannot ask for another city", /403/.test(route) && /confinedCity/.test(route));

console.log("\nAn unmapped city name is canonicalised, not dropped");
/* THE BUG, STATED AS A TEST. normalizeCity is a bare lookup and returns null for Warsaw; canonCity
 * keeps it. Both are asserted so the difference cannot quietly go away. */
is("normalizeCity does not know Warsaw", normalizeCity("Warsaw"), null);
is("...and canonCity keeps it anyway", canonCity("Warsaw"), "Warsaw");
is("...which is the whole fix", canonCity("Warsaw") !== null && normalizeCity("Warsaw") === null, true);
/* IT DOES NOT DISTURB THE MAPPED ONES. */
is("a mapped raw name still canonicalises", canonCity("Dallas / Fort Worth"), "Dallas");
is("...and an already-canonical one stays itself", canonCity("Dallas"), "Dallas");
is("New York City is no longer silently discarded either", canonCity("New York City"), "New York City");
/* A ROW WITH NO CITY AT ALL IS STILL DROPPED — it cannot be grouped or filtered. */
is("an empty city is still falsy, so the row is still dropped", canonCity(null), "");
is("...and so is whitespace", canonCity("   "), "");

console.log("\nBoth review readers go through it");
for (const f of ["src/lib/reviewsData.ts", "src/lib/useReviewData.ts"]) {
  const src = readFileSync(f, "utf8");
  const name = f.split("/").pop();
  yes(`${name} canonicalises rather than requiring a known city`, /= canonCity\(r\.city_name\)/.test(src));
  is(`${name} no longer calls the bare normalizeCity on a row`, src.match(/= normalizeCity\(r\.city_name\)/g), null);
}

console.log("\nThe trailing strip claims nothing on an empty window");
{
  const page = readFileSync("src/app/(internal)/match-ops/reviews/ReviewsClient.tsx", "utf8");
  yes("the strip knows when it has nothing", /const empty = wk\.totalVolume === 0;/.test(page));
  yes("...and says so instead of printing 0.00", /empty \? \([\s\S]{0,200}No reviews in these 8 weeks\./.test(page));
  /* THE SENTENCE AND THE SCALES ARE INSIDE THE NON-EMPTY BRANCH. A rating range described on an
   * empty set is a default axis being narrated as data. */
  const branch = page.slice(page.indexOf("const empty = wk.totalVolume === 0;"));
  const emptyAt = branch.indexOf("No reviews in these 8 weeks.");
  for (const claim of ["Rating has moved between", "scale`", "data-rv=\"wavg\"", "data-rv=\"totvol\""]) {
    yes(`"${claim.slice(0, 24)}" renders only when there IS data`,
      branch.indexOf(claim) > emptyAt && /\}\)<\/>\)\}/.test(branch.replace(/\s/g, "")) === false || branch.indexOf(claim) > emptyAt);
  }
  /* CONTROL: the non-empty path is still fully there, so this is a branch and not a deletion. */
  yes("CONTROL: the real strip still renders its numbers", /wk\.weightedAvg\.toFixed\(2\)/.test(page) && /RatingChart wk=\{wk\}/.test(page));
  yes("...and its scale bands", /wk\.ratingLo\.toFixed\(2\)/.test(page) && /nf\(wk\.volHi\)/.test(page));
  /* NO EM-DASH IN THE STRIP'S COPY. */
  const strip = page.slice(page.indexOf('data-rv="trailing"'), page.indexOf("function ChartCol"));
  const rendered = strip.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  is("no em-dash in the strip's rendered copy", rendered.match(/—/g), null);
}

console.log(`\nreviews-scope: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
