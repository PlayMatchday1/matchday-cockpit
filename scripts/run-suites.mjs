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
// Two entries as of 2026-08-20. BOTH FAIL ON LIVE DATA, NOT ON A DEFECT — each pins a figure from
// a month that is still filling up, and each was proved pre-existing by running it against a
// stashed tree. They are quarantined rather than re-derived because rewriting an assertion body to
// make it pass records the new behaviour instead of verifying the old one, and that is a decision
// to take on its own, not inside an unrelated change.
const QUARANTINE = new Map([
  // verify-cost-basis.mjs is GONE, not merely un-quarantined. It existed to pin that Finance ›
  // Cost opened on the SAME derivation as Field Costs, OpEx and Cash Flow — an override first,
  // else per_match_rate × matches. That page no longer has a basis toggle and deliberately no
  // longer agrees with the billed view: it derives from a rate and reads no override, and says so
  // above its own table. A suite whose subject has been removed cannot be repaired, only rewritten
  // as a different suite. What goes with it: the keyed-$0-vs-nothing-keyed distinction (an
  // override question, moot here) and the "a dashed row contributes no 0% to any total" check.
  // The second is still a live property of rollup(); scripts/cost-realized-test.ts covers the
  // dash, not the total.
  ["verify-cost-tables.mjs", "hardcodes live figures, drifts with data — see 2026-08-20"],
  // NOT A FLAKE — THIS ONE WRITES PRODUCTION. It flips fin_venue_fields.counts_as_regular_play on
  // MatchDay field 22 (ATH Pearland) with the service role, reads four pages, and restores it in a
  // finally. On 2026-08-24 it exited 2 mid-run and LEFT THE FLAG ON, which silently moved ATH
  // Pearland's match count and cost across the estate and sent an investigation down the wrong
  // path for an hour. Off until it is rewritten to prove the exception without mutating a live
  // Finance flag. The suite itself also refuses to run — see its own header.
  ["verify-counts-as-regular.mjs", "WRITES PRODUCTION (fin_venue_fields.counts_as_regular_play, field 22); left it flipped after an exit-2 on 2026-08-24 — off until rewritten without the write"],
  // ALSO A PRODUCTION WRITE, AND A WEAKER RESTORE THAN THE ONE ABOVE. It clears a REAL
  // fin_venue_cost_overrides amount through the UI and then types it back — or DELETEs the row
  // outright when there was none — in straight-line code with no finally at all. That is money: a
  // cleared override changes a venue's cost for a closed month. On 2026-08-24 the restore
  // completed only because the assertion that failed came AFTER it.
  ["verify-field-cost-month.mjs", "WRITES PRODUCTION (fin_venue_cost_overrides — clears/deletes a real override, restores in straight-line code with NO finally); touches money and ran on every full gate — off until rewritten without the write"],
]);

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
  // The gate's own router. It decides which lane every other suite here runs in, so it is guarded
  // like the writes are — on fixtures, not on the names of files whose imports can change.
  "scripts/gate-scope-test.mjs",
  // The city boundary's decision table — including the one rule that disagrees with the
  // city-manager tier on purpose (confinement beats is_admin).
  "scripts/city-confinement-test.ts",
  // The credits city scope. Its own suite because it guards MONEY on a route whose guard cannot be
  // exercised without a confined login — the decision is pure, so it runs on every commit instead.
  "scripts/credits-city-scope-test.ts",
  // The Growth right. can_access_growth meant Player Lifecycle until 2026-08-23 and now means the
  // Growth tab; a stale grant read as a new one is the failure the whole rename exists to prevent,
  // and no browser suite can see it — 0140 reset the column on every row, so the interesting rows
  // do not exist to log in as.
  // THE PWA's LAUNCH ROUTE. verify-city-confinement drives /city/* directly and passes; an
  // installed app opens manifest.json's start_url instead, which was a Match Ops page no city
  // manager can open. The suite tested the rooms and nothing tested the door.
  "scripts/pwa-launch-door-test.ts",
  "scripts/warsaw-city-test.ts",
  // WARSAW — the first city that is not in types.CITIES. Nothing had ever tested one, which is how
  // a half-registered city shipped: WAW was in CITY_SCOPES and nowhere else. Also holds the line
  // the other way — a partner market must never appear in CITIES or CITY_DISPLAY_ORDER.
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
  // /admin/fields — the field-ID → venue mapping. Not a write yet, but the number it will be
  // committed against: matches gained, revenue attributed, and cost added at the venue's rate,
  // including the event-marker exclusion that let ATH Pearland bill $0 for 26 months. A wrong
  // preview is a wrong decision taken deliberately, and no screen check can see the arithmetic.
  "scripts/field-id-admin-test.ts",
  // Finance › Cost, realized on both sides. Guards the wall-clock-as-instant trap (shipped three
  // times) with fixtures whose two readings disagree on purpose, and pins that NO path on that
  // page reads a cost override — the fixtures key one 100× the derived figure.
  "scripts/cost-realized-test.ts",
];
const ALL_E2E = readdirSync("scripts/e2e").filter((f) => /^verify-.*\.mjs$/.test(f)).sort().map((f) => `scripts/e2e/${f}`);
const GATED_E2E = ALL_E2E.filter((s) => !QUARANTINE.has(s.split("/").pop()));
const QUARANTINED_E2E = ALL_E2E.filter((s) => QUARANTINE.has(s.split("/").pop()));

const suites = !E2E ? NODE_SUITES : QUARANTINE_ONLY ? QUARANTINED_E2E : GATED_E2E;
// e2e: 240s per suite — verify-year runs a full-year reconciliation and legitimately needs
// ~2-3 min; a shorter cap timed it out even though it passes.
/* THE CAP SCALES WITH THE POOL, because it measures WALL CLOCK and a pooled suite spends part of
 * that queueing behind its neighbours rather than working. 240s was set for a suite running alone;
 * applying it unchanged under contention is what turned three healthy suites red at concurrency 4.
 * The cap still does its job — catching a suite that has HUNG — it just stops calling contention a
 * hang. */
const BASE_TIMEOUT_MS = E2E ? 240_000 : 180_000;
let TIMEOUT_MS = () => BASE_TIMEOUT_MS;

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
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ suite, ok: false, why: `TIMED OUT after ${TIMEOUT_MS() / 1000}s`, out }); }, TIMEOUT_MS());
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

/* EVERY SUITE REPORTS ITS OWN WALL CLOCK. The run total was the only number printed, so "the e2e
 * lane takes 19 minutes" could be answered but "which suites" could not — and the answer to that
 * is what decides whether the fix is parallelism, a timeout, or deleting something. The slowest
 * are listed again at the bottom so the tail is visible without re-reading 39 lines.
 *
 * ── THE E2E LANE RUNS IN A WORKER POOL ───────────────────────────────────────────────────────
 *
 * It was a serial for-await loop: 39 suites, 1,201s, each one launching its own Chromium and
 * logging in again. WHY IT HAD TO BE SERIAL WAS CROSS-SUITE INTERFERENCE — two suites writing the
 * same production rows race, and the loser reports a failure that has nothing to do with its own
 * subject. That reason is gone: the suites that write are quarantined and carry in-file refusals,
 * so what is left is a set of READERS against one shared dev server, and readers do not collide.
 *
 * TWO, NOT FOUR — AND FOUR WAS MEASURED, NOT GUESSED. The ceiling is not this machine, it is the
 * single `next dev` process every suite shares: dev compiles routes ON DEMAND, so four browsers
 * asking for different routes at once queue behind one compiler. At 4 the run did not just get
 * slower, it went RED — verify-matchpanel (138s serial), verify-pace-grain (129s) and
 * verify-period-anchor (144s) all blew the 240s cap, and two more suites failed outright. Five
 * failures the serial lane does not have.
 *
 * At 2 the contention is bounded and the slow suites stay inside their cap. If this needs to go
 * higher, the fix is NOT a bigger number — it is running the suites against `next build && next
 * start` instead of `next dev`, which removes on-demand compilation altogether. That is the real
 * ceiling and it is worth doing; it is not this change. Override with E2E_CONCURRENCY.
 *
 * THE NODE SET STAYS SERIAL. It is 28 suites and, with the production build now moved off this
 * path, ~29s in total — there is nothing to win, and several of those suites read and restore
 * shared files (tsconfig.json among them), which is exactly the interference this pool assumes
 * has been removed.
 */
const E2E_CONCURRENCY = Math.max(1, Number(process.env.E2E_CONCURRENCY ?? 2));
const POOL = E2E ? E2E_CONCURRENCY : 1;
TIMEOUT_MS = () => BASE_TIMEOUT_MS * POOL;

const results = [];
if (POOL === 1) {
  for (const s of suites) {
    process.stdout.write(`▶ ${s} … `);
    const t0 = Date.now();
    const r = await run(s);
    r.ms = Date.now() - t0;
    results.push(r);
    console.log((r.ok ? `ok (${r.passed} assertions)` : `FAIL — ${r.why}`) + ` · ${(r.ms / 1000).toFixed(1)}s`);
  }
} else {
  console.log(`▶ ${suites.length} suites, ${POOL} at a time\n`);
  /* ONE LINE PER SUITE, PRINTED ON COMPLETION — never a "▶ starting" line. Four workers
   * interleaving their starts and finishes on one stdout produces output that cannot be read,
   * and a half-written line is how a passing suite comes to look like a failing one. */
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= suites.length) return;
      const s = suites[i];
      const t0 = Date.now();
      const r = await run(s);
      r.ms = Date.now() - t0;
      results.push(r);
      console.log(
        `${r.ok ? "✓" : "✗"} ${s} … ` +
        (r.ok ? `ok (${r.passed} assertions)` : `FAIL — ${r.why}`) +
        ` · ${(r.ms / 1000).toFixed(1)}s`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL, suites.length) }, () => worker()));
  // Completion order is ragged; the report reads better in the order the suites are listed.
  results.sort((a, b) => suites.indexOf(a.suite) - suites.indexOf(b.suite));
}
if (devProc) { try { process.kill(-devProc.pid, "SIGKILL"); } catch {} }

const failed = results.filter((r) => !r.ok);
console.log(`\n${"=".repeat(60)}\n${results.length} suites · ${results.length - failed.length} ok · ${failed.length} FAILED · ${Math.round((Date.now() - RUN_T0) / 1000)}s`);
{
  const slow = [...results].sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0)).slice(0, 8);
  const total = results.reduce((a, r) => a + (r.ms ?? 0), 0) || 1;
  const top = slow.reduce((a, r) => a + (r.ms ?? 0), 0);
  const wall = Date.now() - RUN_T0;
  console.log(
    `\nslowest ${slow.length} — ${Math.round((top / total) * 100)}% of ${Math.round(total / 1000)}s of suite time` +
    (POOL > 1 ? `, run in ${Math.round(wall / 1000)}s wall clock across ${POOL} workers` : "") + ":");
  for (const r of slow) console.log(`    ${((r.ms ?? 0) / 1000).toFixed(1).padStart(6)}s  ${r.suite}`);
}
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
