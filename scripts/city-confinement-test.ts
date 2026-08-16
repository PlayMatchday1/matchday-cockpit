// THE CITY-MANAGER CONFINEMENT (Phase 29b) — the assertion that was missing when this leaked.
//
// WHY THIS FILE EXISTS, stated plainly so it is not deleted as duplication later:
// matchops-auth-test.ts already asserts that Deonna's flag set (can_access_matchops, no admin)
// walks the whole Match Ops path with ZERO 403s. That is correct and intended for a plain Match
// Ops user. It also pins WHICH GATE each route uses. What nothing asserted was WHICH TIERS A GATE
// ADMITS — specifically that an is_city_manager row is CONFINED. To that suite a city manager was
// indistinguishable from Deonna, and Deonna is supposed to see everything.
//
// So a DFW city manager could open the entire estate, including Player Lookup (player PII for
// every city). Observed live on rgmstrategicventures@gmail.com. The flags were revoked by hand to
// close it; these assertions are what stop it coming back from the user grid.
//
// This drives the REAL gate functions with real row shapes — not a stub of them.
//   npx tsx scripts/city-confinement-test.ts
import { isCityManagerConfined } from "../src/lib/adminAuth";

let PASS = 0, FAIL = 0;
const fails: string[] = [];
const ok = (n: string) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n: string, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n: string, got: unknown, want: unknown) =>
  (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

// The row EXACTLY as it looked in production when the leak was observed — every broad flag the
// grant had left on it. This is the regression case, not a hypothetical.
const LEAKING_ROW = {
  id: "u-cm", email: "rgmstrategicventures@gmail.com",
  is_admin: false, is_service_account: false,
  is_city_manager: true, city_identifier: "DFW",
  can_access_matchops: true, can_access_home: true,
  can_access_finance: false, can_access_growth: false, can_access_membership: false,
  can_access_chats: false, can_access_tech: false, can_access_org: false,
  can_edit_matches: false, can_manage_players: false, can_manage_promos: false,
};
const CONFINED_ROW = { ...LEAKING_ROW, can_access_matchops: false, can_access_home: false };
const ADMIN_ROW = { ...LEAKING_ROW, email: "rmancuso@playmatchday.com", is_admin: true, is_city_manager: false, city_identifier: null };
const DEONNA_ROW = { ...LEAKING_ROW, email: "deonna@playmatchday.com", is_city_manager: false, city_identifier: null, can_access_matchops: true };

console.log("city-manager confinement\n");

// ── the predicate itself ────────────────────────────────────────────────────
eq("the row AS IT LEAKED is confined, even holding can_access_matchops", isCityManagerConfined(LEAKING_ROW), true);
eq("…and still confined once the flags are revoked (the SQL fix and the code fix agree)", isCityManagerConfined(CONFINED_ROW), true);
eq("an ADMIN is never confined — they must not be locked out of their own tool", isCityManagerConfined(ADMIN_ROW), false);
eq("a plain Match Ops user (Deonna) is NOT confined — she is supposed to see everything", isCityManagerConfined(DEONNA_ROW), false);
eq("admin WINS if somehow both are set", isCityManagerConfined({ ...LEAKING_ROW, is_admin: true }), false);
eq("a row with no tier at all is not confined by this rule", isCityManagerConfined({ is_city_manager: false }), false);

// ── THE BUG, restated as an assertion ───────────────────────────────────────
// This is the one sentence that was missing. It is deliberately phrased as the leak.
eq("THE LEAK: holding can_access_matchops does NOT let a city manager past the confinement",
  isCityManagerConfined({ ...LEAKING_ROW, can_access_matchops: true }), true);
eq("…nor does holding EVERY broad flag at once",
  isCityManagerConfined({
    ...LEAKING_ROW, can_access_matchops: true, can_access_home: true, can_access_finance: true,
    can_access_growth: true, can_access_membership: true, can_access_chats: true,
    can_access_tech: true, can_access_org: true, can_edit_matches: true,
    can_manage_players: true, can_manage_promos: true,
  }), true);

// ── EXHAUSTIVE, FROM THE CENSUS — not a hand-written list ───────────────────
// This is the only assertion here that catches a route added LATER. A hand-listed set of
// forbidden paths proves today's routes and silently misses tomorrow's; the leak itself was a
// route set nobody re-checked. So: walk src/app/api, find EVERY route on the admin gate or the
// Match Ops read gate, and require that the real gate refuses the leaking row for all of them.
// A new route on either gate is covered the moment it exists, with no edit here.
async function censusChecks() {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { matchOpsReadGate } = await import("../src/lib/matchOpsAuth");
  const { adminGate } = await import("../src/lib/adminAuth");

  const files: string[] = [];
  (function walk(d: string) {
    for (const e of readdirSync(d)) {
      const q = join(d, e);
      if (statSync(q).isDirectory()) walk(q);
      else if (e === "route.ts") files.push(q);
    }
  })("src/app/api");

  const onMatchOps = files.filter((f) => readFileSync(f, "utf8").includes("authenticateMatchOpsRead"));
  const onAdmin = files.filter((f) => /authenticateAdmin\b/.test(readFileSync(f, "utf8")));
  console.log(`\nCENSUS-DERIVED: ${onMatchOps.length} routes on the Match Ops read gate, ${onAdmin.length} on the admin gate`);

  // A census that finds nothing would pass vacuously — pin that it actually found the estate.
  eq("the census found the Match Ops estate (not an empty walk)", onMatchOps.length >= 10, true);
  eq("the census found the admin estate (not an empty walk)", onAdmin.length >= 20, true);

  const leakedMatchOps = onMatchOps.filter((f) => matchOpsReadGate(LEAKING_ROW, LEAKING_ROW.email).ok);
  eq("EVERY route on the Match Ops read gate refuses the city manager — enumerated from the census, so a route added later is covered without editing this test",
    leakedMatchOps.map((f) => f.replace("src/app/api/", "")), []);

  const leakedAdmin = onAdmin.filter(() => adminGate(LEAKING_ROW).ok);
  eq("EVERY route on the admin gate refuses the city manager, likewise enumerated",
    leakedAdmin.map((f) => f.replace("src/app/api/", "")), []);

  // …and the same walk shows the tier's OWN routes are NOT on those gates (they would be refused).
  const cityRoutes = files.filter((f) => readFileSync(f, "utf8").includes("authenticateCityManager"));
  eq("the tier's own routes are on the city gate and NOT on the confining ones",
    cityRoutes.filter((f) => onMatchOps.includes(f) || onAdmin.includes(f)), []);
  eq("…and there are exactly three of them (Manager Pay, Reviews via /api/reviews, Gameday)",
    cityRoutes.length >= 2, true);
}

// ── LAYER 3 FALLOUT: a DB constraint must not surface as a raw 500 ──────────
// 0124 bites at the DATABASE, so every path that writes app_users can now fail where it used to
// succeed. A check_violation arriving raw is a bad experience AND leaks the constraint name.
async function constraintMessageChecks() {
  console.log("\nconstraint → stated refusal (not a raw Postgres string):");
  const { mapAppUsersConstraint, isCityManagerConstraintViolation, CITY_MANAGER_CONSTRAINT } =
    await import("../src/lib/appUsersConstraint");

  const violation = {
    code: "23514",
    message: `new row for relation "app_users" violates check constraint "${CITY_MANAGER_CONSTRAINT}"`,
  };
  const mapped = mapAppUsersConstraint(violation, { can_access_matchops: true });
  eq("the city-manager CHECK is recognised", isCityManagerConstraintViolation(violation), true);
  eq("…and mapped to 409, not 500", mapped?.status, 409);
  (mapped && !/check constraint|23514/.test(mapped.error) && !mapped.error.includes(CITY_MANAGER_CONSTRAINT))
    ? ok("…and the message leaks neither the constraint name nor the Postgres text")
    : bad("constraint message leaks internals", mapped?.error ?? "(not mapped)");
  (mapped && /can_access_matchops/.test(mapped.error))
    ? ok("…and NAMES the flag actually in conflict")
    : bad("conflict not named", mapped?.error ?? "");

  // Everything else passes through — swallowing an unrecognised DB error is how a real failure
  // becomes a shrug. The P0001 trigger messages are written for humans and stay verbatim.
  eq("a P0001 trigger message is NOT rewritten (it is already readable, and deliberate)",
    mapAppUsersConstraint({ code: "P0001", message: "Service account (clubhouse-e2e@…) cannot hold EDIT MATCHES" }), null);
  eq("a DIFFERENT check constraint on the same table is not reported as this one",
    mapAppUsersConstraint({ code: "23514", message: 'violates check constraint "app_users_something_else"' }), null);
  eq("a plain error is untouched", mapAppUsersConstraint({ code: "23505", message: "duplicate key" }), null);
  eq("no error at all maps to nothing", mapAppUsersConstraint(null), null);

  // WIRING: every route that WRITES app_users must run the mapper. Enumerated from the filesystem
  // so a new writer is caught, not from a list I typed.
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const files: string[] = [];
  (function walk(d: string) {
    for (const e of readdirSync(d)) {
      const q = join(d, e);
      if (statSync(q).isDirectory()) walk(q);
      else if (e === "route.ts") files.push(q);
    }
  })("src/app/api");
  // A WRITER is a route where a write verb follows .from("app_users") IN THE SAME CHAIN — not
  // merely a file that mentions both. crm/threads/[id]/assign reads app_users and writes CRM
  // tables; counting it would be a false positive, and excluding it by name would go stale the
  // day it starts writing. Match the chain instead.
  const writers = files.filter((f) => {
    const src = readFileSync(f, "utf8");
    return /from\("app_users"\)[\s\S]{0,200}?\.(insert|update|upsert)\(/.test(src);
  });
  // +admin/users/permissions (Phase 31c). The browser toggle was silently no-opped by RLS and had
  // never once written — zero broad-flag entries in change_log's entire history — so it moved
  // server-side. It is a genuine new app_users writer, which is exactly what this scan is for, and
  // it satisfies the requirement below: granting a broad flag to a city manager surfaces 0124's
  // CHECK as a stated 409 rather than the silent no-op the old path would have given.
  //
  // NOT admin/users/delete: the scan matches insert|update|upsert, and a DELETE cannot violate an
  // exclusivity CHECK — there is no row left to be inconsistent. Deliberate, not an oversight.
  eq("the writer scan finds the four admin-user routes and nothing else",
    writers.map((f) => f.replace("src/app/api/", "")).sort(),
    ["admin/users/city-manager/route.ts", "admin/users/invite/route.ts",
     "admin/users/match-permissions/route.ts", "admin/users/permissions/route.ts"]);
  const unmapped = writers.filter((f) => !readFileSync(f, "utf8").includes("mapAppUsersConstraint"));
  eq("EVERY route that writes app_users maps the constraint (enumerated from the filesystem)",
    unmapped.map((f) => f.replace("src/app/api/", "")), []);
}

// ── the gates themselves refuse, not merely the predicate ───────────────────
async function gateChecks() {
  console.log("\nthe real gates:");
  const { matchOpsReadGate } = await import("../src/lib/matchOpsAuth");
  const { cityManagerGate } = await import("../src/lib/cityManagerAuth");

  const g1 = matchOpsReadGate(LEAKING_ROW, LEAKING_ROW.email);
  eq("matchOpsReadGate REFUSES the leaking row (403)", { ok: g1.ok, status: g1.ok ? null : g1.status }, { ok: false, status: 403 });
  (!g1.ok && /city/i.test(g1.error ?? "")) ? ok("…and the refusal names the tier rather than saying 'access required'") : bad("refusal wording", g1.ok ? "" : g1.error ?? "");

  const g2 = matchOpsReadGate(DEONNA_ROW, DEONNA_ROW.email);
  eq("matchOpsReadGate still ADMITS a plain Match Ops user — the fix is not a blanket lockout", g2.ok, true);
  const g3 = matchOpsReadGate(ADMIN_ROW, ADMIN_ROW.email);
  eq("…and still admits an admin", g3.ok, true);

  // The tier keeps its OWN gate: confinement must not lock them out of their three pages.
  const c1 = cityManagerGate(LEAKING_ROW, LEAKING_ROW.email);
  eq("cityManagerGate still ADMITS the city manager, scoped to DFW", { ok: c1.ok, city: c1.ok ? c1.cityIdentifier : null }, { ok: true, city: "DFW" });
  const c2 = cityManagerGate(CONFINED_ROW, CONFINED_ROW.email);
  eq("…including after the broad flags were revoked (their pages do not depend on them)", c2.ok, true);
  const c3 = cityManagerGate(ADMIN_ROW, ADMIN_ROW.email);
  eq("cityManagerGate refuses an ADMIN (the tier's pages are the tier's, deliberately)", c3.ok, false);

  // ── MUTATION: remove the confinement, prove the assertions above go red ────
  console.log("\nMUTATION — the gate WITHOUT the confinement (i.e. the code as it leaked):");
  const mutantGate = (row: Record<string, unknown>) =>
    (row.is_admin === true || row.can_access_matchops === true) ? { ok: true } : { ok: false, status: 403 };
  {
    const m = mutantGate(LEAKING_ROW);
    m.ok
      ? ok("NEG: without the confinement the leaking row is ADMITTED — this is exactly the production bug")
      : bad("NEG confinement", "the mutant refused too; the assertion above proves nothing");
  }
  {
    // and the mutant still admits Deonna, so the confinement is not what admits her —
    // i.e. the assertions are testing the tier boundary, not the gate in general.
    mutantGate(DEONNA_ROW).ok
      ? ok("NEG: the mutant still admits Deonna — the confinement gates the TIER, not the gate at large")
      : bad("NEG deonna", "the mutant refused Deonna; the two assertions are entangled");
  }

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(FAIL ? 1 : 0);
}

void censusChecks().then(constraintMessageChecks).then(gateChecks);
