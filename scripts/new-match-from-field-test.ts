/* NEW MATCH ON A FIELD — the body, and the one failure it must not repeat.
 *
 * IN THE MANDATORY SET because the body is a live match on production MatchDay the moment it lands,
 * and the failure is silent: production 18408 went live at $0 because registrationPrice was absent
 * and the API defaults it to 0. A blank match has no source to inherit a price from, so the body
 * builder must refuse rather than omit.
 *
 * Also the city directory's two filters, because "Philadelphia appears, El Paso and New York do
 * not" is the whole of what Ryan asked the city lists to do (2026-10-28).
 */
import { newMatchTemplate, newMatchBody, missingForNewMatch, NEW_MATCH_TEAMS } from "../src/lib/newMatchFromField";
import { buildCityDirectory, citiesWithFields, fieldFormCities } from "../src/lib/cityDirectory";
import { timezoneFor } from "../src/lib/cityTimezones";
import { normalizeCityName } from "../src/lib/cityNormalization";
import { taxRateFor } from "../src/lib/salesTax";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(m); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const throws = (m: string, f: () => unknown) => { try { f(); bad(m, "did not throw"); } catch { ok(m); } };

const tpl = newMatchTemplate({ id: 2113, title: "Friends Select School", cityName: "Philadelphia" });
const filled = {
  ...tpl, name: "Philly Friday 9v9", description: "Pickup",
  registrationPrice: 1200, minPlayerCount: 12, maxPlayerCount: 18, maxTeamSize2Team: 18, maxTeamSize4Team: 0,
};

console.log("\nTHE TEMPLATE ARRIVES WITHOUT A PRICE OR A CAPACITY");
is("  price is blank", tpl.registrationPrice, null);
is("  capacity is blank", tpl.maxPlayerCount, null);
is("  the field is set", tpl.fieldId, 2113);
is("  two teams", (tpl.teams as unknown[]).length, NEW_MATCH_TEAMS);

console.log("\nA MISSING PRICE IS REFUSED, NEVER OMITTED");
is("  blank template names every required value",
  missingForNewMatch(tpl, "", ""),
  ["Name", "Description", "Price", "Min players", "Capacity now", "Max spots, 2 teams", "Max spots, 4 teams", "Start", "End"]);
throws("  the body builder throws without a price", () => newMatchBody({ ...filled, registrationPrice: null }, "2026-11-06T19:00", "2026-11-06T20:30"));
throws("  … and on a cleared price box (\"\")", () => newMatchBody({ ...filled, registrationPrice: "" }, "2026-11-06T19:00", "2026-11-06T20:30"));
throws("  … and without a start", () => newMatchBody(filled, "", "2026-11-06T20:30"));
is("  a typed 0 is a decision, and is sent", newMatchBody({ ...filled, registrationPrice: 0 }, "2026-11-06T19:00", "2026-11-06T20:30").registrationPrice, 0);

console.log("\nTHE BODY");
const b = newMatchBody(filled, "2026-11-06T19:00", "2026-11-06T20:30");
is("  price in cents, as typed", b.registrationPrice, 1200);
is("  wall clock, string-built, the API's Z shape", [b.startDate, b.endDate], ["2026-11-06T19:00:00.000Z", "2026-11-06T20:30:00.000Z"]);
is("  teamNumbers", b.teamNumbers, 2);
is("  a 4-team total of 0 is a value, and is sent", b.maxTeamSize4Team, 0);
is("  no null is sent for an unset manager", "managerId" in b, false);
is("  no null is sent for the add-on spot price", "additionalSpotPrice" in b, false);
is("  no null rung is sent (the route fills the default ladder)", "fakeSpotLeft36h" in b, false);
is("  pre-filled settings travel", [b.autoCanceled, b.autoCanceledMinutes, b.isFreeMember, b.guestCount], [true, 75, true, 10]);

console.log("\nTHE CITY DIRECTORY — Philadelphia in, El Paso and New York out, Warsaw unchanged");
// Shaped as GET /cities and /admin/fields answered on 2026-10-28 (trimmed to what is read).
const cities = [
  { id: 1, name: "Austin", abbr: "ATX" }, { id: 6, name: "New York City", abbr: "NYC" },
  { id: 7, name: "Dallas / Fort Worth", abbr: "DFW" }, { id: 9, name: "El Paso", abbr: "ELP" },
  { id: 10, name: "Warsaw", abbr: "WAW" }, { id: 234, name: "Philadelphia", abbr: "PHL", timeZone: { name: "America/New_York" } },
];
const fields = [
  { id: 1, title: "Q2", cityId: 1 }, { id: 2, title: "STAR", cityId: 7 }, { id: 1684, title: "Hala", cityId: 10 },
  { id: 2113, title: "Friends Select School", cityId: 234 },
  // A field in an excluded city — the case the exclusion exists for (none exists today).
  { id: 9999, title: "Hypothetical El Paso field", cityId: 9 },
];
const dir = buildCityDirectory(cities, fields);
is("  Master Schedule cities (a field each, less ELP/NYC)", citiesWithFields(dir).map((c) => c.display), ["Austin", "Dallas", "Philadelphia", "Warsaw"]);
is("  New field form cities (every city, less ELP/NYC)", fieldFormCities(dir).map((c) => c.name).sort(),
  ["Austin", "Dallas / Fort Worth", "Philadelphia", "Warsaw"]);
is("  Philadelphia's field is listed under it", dir.find((c) => c.abbr === "PHL")?.fields, [{ id: 2113, title: "Friends Select School" }]);
is("  control — El Paso DOES have a field in this fixture, so its absence is the exclusion", dir.find((c) => c.abbr === "ELP")?.fields.length, 1);

console.log("\nPHILADELPHIA IS EASTERN");
is("  PHL → America/New_York", timezoneFor("PHL"), "America/New_York");
is("  \"Philadelphia\" normalizes to PHL", normalizeCityName("Philadelphia"), "PHL");
is("  sales tax 8% (GET /cities stripeTaxRateValue)", taxRateFor("Philadelphia"), 0.08);

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAIL ${f}`); process.exit(1); }
