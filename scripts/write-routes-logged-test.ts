import "server-only"; // no-op under --conditions=react-server
// Phase 16 — the guard that stops the SIXTH write route from being forgotten. Every
// production write must go through recordWrite (the shared log hook). This asserts,
// by scanning the route sources, that NO route calls apiWrite directly — the only
// permitted apiWrite call site is inside a recordWrite `write: () => apiWrite(...)`
// closure. A new route with a bare apiWrite fails this immediately.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/write-routes-logged-test.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };

// The canonical write endpoints Clubhouse fires (documentary — the source scan below is
// what actually enforces coverage). Removing a paid player is the most consequential.
const WRITE_ENDPOINTS = [
  "PUT /admin/matches/{id}",                       // match editor + both drawers + shape
  "PUT /admin/teams/{id}",                          // team name / lock
  "POST /admin/matches/{id}/players/{u}",           // add player
  "POST /admin/matches/{id}/fake-players",          // add fake
  "POST /admin/matches/{id}/batch/fake-players",    // bulk fake
  "POST /admin/user-matches",                       // move / swap
  "DELETE /admin/matches/user-matches/{um}",        // REMOVE from match + reduce the fake count
                                                    //   (batch/fake-players only ADDS — measured
                                                    //   2026-09-02; see matchday-api-facts.md)
  "PATCH /admin/players/{id}/fake-player",          // toggle fake
];

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p));
    else if (e === "route.ts") out.push(p);
  }
  return out;
}

const API_DIR = "src/app/api";
const files = routeFiles(API_DIR);
ok(`scanned ${files.length} API route files under ${API_DIR}`);

// 1) NO bare apiWrite anywhere: every apiWrite( must be preceded by "=> " (i.e. it is
//    the injected write closure of recordWrite).
let bareOffenders: string[] = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    let idx = 0;
    while ((idx = line.indexOf("apiWrite(", idx)) !== -1) {
      const before = line.slice(Math.max(0, idx - 6), idx);
      if (!/=>\s*$/.test(before)) bareOffenders.push(`${f}:${i + 1}`);
      idx += "apiWrite(".length;
    }
  });
}
bareOffenders.length === 0
  ? ok("no route calls apiWrite directly — every write is a recordWrite closure")
  : bad("a route calls apiWrite OUTSIDE recordWrite (unlogged write!)", bareOffenders.join(", "));

// 2) Every known write route routes through recordWrite (incl. the Phase 18 ban route).
for (const f of ["src/app/api/matchday/[env]/matches/[id]/route.ts", "src/app/api/matchday/[env]/roster/[matchId]/route.ts", "src/app/api/lookup/[env]/ban/route.ts", "src/app/api/matchday/[env]/matches/[id]/fakes/route.ts"]) {
  const src = readFileSync(f, "utf8");
  src.includes("recordWrite(") ? ok(`${f.split("/").slice(-2)[0]} routes writes through recordWrite`) : bad(`${f} does NOT call recordWrite`);
}

// 3) The roster route's op switch still covers every write kind (so none silently
//    drops out of the logged path).
const roster = readFileSync("src/app/api/matchday/[env]/roster/[matchId]/route.ts", "utf8");
const kinds = ["add", "add-fake", "bulk-fake", "move", "remove", "fake", "teams", "shape"];
const missing = kinds.filter((k) => !roster.includes(`case "${k}":`));
missing.length === 0 ? ok(`roster route handles all ${kinds.length} write kinds (all logged)`) : bad("roster route missing kinds", missing.join(", "));

// 4) PHASE 17 — no route imports the CLI backdoor actor, and every write route gates on
//    EDIT MATCHES (canEditMatches). The write path enforces it unbypassably; this ensures
//    a route also does the early zero-network 403 and never fakes an actor.
const WRITE_ROUTES = [
  "src/app/api/matchday/[env]/matches/[id]/route.ts",
  "src/app/api/matchday/[env]/roster/[matchId]/route.ts",
  "src/app/api/matchday/[env]/matches/[id]/fakes/route.ts",
  "src/app/api/stage/matches/[id]/route.ts",
];
let cliOffenders: string[] = [];
for (const f of files) if (readFileSync(f, "utf8").includes("CLI_WRITE_ACTOR")) cliOffenders.push(f);
cliOffenders.length === 0 ? ok("no route imports CLI_WRITE_ACTOR (the script backdoor)") : bad("a route imports CLI_WRITE_ACTOR", cliOffenders.join(", "));
for (const f of WRITE_ROUTES) {
  const src = readFileSync(f, "utf8");
  src.includes("canEditMatches") ? ok(`${f.split("/").slice(-2)[0]} gates on canEditMatches (EDIT MATCHES)`) : bad(`${f} does NOT check canEditMatches`);
}
// Phase 18: the ban route gates on MANAGE PLAYERS (a separate authority), not EDIT MATCHES.
{ const src = readFileSync("src/app/api/lookup/[env]/ban/route.ts", "utf8");
  src.includes("canManagePlayers") ? ok("ban route gates on canManagePlayers (MANAGE PLAYERS)") : bad("ban route does NOT check canManagePlayers");
  src.includes('"manage"') ? ok('ban route passes requires:"manage" to apiWrite (not EDIT MATCHES)') : bad("ban route does not require manage authority"); }

/* 5) MONEY WRITES TO OUR OWN TABLES ARE LOGGED TOO ───────────────────────────────────────────
 * The scan above covers writes to the MatchDay API. These write SUPABASE, and one of them decided
 * who a payroll row pays while writing nothing to change_log at all: manager_gusto_aliases. The
 * Gusto CSV matches on First + Last, so changing an alias redirects a payroll row from one worker
 * to another, and as of 2026-09-15 that is reachable by anyone with Match Ops from two screens
 * rather than by an admin from one. An unlogged write that decides who gets paid is the one
 * combination not to ship. */
const MONEY_ROUTES: { file: string; source: string; methods: string[] }[] = [
  { file: "src/app/api/manager-pay/aliases/route.ts", source: "Manager Pay — Gusto alias", methods: ["PUT", "DELETE"] },
  { file: "src/app/api/manager-pay/added/route.ts", source: "Manager Pay — added", methods: ["POST", "DELETE"] },
];
for (const r of MONEY_ROUTES) {
  const src = readFileSync(r.file, "utf8");
  const name = r.file.split("/").slice(-2)[0];
  const calls = (src.match(/recordWrite\(/g) ?? []).length;
  calls >= r.methods.length
    ? ok(`${name}: ${calls} recordWrite call sites for ${r.methods.length} write methods`)
    : bad(`${name}: only ${calls} recordWrite call sites for ${r.methods.join("/")}`);
  src.includes(`source: "${r.source}"`) ? ok(`  and logs under "${r.source}"`) : bad(`  ${name} does not log under "${r.source}"`);
  src.includes("supabaseLogStore()") ? ok("  through supabaseLogStore (change_log)") : bad(`  ${name} does not use supabaseLogStore`);
  /* THE READ-BACK IS THE VERDICT, not the absence of an error — the rule the whole hook exists for. */
  src.includes("applied:") ? ok("  and its verdict is the read-back, not a 2xx") : bad(`  ${name} has no applied() read-back`);
}
/* NO BARE WRITE OUTSIDE THE HOOK. A second .upsert or .delete on the alias table would be a
 * second path with no audit, which is exactly how this one went unlogged for so long. */
{
  /* COMMENTS ARE STRIPPED BEFORE COUNTING. The header on this route now QUOTES the stale
   * "authenticateAdmin" claim it replaced, and explains the matchops gate in prose — so a scan of
   * the raw text counted four gates and found the very word it was asserting the absence of. A
   * guard that a comment can satisfy, or break, is not a guard. */
  const raw = readFileSync("src/app/api/manager-pay/aliases/route.ts", "utf8");
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const writes = (src.match(/\.(upsert|delete)\(/g) ?? []).length;
  writes === 2
    ? ok(`aliases route has exactly 2 table writes (one per method), both inside recordWrite`)
    : bad(`aliases route has ${writes} table writes — every one must sit in a recordWrite closure`);
  /* THE GATE, ASSERTED, because the header used to claim a different one. */
  const gates = (src.match(/authenticateCapability\(req, "matchops"\)/g) ?? []).length;
  gates === 3 ? ok("all three methods gate on matchops, which is what the header now says") : bad(`aliases route has ${gates} matchops gates, expected 3`);
  src.includes("authenticateAdmin") ? bad("aliases route still CALLS authenticateAdmin") : ok("  and no code path calls authenticateAdmin");
  /* THE HEADER HAS TO SAY THE REAL GATE. It said "Admin-only on app_users.is_admin" while the code
   * gated on matchops, and it said it about money. */
  /matchops/.test(raw.split("import")[0]) ? ok("  and the header names the gate the code actually uses") : bad("the aliases header does not name the matchops gate");
}

/* 6) THE NAMED UNLOCK IS COUNTED, NOT TRUSTED ─────────────────────────────────────────────────
 * DELETE /admin/matches/{id} stays on the write client's endpoint deny-list and is reachable only
 * by a caller passing unlock: "delete-match" by name. A named unlock is only worth anything if a
 * SECOND one is visible the day it appears, so this counts them.
 *
 * Match cancel was removed from that deny-list outright in Phase 23 and its protection moved into a
 * dedicated route. Delete is not being treated the same way, because a cancel leaves a record and a
 * delete leaves nothing. */
{
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const callers: string[] = [];
  for (const f of files) {
    if (strip(readFileSync(f, "utf8")).includes('"delete-match"')) callers.push(f);
  }
  // src/lib is scanned too: an unlock passed from a helper would be just as reachable as one
  // passed from a route, and would not show up in the route scan above.
  const libHits: string[] = [];
  for (const e of readdirSync("src/lib")) {
    if (!e.endsWith(".ts")) continue;
    const p2 = join("src/lib", e);
    const src = strip(readFileSync(p2, "utf8"));
    // The definition in matchdayStageApi is the deny-list entry itself, not a call.
    if (src.includes('"delete-match"') && e !== "matchdayStageApi.ts") libHits.push(p2);
  }
  const all = [...callers, ...libHits];
  all.length === 1
    ? ok(`exactly one call site unlocks the match-delete endpoint: ${all[0]}`)
    : bad(`${all.length} call sites unlock the match-delete endpoint`, all.join(", ") || "(none)");
  const expected = "src/app/api/matchday/[env]/matches/[id]/route.ts";
  all[0] === expected
    ? ok("  and it is the delete route, not somewhere else")
    : bad(`  the unlocked call site is ${all[0]}, expected ${expected}`);
  /* THE ENTRY IS STILL ON THE LIST. An unlock that worked by deleting the line would pass the count
   * above and protect nothing. */
  const client = readFileSync("src/lib/matchdayStageApi.ts", "utf8");
  /DELETE[\s\S]{0,120}segs: \["admin", "matches", null\]/.test(client)
    ? ok("  and DELETE /admin/matches/{id} is still ON the deny-list, not removed from it")
    : bad("  the match-delete deny-list entry is gone, so the unlock guards nothing");
  /unlock: "delete-match"/.test(client)
    ? ok("  with the unlock named on the entry itself")
    : bad("  the deny-list entry carries no named unlock");
}

console.log(`\nCanonical write endpoints (${WRITE_ENDPOINTS.length}), all via recordWrite:`);
for (const e of WRITE_ENDPOINTS) console.log(`  · ${e}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
