import "server-only"; // no-op under --conditions=react-server
// THE ARTIFACT HALF OF THE SEAM GUARD — build a real production bundle and grep it.
//
// SPLIT OUT OF seam-stripped-test.ts BECAUSE OF WHAT IT COST, not because of what it proves.
// Measured: 99s of a 128s fast set — 77% — on every single push, for one `next build`. The other
// half of that suite (the STRUCTURAL and GENERAL checks) runs in milliseconds and stays inline,
// and it is the half that catches the actual regression AT SOURCE: seam code escaping the
// NODE_ENV guard, the guard being deleted, or a new page-settable global appearing anywhere in
// src/. This file is the belt to that pair of braces — it proves the compiler really did strip
// what the source says should be strippable.
//
// SO IT RUNS AFTER THE PUSH, NOT BEFORE IT. .githooks/pre-push spawns it detached once the gate
// has passed; it writes its verdict to .seam-artifact-result and raises a desktop notification if
// it fails. Nothing is lost but the wait: a broken build cannot reach players silently — Vercel
// fails the deploy on the same build, and this reports in ~100s either way.
//
// WHAT WOULD MAKE IT INLINE AGAIN. A content-hash cache over src/ + the lockfile + next.config
// would skip the build when nothing that determines the bundle changed — but that is precisely
// the push where the fast set is cheapest anyway, and it would still cost the full 99s on every
// push that touches src/, which is most of them. The split is the honest fix; the cache is not.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/seam-artifact-check.ts

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };

const SEAM_ID = "__CRM_TEST_REALTIME__";
const PROD_STATIC = ".next-seamcheck/static";
const RESULT_FILE = ".seam-artifact-result";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// Next rewrites tsconfig.json during a build; the `finally` puts it back whether the build passed
// or failed, so that edit can never be committed. This has caught me once already.
const TSCONFIG = "tsconfig.json";
const savedTsconfig = readFileSync(TSCONFIG, "utf8");
let buildOk = false, buildErr = "";
try {
  rmSync(join(".next-seamcheck", "static"), { recursive: true, force: true }); // grep only FRESH chunks
  execSync("npx next build", {
    // NODE_ENV=production so the seam is dead-code-eliminated; NEXT_DIST_DIR isolates the output
    // from a running `next dev`; NODE_OPTIONS cleared so --conditions=react-server cannot reach
    // the app build.
    env: { ...process.env, NODE_ENV: "production", NEXT_DIST_DIR: ".next-seamcheck", NODE_OPTIONS: "" },
    stdio: "pipe",
    timeout: 300_000,
  });
  buildOk = true;
} catch (e) {
  const err = e as { stderr?: Buffer; stdout?: Buffer; message?: string };
  buildErr = (err.stderr?.toString() || err.stdout?.toString() || err.message || String(e))
    .split("\n").filter(Boolean).slice(-6).join(" | ");
} finally {
  writeFileSync(TSCONFIG, savedTsconfig);
}

if (!buildOk) {
  bad(`ARTIFACT: isolated production build FAILED — cannot verify the seam is stripped`, buildErr);
} else if (existsSync(PROD_STATIC) && statSync(PROD_STATIC).isDirectory()) {
  let hits = 0;
  for (const f of walk(PROD_STATIC)) {
    try { hits += (readFileSync(f, "utf8").match(new RegExp(SEAM_ID, "g")) ?? []).length; } catch { /* binary/asset */ }
  }
  hits === 0
    ? ok(`ARTIFACT: 0 occurrences of ${SEAM_ID} in the freshly-built production client chunks`)
    : bad(`ARTIFACT: ${SEAM_ID} appears ${hits}× in the production client chunks — the seam SHIPPED`);
} else {
  bad(`ARTIFACT: build reported success but ${PROD_STATIC} is missing`);
}

console.log(`\n${pass} passed, ${fail} failed`);

/* THE VERDICT HAS TO SURVIVE THE PROCESS, because nobody is watching this one. It runs detached
 * after the push, so its exit status goes nowhere — the file and the notification ARE the report.
 * Written on success too: a stale PASS from three pushes ago reading as today's is the failure
 * mode this file is trying not to have. */
const stamp = new Date().toISOString();
const head = (() => {
  try { return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); } catch { return "unknown"; }
})();
writeFileSync(RESULT_FILE,
  `${fail ? "FAIL" : "PASS"} ${head} ${stamp}\n${fail ? buildErr || `${SEAM_ID} found in the production bundle` : "seam stripped from the production bundle"}\n`);

if (fail) {
  // macOS only, and deliberately best-effort: a missing notifier must not turn a build failure
  // into a crash that hides the build failure.
  try {
    execSync(
      `osascript -e 'display notification "seam artifact check FAILED on ${head} — see .seam-artifact-result" with title "Clubhouse gate"'`,
      { stdio: "ignore" },
    );
  } catch { /* not macOS, or notifications are off */ }
}
process.exit(fail ? 1 : 0);
