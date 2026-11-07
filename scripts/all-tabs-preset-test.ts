// Offline suite: scripts/run-suites.mjs runs it with NODE_OPTIONS=--conditions=react-server.
// THE "ALL TABS" PRESET (2026-11-07) and the per-person manager pay rule (0260).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { can, type Capability } from "../src/lib/capabilities";
import { matchOpsReadGate } from "../src/lib/matchOpsAuth";
import { markStaffApp } from "../src/lib/staffAppForward";
import { ALL_TABS_PRESET_ON, ALL_TABS_PER_PERSON, allTabsPresetRefusal, holdsAllTabsPreset } from "../src/lib/allTabsPreset";
import { appAccess, canChangeManagerPay } from "../src/lib/appModel";

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log(`  ✓ ${name}`); };
const on: Record<string, unknown> = { id: "d", email: "d@x.com" };
for (const k of ALL_TABS_PRESET_ON) on[k] = true;
const app = markStaffApp(on);

console.log("\n── who it is for ──");
t("a person with no city: allowed", () => assert.equal(allTabsPresetRefusal({ id: "d" }), null));
t("a city manager: refused", () => assert.notEqual(allTabsPresetRefusal({ is_city_manager: true, city_identifier: "ATX" }), null));
t("a city-confined account: refused", () => assert.notEqual(allTabsPresetRefusal({ city_identifier: "WAW" }), null));
t("a service account: refused", () => assert.notEqual(allTabsPresetRefusal({ is_service_account: true }), null));
t("holds it with the six on", () => assert.equal(holdsAllTabsPreset(on), true));
t("…not with one missing", () => assert.equal(holdsAllTabsPreset({ ...on, can_access_growth: false }), false));
t("never sets a per-person grant", () => assert.equal(ALL_TABS_PER_PERSON.some((k) => (ALL_TABS_PRESET_ON as readonly string[]).includes(k)), false));

console.log("\n── every tab, all cities ──");
const a = appAccess(on, null);
t("unconfined operator, reads matches", () => { assert.equal(a.tier, "operator"); assert.equal(a.canReadMatches, true); assert.equal(a.confined, false); });
t("Match Ops read gate admits (Lookup, cancel GET, details)", () => assert.equal(matchOpsReadGate(app, "d@x.com").ok, true));
for (const cap of ["matchops", "chats", "growth", "lifecycle", "editMatches", "sendMessages"] as Capability[]) t(`${cap} granted`, () => assert.equal(can(app, cap, "d@x.com"), true));
for (const cap of ["editCredits", "editMemberships", "managePlayers", "managePromos", "grantAccess"] as Capability[]) t(`${cap} NOT granted by the preset`, () => assert.equal(can(app, cap, "d@x.com"), false));
t("Players gate (is_admin or can_access_lifecycle) passes", () => assert.equal(on.is_admin === true || on.can_access_lifecycle === true, true));

console.log("\n── manager pay changes in the staff app, per person (0260) ──");
t("the preset alone: off", () => assert.equal(canChangeManagerPay(on, false), false));
t("ticked: on", () => assert.equal(canChangeManagerPay({ ...on, can_change_manager_pay: true }, false), true));
t("an admin: on without the box", () => assert.equal(canChangeManagerPay({ is_admin: true }, false), true));
t("a confined account: off even ticked", () => assert.equal(canChangeManagerPay({ can_change_manager_pay: true }, true), false));
t("before 0260 (column missing): off", () => assert.equal(canChangeManagerPay({ can_access_matchops: true }, false), false));

console.log("\n── Additional pay on an existing row: the same people, and logged ──");
const adj = readFileSync("src/app/api/manager-pay/adjustments/route.ts", "utf8");
t("gated on admin OR the Manager pay box (refuseUnlessPayChanger), no longer admin-only", () => { assert.match(adj, /refuseUnlessPayChanger\(data\.user\.email\)/); assert.doesNotMatch(adj, /refuseUnlessAdmin\(/); });
t("every save and clear goes through recordWrite into change_log", () => assert.match(adj, /recordWrite\([\s\S]*source: "Manager Pay — adjustment"[\s\S]*supabaseLogStore\(\)/));
const sess = readFileSync("src/lib/adminSession.ts", "utf8");
t("the pay check admits exactly is_admin or can_change_manager_pay", () => assert.match(sess, /is_admin === true \|\| row\.data\?\.can_change_manager_pay === true/));

console.log(`\n${n} passed, 0 failed`);
