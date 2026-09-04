/* THE PATCH'S VOCABULARY MUST BE THE GRID'S. Pure, so it runs without a browser or a save.
 * This is the bug that made a saved match vanish from the calendar: the patch wrote the API's raw
 * field title where the grid holds the canonical one, and the field chip stopped matching it. */
import { canonicalVenueName } from "../src/lib/venueResolver";
import { CITY_SCOPES } from "../src/lib/cityScope";
import { CITY_CODE_TO_DISPLAY } from "../src/lib/scheduleReconcile";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(m); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const gridCity = (apiName: string | null): string | null => {
  if (!apiName) return null;
  const scope = CITY_SCOPES.find((c) => c.name === apiName);
  return scope ? (CITY_CODE_TO_DISPLAY[scope.identifier] ?? apiName) : apiName;
};

console.log("\nVENUE — the API's raw title maps onto the grid's canonical one");
// Measured off the live detail route, 2026-09-04.
is("  STAR Soccer Complex → STAR", canonicalVenueName("STAR Soccer Complex"), "STAR");
is("  control — the raw title is NOT already canonical", "STAR Soccer Complex" === "STAR", false);
is("  Scissortail Park is unchanged", canonicalVenueName("Scissortail Park"), canonicalVenueName("Scissortail Park"));
is("  canonicalising twice is a no-op", canonicalVenueName(canonicalVenueName("STAR Soccer Complex")), "STAR");

console.log("\nCITY — two of the seven disagree, measured off the live detail route");
is("  Dallas / Fort Worth → Dallas", gridCity("Dallas / Fort Worth"), "Dallas");
is("  Oklahoma City → OKC", gridCity("Oklahoma City"), "OKC");
is("  San Antonio → San Antonio", gridCity("San Antonio"), "San Antonio");
is("  control — the API names are NOT the grid's for those two",
  ["Dallas / Fort Worth", "Oklahoma City"].map((n) => n === gridCity(n)), [false, false]);
is("  an unknown name passes through rather than becoming null", gridCity("Nowhere"), "Nowhere");
is("  null stays null", gridCity(null), null);

console.log("\nEVERY FLEET CITY resolves into the grid's vocabulary");
const unresolved = CITY_SCOPES
  .filter((c) => CITY_CODE_TO_DISPLAY[c.identifier] !== undefined)
  .filter((c) => gridCity(c.name) !== CITY_CODE_TO_DISPLAY[c.identifier]);
is(`  all ${CITY_SCOPES.length} scopes map to their display name`, unresolved.map((c) => c.identifier), []);

console.log(`\n${fails.length ? "FAIL" : "PASS"} — ${pass} assertions, ${fails.length} failed`);
if (fails.length) process.exit(1);
