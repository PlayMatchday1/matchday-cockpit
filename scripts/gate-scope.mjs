// WHICH GATE DOES THIS PUSH NEED — DERIVED from the import graph, not from a hand-kept list.
//
// THE POLICY: the gate exists for WRITES TO THE MATCHDAY API. Those reach players — a wrong match
// name, a wrong price, a duplicated charge. Everything else gets typecheck.
//
// THE FIRST VERSION PUT ALL OF src/ IN THE FULL LANE, which defeated the point: a read-only Finance
// chart cost the same nine minutes as a match edit. This one asks a sharper question — CAN THIS
// FILE REACH THE MATCHDAY API? — and answers it two ways, because there are two ways to reach it:
//
//   1. BY IMPORT. Anything whose import graph reaches src/lib/matchdayApi.ts or
//      matchdayStageApi.ts can call the API in-process. Computed transitively, so a component three
//      hops from the client is caught without anyone remembering to list it.
//
//   2. BY HTTP. A browser component cannot import the server client; it fetches a route. So the
//      route files found in (1) are turned back into URL prefixes, and any file whose source
//      mentions one of those prefixes is full-gate too. That is how MatchPanel, PromoCodes,
//      PlayerLookup, VeoMasterSchedule, MatchEditor and MatchDrawer are caught — none of them
//      imports the client, all of them POST to a route that does.
//
// SUITES ROUTE BY WHAT THEY TOUCH, exactly like src/. A bare `scripts/` rule used to answer FULL
// before either question was asked — 06529c1's whole-directory policy, carried into this file's
// import-graph rewrite by omission rather than by decision. A test for a pure arithmetic function
// cost the same nine minutes as a match edit.
//
// THE DIRECTION IS UNCHANGED AND DELIBERATE: unrecognised falls to the FULL gate. A file that
// cannot be read, an import that cannot be resolved, an empty diff — all take the gate. A false
// full gate costs nine minutes. A false skip costs a player.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

/** The MatchDay API clients. Everything that can talk to MatchDay in-process goes through one. */
export const MATCHDAY_CLIENTS = [
  "src/lib/matchdayApi.ts",
  "src/lib/matchdayStageApi.ts",
];

/**
 * Always full gate regardless of what the graph says — the gate's own machinery, anything that
 * changes the database under it, and the two permission suites.
 *
 * THE SIX GUARD SUITES THAT USED TO BE LISTED HERE ARE GONE, and nothing was weakened by it: each
 * imports a MatchDay client and so re-earns the full lane through the graph, which is the same
 * answer arrived at by evidence rather than by memory. The permission pair stays because it does
 * NOT re-earn it — those suites drive permissions through the browser and touch no client — and a
 * permission regression is invisible on screen.
 */
export const FULL_GATE_ALWAYS = [
  ".githooks/",
  "package.json",
  "package-lock.json",
  "supabase/migrations/",
  "scripts/e2e/verify-user-permissions.mjs",
  "scripts/e2e/verify-user-delete.mjs",
];

/**
 * THE GATE'S OWN MACHINERY — fast set, NOT the browser lane.
 *
 * These three used to sit in FULL_GATE_ALWAYS and they were the single biggest source of false
 * FULLs. Measured on two of tonight's pushes: FULL was decided by `quarantine.pinned.json` and
 * `run-suites.mjs` alone, with every one of the ten source files in the diff routing to typecheck
 * on its own. Editing the quarantine list cost 19 minutes of browser suites that the edit could
 * not possibly have affected.
 *
 * WHAT ACTUALLY VALIDATES A CHANGE TO THESE FILES IS THE FAST SET, and it already does:
 * `gate-scope-test.mjs` guards the router and the pinned-list DRIFT GUARD lives in
 * `run-suites.mjs` itself — both run under `npm run verify`, in ~70s. The e2e lane tests the
 * product, not the runner. Routing the runner through it was a category error, not a safety
 * margin: no browser suite asserts anything about the quarantine list.
 *
 * `.githooks/`, migrations and the two permission suites STAY at FULL. The hook chooses which
 * gate runs (so nothing downstream can catch it breaking), a migration changes the database under
 * everything, and the permission pair drives permissions through the browser and is the one thing
 * a regression stays invisible in.
 */
export const VERIFY_GATE_ALWAYS = [
  "scripts/run-suites.mjs",
  "scripts/gate-scope.mjs",
  // THE ROUTER'S OWN GUARD, added for the same reason the router is here: it IS the fast set's
  // check on this file, so routing it through the browser lane is the same category error.
  // It also has to be listed rather than left to the rules below, because its CONTROL fixture
  // writes `fetch("/api/matchday/x")` as a string literal — the URL-is-data case, in the very
  // test that proves the URL-is-data case. Left alone it would route itself to FULL forever.
  "scripts/gate-scope-test.mjs",
  "scripts/quarantine.pinned.json",
];

/** Presentation and prose, wherever they live. */
export const TYPECHECK_ONLY_EXT = [".css", ".md", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico", ".json"];

/**
 * ── FILES THAT NAME A MATCHDAY ROUTE AS DATA AND CANNOT CALL IT ───────────────
 *
 * THE DEFECT THIS FIXES. Rule 2 below asks "does this file's source mention a
 * MatchDay-reaching URL prefix?" and takes the full gate if it does. That is a
 * TEXT match standing in for a FACT, and it cannot tell a fetch from a mention.
 * It cost a nine-minute browser lane on a push whose every source file routed to
 * typecheck: the deciding path was `scripts/matchops-auth-test.ts`, a CENSUS
 * suite that readFileSync's route files and asserts on their gates. It names
 * `/api/city/gameday` in a string literal, as DATA, and issues no request at all.
 *
 * COMMENTS ARE NOW STRIPPED BEFORE THE SCAN (see fullGateReason), which is the
 * same fix matchops-auth-test.ts already applies to its own detectors under the
 * heading READ THE CODE, NOT THE PROSE — and it alone freed 31 of the 62 files
 * the rule was catching, among them syncLogging.ts, crmAuth.ts,
 * mirrorWriteThrough.ts and every sync route that merely cites a sibling.
 *
 * These are the rest: files that hold the URL in a literal because the URL IS
 * the subject. Each is named, with the reason, and NONE of this is taken on
 * trust — `gate-scope-test.mjs` asserts for every entry that the file still
 * exists, still names a prefix (so a stale entry is removed rather than left to
 * rot), and CONTAINS NO HTTP-ISSUING CALL. Add a `fetch(` or a `page.goto(` to
 * one of these and the fast set goes red until the entry comes out.
 *
 * THE DIRECTION IS UNCHANGED: this is the only narrowing, it is explicit, and
 * everything not on it still takes the gate. A false full gate costs nine
 * minutes; a false skip costs a player.
 */
export const URL_IS_DATA_NOT_A_CALL = [
  { file: "scripts/matchops-auth-test.ts", why: "the route→gate census — it reads route sources and asserts on them; the URLs are the data" },
  { file: "scripts/write-routes-logged-test.ts", why: "scans route sources for bare apiWrite; the URLs are the endpoints it is enumerating" },
  { file: "scripts/roster-edit-model-test.ts", why: "a pure model suite — the route path appears in the log payload it asserts on" },
  { file: "scripts/mirror-writethrough-test.ts", why: "a pure model suite — the route path appears in the log payload it asserts on" },
  { file: "scripts/city-confinement-test.ts", why: "the city boundary's decision table — the route paths are the rows being decided" },
  { file: "src/lib/cityConfinement.ts", why: "names the confined route prefixes as DATA for the gate to test against; it makes no request" },
];

/** The tokens that mean a file can actually issue a request. Used by the rot guard
 *  in gate-scope-test.mjs, exported so the guard and this list cannot drift. */
export const HTTP_ISSUING = /\bfetch\s*\(|\.goto\s*\(|XMLHttpRequest|sendBeacon|new WebSocket|new EventSource|\baxios\b|page\.route\s*\(/;

const SRC = "src";
// WALK ROOTS. src/ alone could not see a suite file, which is why the blanket rule below was
// load-bearing: delete it without this and every suite routes to typecheck. Adding scripts/ as an
// IMPORTER root cannot pull src/ files in — reachability runs from the clients outward to whoever
// imports them, so a new root only ever adds itself.
const GRAPH_ROOTS = ["src", "scripts"];
const exts = [".ts", ".tsx"];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (exts.some((x) => p.endsWith(x))) out.push(p);
  }
  return out;
}

/** Resolve an import specifier to a repo-relative file, or null if it is a package. */
function resolveImport(spec, fromFile) {
  let base;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec).replace(process.cwd() + "/", "");
  else return null; // node_modules
  for (const cand of [base, ...exts.map((e) => base + e), ...exts.map((e) => join(base, "index" + e))]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

const IMPORT_RX = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function importsOf(file) {
  let src;
  try { src = readFileSync(file, "utf8"); } catch { return []; }
  const out = [];
  for (const m of src.matchAll(IMPORT_RX)) {
    const spec = m[1] ?? m[2];
    if (!spec) continue;
    const r = resolveImport(spec, file);
    if (r) out.push(r);
  }
  return out;
}

/**
 * Every file whose import graph reaches a MatchDay client, computed by walking edges backwards from
 * the clients. Cached per process — the hook calls this once.
 */
let _reach = null;
export function matchdayReachable() {
  if (_reach) return _reach;
  const files = GRAPH_ROOTS.flatMap((r) => walk(r));
  const rev = new Map();            // file -> [files that import it]
  for (const f of files) for (const dep of importsOf(f)) {
    if (!rev.has(dep)) rev.set(dep, []);
    rev.get(dep).push(f);
  }
  const seen = new Set(MATCHDAY_CLIENTS.filter((c) => existsSync(c)));
  const queue = [...seen];
  while (queue.length) {
    const cur = queue.pop();
    for (const importer of rev.get(cur) ?? []) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      queue.push(importer);
    }
  }
  _reach = seen;
  return seen;
}

/**
 * URL prefixes for the API routes that CAN reach MatchDay — derived from their file paths, so a new
 * write route is covered the day it is added. Dynamic segments end the prefix: `[env]` becomes the
 * boundary, which makes the match coarser and therefore safer.
 */
export function matchdayUrlPrefixes() {
  const out = new Set();
  for (const f of matchdayReachable()) {
    if (!f.startsWith("src/app/api/") || !f.endsWith("/route.ts")) continue;
    const rel = f.slice("src/app".length, -"/route.ts".length); // "/api/matchday/[env]/matches/[id]"
    const cut = rel.indexOf("/[");
    out.add(cut >= 0 ? rel.slice(0, cut + 1) : rel);            // "/api/matchday/"
  }
  return [...out].sort();
}

const inList = (p, list) => list.some((f) => p === f || p.startsWith(f));

/** Mode → process exit status, read by .githooks/pre-push. Keep the two in step. */
export const EXIT_CODE = { skip: 12, typecheck: 0, verify: 11, full: 10 };

/** Why this one path needs the fast set, or null. Checked BEFORE fullGateReason. */
export function verifyGateReason(p) {
  return inList(p, VERIFY_GATE_ALWAYS)
    ? "the gate's own machinery — guarded by the fast set, not by the browser suites"
    : null;
}

/** Why this one path takes the full gate, or null if it does not. */
export function fullGateReason(p) {
  if (inList(p, VERIFY_GATE_ALWAYS)) return null;   // claimed by the tier above
  if (inList(p, FULL_GATE_ALWAYS)) return "a migration, the hook itself, or a kept permission carve-out";
  if (TYPECHECK_ONLY_EXT.some((e) => p.toLowerCase().endsWith(e))) return null;
  if (!p.startsWith("src/") && !p.startsWith("scripts/")) return null;   // docs, mockups, public…
  if (!existsSync(p)) return "the file could not be read — taking the gate rather than guessing";
  if (matchdayReachable().has(p)) return "its import graph reaches the MatchDay API client";
  if (URL_IS_DATA_NOT_A_CALL.some((e) => e.file === p)) return null;   // named, and guarded by the rot check
  let src;
  try { src = readFileSync(p, "utf8"); }
  catch { return "the file could not be read — taking the gate rather than guessing"; }
  // READ THE CODE, NOT THE PROSE. A URL inside a comment cannot send a request,
  // and half the files this rule was catching only ever cited one in a header.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const hit = matchdayUrlPrefixes().find((u) => code.includes(u));
  if (hit) return `it sends requests to ${hit} — a route that reaches the MatchDay API`;
  return null;
}

/**
 * TWO DIFFERENT NOTHINGS, and only one of them is dangerous.
 *
 * This used to answer FULL for both, under one message — "no changed paths could be read from the
 * diff" — which is true of an unreadable diff and false of an empty one. An empty commit changes
 * no file, so there is nothing any gate could test; taking the browser lane for it is 19 minutes
 * spent proving the previous push still works. An UNREADABLE diff is the opposite: the router has
 * no idea what is in it, and that is exactly when it should refuse to guess.
 *
 * The hook can tell these apart and this function cannot, so the hook says which it saw. The
 * sentinel is explicit rather than inferred from an empty argv, because "no arguments" is also
 * what a broken invocation looks like.
 */
export const EMPTY_DIFF = "--empty-diff";
export const UNKNOWN_DIFF = "--unknown-diff";

/**
 * @param {string[]} changed repo-relative paths, or one of the two sentinels above
 * @returns {{ mode: "skip"|"typecheck"|"verify"|"full", reason: string, deciding: {path:string,why:string}[] }}
 */
export function decideGateScope(changed) {
  const raw = (changed ?? []).map((p) => p.trim()).filter(Boolean);
  if (raw.includes(UNKNOWN_DIFF)) {
    return { mode: "full", reason: "the diff could not be read — taking the gate rather than guessing", deciding: [] };
  }
  if (raw.includes(EMPTY_DIFF)) {
    return { mode: "skip", reason: "the diff changes no files — there is nothing to gate", deciding: [] };
  }
  const paths = raw;
  if (paths.length === 0) {
    // Neither sentinel and no paths: a malformed call, which is an unknown diff by another name.
    return { mode: "full", reason: "no paths and no sentinel — treating as an unreadable diff", deciding: [] };
  }
  const full = [];
  const verify = [];
  for (const p of paths) {
    const fw = fullGateReason(p);
    if (fw) { full.push({ path: p, why: fw }); continue; }
    const vw = verifyGateReason(p);
    if (vw) verify.push({ path: p, why: vw });
  }
  if (full.length) {
    return {
      mode: "full",
      reason: `${full.length} of ${paths.length} changed path(s) can reach the MatchDay API or the gate itself`,
      deciding: full.slice(0, 8),
    };
  }
  if (verify.length) {
    return {
      mode: "verify",
      reason: `${verify.length} of ${paths.length} changed path(s) touch the gate's own machinery — fast set, no browser suites`,
      deciding: verify.slice(0, 8),
    };
  }
  return {
    mode: "typecheck",
    reason: `none of the ${paths.length} changed path(s) can reach the MatchDay API`,
    deciding: [],
  };
}

// CLI: prints the decision and exits 0 (typecheck) or 10 (full), so the shell hook branches on the
// status rather than parsing text.
if (process.argv[1] && process.argv[1].endsWith("gate-scope.mjs")) {
  const args = process.argv.slice(2);
  if (args[0] === "--explain") {
    console.log("MatchDay API clients:", MATCHDAY_CLIENTS.join(", "));
    console.log(`files reaching them by import: ${matchdayReachable().size}`);
    console.log("URL prefixes derived from those routes:");
    for (const u of matchdayUrlPrefixes()) console.log("  " + u);
    process.exit(0);
  }
  const d = decideGateScope(args);
  console.log(`▶ gate scope: ${d.mode.toUpperCase()} — ${d.reason}`);
  for (const { path, why } of d.deciding) console.log(`    · ${path} — ${why}`);
  const total = args.filter((p) => (d.mode === "full" ? fullGateReason(p) : verifyGateReason(p))).length;
  if (total > d.deciding.length) console.log(`    · …and ${total - d.deciding.length} more`);
  // The shell branches on the STATUS, never on this text.
  process.exit(EXIT_CODE[d.mode]);
}
