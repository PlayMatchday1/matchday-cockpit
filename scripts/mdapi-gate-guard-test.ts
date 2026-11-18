// THE BUILD GUARD (Ryan, 2026-11-18): nothing reaches the MatchDay API except through the gate
// (src/lib/mdapiGate.ts). Part of `npm run verify`, so a push that adds a way around it fails.
//
// WHY A SOURCE CHECK. Which host a fetch() talks to is decided at runtime by an env var; it cannot be
// observed inside the gate without the network. So this reads source, and per CLAUDE.md it pairs
// every negative with a positive control proving the pattern finds what it looks for.
//
// THE RULES
//   1. In src/, a file that calls fetch() directly may not know where MatchDay lives: no MatchDay
//      host, no MatchDay base-URL variable. The one exception is the gate itself.
//   2. The two transports (matchdayApi.ts, matchdayStageApi.ts) call mdapiFetch and never fetch().
//   3. Only those two transports import mdapiFetch (everything else goes through them, so the lane,
//      retry and write rules cannot be skipped).
//   4. scripts/: hand-run scripts that call MatchDay directly are FROZEN at today's list (the
//      tools that predate the gate). A new one fails; use getMatchdayApiClient / apiGet instead,
//      which take a production slot even from a laptop.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/mdapi-gate-guard-test.ts

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const eq = (n: string, got: unknown, want: unknown) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const ROOT = join(__dirname, "..");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(ROOT, p);
// Comments removed so a sentence about fetch or a host does not count either way.
const code = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** A direct call of the global fetch: `fetch(` not preceded by an identifier character or a dot. */
const RAW_FETCH = /(^|[^\w.$])fetch\s*\(/m;
/** Knowing where MatchDay lives. */
// (playmatchday.com alone is the marketing site and staff email domain — not the API.)
const MATCHDAY_WHERE = /herokuapp\.com|api\.playmatchday\.com|MATCHDAY_API_BASE_URL|MATCHDAY_PROD_BASE_URL|MATCHDAY_STAGE_API_BASE_URL|OFFERS_API_BASE_URL|LOCAL_MDAPI_BASE_URL|MATCHDAY_HOSTS/;
const IMPORTS_MDAPIFETCH = /import\s*{[^}]*\bmdapiFetch\b[^}]*}\s*from\s*["'][^"']*mdapiGate["']/;

const GATE = "src/lib/mdapiGate.ts";
const TRANSPORTS = ["src/lib/matchdayApi.ts", "src/lib/matchdayStageApi.ts"];

const src = walk(join(ROOT, "src")).map((p) => ({ f: rel(p), c: code(p) }));

console.log("\nPOSITIVE CONTROLS — the patterns find what they look for:");
const byName = (f: string) => src.find((x) => x.f === f);
eq("RAW_FETCH finds the gate's own fetch", RAW_FETCH.test(byName(GATE)?.c ?? ""), true);
eq("RAW_FETCH finds a known non-MatchDay fetch (wpSubmissionsSync)", RAW_FETCH.test(byName("src/lib/wpSubmissionsSync.ts")?.c ?? ""), true);
eq("RAW_FETCH does not mistake mdapiFetch( for fetch(", RAW_FETCH.test("await mdapiFetch(url)"), false);
eq("MATCHDAY_WHERE finds the host list in matchdayStageApi", MATCHDAY_WHERE.test(byName("src/lib/matchdayStageApi.ts")?.c ?? ""), true);
eq("MATCHDAY_WHERE finds the default base in matchdayApi", MATCHDAY_WHERE.test(byName("src/lib/matchdayApi.ts")?.c ?? ""), true);
eq("IMPORTS_MDAPIFETCH finds the transports' import", TRANSPORTS.every((t) => IMPORTS_MDAPIFETCH.test(byName(t)?.c ?? "")), true);
eq("src was walked (a missing tree would pass every negative below)", src.length > 500, true);

console.log("\nRULE 1 — a file with a raw fetch() does not know where MatchDay lives:");
const offenders = src.filter((x) => x.f !== GATE && RAW_FETCH.test(x.c) && MATCHDAY_WHERE.test(x.c)).map((x) => x.f);
eq("no file outside the gate both calls fetch() and names a MatchDay host or base URL", offenders, []);

console.log("\nRULE 2 — the transports go through the gate:");
for (const t of TRANSPORTS) {
  eq(`${t}: no raw fetch()`, RAW_FETCH.test(byName(t)?.c ?? "fetch("), false);
  eq(`${t}: calls mdapiFetch`, /\bmdapiFetch\s*\(/.test(byName(t)?.c ?? ""), true);
}

console.log("\nRULE 3 — only the transports import mdapiFetch:");
eq("importers of mdapiFetch", src.filter((x) => IMPORTS_MDAPIFETCH.test(x.c)).map((x) => x.f).sort(), [...TRANSPORTS].sort());

console.log("\nRULE 4 — scripts that call MatchDay directly are frozen:");
const FROZEN = [
  "scripts/audit-phantom-matches.ts", "scripts/check-firstmatch-promo-api.ts", "scripts/e2e/verify-fakes-route-staging.mjs",
  "scripts/probe-admin-players.ts", "scripts/probe-weekly-managers-report.ts", "scripts/prod-echo-probe.ts",
  "scripts/stage-fake-reconciler-probe.mjs", "scripts/stage-p4-reconcile.ts", "scripts/stage-rename-2470.ts",
  "scripts/test-matchday-shapes.ts",
];
// Test suites name hosts in fixtures and mock fetch; untracked _scratch files are not in the tree.
const scripts = walk(join(ROOT, "scripts")).map(rel)
  .filter((f) => !/(^|\/)_/.test(f.replace(/^scripts\//, "")) && !/test\.(ts|mts|mjs)$|-test-/.test(f) && !f.includes("/mocks/"));
const direct = scripts.filter((f) => { const c = code(join(ROOT, f)); return RAW_FETCH.test(c) && MATCHDAY_WHERE.test(c); }).sort();
eq("scripts calling MatchDay directly: exactly the frozen list, nothing new", direct.filter((f) => !FROZEN.includes(f)), []);
eq("...and the scan finds every frozen one (positive control: the pattern still sees them)", direct, [...FROZEN].sort());

console.log(`\n${pass} passed, ${fail} failed`);
if (pass === 0 || fail > 0) process.exit(1);
