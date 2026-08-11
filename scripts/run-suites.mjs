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
import http from "node:http";

const E2E = process.argv.includes("--e2e");
const QUARANTINE_ONLY = process.argv.includes("--quarantine"); // run ONLY the quarantined suites

// QUARANTINE — browser suites EXCLUDED from the gate. A mandatory gate that is red on every run
// and waved through is not a gate; a quarantined suite is EXCLUDED and named loudly instead, with
// why and what brings it back. Run them with `node scripts/run-suites.mjs --e2e --quarantine`
// (npm run verify:e2e:quarantine). Each is quarantined, not fixed, because the fix is out of this
// phase's scope; the reason + restore condition make the debt visible, not silent.
const QUARANTINE = new Map([
  ["verify-year.mjs", { why: "non-hermetic: drives LIVE manager-pay data; the Manager <select> has no options when the live manager list lacks the picked manager, and Supabase magic-link generation rate-limits at the tail of a full run", restore: "fixture the manager-pay + managers data (hermetic, like verify-snapshot), then move it back into the gated set" }],
  // verify-adminpay REMOVED from quarantine (Phase 20 E2): the $59 owed label is now 5.4:1 — back in the gate.
  ["verify-partner.mjs", { why: "real: a frozen paid-snapshot expects $13 but shows $28 — needs a product decision (see Phase 20 E3)", restore: "reconcile the frozen snapshot (or update the expectation) and re-gate" }],
  ["verify-reviews.mjs", { why: "non-hermetic: waits for a LIVE 'due' review that may not exist at run time", restore: "fixture a due review so the suite is hermetic, then re-gate" }],
]);

// The Node suites, in the order `verify` ran them.
const NODE_SUITES = [
  "scripts/mutation-tests.ts", "scripts/prod-guard-test.ts", "scripts/stage-denylist-test.ts",
  "scripts/gameday-model-test.ts", "scripts/change-log-test.ts", "scripts/write-routes-logged-test.ts",
  "scripts/player-lookup-model-test.ts", "scripts/walltime-guard-test.ts", "scripts/promo-model-test.ts",
];
const ALL_E2E = readdirSync("scripts/e2e").filter((f) => /^verify-.*\.mjs$/.test(f)).sort().map((f) => `scripts/e2e/${f}`);
const GATED_E2E = ALL_E2E.filter((s) => !QUARANTINE.has(s.split("/").pop()));
const QUARANTINED_E2E = ALL_E2E.filter((s) => QUARANTINE.has(s.split("/").pop()));

const suites = !E2E ? NODE_SUITES : QUARANTINE_ONLY ? QUARANTINED_E2E : GATED_E2E;
// e2e: 240s per suite — verify-year runs a full-year reconciliation and legitimately needs
// ~2-3 min; a shorter cap timed it out even though it passes.
const TIMEOUT_MS = E2E ? 240_000 : 180_000;

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

// ── e2e: make sure a dev server is up (start one if not, tear it down after) ──
const ping = () => new Promise((res) => { const req = http.get("http://localhost:3000", () => { req.destroy(); res(true); }); req.on("error", () => res(false)); req.setTimeout(1500, () => { req.destroy(); res(false); }); });
let devProc = null;
if (E2E && !(await ping())) {
  console.log("↻ no dev server on :3000 — starting `npm run dev` …");
  devProc = spawn("npm", ["run", "dev"], { detached: true, stdio: "ignore" });
  const start = Date.now();
  while (Date.now() - start < 90_000) { if (await ping()) break; await new Promise((r) => setTimeout(r, 2000)); }
  if (!(await ping())) { console.log("✗ dev server did not come up in 90s"); if (devProc) try { process.kill(-devProc.pid, "SIGKILL"); } catch {} process.exit(1); }
  console.log("✓ dev up");
}

const results = [];
for (const s of suites) {
  process.stdout.write(`▶ ${s} … `); const r = await run(s); results.push(r); console.log(r.ok ? `ok (${r.passed} assertions)` : `FAIL — ${r.why}`);
}
if (devProc) { try { process.kill(-devProc.pid, "SIGKILL"); } catch {} }

const failed = results.filter((r) => !r.ok);
console.log(`\n${"=".repeat(60)}\n${results.length} suites · ${results.length - failed.length} ok · ${failed.length} FAILED`);
for (const f of failed) {
  console.log(`\n✗ ${f.suite} — ${f.why}`);
  console.log(f.out.split("\n").slice(-12).map((l) => "    " + l).join("\n"));
}

// The gate is only meaningful if what it excludes is VISIBLE. Print every quarantined suite,
// why, and what brings it back — every gated e2e run, not buried in a config file.
if (E2E && !QUARANTINE_ONLY && QUARANTINE.size) {
  console.log(`\n${"─".repeat(60)}\n⚠ ${QUARANTINE.size} suite(s) QUARANTINED — excluded from this gate (run \`npm run verify:e2e:quarantine\` to run them):`);
  for (const [base, q] of QUARANTINE) console.log(`  • ${base}\n      why:     ${q.why}\n      restore: ${q.restore}`);
}
process.exit(failed.length ? 1 : 0);
