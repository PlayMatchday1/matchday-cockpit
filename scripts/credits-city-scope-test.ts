// CREDITS ARE SCOPED BY THE PLAYER'S STATED CITY — the pure decision, tested offline.
//
// WHY THIS EXISTS AS ITS OWN SUITE. The route's guard cannot be exercised end-to-end without a
// confined login, and it protects MONEY. The decision itself is pure, so it is asserted here where
// it runs on every commit rather than only when someone can sign in as Warsaw.
//
// WHAT IT PROTECTS. Both Warsaw accounts held can_edit_credits from 14 August with NO city check
// behind this route — any player's balance, anywhere in the estate, by id. Neither had logged in.
import assert from "node:assert/strict";
import { playerCityAllowed } from "../src/lib/cityConfinement";

/* EVERY ASSERTION RUNS, EVEN AFTER ONE FAILS. node:assert throws, so a bare `fn()` stops the suite
 * at the first failure — which means a mutation run reports "1 of 10 passed" when it means "1 ran
 * before the abort". Those are different numbers and only one of them is a survivor count. */
let n = 0, failed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); n += 1; console.log(`  ok ${name}`); }
  catch (e) { failed += 1; console.log(`  FAIL ${name} — ${(e as Error).message.split("\n")[0]}`); }
};

const player = (city: unknown) => ({ preferableCity: city } as Record<string, unknown>);
const WAW = { id: 10, abbr: "WAW", name: "Warsaw" };
const ATX = { id: 1, abbr: "ATX", name: "Austin" };

t("a confined account may act on a player in its own city", () =>
  assert.equal(playerCityAllowed("WAW", player(WAW)), true));

t("…and is refused on a player in another city", () =>
  assert.equal(playerCityAllowed("WAW", player(ATX)), false));

// NULL IS A REFUSAL, NOT A PASS. 4,187 players have no preferred city and none of them belong to
// anybody — treating absence as permission would hand a confined account one seventh of the estate.
t("a player with NO preferred city is refused", () =>
  assert.equal(playerCityAllowed("WAW", player(null)), false));
t("…and so is one whose city key is missing entirely", () =>
  assert.equal(playerCityAllowed("WAW", {}), false));
t("…and one whose city is an empty object", () =>
  assert.equal(playerCityAllowed("WAW", player({})), false));

// THE COMMON PATH COMPARES abbr TO city_identifier — the same string app_users stores, so no name
// mapping is involved and no spelling can drift.
t("the match is on abbr, which is what app_users stores", () =>
  assert.equal(playerCityAllowed("WAW", player({ abbr: "WAW" })), true));
t("a name-only payload still resolves through cityNameFor", () =>
  assert.equal(playerCityAllowed("WAW", player({ name: "Warsaw" })), true));
t("…and a name that is not the confined city is refused", () =>
  assert.equal(playerCityAllowed("WAW", player({ name: "Austin" })), false));
// abbr WINS WHEN BOTH ARE PRESENT. A payload whose name disagrees with its abbr must not be able to
// talk its way in through the fallback.
t("abbr decides even when a mismatched name is present", () =>
  assert.equal(playerCityAllowed("WAW", player({ abbr: "ATX", name: "Warsaw" })), false));

// UNCONFINED ACCOUNTS ARE UNAFFECTED — this must not break credits for Ryan.
t("an unconfined account may act on any player", () => {
  assert.equal(playerCityAllowed(null, player(ATX)), true);
  assert.equal(playerCityAllowed(null, player(null)), true);
  assert.equal(playerCityAllowed(null, {}), true);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
