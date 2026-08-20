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
} finally {
  try { chmodSync(P.unreadable, 0o644); } catch {}
  rmSync(DIR, { recursive: true, force: true });
}

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
