// THE GROWTH RIGHT — the pure decision table, asserted offline.
//
// WHY ITS OWN SUITE. can_access_growth was Player Lifecycle's permission until 2026-08-23 and now
// means the Growth tab. A stale grant read as a new one is the single failure this whole four-push
// sequence exists to prevent, and it is not a thing a browser suite can see: every account's flag
// was reset to false by migration 0140, so the interesting rows do not exist to log in as.
//
// THE MOST IMPORTANT ROW IN THE TABLE IS THE ADMIN ONE, and it is the one most likely to be
// misread: `can()` returns true for an admin on any PAGE capability without consulting the column.
// So the Growth tab is visible to all six admins the moment it deploys, granted to nobody. That is
// how every other page flag has always behaved — it is not a bug and it is not the grant working.
import assert from "node:assert/strict";
import { can, denial, LABEL } from "../src/lib/capabilities";

/* useAuth CANNOT BE IMPORTED STATICALLY HERE — it builds the Supabase client at module scope and
 * throws on a bare `import` outside a browser, which is exactly the constraint capabilities.ts was
 * written to work around. The env is loaded first and the module pulled in dynamically, so the
 * client/server agreement table below can call the REAL client predicate rather than a copy of it.
 * No request is ever made. */
process.loadEnvFile(".env.local");

/* EVERY ASSERTION RUNS, EVEN AFTER ONE FAILS — node:assert throws, and a bare call stops the suite
 * at the first failure, which turns a mutation run's survivor count into an "assertions reached"
 * count. Those are different numbers. */
let n = 0, failed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); n += 1; console.log(`  ok ${name}`); }
  catch (e) { failed += 1; console.log(`  FAIL ${name} — ${(e as Error).message.split("\n")[0]}`); }
};

type Row = Record<string, unknown>;
const base: Row = {
  email: "someone@playmatchday.com", is_admin: false, is_service_account: false,
  is_city_manager: false, city_identifier: null,
  can_access_growth: false, can_access_lifecycle: false, can_access_matchops: false,
  can_access_chats: false, can_access_tech: false,
};
const row = (o: Row): Row => ({ ...base, ...o });

// ── the flag decides, for a non-admin ──────────────────────────────────────────────────────────
t("no flag → no Growth", () =>
  assert.equal(can(row({}), "growth"), false));

t("the flag alone is enough — no is_admin term", () =>
  assert.equal(can(row({ can_access_growth: true }), "growth"), true));

t("an admin holds Growth WITHOUT the flag (page access, as every page flag behaves)", () =>
  assert.equal(can(row({ is_admin: true }), "growth"), true));

// ── the two names must not be each other ───────────────────────────────────────────────────────
t("can_access_lifecycle does NOT grant Growth", () =>
  assert.equal(can(row({ can_access_lifecycle: true }), "growth"), false));

t("can_access_growth does NOT grant Player Lifecycle", () =>
  assert.equal(can(row({ can_access_growth: true }), "lifecycle"), false));

t("…and the two capabilities resolve to DIFFERENT columns", () =>
  assert.equal(
    can(row({ can_access_growth: true }), "growth") && !can(row({ can_access_growth: true }), "lifecycle"),
    true));

// ── the service account, refused in code as well as at the database ────────────────────────────
t("the E2E service account is refused Growth even holding the flag", () =>
  assert.equal(can(row({ can_access_growth: true, is_service_account: true }), "growth"), false));

t("…and by email alone, without the flag on the row", () =>
  assert.equal(can(row({ can_access_growth: true, email: "clubhouse-e2e@playmatchday.com" }),
    "growth", "clubhouse-e2e@playmatchday.com"), false));

t("…with a refusal that says why", () =>
  assert.equal(denial(row({ can_access_growth: true, is_service_account: true }), "growth"),
    "Service accounts hold no permissions."));

// ── the two city tiers, whose precedence differs ───────────────────────────────────────────────
t("a CONFINED account is refused Growth (the boundary keeps only matchops and chats)", () =>
  assert.equal(can(row({ can_access_growth: true, city_identifier: "WAW" }), "growth"), false));

t("…and the boundary BEATS is_admin, because isConfined carries no is_admin term", () =>
  assert.equal(can(row({ is_admin: true, city_identifier: "WAW" }), "growth"), false));

t("a CITY MANAGER is refused Growth", () =>
  assert.equal(can(row({ can_access_growth: true, is_city_manager: true, city_identifier: "ATX" }), "growth"), false));

/* THE PRECEDENCE PAIR, AND A CORRECTION TO HOW IT IS USUALLY STATED.
 *
 * "is_admin wins for city managers, loses for confined accounts" is true of the two PREDICATES in
 * isolation, and MISLEADING about can(), which composes them. isCityManagerConfined() carries an
 * is_admin term so an admin passes it; isConfined() carries none. But a real city manager MUST
 * carry a city (constraint app_users_city_manager_needs_city, 0120) — so for every row that can
 * actually exist, the confinement boundary catches what the city-manager predicate let through, and
 * an admin city manager is refused anyway. Both halves are asserted, because the first one alone is
 * how someone talks themselves into believing the second cannot happen. */
t("is_admin beats the city-manager predicate — with no city on the row", () =>
  assert.equal(can(row({ is_admin: true, is_city_manager: true, city_identifier: null }), "growth"), true));

t("…but a REAL city manager carries a city, and the boundary then refuses them anyway", () =>
  assert.equal(can(row({ is_admin: true, is_city_manager: true, city_identifier: "ATX" }), "growth"), false));

// ── the client predicate must agree with the server one, row for row ───────────────────────────
// THE RAIL MUST NOT OFFER A DOOR THE SERVER WILL SLAM. canAccess() is NOT a thin wrapper over
// can(): it carries its own confinement branch, so these are two implementations and the only
// thing holding them together is this table.
const CASES: Row[] = [
  {}, { can_access_growth: true }, { is_admin: true },
  { can_access_lifecycle: true },
  { can_access_growth: true, city_identifier: "WAW" }, { is_admin: true, city_identifier: "WAW" },
  { can_access_growth: true, is_city_manager: true, city_identifier: "ATX" },
  { is_admin: true, is_city_manager: true, city_identifier: "ATX" },
];

/* THE ONE ROW WHERE THEY DISAGREE, ASSERTED AS A DISAGREEMENT RATHER THAN LEFT OUT.
 *
 * can() refuses a service account before it reads any flag. canAccess() has NO service-account
 * term at all — so a service account holding a page flag is offered the tab and refused the data.
 * This is NOT specific to Growth; it is every page.
 *
 * WHY IT IS NOT FIXED HERE. scripts/e2e/shot.mjs drives the browser AS the service account to
 * screenshot every route; adding the term would render every page empty and break that harness.
 * It is also latent: 0140 reset can_access_growth to false on every row, and the
 * app_users_growth_guard trigger raises on any attempt to set it for a service account, so no such
 * row can exist to be offered anything. Fixing canAccess and re-pointing shot.mjs at a real
 * identity is its own change; this assertion is here so the divergence cannot be discovered by
 * someone assuming the two functions agree. */
const SVC = { can_access_growth: true, is_service_account: true };
// ── the label is the word on the checkbox ──────────────────────────────────────────────────────
t('the grid labels it "Growth", not the old section name', () =>
  assert.equal(LABEL.growth, "Growth"));

t('…and Player Lifecycle keeps its own label', () =>
  assert.equal(LABEL.lifecycle, "Player Lifecycle"));

async function main() {
  const { canAccess } = await import("../src/lib/useAuth");
  for (const [i, c] of CASES.entries()) {
    t(`client canAccess agrees with server can() on case ${i + 1}: ${JSON.stringify(c)}`, () => {
      const r = row(c);
      assert.equal(canAccess(r as never, "growth"), can(r, "growth", r.email as string));
    });
  }
  t("the client and the server DISAGREE on a service account, knowingly — see the note above", () => {
    const r = row(SVC);
    assert.equal(can(r, "growth", r.email as string), false, "server refuses");
    assert.equal(canAccess(r as never, "growth"), true, "client offers");
  });

  console.log(`\n${n} passed, ${failed} failed`);
  if (failed) process.exit(1);
  if (n === 0) { console.log("ZERO ASSERTIONS — that is a failure, not a pass"); process.exit(1); }
}

main();
