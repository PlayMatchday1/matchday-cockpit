// Phase 22 — the teardown race, and the line between "teardown noise" and a real failure.
//
// WHY THIS SUITE EXISTS. Suites intercept a request, fetch it for real, mutate the body and
// fulfil it (the `grantEdit` shape, in 18 files). When the context closes with one of those
// `route.fetch()` calls still in flight, it rejects with `route.fetch: Request context
// disposed.` — an unhandled rejection that killed verify-log-health AFTER it had printed
// "6 passed, 0 failed". A gate that reddens a suite which passed everything is worse than
// useless, because the next person learns to re-run rather than read.
//
// The tempting fix — teach installHarnessGuard to ignore disposal errors — is WRONG. It
// would also swallow a genuine failure that happens during teardown, which is the exact
// silence this harness exists to prevent. So the fix removes the error instead of
// classifying it: closeContext()/closeBrowser() call unrouteAll({behavior:"wait"}) first,
// which waits for in-flight handlers, so nothing is left to reject.
//
// This suite asserts BOTH halves, because a fix to one that breaks the other is the real risk:
//   1. the racing handler shape KILLS a suite process with a bare close   (the race is real)
//   2. …and does not through closeContext/closeBrowser                    (the fix works)
//   3. a suite that genuinely throws mid-run STILL exits non-zero         (guard still strict)
//   4. a genuine error whose TEXT mentions disposal is STILL fatal        (we narrowed nothing)
//
// Each case runs in its own child process under installHarnessGuard, exactly like a real
// suite — which is the only way to observe what the guard does to the exit code.
//
// Hermetic: a local http server + chromium. No dev server, no Supabase, no network.
//   node scripts/e2e/verify-teardown-guard.mjs
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import http from "node:http";
import { installHarnessGuard, fatal } from "./_session.mjs";
installHarnessGuard();

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

// absolute specifiers, so a temp-dir child can still resolve them
const PW = pathToFileURL(createRequire(import.meta.url).resolve("playwright")).href;
const SESSION = new URL("./_session.mjs", import.meta.url).href;

const dir = mkdtempSync(join(tmpdir(), "tdguard-"));
let seq = 0;

// Spawn `body` as a suite: guard installed, same as every verify-*. Returns {code, out}.
function runCase(body) {
  const file = join(dir, `case${seq++}.mjs`);
  writeFileSync(file, `import { installHarnessGuard } from ${JSON.stringify(SESSION)};\ninstallHarnessGuard();\n${body}\n`);
  return new Promise((resolve) => {
    const child = spawn("node", [file], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (out += b));
    const t = setTimeout(() => { child.kill("SIGKILL"); resolve({ code: "TIMEOUT", out }); }, 60000);
    child.on("close", (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

// A teardown case: intercept + real-fetch + fulfil, close while the handler is in flight.
const teardownCase = (base, useHelpers) => `
import pw from ${JSON.stringify(PW)};   // CJS entry by file URL — named exports do not survive
const { chromium } = pw;
import { closeContext, closeBrowser } from ${JSON.stringify(SESSION)};
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
await ctx.route("**/slow*", async (route) => {          // the grantEdit shape
  const res = await route.fetch();
  const j = await res.json().catch(() => null);
  return route.fulfill({ status: res.status(), contentType: "application/json", body: JSON.stringify(j) });
});
const page = await ctx.newPage();
await page.goto(${JSON.stringify(base)}, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(150);                          // handler now mid-flight
console.log("SUITE-COMPLETED");                          // stands in for "Assertions: N passed, 0 failed"
${useHelpers ? "await closeContext(ctx); await closeBrowser(browser);" : "await browser.close();"}
await new Promise((r) => setTimeout(r, 2500));           // let any rejection surface
process.exit(0);
`;

function server() {
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith("/slow")) {
      setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }); res.end('[{"a":1}]'); }, 1500);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<html><body>x<script>fetch("/slow")</script></body></html>');
  });
  return new Promise((r) => srv.listen(0, () => r(srv)));
}

async function main() {
  const srv = await server();
  const base = `http://127.0.0.1:${srv.address().port}`;
  console.log(`teardown guard — hermetic, ${base}\n`);

  // ── 1. the race is REAL: a bare close kills a suite that already finished ──
  const bare = await runCase(teardownCase(base, false));
  const bareReached = bare.out.includes("SUITE-COMPLETED");
  const bareDisposed = /Request context disposed/i.test(bare.out);
  if (bare.code !== 0 && bareReached && bareDisposed) {
    ok(`the race is REAL: the suite completed, then a bare close killed it (exit ${bare.code}, "Request context disposed")`);
  } else {
    bad("the race is REAL", `expected completed+nonzero+disposed, got code=${bare.code} completed=${bareReached} disposed=${bareDisposed} — this suite can no longer prove the fix does anything`);
  }

  // ── 2. the fix: same shape through the helpers, clean exit ────────────────
  const fixed = await runCase(teardownCase(base, true));
  eq("closeContext/closeBrowser: same handler shape exits 0", fixed.code, 0);
  eq("closeContext/closeBrowser: no disposal error anywhere in the output", /Request context disposed/i.test(fixed.out), false);

  // ── 3. the guard is STILL strict — the half a blanket-ignore fix would break ──
  eq("a genuine mid-run throw still exits non-zero",
    (await runCase(`await new Promise((r) => setTimeout(r, 10));\nthrow new Error("a real mid-run failure");`)).code !== 0, true);

  eq("a genuine unhandled rejection still exits non-zero",
    (await runCase(`Promise.reject(new Error("a real unhandled rejection"));\nawait new Promise((r) => setTimeout(r, 200));`)).code !== 0, true);

  // ── 4. we narrowed NOTHING by message — this goes red if anyone adds an escape hatch ──
  eq("a REAL error whose text says 'Request context disposed' is still fatal",
    (await runCase(`Promise.reject(new Error("route.fetch: Request context disposed."));\nawait new Promise((r) => setTimeout(r, 200));`)).code !== 0, true);

  srv.close();
  rmSync(dir, { recursive: true, force: true });
  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(FAIL ? 1 : 0);
}

main().catch(fatal);
