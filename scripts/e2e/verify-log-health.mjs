// Phase 16 (item 2) — logging failure must not be silent. Drives a REAL write path (the
// match editor) with the server reporting logRecorded:false (the write landed but the
// Change Log could not record it) and confirms: the write succeeds, the durable counter
// increments, the red banner appears, it survives a reload, and it shows on the Change
// Log too. A clean write (logRecorded:true) never raises it.
//   node scripts/e2e/verify-log-health.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { netRetry, installHarnessGuard, fatal } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";
const ID = 17371;
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const matchFixture = (name) => ({
  id: ID, name, isCancelled: false, teams: [], startDate: "2026-08-08T18:00:00.000", endDate: "2026-08-08T19:00:00.000",
  fieldId: 1, category: "OPEN", type: "REGULAR", managerId: null, secondManagerId: null, description: "", managerIntro: "",
  registrationPrice: 1200, additionalSpotPrice: 400, guestCount: 10, minPlayerCount: 8, maxPlayerCount: 20,
  maxTeamSize2Team: 20, maxTeamSize4Team: 40, autoCanceled: false, autoCanceledMinutes: 75, isFreeMember: false, isAutoBump: false,
  fakeSpotLeft36h: 0, fakeSpotLeft24h: 0, fakeSpotLeft12h: 0, fakeSpotLeft6h: 0, fakeSpotLeft3h: 0,
  fieldTitle: "PRUMC", cityName: "Austin", cityId: 1, manager: null, secondManager: null,
});

const grantEdit = (ctx) => ctx.route("**/rest/v1/app_users*", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  const res = await route.fetch();
  let json = await res.json().catch(() => null);
  const patch = (r) => ({ ...r, can_edit_matches: true, can_access_matchops: true });
  json = Array.isArray(json) ? json.map(patch) : (json && typeof json === "object" ? patch(json) : json);
  return route.fulfill({ status: res.status(), contentType: "application/json", body: JSON.stringify(json) });
});

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const link = await netRetry(() => svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" }), "generateLink");
  const vv = await netRetry(() => anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token }), "verifyOtp");
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] };

  let logOk = false; // the server "could not record" state we are simulating
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, storageState });
  await ctx.route(`**/api/matchday/**/matches/${ID}`, (route) => {
    const req = route.request();
    if (req.method() === "PUT") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, outcome: "landed", logRecorded: logOk, match: matchFixture("Edited Name") }) });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ match: matchFixture("Test Match"), fields: [{ id: 1, title: "PRUMC", city: "Austin" }], players: [], managers: [] }) });
  });
  await ctx.route("**/api/changelog**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ rows: [] }) }));
  await grantEdit(ctx);

  const page = await ctx.newPage();
  const EDITOR = `${BASE}/match-ops/matches/${ID}`;

  // clean slate
  await page.goto(EDITOR, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.removeItem("matchday-changelog-failures"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="save"]', { timeout: 30000 });
  eq("no banner before any failed log write", !!(await page.$('[data-testid="log-health-banner"]')), false);

  // a write whose LOG failed: the edit lands, the counter rises, the banner appears
  await page.fill('[data-testid="in-name"]', "Edited Name");
  await page.click('[data-testid="save"]');
  await page.waitForSelector('[data-testid="log-health-banner"]', { timeout: 8000 }).catch(() => {});
  const banner = await page.$('[data-testid="log-health-banner"]');
  const saveDisabled = await page.$eval('[data-testid="save"]', (b) => b.disabled);
  const counter = await page.evaluate(() => JSON.parse(localStorage.getItem("matchday-changelog-failures") || "{}").count);
  eq("log-write failure: the edit SUCCEEDS, the counter increments, the banner appears", { landed: saveDisabled, counter, banner: !!banner }, { landed: true, counter: 1, banner: true });
  { const txt = banner ? await banner.textContent() : ""; eq("banner names the count and is a hole, not a question", /could not be recorded/i.test(txt) && /1 write/i.test(txt), true); }

  // it survives a reload
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="save"]');
  eq("the banner survives a page reload (durable counter)", !!(await page.$('[data-testid="log-health-banner"]')), true);

  // it shows on the Change Log too
  await page.goto(`${BASE}/match-ops/change-log`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="changelog"]');
  await page.waitForTimeout(150);
  eq("the same banner shows on the Change Log", !!(await page.$('[data-testid="log-health-banner"]')), true);

  // a clean write (logRecorded:true) never raises it
  logOk = true;
  await page.goto(EDITOR, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.removeItem("matchday-changelog-failures"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="save"]');
  await page.fill('[data-testid="in-name"]', "Edited Again");
  await page.click('[data-testid="save"]');
  await page.waitForTimeout(600);
  eq("a recorded write (logRecorded:true) never raises the banner", { banner: !!(await page.$('[data-testid="log-health-banner"]')), counter: await page.evaluate(() => JSON.parse(localStorage.getItem("matchday-changelog-failures") || "{}").count || 0) }, { banner: false, counter: 0 });

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await browser.close();
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch(fatal);
