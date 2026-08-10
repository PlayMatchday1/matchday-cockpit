// Screenshots of the REAL match full editor for 17259 + 17260 at 1280 (real data via the
// server route — the dev server holds prod API creds). Shows the roster names + capacity fix.
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
const BASE = process.env.BASE || "http://localhost:3000";
const OUT = process.env.OUT || "/Users/ryanmancuso/.claude/jobs/dae135f8/tmp";

const grantEdit = (ctx) => ctx.route("**/rest/v1/app_users*", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  const res = await route.fetch(); let j = await res.json().catch(() => null);
  const p = (r) => ({ ...r, can_edit_matches: true, can_access_matchops: true });
  j = Array.isArray(j) ? j.map(p) : (j && typeof j === "object" ? p(j) : j);
  return route.fulfill({ status: res.status(), contentType: "application/json", body: JSON.stringify(j) });
});

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const link = await svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
  const vv = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] };

  const b = await chromium.launch({ headless: true });
  for (const id of [17259, 17260]) {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 1400 }, storageState });
    await grantEdit(ctx);
    const p = await ctx.newPage();
    await p.goto(`${BASE}/match-ops/matches/${id}`, { waitUntil: "domcontentloaded" });
    await p.waitForSelector('[data-testid="roster"]', { timeout: 30000 });
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${OUT}/editor-${id}.png`, fullPage: true });
    const pc = await p.$eval('[data-testid="pcount"]', (e) => e.textContent.replace(/\s+/g, " ").trim()).catch(() => "?");
    const names = await p.$$eval('[data-testid="player-name"]', (e) => e.length).catch(() => 0);
    console.log(`wrote editor-${id}.png — pcount="${pc}" names=${names}`);
    await ctx.close();
  }
  await b.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
