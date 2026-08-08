// PART C - the empty (or non-numeric) number input must never reach the body.
// Loads the 2470 fixture, clears each numeric input, and asserts the request body
// never carries that field as "" / NaN / a silently-coerced value. Hermetic.
//   node scripts/e2e/verify-matchedit-emptynum.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE || "http://localhost:3000";
const PAGE_URL = `${BASE}/match-ops/matches/2470`;
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n, d) => { FAIL++; fails.push(`${n} - ${d}`); console.log(`  XX  ${n} - ${d}`); };
const FIX = JSON.parse(readFileSync("scripts/e2e/fixtures/match-2470.json", "utf8"));
const NUMERIC = ["registrationPrice", "additionalSpotPrice", "guestCount", "minPlayerCount",
  "autoCanceledMinutes", "maxTeamSize2Team", "maxTeamSize4Team",
  "fakeSpotLeft36h", "fakeSpotLeft24h", "fakeSpotLeft12h", "fakeSpotLeft6h", "fakeSpotLeft3h"];
const hasBadNumber = (body) => Object.entries(body || {}).filter(([k, v]) =>
  NUMERIC.includes(k) && (v === "" || v === null || (typeof v === "number" && Number.isNaN(v)) || (typeof v === "string" && !Number.isFinite(Number(v)))));

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const link = await svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
  const vv = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] } });
  let lastBody = null;
  await context.route("**/api/matchday/production/matches/**", (route) => route.request().method() === "PUT"
    ? (lastBody = JSON.parse(route.request().postData() || "{}").changes, route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, match: { ...FIX.match, ...lastBody } }) }))
    : route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FIX) }));
  const page = await context.newPage();
  const load = async () => { await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" }); await page.waitForSelector('[data-testid="save"]', { timeout: 30_000 }); await page.waitForTimeout(120); };

  // capture: clear a field (optionally after a real name change), try to save, return {body, saveDisabled}
  const clearAndSave = async (key, alsoName) => {
    await load();
    if (await page.$('[data-testid="in-isAutoBump"]') && key.startsWith("maxTeamSize")) {
      if (!(await page.$('[data-testid="in-maxTeamSize2Team"]'))) await page.click('[data-testid="in-isAutoBump"]');
    }
    if (alsoName) await page.fill('[data-testid="in-name"]', "changed name");
    await page.fill(`[data-testid="in-${key}"]`, "");
    await page.waitForTimeout(50);
    lastBody = null;
    const disabled = await page.$eval('[data-testid="save"]', (b) => b.disabled);
    if (!disabled) { await page.click('[data-testid="save"]'); for (let i = 0; i < 30 && !lastBody; i++) await page.waitForTimeout(40); }
    return { body: lastBody, disabled };
  };

  console.log(`URL ${PAGE_URL}\n`);
  // PART C1 - the pre-fix body when price is cleared on its own
  const clearedPrice = await clearAndSave("registrationPrice", false);
  console.log(`clearing registrationPrice alone -> save ${clearedPrice.disabled ? "DISABLED (no body sent)" : "ENABLED, body: " + JSON.stringify(clearedPrice.body)}\n`);

  // Every numeric field: clear alongside a real name change, assert body is clean
  for (const key of NUMERIC) {
    const r = await clearAndSave(key, true);
    if (r.disabled) { ok(`cleared ${key}: save blocked (nothing bad sent)`); continue; }
    const bad2 = hasBadNumber(r.body);
    const hasKey = Object.prototype.hasOwnProperty.call(r.body || {}, key);
    if (bad2.length) bad(`cleared ${key}`, `body carries bad numeric: ${JSON.stringify(bad2)}`);
    else if (hasKey) bad(`cleared ${key}`, `cleared field present in body as ${JSON.stringify(r.body[key])} (should be absent)`);
    else ok(`cleared ${key}: absent from body, body=${JSON.stringify(r.body)}`);
  }

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await browser.close();
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
