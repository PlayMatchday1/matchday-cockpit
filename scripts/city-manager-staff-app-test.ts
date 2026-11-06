// Offline suite: scripts/run-suites.mjs runs it with NODE_OPTIONS=--conditions=react-server.
// CITY MANAGERS IN THE STAFF APP (2026-11-06): the City manager preset works in the staff app,
// confined to the city, and changes nothing on the desktop. Every gate decision for the preset row,
// marked (a staff-app request the server vouched for) and unmarked (every desktop request).
import assert from "node:assert/strict";
import { can, type Capability } from "../src/lib/capabilities";
import { matchOpsReadGate } from "../src/lib/matchOpsAuth";
import { isCityManagerConfined } from "../src/lib/adminAuth";
import { assertConfinedRoute } from "../src/lib/cityConfinement";
import { markStaffApp, STAFF_APP_KEY } from "../src/lib/staffAppForward";
import { CITY_MANAGER_PRESET_ON, CITY_MANAGER_PRESET_OFF, holdsCityManagerPreset } from "../src/lib/cityManagerPreset";
import { scopeWeekToCity } from "../src/lib/appManagerPayScope";
import type { ManagerPayWeekPayload, ManagerRow } from "../src/lib/managerPayCompute";

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log(`  ✓ ${name}`); };

const preset: Record<string, unknown> = { id: "g", email: "g@x.com", is_city_manager: true, city_identifier: "ATX" };
for (const k of CITY_MANAGER_PRESET_ON) preset[k] = true;
for (const k of CITY_MANAGER_PRESET_OFF) preset[k] = false;
const app = markStaffApp(preset);
const desk = preset;

console.log("\n── the preset row ──");
t("holdsCityManagerPreset recognises it", () => assert.equal(holdsCityManagerPreset(preset), true));
t("…and not with a stray credit grant", () => assert.equal(holdsCityManagerPreset({ ...preset, can_edit_credits: true }), false));
t("the mark is not a column a row can carry by accident", () => assert.equal(STAFF_APP_KEY.startsWith("__"), true));

console.log("\n── desktop (unmarked): unchanged, every capability refused ──");
for (const cap of ["matchops", "editMatches", "chats", "sendMessages", "growth", "lifecycle", "editCredits"] as Capability[]) {
  t(`desktop ${cap} refused`, () => assert.equal(can(desk, cap, "g@x.com"), false));
}
t("desktop Match Ops read gate refuses", () => assert.equal(matchOpsReadGate(desk, "g@x.com").ok, false));
t("isCityManagerConfined on the desktop", () => assert.equal(isCityManagerConfined(desk), true));

console.log("\n── staff app (marked): the preset's grants, confined ──");
for (const cap of ["matchops", "editMatches", "chats", "sendMessages", "growth"] as Capability[]) {
  t(`app ${cap} granted`, () => assert.equal(can(app, cap, "g@x.com"), true));
}
t("app Match Ops read gate admits", () => assert.equal(matchOpsReadGate(app, "g@x.com").ok, true));
t("app EDIT CREDITS refused even if the column were ticked", () => assert.equal(can({ ...app, can_edit_credits: true }, "editCredits", "g@x.com"), false));
t("app EDIT MEMBERSHIPS refused even if ticked", () => assert.equal(can({ ...app, can_edit_memberships: true }, "editMemberships", "g@x.com"), false));
t("app MANAGE PLAYERS refused (not in the preset)", () => assert.equal(can(app, "managePlayers", "g@x.com"), false));
t("app Finance refused", () => assert.equal(can(app, "finance", "g@x.com"), false));
t("an unmarked row without the preset still refused in the app", () => assert.equal(can(markStaffApp({ id: "y", is_city_manager: true, city_identifier: "HOU" }), "matchops"), false));
t("an admin flag never rides along: grantAccess refused", () => assert.equal(can(app, "grantAccess"), false));

console.log("\n── the route allowlist still binds a marked city manager ──");
for (const p of ["/api/matchday/production/matches/1", "/api/lookup/production", "/api/growth/field-goals", "/api/crm/threads", "/api/match-chats/active", "/api/reviews"]) {
  t(`allowed ${p}`, () => assert.equal(assertConfinedRoute(app, `http://x${p}`).ok, true));
}
for (const p of ["/api/admin/users/permissions", "/api/finance/summary", "/api/manager-pay/aliases", "/api/lifecycle/acquisition", "/api/veo/codes"]) {
  t(`refused ${p}`, () => assert.equal(assertConfinedRoute(app, `http://x${p}`).ok, false));
}

console.log("\n── Warsaw (confined, not a city manager): desktop send unchanged ──");
const waw = { id: "w", city_identifier: "WAW", can_access_matchops: true, can_access_chats: true, can_send_messages: true };
t("desktop can(sendMessages) still false", () => assert.equal(can(waw, "sendMessages"), false));
t("staff app can(sendMessages) follows the column", () => assert.equal(can(markStaffApp(waw), "sendMessages"), true));

console.log("\n── Managers week, scoped to one city ──");
const m = (id: number, city: string, pay: number) => ({ matchId: id, cityIdentifier: city, fieldTitle: null, startDate: "", centralDate: "", centralWeekday: "", centralTime: "", name: `M${id}`, maxPlayerCount: 20, payAmount: pay, role: "primary" as const, coManaged: false });
const row = (name: string, city: string, matches: ReturnType<typeof m>[], adj = 0, notes: string | null = null): ManagerRow => ({ managerEmail: `${name}@x`, managerName: name, managerId: 1, cityIdentifier: city, matches, matchCount: matches.length, baseTotal: matches.reduce((s, x) => s + x.payAmount, 0), adjustment: adj, adjustmentNotes: notes, adjustmentAt: null, total: matches.reduce((s, x) => s + x.payAmount, 0) + adj, addedManually: false, adjustmentId: null });
const sec = (city: string, managers: ManagerRow[], unassigned = 0) => ({ cityIdentifier: city, managers, matches: Array.from({ length: unassigned }, (_, i) => ({ isCancelled: false, primaryManagerName: null, secondManagerName: null, matchId: 900 + i })) as never, matchCount: 0, baseTotal: 0, adjustment: 0, total: 0 });
// Two-city managers: "A" mostly Austin with one Houston match; "H" mostly Houston with one Austin match.
const week = { weekStart: "w", weekEnd: "w", payDate: "w", computedAt: "", isAdmin: true, network: {} as never,
  attention: { count: 9, unassigned: 9, noEmail: 0, bareAdjustment: 0 },
  cities: [
    sec("ATX", [row("A", "ATX", [m(1, "ATX", 50), m(2, "ATX", 50), m(3, "HOU", 50)], 20, null)]),
    sec("HOU", [row("H", "HOU", [m(4, "HOU", 50), m(5, "HOU", 50), m(6, "ATX", 40)], 10, "bonus")], 3),
  ] } as unknown as ManagerPayWeekPayload;
const atx = scopeWeekToCity(week, "ATX");
const hou = scopeWeekToCity(week, "HOU");
t("Austin view: one section, Austin", () => assert.deepEqual(atx.cities.map((c) => c.cityIdentifier), ["ATX"]));
t("Austin view: A keeps only Austin matches", () => assert.deepEqual(atx.cities[0].managers.find((r) => r.managerName === "A")!.matches.map((x) => x.matchId), [1, 2]));
t("Austin view: H appears with their one Austin match", () => assert.deepEqual(atx.cities[0].managers.find((r) => r.managerName === "H")!.matches.map((x) => x.matchId), [6]));
t("Austin view: no Houston match id anywhere", () => assert.equal(JSON.stringify(atx.cities).includes('"cityIdentifier":"HOU"'), false));
t("Austin view: H's adjustment stays with Houston", () => assert.equal(atx.cities[0].managers.find((r) => r.managerName === "H")!.adjustment, 0));
t("Austin view: totals recomputed (50+50+20 + 40)", () => assert.equal(atx.cities[0].total, 160));
t("Austin view: attention is Austin's (A's bare adjustment), not the estate's 9", () => assert.deepEqual(atx.attention, { unassigned: 0, noEmail: 0, bareAdjustment: 1, count: 1 }));
t("Houston view: 3 unassigned Houston matches, no bare adjustment", () => assert.deepEqual(hou.attention, { unassigned: 3, noEmail: 0, bareAdjustment: 0, count: 3 }));
t("Houston view: A appears with only match 3", () => assert.deepEqual(hou.cities[0].managers.find((r) => r.managerName === "A")!.matches.map((x) => x.matchId), [3]));

console.log(`\n${n} passed, 0 failed`);
