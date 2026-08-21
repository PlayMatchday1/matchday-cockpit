// THE CITY BOUNDARY — the decision, tested offline for every row shape that matters.
//
// THE ONE THAT MATTERS MOST is confinement-beats-is_admin. It is the opposite of the city-manager
// rule and someone will eventually "fix" the inconsistency; this fails when they do.
import assert from "node:assert/strict";
import { isConfined, confinedCity, confinedCityName, assertConfinedScope, CONFINED_CAPABILITIES, CONFINED_RAIL_KEYS, confinementSummary } from "../src/lib/cityConfinement";
import { can } from "../src/lib/capabilities";

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log(`  ✓ ${name}`); };

const WAW = { city_identifier: "WAW", can_access_matchops: true, can_access_chats: true } as never;
const WAW_ADMIN = { ...(WAW as object), is_admin: true } as never;
const FREE = { is_admin: true, can_access_matchops: true, can_access_chats: true } as never;
const JUNK = { city_identifier: "waw ", can_access_matchops: true } as never;

console.log("\n── the predicate ──");
// ONE COLUMN. city_identifier is the city, for city managers and confined accounts alike; 0131's
// second column was dropped by 0132 after the check proved no account carried one without the
// other. A test that still named confined_to_city would pass against a column nothing reads.
t("a value confines", () => assert.equal(isConfined(WAW), true));
t("null does not", () => assert.equal(isConfined(FREE), false));
t("an unrecognised value STILL confines — safe direction", () => assert.equal(isConfined(JUNK), true));
t("  …and resolves to no city, so every scoped query matches nothing", () => assert.equal(confinedCity(JUNK), null));
t("WAW resolves", () => assert.equal(confinedCity(WAW), "WAW"));
t("  …and maps to Warsaw in ONE place", () => assert.equal(confinedCityName(WAW), "Warsaw"));

console.log("\n── confinement beats is_admin ──");
t("a confined admin is still confined", () => assert.equal(isConfined(WAW_ADMIN), true));
t("  …and is refused a page outside the six", () => assert.equal(can(WAW_ADMIN, "finance"), false));
t("  …and tech", () => assert.equal(can(WAW_ADMIN, "tech"), false));
t("  …and grantAccess, which is is_admin's ONE remaining meaning", () => assert.equal(can(WAW_ADMIN, "grantAccess"), false));
t("an UNCONFINED admin still gets finance — nothing else moved", () => assert.equal(can(FREE, "finance"), true));

console.log("\n── the six still resolve ──");
for (const cap of ["matchops", "chats"] as const) {
  t(`${cap} resolves true for a confined account`, () => assert.equal(can(WAW, cap), true));
}
t("  control — the set names exactly those two", () => assert.deepEqual([...CONFINED_CAPABILITIES].sort(), ["chats", "matchops"]));
t("write grants still hang off their own column, not the boundary", () => {
  assert.equal(can(WAW, "managePromos"), false);                       // box unticked
  assert.equal(can({ ...(WAW as object), can_manage_promos: true } as never, "managePromos"), true);
});

console.log("\n── naming another city ──");
t("naming your own city is fine", () => assert.equal(assertConfinedScope(WAW, "WAW").ok, true));
t("naming another city is 403", () => {
  const r = assertConfinedScope(WAW, "ATX");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 403);
});
t("  …case and whitespace do not sneak through", () => assert.equal(assertConfinedScope(WAW, "waw").ok, false));
t("naming nothing applies your own scope", () => assert.equal(assertConfinedScope(WAW, null).ok, true));
t("an unconfined account is never refused", () => assert.equal(assertConfinedScope(FREE, "ATX").ok, true));
t("a junk-confined account is refused any named city", () => assert.equal(assertConfinedScope(JUNK, "ATX").ok, false));

console.log("\n── the sentence on the User access screen ──");
// THE SAME CITY, TWO SHAPES, TWO ANSWERS. A city manager gets the /city/* pages; a confined
// non-manager gets the Match Ops six. One sentence for both would be false for four of the five
// city managers who exist today.
{
  const cm = confinementSummary({ cityName: "Dallas / Fort Worth", isCityManager: true, pageCount: 3 });
  const waw = confinementSummary({ cityName: "Warsaw", isCityManager: false, pageCount: CONFINED_RAIL_KEYS.length });
  t("a city manager is told about city manager pages", () => assert.match(cm, /city manager pages only$/));
  t("  …and NOT about Match Ops", () => assert.equal(/Match Ops/.test(cm), false));
  t("a confined non-manager is told about Match Ops pages", () => assert.match(waw, /Match Ops pages only$/));
  t("  …and NOT about city manager pages", () => assert.equal(/city manager/.test(waw), false));
  t("the two sentences differ for the same control", () => assert.notEqual(cm, waw));
  // THE COUNT IS THE LIST'S LENGTH, NOT A WORD. "six" written down is wrong the first time
  // somebody adds a seventh page, and wrong silently.
  t(`the Match Ops count is CONFINED_RAIL_KEYS.length (${CONFINED_RAIL_KEYS.length})`,
    () => assert.match(waw, new RegExp(`— ${CONFINED_RAIL_KEYS.length} Match Ops`)));
  t("  …and no sentence hardcodes a number word", () => {
    assert.equal(/\b(six|three|seven)\b/i.test(cm + waw), false);
  });
  t("  …and one page reads 'page', not 'pages'", () =>
    assert.match(confinementSummary({ cityName: "X", isCityManager: false, pageCount: 1 }), /1 Match Ops page only$/));
  // WHAT THIS TEST CANNOT PROVE, STATED RATHER THAN IMPLIED: that the number in the sentence
  // equals the number of items the RAIL actually draws. visibleSections() cannot be imported here
  // — it pulls useAuth, which pulls a browser Supabase client — so the tie is asserted in the
  // browser suite instead, by counting rendered rail items and matching them to this sentence.
  // Both sides already read the same list; this says which check proves it.
  console.log(`     manager: ${cm}`);
  console.log(`     confined: ${waw}`);
}

console.log(`\n${n} passed, 0 failed`);
