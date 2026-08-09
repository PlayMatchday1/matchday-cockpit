// Screenshots for Player Lookup at 1280 and 390 (profile view), hermetic.
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const BASE = process.env.BASE || "http://localhost:3000";
const PAGE = `${BASE}/match-ops/player-lookup`;
const OUT = process.env.OUT || "/Users/ryanmancuso/.claude/jobs/dae135f8/tmp";

const MARISOL = {
  env: "production",
  player: { id: 79214, name: "Marisol Reyes", email: "m.reyes@gmail.com", phone: "+12105557781", phoneVerified: true, city: "San Antonio", level: 6, registered: "2026-02-11T00:00:00.000Z", goals: 14, cityManager: false, credits: 0, status: "ok", banReason: null, bannedAt: null, banExpiredAt: null, matchesPlayed: 1, upcoming: 1 },
  membership: { status: "active", number: "sub_ABC123", since: "2026-03-02T00:00:00.000Z", renews: "2026-09-02T00:00:00.000Z", canceledAt: null, price: 2900, city: "SAT" },
  matches: [
    { umId: 900001, matchId: 17402, name: "Soccer Central Field 6", startDate: "2026-08-09T20:30:00.000Z", startDateUtc: new Date(Date.now() + 6 * 3600e3).toISOString(), team: 1, num: 3, price: 1200, state: "upcoming", removable: true },
    { umId: 900002, matchId: 17244, name: "Soccer Central Field 4", startDate: "2026-08-05T19:00:00.000Z", startDateUtc: "2026-08-05T19:00:00.000Z", team: 1, num: 2, price: 1200, state: "played", removable: false },
    { umId: 900003, matchId: 17190, name: "Soccer Central Field 1", startDate: "2026-08-02T18:00:00.000Z", startDateUtc: "2026-08-02T18:00:00.000Z", team: 2, num: 5, price: 1200, state: "cancelled", removable: false },
  ],
};
const grantEdit = (ctx) => ctx.route("**/rest/v1/app_users*", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  const res = await route.fetch(); let json = await res.json().catch(() => null);
  const patch = (r) => ({ ...r, can_edit_matches: true, can_access_matchops: true });
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

  const routes = async (ctx) => {
    await ctx.route("**/api/lookup/**", (route) => {
      const id = new URL(route.request().url()).searchParams.get("id");
      if (id) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MARISOL) });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kind: "name", results: [{ id: 79214, name: "Marisol Reyes", email: "m.reyes@gmail.com", phone: "+12105557781", city: "San Antonio", status: "ok", hasMembership: true }] }) });
    });
    await grantEdit(ctx);
  };

  const browser = await chromium.launch({ headless: true });
  for (const [w, h, tag] of [[1280, 1400, "1280"], [390, 1500, "390"]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, storageState, ...(w === 390 ? { isMobile: true, hasTouch: true } : {}) });
    await routes(ctx);
    const p = await ctx.newPage();
    await p.goto(PAGE, { waitUntil: "domcontentloaded" }); await p.waitForSelector("#pl-q");
    await p.fill("#pl-q", "Marisol"); await p.waitForTimeout(300);
    await p.waitForSelector('.res[data-pid="79214"]'); await p.click('.res[data-pid="79214"]');
    await p.waitForSelector('.idcard[data-pid="79214"]'); await p.waitForTimeout(200);
    await p.screenshot({ path: `${OUT}/lookup-${tag}.png`, fullPage: true });
    console.log(`wrote ${OUT}/lookup-${tag}.png`);
    await ctx.close();
  }
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
