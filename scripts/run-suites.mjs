// Suite runner + GUARD (Phase 18 harness fix). Runs each test suite in its own process
// and FAILS the build if a suite: times out, exits non-zero, reports any failure, OR runs
// ZERO assertions (no "N passed, M failed" line, or N == 0). The last case is the hole that
// let rotted suites pass quietly — a suite whose mock no longer matches can load nothing,
// assert nothing, and still exit 0. Not anymore.
//
//   node scripts/run-suites.mjs         # the Node/tsx model+guard suites (in `npm run verify`)
//   node scripts/run-suites.mjs --e2e   # the browser suites (needs `npm run dev` up)
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";

const E2E = process.argv.includes("--e2e");

// The Node suites, in the order `verify` ran them.
const NODE_SUITES = [
  "scripts/mutation-tests.ts", "scripts/prod-guard-test.ts", "scripts/stage-denylist-test.ts",
  "scripts/gameday-model-test.ts", "scripts/change-log-test.ts", "scripts/write-routes-logged-test.ts",
  "scripts/player-lookup-model-test.ts", "scripts/walltime-guard-test.ts",
];
const E2E_SUITES = readdirSync("scripts/e2e").filter((f) => /^verify-.*\.mjs$/.test(f)).sort().map((f) => `scripts/e2e/${f}`);

const suites = E2E ? E2E_SUITES : NODE_SUITES;
const TIMEOUT_MS = E2E ? 150_000 : 180_000;

function run(suite) {
  return new Promise((resolve) => {
    const isTs = suite.endsWith(".ts");
    const cmd = isTs ? "npx" : "node";
    const args = isTs ? ["tsx", suite] : [suite];
    const env = { ...process.env, ...(isTs ? { NODE_OPTIONS: "--conditions=react-server" } : {}) };
    const child = spawn(cmd, args, { env });
    let out = "";
    const grab = (b) => { out += b.toString(); };
    child.stdout.on("data", grab); child.stderr.on("data", grab);
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ suite, ok: false, why: `TIMED OUT after ${TIMEOUT_MS / 1000}s`, out }); }, TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      // last "(N) passed, (M) failed" anywhere in the output (also matches "Assertions: N passed, M failed")
      const matches = [...out.matchAll(/(\d+)\s+passed,\s+(\d+)\s+failed/g)];
      const last = matches[matches.length - 1];
      if (code !== 0) return resolve({ suite, ok: false, why: `exited ${code}`, out });
      if (!last) return resolve({ suite, ok: false, why: "ZERO ASSERTIONS — no 'N passed, M failed' summary (rotted mock / early return?)", out });
      const passed = Number(last[1]), failed = Number(last[2]);
      if (passed === 0) return resolve({ suite, ok: false, why: "ZERO ASSERTIONS — 0 passed (suite ran no checks)", out });
      if (failed > 0) return resolve({ suite, ok: false, why: `${failed} failed`, out });
      resolve({ suite, ok: true, passed, out });
    });
  });
}

const results = [];
for (const s of suites) { process.stdout.write(`▶ ${s} … `); const r = await run(s); results.push(r); console.log(r.ok ? `ok (${r.passed} assertions)` : `FAIL — ${r.why}`); }

const failed = results.filter((r) => !r.ok);
console.log(`\n${"=".repeat(60)}\n${results.length} suites · ${results.length - failed.length} ok · ${failed.length} FAILED`);
for (const f of failed) {
  console.log(`\n✗ ${f.suite} — ${f.why}`);
  console.log(f.out.split("\n").slice(-12).map((l) => "    " + l).join("\n"));
}
process.exit(failed.length ? 1 : 0);
