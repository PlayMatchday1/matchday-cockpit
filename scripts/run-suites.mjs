// Suite runner + GUARD (Phase 18 harness fix). Runs each test suite in its own process
// and FAILS the build if a suite: times out, exits non-zero, reports any failure, OR runs
// ZERO assertions (no "N passed, M failed" line, or N == 0). The last case is the hole that
// let rotted suites pass quietly — a suite whose mock no longer matches can load nothing,
// assert nothing, and still exit 0. Not anymore.
//
//   node scripts/run-suites.mjs         # the Node/tsx model+guard suites (in `npm run verify`)
//   node scripts/run-suites.mjs --e2e   # the browser suites (needs `npm run dev` up)
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import http from "node:http";

const E2E = process.argv.includes("--e2e");
const QUARANTINE_ONLY = process.argv.includes("--quarantine"); // run ONLY the quarantined suites

// QUARANTINE — browser suites EXCLUDED from the gate. A mandatory gate that is red on every run
// and waved through is not a gate; a quarantined suite is EXCLUDED and named loudly instead, with
// why and what brings it back. Run them with `node scripts/run-suites.mjs --e2e --quarantine`
// (npm run verify:e2e:quarantine). Each is quarantined, not fixed, because the fix is out of this
// phase's scope; the reason + restore condition make the debt visible, not silent.
// EMPTY. All five quarantined suites were Finance/partner/reviews/calendar screens — every one of
// them outside the testing rule (the gate exists for writes to the MatchDay API), so they were
// deleted rather than carried as debt. The drift guard below stays: it is what stops a suite
// leaving the gate silently, and it will bind the moment anything is quarantined again.
const QUARANTINE = new Map([]);

// ── QUARANTINE DRIFT GUARD (Phase 21b item 1) ────────────────────────────────
// A suite must never leave the gate silently. The set of quarantined suites is PINNED in
// scripts/quarantine.pinned.json; if the live QUARANTINE map above drifts from it — an
// addition, a removal, OR a swap that keeps the count the same (exactly how verify-week
// slipped in while adminpay left, both at 4) — the e2e gate FAILS until the pinned file is
// updated in the SAME commit. Growing the quarantine is therefore an explicit, reviewable diff.
function quarantineDrift() {
  const live = [...QUARANTINE.keys()].sort();
  let pinned;
  try { pinned = (JSON.parse(readFileSync("scripts/quarantine.pinned.json", "utf8")).quarantined ?? []).slice().sort(); }
  catch (e) { return { ok: false, msg: `cannot read scripts/quarantine.pinned.json (${e.message})` }; }
  const added = live.filter((s) => !pinned.includes(s));
  const removed = pinned.filter((s) => !live.includes(s));
  if (added.length === 0 && removed.length === 0) return { ok: true, live };
  const lines = [];
  if (added.length) lines.push(`  + newly quarantined, NOT in the pinned list: ${added.join(", ")}`);
  if (removed.length) lines.push(`  − pinned but no longer quarantined:        ${removed.join(", ")}`);
  return { ok: false, live, msg: `quarantine set drifted from scripts/quarantine.pinned.json\n${lines.join("\n")}\n  → if intended, edit scripts/quarantine.pinned.json in THIS commit to match (keep it sorted).` };
}

// The Node suites, in the order `verify` ran them.
// THE UNIT SUITES THAT SURVIVE THE TESTING RULE — writes to the MatchDay API, and the guards
// that pin traps which have already cost a real production write. Nine model/scope suites for
// internal dashboards and read gates were deleted with the policy change; a wrong number on an
// internal screen is visible to Ryan and says so faster than a suite does.
//
// matchops-auth-test is KEPT despite testing reads: a route shipped with NO gate is invisible
// on screen, which is exactly the case a suite has to cover.
const NODE_SUITES = [
  "scripts/mutation-tests.ts",
  "scripts/prod-guard-test.ts",
  "scripts/stage-denylist-test.ts",
  "scripts/change-log-test.ts",
  "scripts/write-routes-logged-test.ts",
  "scripts/walltime-guard-test.ts",
  "scripts/promo-model-test.ts",
  "scripts/cost-basis-confinement-test.ts",
  "scripts/cost-ratio-band-test.ts",
  "scripts/pace-projection-test.ts",
  "scripts/crm-characterize-test.ts",
  "scripts/crm-host-guard-test.ts",
  "scripts/seam-stripped-test.ts",
  "scripts/matchops-auth-test.ts",
  "scripts/crm-push-test.ts",
  "scripts/verify-checkin-model.ts",
  "scripts/roster-edit-model-test.ts",
  "scripts/credits-model-test.ts",
  "scripts/promo-edit-model-test.ts",
  // The 🎥 name transform — a MatchDay match-name write that reaches players in the live app.
  "scripts/veo-name-sync-test.ts",
  // The mirror write-through: only on LANDED, only the read-back value, production only.
  "scripts/mirror-writethrough-test.ts",
  // The Gusto payroll CSV — proves the email alias moved no amount or memo.
  "scripts/gusto-alias-email-test.ts",
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
      // exit 3 is the harness guard's NETWORK signal (retried 3×, gave up / died mid-run) — name it
      // so the summary line itself separates a network death from an assertion failure ("N failed").
      if (code === 3) return resolve({ suite, ok: false, why: "NETWORK — retried 3×, gave up (not an assertion failure; see output)", out });
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

// ── WARM THE DEV SERVER BEFORE ANY SUITE (Phase 22, landed 29e) ──────────────
// `next dev` COMPILES ROUTES ON DEMAND, and the first suite to touch an uncompiled route pays
// for it inside its own waitForSelector/waitForFunction budget (10-30s). That is why timeout
// failures land on DIFFERENT suites from run to run and all pass when run alone — contention
// with the compiler, not a defect in what they assert.
//
// Paying the compile ONCE, sequentially, before any suite starts removes that. Measured on
// phase22-gate: 429s → 259s sequential.
//
// This is the dev-server half of the problem. The bigger lever (`next build && next start`) is
// deliberately NOT here: it is unmeasured and it strips the CRM realtime test seam that
// verify-crm-characterize depends on.
//
// Cherry-picked from phase22-gate 5eb553e — THIS BLOCK ONLY. The one-auth-event-per-run change
// and the concurrency switch in that commit did NOT come with it and remain unsoaked there.
if (E2E) {
  const WARM = [
    "/home", "/match-ops", "/match-ops/gameday", "/match-ops/change-log", "/match-ops/field-ops",
    "/match-ops/master-schedule", "/match-ops/partner-dashboards", "/match-ops/reviews",
    "/match-ops/slate-review", "/match-ops/promos", "/match-ops/player-lookup",
    "/match-ops/player-chats", "/match-ops/manager-pay/history",
    "/city/manager-pay", "/city/reviews", "/city/gameday",
    "/match-ops/match-panel/17494", "/match-ops/matches/2470", "/match-ops/matches/501/roster",
    "/matchops/checkin/2470",
  ];
  const t0 = Date.now();
  process.stdout.write(`↻ warming ${WARM.length} routes (next dev compiles on demand) `);
  for (const r of WARM) {
    try {
      const res = await fetch(`http://localhost:3000${r}`, { redirect: "manual" });
      await res.arrayBuffer().catch(() => {});
      process.stdout.write(".");
    } catch { process.stdout.write("x"); }
  }
  console.log(` done in ${Math.round((Date.now() - t0) / 1000)}s`);
}

// Wall-clock for the run, so every gate reports its own duration and a regression in the gate
// itself is visible rather than felt.
const RUN_T0 = Date.now();

const results = [];
for (const s of suites) {
  process.stdout.write(`▶ ${s} … `); const r = await run(s); results.push(r); console.log(r.ok ? `ok (${r.passed} assertions)` : `FAIL — ${r.why}`);
}
if (devProc) { try { process.kill(-devProc.pid, "SIGKILL"); } catch {} }

const failed = results.filter((r) => !r.ok);
console.log(`\n${"=".repeat(60)}\n${results.length} suites · ${results.length - failed.length} ok · ${failed.length} FAILED · ${Math.round((Date.now() - RUN_T0) / 1000)}s`);
for (const f of failed) {
  console.log(`\n✗ ${f.suite} — ${f.why}`);
  console.log(f.out.split("\n").slice(-12).map((l) => "    " + l).join("\n"));
}

// The gate is only meaningful if what it excludes is VISIBLE. Print every quarantined suite,
// why, and what brings it back — every gated e2e run, not buried in a config file.
let driftFailed = false;
if (E2E && !QUARANTINE_ONLY) {
  const drift = quarantineDrift();
  console.log(`\n${"─".repeat(60)}\n⚠ QUARANTINE: ${QUARANTINE.size} suite(s) excluded from this gate ${drift.ok ? "(matches the pinned list ✓)" : "(⛔ PIN MISMATCH)"} — run \`npm run verify:e2e:quarantine\` to run them:`);
  for (const [base, q] of QUARANTINE) console.log(`  • ${base}\n      why:     ${q.why}\n      restore: ${q.restore}`);
  if (!drift.ok) {
    driftFailed = true;
    console.log(`\n⛔ QUARANTINE DRIFT GUARD FAILED — ${drift.msg}`);
  }
}
process.exit(failed.length || driftFailed ? 1 : 0);
