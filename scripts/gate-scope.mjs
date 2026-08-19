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
 * Always full gate regardless of what the graph says — the gate's own machinery, the permission
 * carve-outs the testing cut kept, and anything that changes the database under it. A permission
 * regression is invisible on screen, which is exactly why those suites survived.
 */
export const FULL_GATE_ALWAYS = [
  ".githooks/",
  "package.json",
  "package-lock.json",
  "supabase/migrations/",
  "scripts/run-suites.mjs",
  "scripts/gate-scope.mjs",
  "scripts/quarantine.pinned.json",
  "scripts/e2e/verify-user-permissions.mjs",
  "scripts/e2e/verify-user-delete.mjs",
  "scripts/matchops-auth-test.ts",
  // the five sub-second guards
  "scripts/mutation-tests.ts",
  "scripts/prod-guard-test.ts",
  "scripts/stage-denylist-test.ts",
  "scripts/change-log-test.ts",
  "scripts/write-routes-logged-test.ts",
];

/** Presentation and prose, wherever they live. */
export const TYPECHECK_ONLY_EXT = [".css", ".md", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico", ".json"];

const SRC = "src";
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
  const files = walk(SRC);
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

/** Why this one path takes the full gate, or null if it does not. */
export function fullGateReason(p) {
  if (inList(p, FULL_GATE_ALWAYS)) return "gate machinery, a migration, or a kept permission carve-out";
  if (TYPECHECK_ONLY_EXT.some((e) => p.toLowerCase().endsWith(e))) return null;
  if (!p.startsWith("src/") && !p.startsWith("scripts/")) return null;   // docs, mockups, public…
  if (p.startsWith("scripts/")) return "a suite or tool that runs inside the gate";
  if (!existsSync(p)) return "the file could not be read — taking the gate rather than guessing";
  if (matchdayReachable().has(p)) return "its import graph reaches the MatchDay API client";
  const src = (() => { try { return readFileSync(p, "utf8"); } catch { return ""; } })();
  const hit = matchdayUrlPrefixes().find((u) => src.includes(u));
  if (hit) return `it sends requests to ${hit} — a route that reaches the MatchDay API`;
  return null;
}

/**
 * @param {string[]} changed repo-relative paths, as `git diff --name-only` prints them
 * @returns {{ mode: "full"|"typecheck", reason: string, deciding: {path:string,why:string}[] }}
 */
export function decideGateScope(changed) {
  const paths = (changed ?? []).map((p) => p.trim()).filter(Boolean);
  if (paths.length === 0) {
    return { mode: "full", reason: "no changed paths could be read from the diff", deciding: [] };
  }
  const deciding = [];
  for (const p of paths) {
    const why = fullGateReason(p);
    if (why) deciding.push({ path: p, why });
  }
  if (deciding.length === 0) {
    return {
      mode: "typecheck",
      reason: `none of the ${paths.length} changed path(s) can reach the MatchDay API`,
      deciding: [],
    };
  }
  return {
    mode: "full",
    reason: `${deciding.length} of ${paths.length} changed path(s) can reach the MatchDay API or the gate itself`,
    deciding: deciding.slice(0, 8),
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
  const total = args.filter((p) => fullGateReason(p)).length;
  if (total > d.deciding.length) console.log(`    · …and ${total - d.deciding.length} more`);
  process.exit(d.mode === "full" ? 10 : 0);
}
