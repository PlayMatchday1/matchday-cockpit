// PART A step 2+4 — the null trap. Load the editor against (1) the real 2470
// payload and (2) an all-nulls payload, and assert the CLEAN-LOAD diff is empty
// and Save is disabled. If any key falsely enters the diff, print the key and
// both raw sides of the comparison. Hermetic: GET is fixture-fulfilled.
//   node scripts/e2e/verify-matchedit-nulltrap.mjs

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { netRetry, installHarnessGuard, fatal, sessionFor } from "./_session.mjs";
installHarnessGuard();
import { readFileSync } from "node:fs";

const BASE = process.env.BASE || "http://localhost:3000";
const PAGE_URL = `${BASE}/match-ops/matches/2470`;
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };

const FIXTURES = [
  ["real 2470 (has nulls + empty strings)", JSON.parse(readFileSync("scripts/e2e/fixtures/match-2470.json", "utf8"))],
  ["all-nulls (every editable field null)", JSON.parse(readFileSync("scripts/e2e/fixtures/match-nulls.json", "utf8"))],
];

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  // ONE SESSION PER IDENTITY, cached across the whole gate run — see sessionFor in _session.mjs.
  const session = await sessionFor("rmancuso@playmatchday.com");
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(session) }] }] } });
  let BODY = "{}";
  // The editor fetches the guarded matchday route (FULL_EDITOR_ENV=production). Mocking the
  // old /api/stage/matches route did nothing — the page loaded REAL data and this suite
  // passed vacuously. Point at the route the editor actually calls.
  await context.route("**/api/matchday/production/matches/**", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"match":{}}' })
      : route.fulfill({ status: 200, contentType: "application/json", body: BODY }));
  const page = await context.newPage();

  for (const [label, fixture] of FIXTURES) {
    BODY = JSON.stringify(fixture);
    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="save"]', { timeout: 30_000 });
    await page.waitForTimeout(150);
    const diff = await page.$$eval('[data-testid="diff-item"]', (els) => els.map((e) => ({ key: e.getAttribute("data-key"), from: e.getAttribute("data-from"), to: e.getAttribute("data-to") })));
    const saveDisabled = await page.$eval('[data-testid="save"]', (b) => b.disabled);
    if (diff.length === 0 && saveDisabled) ok(`clean-load diff EMPTY + save disabled — ${label}`);
    else {
      bad(`clean-load diff EMPTY + save disabled — ${label}`, `${diff.length} false diff item(s), saveDisabled=${saveDisabled}`);
      for (const d of diff) console.log(`       FALSE DIFF ${d.key}: loaded=${d.from} vs state=${d.to}`);
    }
  }

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await browser.close();
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch(fatal);
