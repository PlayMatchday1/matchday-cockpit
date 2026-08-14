// Phase 23 Step 2 Part D — the Match Ops READ gate + the deny-by-default census.
//
// The e2e harness can't simulate a non-admin: server-side auth reads the REAL app_users row, not the
// browser mock. So the gate DECISIONS are proven here as pure functions (every flag shape), and the
// route→gate wiring is proven structurally. Together these give the "no-flags is denied everywhere"
// proof without needing a real Deonna account.
//   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/matchops-auth-test.ts

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { adminGate, deriveMatchOpsFlags, type AppUserRow } from "../src/lib/adminAuth";
import { matchOpsReadGate, E2E_SERVICE_EMAIL } from "../src/lib/matchOpsAuth";
import { cityManagerGate, assertCityScope } from "../src/lib/cityManagerAuth";

let PASS = 0, FAIL = 0;
const ok = (n: string) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { FAIL++; console.log(`  XX  ${n} — ${d}`); };
const is = (n: string, got: unknown, want: unknown) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

// ── flag shapes ──
const ADMIN = { id: "u-admin", is_admin: true, can_access_matchops: true, can_edit_matches: true, can_manage_players: true, can_manage_promos: true };
// Deonna's REAL granted set after Part D round 2: Match Ops READ + MANAGE PLAYERS (ban). Nothing else
// — no EDIT MATCHES, no MANAGE PROMOS, not is_admin.
const DEONNA = { id: "u-deonna", is_admin: false, can_access_matchops: true, can_edit_matches: false, can_manage_players: true, can_manage_promos: false };
// Match Ops read and NOTHING else — the shape that must still be refused every write, ban included.
const MATCHOPS_ONLY = { id: "u-ro", is_admin: false, can_access_matchops: true, can_edit_matches: false, can_manage_players: false, can_manage_promos: false };
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
is("a Match-Ops-only account derives NO write flags", deriveMatchOpsFlags(MATCHOPS_ONLY), { canEditMatches: false, canManagePlayers: false, canManagePromos: false });
is("Deonna derives MANAGE PLAYERS only — never EDIT MATCHES or MANAGE PROMOS", deriveMatchOpsFlags(DEONNA), { canEditMatches: false, canManagePlayers: true, canManagePromos: false });
is("an admin WITHOUT manage-promos still cannot write promos", deriveMatchOpsFlags(PROMO_ADMIN).canManagePromos, false);
is("manage-promos requires Match Ops too (flag true but no matchops → false)", deriveMatchOpsFlags({ can_manage_promos: true }).canManagePromos, false);
is("manage-promos true + matchops → true", deriveMatchOpsFlags({ can_manage_promos: true, can_access_matchops: true }).canManagePromos, true);

// ── structural census: route → gate wiring, pinned so a silent move/relax fails the gate ──
console.log("\nCENSUS — route → gate wiring (deny by default, moved one at a time):");
const API = "src/app/api";
const routeFiles: string[] = [];
(function walk(dir: string) { for (const e of readdirSync(dir)) { const p = join(dir, e); if (statSync(p).isDirectory()) walk(p); else if (e === "route.ts") routeFiles.push(p); } })(API);

const importsMatchOpsRead = routeFiles.filter((f) => readFileSync(f, "utf8").includes("authenticateMatchOpsRead"));
const importsCredits = routeFiles.filter((f) => readFileSync(f, "utf8").includes("authenticateCredits"));
const importsAdmin = routeFiles.filter((f) => /authenticateAdmin\b/.test(readFileSync(f, "utf8")));
const rel = (p: string) => p.replace("src/app/api/", "");

// EXACTLY the intended routes are on the read gate — no more (a further move must edit this test).
// Round 1 moved 3; round 2 moved 9 more (6 reads + the 3 dual-gate routes whose GET moved and whose
// write stayed) — the ban route is on the read gate too, but with a MANAGE PLAYERS check on top.
is("authenticateMatchOpsRead is imported by EXACTLY the 14 intended routes", importsMatchOpsRead.map(rel).sort(), [
  // Phase 26 — Slate Review notes. Clubhouse's OWN table (slate_notes), not a MatchDay call:
  // can_access_matchops gates read AND write here, which is why the whole route is on this gate
  // with no write flag on top. Deliberately NOT recordWrite'd — change_log is for API writes.
  "slate-notes/route.ts",
  // Phase 26 — Manager Check-In. Marks/result are Clubhouse-only (no proven MatchDay write for
  // userStatus); the MOVE is a live MatchDay write and carries its own EDIT MATCHES check inside
  // the route, which is why the whole route sits on the read gate.
  "matchops/checkin/[matchId]/route.ts",
  // round 1
  "lookup/[env]/route.ts", "matchday/[env]/gameday/route.ts", "promos/list/route.ts",
  // round 2 — reads moved whole
  "lookup/[env]/payments/route.ts", "promos/detail/[id]/route.ts", "promos/fields/route.ts",
  "promos/matches/route.ts", "promos/check/route.ts",
  // round 2 — the one WRITE moved, onto its own flag
  "lookup/[env]/ban/route.ts",
  // round 2 — dual-gate: GET on the read gate, the write still authenticateAdmin + EDIT MATCHES
  "matchday/[env]/matches/[id]/route.ts", "matchday/[env]/roster/[matchId]/route.ts",
  "matchday/[env]/matches/[id]/cancel/route.ts",
].sort());
// The ONLY routes allowed to keep BOTH gates are the three whose GET moved and whose write did not.
// Anything else holding both is a half-finished move.
is("exactly the 3 dual-gate routes still reference authenticateAdmin (their writes)",
  importsMatchOpsRead.filter((f) => /authenticateAdmin\b/.test(readFileSync(f, "utf8"))).map(rel).sort(), [
    "matchday/[env]/matches/[id]/route.ts", "matchday/[env]/roster/[matchId]/route.ts",
    "matchday/[env]/matches/[id]/cancel/route.ts",
  ].sort());
// ── EDIT CREDITS (Phase 27) — the money route, and the ONE route on a gate of its own ──────────
// It is registered here so it can never drift onto a shared gate: the whole point of the grant is
// that nobody acquires the ability to move money as a side effect of Match Ops.
console.log("\nEDIT CREDITS — its own gate, deliberately outside Match Ops:");
is("exactly ONE route is on the credits gate", importsCredits.map(rel).sort(), ["matchday/[env]/players/[playerId]/credits/route.ts"]);
{
  const f = importsCredits[0];
  const src = f ? readFileSync(f, "utf8") : "";
  is("the credits route exists", !!f, true);
  is("...and does NOT use authenticateAdmin (an admin is not automatically allowed to move money)", /authenticateAdmin\b/.test(src), false);
  is("...and does NOT use authenticateMatchOpsRead (Match Ops does not include it)", /authenticateMatchOpsRead\b/.test(src), false);
  is("BOTH its GET and its POST are gated", (src.match(/authenticateCredits\(req\)/g) ?? []).length, 2);
  is("...the write names the credits authority at the apiWrite chokepoint", /"credits"\s*\)/.test(src), true);
  is("...it re-reads the balance and race-checks before writing", /raceCheck\(/.test(src), true);
  is("...it goes through recordWrite (never a bare apiWrite)", /recordWrite\(/.test(src), true);
  is("...it logs the REASON", /field: "Reason"/.test(src), true);
  is("...and never reads a name, phone or email onto the log", /phone|email(?!:? auth\.email|Email)/i.test(src.slice(src.indexOf("const changes"), src.indexOf("supabaseLogStore"))), false);
}
// no OTHER route may reference the credits flag — a second money surface must be a deliberate edit here
is("no other route reads can_edit_credits directly", routeFiles.filter((f) => /can_edit_credits/.test(readFileSync(f, "utf8"))).map(rel), []);

// the remaining is_admin surface: 28 − 6 routes that moved WHOLE = 22 (the 3 dual-gate ones still
// count), + 1 for Phase 29's /admin/users/city-manager (granting the tier is an ADMIN act — the
// tier itself is not admin-gated, the act of handing it out is) = 23.
// +1 Phase 29 city-manager grant, +2 Phase 30 (auth-status, resend-invite), +1 Phase 31
// (promos/uses — admin AND can_manage_promos, because it returns player contact details) = 26.
is("authenticateAdmin still guards 26 routes", importsAdmin.length, 26);
is("the promo USES route is gated on MANAGE PROMOS, not the Match Ops read gate the other promo reads use",
  /canManagePromos/.test(readFileSync("src/app/api/promos/uses/[id]/route.ts", "utf8"))
  && !/authenticateMatchOpsRead/.test(readFileSync("src/app/api/promos/uses/[id]/route.ts", "utf8")), true);
is("...and the added ones are exactly the three admin-user routes",
  importsAdmin.map(rel).filter((f) => /admin\/users\//.test(f)).sort(),
  // NOT invite/ — that one is gated on isProvisioningOwner (stricter than admin), deliberately.
  ["admin/users/auth-status/route.ts", "admin/users/city-manager/route.ts", "admin/users/match-permissions/route.ts", "admin/users/resend-invite/route.ts"].sort());

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
// the promos READS no longer require MANAGE PROMOS (round 1 opened list; round 2 opened the other four)
for (const r of ["list", "detail/[id]", "fields", "matches", "check"]) {
  const s = readFileSync(`src/app/api/promos/${r}/route.ts`, "utf8");
  is(`promos/${r} read no longer gates on canManagePromos`, /canManagePromos/.test(s), false);
}

// ── /api/veo/* — CLOSING A CENSUS BLIND SPOT ──
// The census pinned the match-ops read gate exactly and counted the admin gate, but it never
// enumerated the veo routes. Adding a GET to /api/veo/intent therefore changed an auth surface
// without the gate noticing — a census with a hole is worse than a known gap, so the veo surface
// is now pinned by name. Each entry states the gate it sits behind; changing one must edit this.
{
  const veoDir = "src/app/api/veo";
  const veoRoutes: string[] = [];
  (function walk(d: string) { for (const e of readdirSync(d)) { const q = join(d, e); if (statSync(q).isDirectory()) walk(q); else if (e === "route.ts") veoRoutes.push(q); } })(veoDir);
  const gateOf = (f: string) => {
    const src = readFileSync(f, "utf8");
    if (/authenticateAdmin\b/.test(src)) return "admin";
    if (/authenticateCrm\b/.test(src)) return "crm";
    if (/VEO_INBOUND_SECRET/.test(src)) return "shared-secret";
    return "NONE";
  };
  // sorted: the walk order is directory order, which is not a fact worth asserting
  const map = Object.fromEntries(veoRoutes.map((f) => [f.replace("src/app/api/", ""), gateOf(f)] as const).sort((a, b) => a[0].localeCompare(b[0])));
  is("every /api/veo route is pinned to a named gate (a NONE here is an unauthenticated route)", map, {
    "veo/[id]/route.ts": "crm",              // resolve a queued review item
    "veo/cameras/route.ts": "crm",
    "veo/codes/[id]/route.ts": "admin",
    "veo/codes/route.ts": "admin",
    "veo/inbound/route.ts": "shared-secret", // machine-to-machine from the Gmail forwarder, no session
    "veo/intent/route.ts": "crm",            // GET (read one match's intent) + POST (toggle it)
    "veo/route.ts": "crm",
  });
  // and the one unauthenticated route really does compare its secret rather than merely mention it
  { const inbound = readFileSync("src/app/api/veo/inbound/route.ts", "utf8");
    is("veo/inbound compares its shared secret in constant time", /timingSafeEqual|constantTime/.test(inbound), true); }
}

// the third gate in the system (authenticateCrm) also denies a no-flags account — so the compositional
// claim "no-flags is denied on every gated route" holds for the CRM surface too. Asserted at source.
{ const s = readFileSync("src/lib/crmAuth.ts", "utf8");
  is("authenticateCrm denies a no-flags account (!isAdmin && !canAccessChats → 403)", /!isAdmin\s*&&\s*!canAccessChats/.test(s), true); }

// ── Phase 25 — the CITY MANAGER tier, the THIRD gate ──
//
// Its whole reason to exist is that it is NOT can_access_matchops: that flag opens twelve routes
// and would hand a city manager every one of them, plus anything added later, silently.
console.log("\ncityManagerGate — a third tier, deny by default, scope REQUIRED:");
const CITYMGR = { id: "u-cm", is_admin: false, is_city_manager: true, city_identifier: "DFW" };
is("a city manager passes and gets their SCOPE back", cityManagerGate(CITYMGR, "cm@playmatchday.com"), { ok: true, cityIdentifier: "DFW" });
is("a city manager with NO city is refused (never 'all cities')",
  cityManagerGate({ id: "u-nc", is_city_manager: true }, "nc@x.com").ok, false);
is("a blank/whitespace city is refused too", cityManagerGate({ id: "u-b", is_city_manager: true, city_identifier: "   " }, "b@x.com").ok, false);
is("a no-flags account is refused", cityManagerGate(NOFLAGS, "x@playmatchday.com").ok, false);
is("missing row is refused", cityManagerGate(null, "x@x").ok, false);
// an ADMIN is NOT a city manager — this gate answers "which city are you scoped to", and an admin
// has no scope to hand back. Deliberate asymmetry with matchOpsAuth, where is_admin IS sufficient.
is("an ADMIN does not satisfy the city-manager gate (no scope to return)", cityManagerGate(ADMIN, "admin@playmatchday.com").ok, false);
// Deonna holds Match Ops, which must NOT imply the city tier
is("a Match Ops operator does NOT get the city tier for free", cityManagerGate(DEONNA, DEONNA_EMAIL).ok, false);
is("the E2E service account is BLOCKED by email", cityManagerGate({ id: "e", is_city_manager: true, city_identifier: "ATX" }, E2E_SERVICE_EMAIL).ok, false);
is("any is_service_account row is blocked regardless of email",
  cityManagerGate({ id: "e2", is_city_manager: true, city_identifier: "ATX", is_service_account: true }, "someone@x.com").ok, false);
// the city tier grants NO match-ops write flags
is("the city tier derives NO Match Ops write flags", deriveMatchOpsFlags(CITYMGR), { canEditMatches: false, canManagePlayers: false, canManagePromos: false });
// and it does NOT open the Match Ops read gate
is("a city manager is REFUSED by the Match Ops read gate (separate tiers)", matchOpsReadGate(CITYMGR, "cm@playmatchday.com").ok, false);

console.log("\nassertCityScope — the SERVER-SIDE refusal (not a hidden UI row):");
is("a match in the caller's own city passes", assertCityScope("DFW", "DFW"), { ok: true });
is("a match in ANOTHER city is REFUSED 403", assertCityScope("DFW", "ATX"), { ok: false, status: 403, error: "That match is not in your city." });
is("case and whitespace do not open a hole", assertCityScope("DFW", " dfw "), { ok: true });
is("a spoofed ?city= for another city is refused", assertCityScope("DFW", "atx").ok, false);
is("naming no city applies the caller's own scope", assertCityScope("DFW", null), { ok: true });

// CENSUS: the city gate is opt-in, route by route. Nothing is on it yet — Part B adds the first.
{ const importsCity = routeFiles.filter((f) => readFileSync(f, "utf8").includes("authenticateCityManager"));
  is("authenticateCityManager is imported by EXACTLY the intended routes (a new one must edit this test)",
    importsCity.map(rel).sort(), ["manager-pay/city-week/route.ts"]); }

// ── THE WALK: whole paths, not routes in isolation ──
//
// A route-by-route census cannot catch the failure that actually hurts: a panel that OPENS and then
// 403s on the next click. So we resolve each step's gate FROM THE HANDLER SOURCE (the table below
// cannot drift from the code), run the real pure gate functions against a real flag row, and assert
// the whole sequence — every step, in order — with no denial anywhere.

type Method = "GET" | "POST" | "PUT";
type Flag = "canEditMatches" | "canManagePlayers" | "canManagePromos";
type Step = { label: string; file: string; method: Method; flag?: Flag };

// The body of ONE handler — so a route with an open GET and a gated POST is read per method, never
// as a whole file (which is exactly how a dual-gate route would fool a file-level grep).
function handlerBody(file: string, method: Method): string {
  const s = readFileSync(file, "utf8");
  const i = s.indexOf(`export async function ${method}(`);
  if (i < 0) throw new Error(`${file}: no ${method} handler`);
  const rest = s.slice(i + 10);
  const j = rest.search(/\nexport async function |\nfunction errToResponse/);
  return j < 0 ? rest : rest.slice(0, j);
}

// The DECISION for one step, using the gate the handler really calls + the flag check it really has.
function decide(step: Step, row: AppUserRow, email: string): { ok: boolean; status?: number; why?: string } {
  const body = handlerBody(step.file, step.method);
  const usesMatchOps = /authenticateMatchOpsRead\(req\)/.test(body);
  const usesAdmin = /authenticateAdmin\(req\)/.test(body);
  if (usesMatchOps === usesAdmin) return { ok: false, status: 500, why: `${step.label}: expected exactly one gate` };
  // the declared flag must ACTUALLY be checked in that handler — a table entry can't claim a check
  // the code doesn't perform
  if (step.flag && !new RegExp(`auth\\.${step.flag}`).test(body)) return { ok: false, status: 500, why: `${step.label}: no auth.${step.flag} check in source` };
  const g = usesMatchOps ? matchOpsReadGate(row, email) : adminGate(row);
  if (!g.ok) return { ok: false, status: g.status, why: g.error };
  if (step.flag && !deriveMatchOpsFlags(row)[step.flag]) return { ok: false, status: 403, why: `missing ${step.flag}` };
  return { ok: true };
}

const R = (p: string) => `src/app/api/${p}/route.ts`;
// Deonna's actual click path through Gameday Ops.
const PANEL_PATH: Step[] = [
  { label: "board (gameday)", file: R("matchday/[env]/gameday"), method: "GET" },
  { label: "tile → panel opens (match detail)", file: R("matchday/[env]/matches/[id]"), method: "GET" },
  { label: "panel roster read-back", file: R("matchday/[env]/roster/[matchId]"), method: "GET" },
  { label: "cancel preview (live credit numbers)", file: R("matchday/[env]/matches/[id]/cancel"), method: "GET" },
];
const BAN: Step = { label: "ban (suspend/expel/lift)", file: R("lookup/[env]/ban"), method: "POST", flag: "canManagePlayers" };
// Every write she must STILL be refused, asserted individually.
const WRITES: Step[] = [
  { label: "PUT match (save edits)", file: R("matchday/[env]/matches/[id]"), method: "PUT", flag: "canEditMatches" },
  { label: "POST roster op", file: R("matchday/[env]/roster/[matchId]"), method: "POST", flag: "canEditMatches" },
  { label: "POST cancel (execute)", file: R("matchday/[env]/matches/[id]/cancel"), method: "POST", flag: "canEditMatches" },
];
const LOOKUP: Step[] = [
  { label: "player lookup search", file: R("lookup/[env]"), method: "GET" },
  { label: "player payments (why was I charged twice)", file: R("lookup/[env]/payments"), method: "GET" },
];

console.log("\nTHE WALK — Deonna's exact flag set, board → tile → panel → roster → cancel preview:");
{
  const results = PANEL_PATH.map((s) => ({ s, d: decide(s, DEONNA, DEONNA_EMAIL) }));
  for (const { s, d } of results) is(`  ${s.label} — opens`, d.ok, true);
  // the end-to-end claim: the WHOLE path, no denial at any step
  is("THE WHOLE PATH walks with zero 403s (panel never opens-then-403s)", results.filter((r) => !r.d.ok).map((r) => `${r.s.label}: ${r.d.why}`), []);
}

console.log("\nDeonna's reads on Player Lookup:");
for (const s of LOOKUP) is(`  ${s.label} — opens`, decide(s, DEONNA, DEONNA_EMAIL).ok, true);

console.log("\nBAN — the one write she holds:");
is("Deonna CAN ban (MANAGE PLAYERS)", decide(BAN, DEONNA, DEONNA_EMAIL).ok, true);
is("Match Ops WITHOUT manage-players CANNOT ban → 403", decide(BAN, MATCHOPS_ONLY, "ro@playmatchday.com"), { ok: false, status: 403, why: "missing canManagePlayers" });
is("an admin without manage-players CANNOT ban either", decide(BAN, { id: "a3", is_admin: true, can_access_matchops: true }, "a3@x.com").ok, false);

console.log("\nEvery other write still refuses her — asserted individually:");
for (const s of WRITES) is(`  ${s.label} — REFUSED`, decide(s, DEONNA, DEONNA_EMAIL).ok, false);

console.log("\nA no-flags account is denied EVERYTHING (deny by default):");
for (const s of [...PANEL_PATH, ...LOOKUP, BAN, ...WRITES]) {
  const d = decide(s, NOFLAGS, "nobody@playmatchday.com");
  is(`  ${s.label} — 403`, { ok: d.ok, status: d.status }, { ok: false, status: 403 });
}

console.log("\nThe E2E service account stays blocked, keyed on EMAIL:");
for (const s of [...PANEL_PATH, ...LOOKUP, BAN]) {
  const d = decide(s, { id: "e2e2", can_access_matchops: true }, E2E_SERVICE_EMAIL);
  is(`  ${s.label} — blocked`, { ok: d.ok, why: d.why }, { ok: false, why: "Service accounts cannot access Match Ops" });
}

// The ban route must report LANDED / NOT APPLIED — a 2xx is not proof, and this write is
// player-facing (it revokes platform access). Asserted at source.
console.log("\n/ban outcome reporting (a 2xx is not proof):");
{ const s = readFileSync(R("lookup/[env]/ban"), "utf8");
  is("ban goes through recordWrite (change_log, with the actor)", /recordWrite\(/.test(s) && /actorEmail: auth\.email/.test(s), true);
  is("ban re-reads and returns LANDED / NOT APPLIED", /"NOT APPLIED"/.test(s) && /landed/.test(s), true); }
{ const s = readFileSync("src/components/PlayerLookup.tsx", "utf8");
  is("the ban UI refuses to report success on landed:false", /j\?\.landed === false/.test(s), true); }

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
