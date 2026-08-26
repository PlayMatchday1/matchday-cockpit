// A LOOK, not a suite. Opens MATCH MANAGERS on Player Lookup with the REAL route behind it and
// screenshots it at 1280 and 390. Nothing is mocked except the app_users grant.
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
const BASE = process.env.BASE || "http://localhost:3000";
const OUT = process.env.OUT || "/tmp";
const grantEdit = (ctx) => ctx.route("**/rest/v1/app_users*", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  const res = await route.fetch(); let json = await res.json().catch(() => null);
  const patch = (r) => ({ ...r, can_access_matchops: true });
  json = Array.isArray(json) ? json.map(patch) : (json && typeof json === "object" ? patch(json) : json);
  return route.fulfill({ status: res.status(), contentType: "application/json", body: JSON.stringify(json) });
});
async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const link = await svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
  const vv = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] };
  const browser = await chromium.launch({ headless: true });
  for (const [w, h, tag] of [[1280, 1600, "1280"], [390, 1600, "390"]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, storageState, ...(w === 390 ? { isMobile: true, hasTouch: true } : {}) });
    await grantEdit(ctx);
    const p = await ctx.newPage();
    p.on("console", (m) => { if (m.type() === "error") console.log("  console.error:", m.text().slice(0, 200)); });
    await p.goto(`${BASE}/match-ops/player-lookup`, { waitUntil: "domcontentloaded" });
    await p.waitForSelector('[data-testid="mm-toggle"]', { timeout: 20000 });
    await p.click('[data-testid="mm-toggle"]');
    // PRESENCE WAIT BEFORE ANYTHING IS READ: a row, not a timeout.
    await p.waitForSelector('[data-testid="mm-row"]', { timeout: 30000 });
    const counts = await p.textContent('[data-testid="mm-counts"]');
    const rows = await p.locator('[data-testid="mm-row"]').count();
    const chips = await p.locator('[data-testid="mm-city-chip"]').count();
    const body = await p.textContent('[data-testid="mm-panel"]');
    const banner = await p.textContent('[data-testid="mm-naming-banner"]');
    const addDis = await p.locator('[data-testid="mm-add"]').isDisabled();
    const rmDis = await p.locator('[data-testid="mm-remove"]').first().isDisabled();
    const leaks = (body.match(/privaterelay/gi) || []).length;
    const cmOutsideBanner = (body.replace(banner, "").match(/city[\s-]?manager/gi) || []).length;
    console.log(`[${tag}] header="${counts.trim()}" rows=${rows} chips=${chips} addDisabled=${addDis} removeDisabled=${rmDis} relayTokens=${leaks} cityManagerOutsideBanner=${cmOutsideBanner}`);
    await p.locator('[data-testid="mm-panel"]').screenshot({ path: `${OUT}/mm-${tag}.png` });
    console.log(`  wrote ${OUT}/mm-${tag}.png`);
    await ctx.close();
  }
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
