// THE GATE ROUTER'S OWN GUARD — four cases, on fixtures this test builds and destroys.
//
// WHY NOT NAME REAL FILES. A guard that asserts "scripts/mutation-tests.ts is FULL" stops being a
// guard the day that file drops its import: the assertion still passes, for a reason nobody chose.
// These fixtures exist for the length of this run and their imports are written here, in view of
// the assertion, so what is being tested cannot drift out from under it.
//
// THE ONE THAT CARRIES THE WEIGHT is `plain.ts → typecheck`. FULL is this router's default and
// three of the four cases expect it, so those pass on a router that has stopped thinking. Only the
// typecheck case proves it can still reach the other answer at all.
//
//   node scripts/gate-scope-test.mjs
import { mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync } from "node:fs";

let PASS = 0, FAIL = 0;
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (got === want ? ok(n) : bad(n, `got ${got}, want ${want}`));

const DIR = "scripts/__gatefix__";
const P = {
  plain:      `${DIR}/plain.ts`,
  api:        `${DIR}/api.ts`,
  unreadable: `${DIR}/unreadable.ts`,
  deleted:    `${DIR}/deleted.ts`,   // deliberately never written
  mention:    `${DIR}/mention.ts`,   // names a MatchDay URL in a COMMENT only
  caller:     `${DIR}/caller.ts`,    // the control: actually fetches one
};

try {
  // THE FIXTURES ARE BUILT BEFORE gate-scope IS IMPORTED. Its reachability set is computed once
  // per process and cached, so a fixture written after the first call would be invisible to it.
  mkdirSync(DIR, { recursive: true });
  writeFileSync(P.plain, `import { readFileSync } from "node:fs";\nexport const x = readFileSync;\n`);
  writeFileSync(P.api, `import { matchdayFetch } from "@/lib/matchdayApi";\nexport const y = matchdayFetch;\n`);
  writeFileSync(P.unreadable, `export const z = 1;\n`);
  chmodSync(P.unreadable, 0o000);

  const { decideGateScope } = await import("./gate-scope.mjs");
  const lane = (p) => decideGateScope([p]).mode;

  console.log("\na suite that touches nothing API-adjacent:");
  eq("a scripts/ file importing only node builtins is TYPECHECK", lane(P.plain), "typecheck");

  console.log("\na suite that can reach the API in-process:");
  eq("a scripts/ file importing matchdayApi.ts is FULL", lane(P.api), "full");

  console.log("\na path the router cannot read:");
  // POSITIVE CONTROL ON THE FIXTURE ITSELF. If this process can read the file anyway — running as
  // root, or a filesystem that ignores the mode — then the case under test never occurred, and a
  // passing FULL below would be the default answer rather than the tested one. Fail, do not skip.
  let readable = true;
  try { readFileSync(P.unreadable, "utf8"); } catch { readable = false; }
  eq("  (control) the unreadable fixture really is unreadable", readable, false);
  eq("an existing but unreadable path is FULL", lane(P.unreadable), "full");

  console.log("\na path that is no longer on disk:");
  eq("a deleted path is FULL", lane(P.deleted), "full");

  console.log("\none bad path in a diff decides the whole diff:");
  eq("plain + api together are FULL", decideGateScope([P.plain, P.api]).mode, "full");
  eq("  …and plain alone is still typecheck (the mix, not the count, decides)",
     decideGateScope([P.plain]).mode, "typecheck");

  /* THE GATE'S OWN MACHINERY GETS THE FAST SET, NOT THE BROWSER LANE. These three were in
   * FULL_GATE_ALWAYS and were the single largest source of false FULLs: two of tonight's pushes
   * were routed to 19 minutes of browser suites by the quarantine list alone, while every source
   * file in the diff routed to typecheck on its own. Real paths are named deliberately here —
   * unlike the fixtures above, the POINT of the assertion is which list these specific files are
   * on, so naming them is what is being tested rather than a detail that can drift. */
  console.log("\nthe gate's own machinery:");
  for (const f of ["scripts/run-suites.mjs", "scripts/gate-scope.mjs", "scripts/quarantine.pinned.json"]) {
    eq(`${f} is VERIFY, not FULL`, decideGateScope([f]).mode, "verify");
  }
  eq("  …and a migration is still FULL", decideGateScope(["supabase/migrations/0143_x.sql"]).mode, "full");
  eq("  …and the hook itself is still FULL", decideGateScope([".githooks/pre-push"]).mode, "full");
  eq("  …and a permission suite is still FULL",
     decideGateScope(["scripts/e2e/verify-user-permissions.mjs"]).mode, "full");
  /* FULL BEATS VERIFY when a diff carries both — the stronger lane wins, which is the direction
   * this router is supposed to fail in. */
  eq("  …and full beats verify in a mixed diff",
     decideGateScope(["scripts/run-suites.mjs", P.api]).mode, "full");

  /* TWO DIFFERENT NOTHINGS. An empty commit has no file for any suite to exercise; an unreadable
   * diff could contain anything. Answering FULL for both is what made an empty commit cost the
   * browser lane, and answering SKIP for both would be the dangerous half of the same mistake. */
  console.log("\nan empty diff versus an unreadable one:");
  eq("an EMPTY diff skips entirely", decideGateScope(["--empty-diff"]).mode, "skip");
  eq("an UNREADABLE diff is FULL", decideGateScope(["--unknown-diff"]).mode, "full");
  eq("  …and a malformed call (no paths, no sentinel) is FULL", decideGateScope([]).mode, "full");

  /* ── THE URL RULE: A MENTION IS NOT A CALL ────────────────────────────────────────────────
   * Rule 2 matches a MatchDay URL prefix against a file's SOURCE TEXT, which cannot tell a fetch
   * from a mention. Two fixtures prove it now can: one that only names the prefix in a comment,
   * one that fetches it. Both are written here so neither can drift out from under the assertion.
   */
  console.log("\na URL prefix in a comment vs a URL prefix in a fetch:");
  writeFileSync(P.mention, `// this route posts to /api/matchday/ and we do not\nexport const q = 1;\n`);
  writeFileSync(P.caller, `export const go = () => fetch("/api/matchday/x");\n`);
  eq("a file that only MENTIONS /api/matchday/ in a comment is typecheck", lane(P.mention), "typecheck");
  eq("  …CONTROL — one that actually fetches it is FULL", lane(P.caller), "full");

  /* ── THE NAMED EXEMPTIONS MUST NOT ROT ────────────────────────────────────────────────────
   * URL_IS_DATA_NOT_A_CALL exempts files that hold a route path as DATA. That claim is asserted,
   * not trusted: each entry must still exist, must still name a prefix (or the entry is stale and
   * should be deleted), and must contain NO http-issuing call. Add a fetch to one of them and this
   * goes red until the entry comes out.
   */
  console.log("\nthe named URL-is-data exemptions, each re-proved:");
  const { URL_IS_DATA_NOT_A_CALL, HTTP_ISSUING, matchdayUrlPrefixes } = await import("./gate-scope.mjs");
  const prefixes = matchdayUrlPrefixes();
  eq("the exemption list is small enough to read", URL_IS_DATA_NOT_A_CALL.length <= 10, true);
  for (const { file, why } of URL_IS_DATA_NOT_A_CALL) {
    let src = null;
    try { src = readFileSync(file, "utf8"); } catch {}
    if (src == null) { bad(`${file} — exempted but missing; delete the entry`); continue; }
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    eq(`${file} still names a prefix in CODE (else the entry is stale)`, prefixes.some((u) => code.includes(u)), true);
    eq(`  …and issues no request — the whole basis of the exemption`, HTTP_ISSUING.test(code), false);
    eq(`  …and carries a reason`, typeof why === "string" && why.length > 20, true);
    eq(`  …and therefore routes to typecheck`, lane(file), "typecheck");
  }

  /* THE EXIT CODES ARE THE CONTRACT WITH THE SHELL. The hook branches on the status and never on
   * the text, so a renumbering here that the hook did not follow would silently reroute a lane. */
  console.log("\nthe exit codes the hook branches on:");
  const { EXIT_CODE } = await import("./gate-scope.mjs");
  eq("skip=12 typecheck=0 verify=11 full=10",
     JSON.stringify(EXIT_CODE), JSON.stringify({ skip: 12, typecheck: 0, verify: 11, full: 10 }));
  const hook = readFileSync(".githooks/pre-push", "utf8");
  for (const [mode, code] of Object.entries(EXIT_CODE)) {
    eq(`  the hook handles ${mode} (${code})`, new RegExp(`^\\s*${code}\\)`, "m").test(hook), true);
  }
} finally {
  try { chmodSync(P.unreadable, 0o644); } catch {}
  rmSync(DIR, { recursive: true, force: true });
}

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
