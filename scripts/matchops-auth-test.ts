// Phase 23 Step 2 Part D — the Match Ops READ gate + the deny-by-default census.
//
// The e2e harness can't simulate a non-admin: server-side auth reads the REAL app_users row, not the
// browser mock. So the gate DECISIONS are proven here as pure functions (every flag shape), and the
// route→gate wiring is proven structurally. Together these give the "no-flags is denied everywhere"
// proof without needing a real Deonna account.
//   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/matchops-auth-test.ts

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { adminGate, deriveMatchOpsFlags } from "../src/lib/adminAuth";
import { matchOpsReadGate, E2E_SERVICE_EMAIL } from "../src/lib/matchOpsAuth";

let PASS = 0, FAIL = 0;
const ok = (n: string) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { FAIL++; console.log(`  XX  ${n} — ${d}`); };
const is = (n: string, got: unknown, want: unknown) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

// ── flag shapes ──
const ADMIN = { id: "u-admin", is_admin: true, can_access_matchops: true, can_edit_matches: true, can_manage_players: true, can_manage_promos: true };
const DEONNA = { id: "u-deonna", is_admin: false, can_access_matchops: true, can_edit_matches: false, can_manage_players: false, can_manage_promos: false };
const NOFLAGS = { id: "u-none" }; // every flag absent → every derived permission false
const E2E = { id: "u-e2e", is_admin: false, can_access_matchops: true, is_service_account: true };
const PROMO_ADMIN = { id: "u-pa", is_admin: true, can_access_matchops: true, can_manage_promos: false };
const DEONNA_EMAIL = "deonna@playmatchday.com";

console.log("adminGate — is_admin only, deny by default:");
is("admin passes", adminGate(ADMIN).ok, true);
is("Deonna (non-admin) is denied 403 'Admin access required'", adminGate(DEONNA), { ok: false, status: 403, error: "Admin access required" });
is("no-flags account is denied", adminGate(NOFLAGS).ok, false);
is("missing row is denied", adminGate(null).ok, false);

console.log("\nmatchOpsReadGate — can_access_matchops, NOT is_admin; deny by default:");
is("Deonna (can_access_matchops, non-admin) READS", matchOpsReadGate(DEONNA, DEONNA_EMAIL).ok, true);
is("an admin (also holds Match Ops) READS", matchOpsReadGate(ADMIN, "admin@playmatchday.com").ok, true);
// an admin must NEVER be locked out of a read even if their row lacks can_access_matchops (no regression)
is("an admin WITHOUT can_access_matchops still READS (is_admin is sufficient)", matchOpsReadGate({ id: "a2", is_admin: true }, "a2@playmatchday.com").ok, true);
// a non-admin with matchops but nothing else still reads; a non-admin with neither is denied
is("a non-admin with NEITHER flag is denied", matchOpsReadGate({ id: "n2", is_admin: false, can_access_matchops: false }, "n2@x.com").ok, false);
is("no-flags account is DENIED (deny by default)", matchOpsReadGate(NOFLAGS, "x@playmatchday.com").ok, false);
is("missing row is denied", matchOpsReadGate(null, "x@x").ok, false);
// the E2E service account, keyed on EMAIL, even though its row carries can_access_matchops
is("E2E service account is BLOCKED by email", matchOpsReadGate(E2E, E2E_SERVICE_EMAIL), { ok: false, status: 403, error: "Service accounts cannot access Match Ops" });
is("E2E constant is the expected email", E2E_SERVICE_EMAIL, "clubhouse-e2e@playmatchday.com");
// and by the is_service_account flag regardless of email (belt-and-suspenders)
is("any is_service_account row is blocked regardless of email", matchOpsReadGate({ ...E2E, id: "svc" }, "someone-else@x.com").ok, false);

console.log("\nWRITE flags stay gated (read open ≠ write open):");
is("Deonna derives NO write flags", deriveMatchOpsFlags(DEONNA), { canEditMatches: false, canManagePlayers: false, canManagePromos: false });
is("an admin WITHOUT manage-promos still cannot write promos", deriveMatchOpsFlags(PROMO_ADMIN).canManagePromos, false);
is("manage-promos requires Match Ops too (flag true but no matchops → false)", deriveMatchOpsFlags({ can_manage_promos: true }).canManagePromos, false);
is("manage-promos true + matchops → true", deriveMatchOpsFlags({ can_manage_promos: true, can_access_matchops: true }).canManagePromos, true);

// ── structural census: route → gate wiring, pinned so a silent move/relax fails the gate ──
console.log("\nCENSUS — route → gate wiring (deny by default, moved one at a time):");
const API = "src/app/api";
const routeFiles: string[] = [];
(function walk(dir: string) { for (const e of readdirSync(dir)) { const p = join(dir, e); if (statSync(p).isDirectory()) walk(p); else if (e === "route.ts") routeFiles.push(p); } })(API);

const importsMatchOpsRead = routeFiles.filter((f) => readFileSync(f, "utf8").includes("authenticateMatchOpsRead"));
const importsAdmin = routeFiles.filter((f) => /authenticateAdmin\b/.test(readFileSync(f, "utf8")));
const rel = (p: string) => p.replace("src/app/api/", "");

// EXACTLY the three Deonna needs are on the read gate — no more (a fourth move must edit this test).
is("authenticateMatchOpsRead is imported by EXACTLY the 3 intended read routes", importsMatchOpsRead.map(rel).sort(), [
  "lookup/[env]/route.ts", "matchday/[env]/gameday/route.ts", "promos/list/route.ts",
].sort());
// none of the three still references the admin gate
is("the 3 read routes NO LONGER reference authenticateAdmin", importsMatchOpsRead.filter((f) => /authenticateAdmin\b/.test(readFileSync(f, "utf8"))).map(rel), []);
// the remaining is_admin surface is unchanged at 28 (was 31, moved 3) — a drop means a route lost its gate
is("authenticateAdmin still guards 28 routes (31 − 3 moved)", importsAdmin.length, 28);

// the five Deonna must STILL be refused stay is_admin-gated (authenticateAdmin, or authenticateCrm + an is_admin check)
const requiresAdmin = (f: string) => { const s = readFileSync(f, "utf8"); return /authenticateAdmin\b/.test(s) || (/authenticateCrm\b/.test(s) && /isAdmin|is_admin/.test(s)); };
for (const [name, f] of [
  ["change log", "src/app/api/changelog/route.ts"],
  ["veo codes", "src/app/api/veo/codes/route.ts"],
  ["manager pay (year report)", "src/app/api/manager-pay/manager-year/route.ts"],
  ["sms-log", "src/app/api/sms-log/route.ts"],
  ["canned responses", "src/app/api/crm/canned-responses/route.ts"],
] as const) {
  is(`${name} still requires is_admin (Deonna stays 403 there)`, requiresAdmin(f), true);
}

// promos WRITE is untouched: still authenticateAdmin + canManagePromos (read opened, write did not)
{ const s = readFileSync("src/app/api/promos/create/route.ts", "utf8");
  is("promos/create still authenticateAdmin + MANAGE PROMOS (write stays gated)", /authenticateAdmin\b/.test(s) && /canManagePromos/.test(s), true); }
// promos/list read no longer requires MANAGE PROMOS
{ const s = readFileSync("src/app/api/promos/list/route.ts", "utf8");
  is("promos/list read no longer gates on canManagePromos", /canManagePromos/.test(s), false); }

// the third gate in the system (authenticateCrm) also denies a no-flags account — so the compositional
// claim "no-flags is denied on every gated route" holds for the CRM surface too. Asserted at source.
{ const s = readFileSync("src/lib/crmAuth.ts", "utf8");
  is("authenticateCrm denies a no-flags account (!isAdmin && !canAccessChats → 403)", /!isAdmin\s*&&\s*!canAccessChats/.test(s), true); }

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
