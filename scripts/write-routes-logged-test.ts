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
  "DELETE /admin/matches/user-matches/{um}",        // REMOVE from match
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

// 2) Both known write routes route through recordWrite.
for (const f of ["src/app/api/matchday/[env]/matches/[id]/route.ts", "src/app/api/matchday/[env]/roster/[matchId]/route.ts"]) {
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
  "src/app/api/stage/matches/[id]/route.ts",
];
let cliOffenders: string[] = [];
for (const f of files) if (readFileSync(f, "utf8").includes("CLI_WRITE_ACTOR")) cliOffenders.push(f);
cliOffenders.length === 0 ? ok("no route imports CLI_WRITE_ACTOR (the script backdoor)") : bad("a route imports CLI_WRITE_ACTOR", cliOffenders.join(", "));
for (const f of WRITE_ROUTES) {
  const src = readFileSync(f, "utf8");
  src.includes("canEditMatches") ? ok(`${f.split("/").slice(-2)[0]} gates on canEditMatches (EDIT MATCHES)`) : bad(`${f} does NOT check canEditMatches`);
}

console.log(`\nCanonical write endpoints (${WRITE_ENDPOINTS.length}), all via recordWrite:`);
for (const e of WRITE_ENDPOINTS) console.log(`  · ${e}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
