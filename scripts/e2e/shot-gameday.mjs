// Screenshots of the grouped Gameday board (Detail) at 1280 + 390, hermetic.
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const BASE = process.env.BASE || "http://localhost:3000";
const PAGE = `${BASE}/match-ops/gameday`;
const OUT = process.env.OUT || "/Users/ryanmancuso/.claude/jobs/dae135f8/tmp";
const HR = 3600000, MIN = 60000;

const grantEdit = (ctx) => ctx.route("**/rest/v1/app_users*", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  const res = await route.fetch(); let j = await res.json().catch(() => null);
  const p = (r) => ({ ...r, can_edit_matches: true, can_access_matchops: true });
  j = Array.isArray(j) ? j.map(p) : (j && typeof j === "object" ? p(j) : j);
  return route.fulfill({ status: res.status(), contentType: "application/json", body: JSON.stringify(j) });
});

function fixture(base, ymd) {
  const iso = (m) => new Date(base + m * MIN).toISOString();
  const mk = (o) => ({ id: 0, name: "M", isCancelled: false, autoCanceledMinutes: 60, minPlayerCount: 11, maxPlayerCount: 20, registrationPrice: 1200, additionalSpotPrice: 400, fakeSpotLeft36h: 0, fakeSpotLeft24h: 0, fakeSpotLeft12h: 0, fakeSpotLeft6h: 4, fakeSpotLeft3h: 2, isAutoBump: false, category: "OPEN", type: "REGULAR", _count: { players: 6, fakePlayers: 0 }, manager: { firstName: "Sam", lastName: "Webb" }, teams: [{ teamNumber: 1 }, { teamNumber: 2 }], startDate: `${ymd}T18:00:00.000`, ...o });
  const city = (name, abbr) => ({ id: 1, name, timeZone: { abbr } });
  return [
    mk({ id: 501, name: "PRUMC Atlanta", startDateUtc: iso(90), autoCanceledMinutes: 30, _count: { players: 3, fakePlayers: 0 }, field: { title: "PRUMC", city: city("Atlanta", "EDT") } }),
    mk({ id: 503, name: "Kiest Dallas", startDateUtc: iso(234), _count: { players: 6, fakePlayers: 0 }, field: { title: "Kiest", city: city("Dallas", "CDT") } }),
    mk({ id: 502, name: "NEMP Austin", startDateUtc: iso(150), _count: { players: 15, fakePlayers: 0 }, field: { title: "NEMP", city: city("Austin", "CDT") } }),
    mk({ id: 505, name: "Round Rock", isCancelled: true, startDateUtc: iso(60), _count: { players: 4, fakePlayers: 0 }, field: { title: "Round Rock", city: city("Austin", "CDT") } }),
    mk({ id: 509, name: "Havana Fields", isCancelled: true, startDateUtc: iso(180), _count: { players: 8, fakePlayers: 2 }, field: { title: "Havana", city: city("Houston", "CDT") } }),
    mk({ id: 506, name: "Blossom AM", startDateUtc: iso(-150), _count: { players: 16, fakePlayers: 5 }, field: { title: "Blossom", city: city("Austin", "CDT") } }),
  ];
}

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const link = await svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
  const vv = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] };
  const ymd = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();

  const routes = async (ctx) => {
    await ctx.route("**/api/matchday/**/gameday**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ date: ymd, env: "production", matches: fixture(Date.now(), ymd) }) }));
    await ctx.route("**/api/veo**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ matches: [] }) }));
    await grantEdit(ctx);
  };

  const browser = await chromium.launch({ headless: true });
  for (const [w, h, view, tag] of [[1280, 1500, "detail", "1280"], [390, 1700, "detail", "390"], [1280, 1400, "snapshot", "snap-1280"]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, storageState, ...(w === 390 ? { isMobile: true, hasTouch: true } : {}) });
    await routes(ctx);
    const p = await ctx.newPage();
    await p.addInitScript((v) => localStorage.setItem("gameday-view", v), view);
    await p.goto(PAGE, { waitUntil: "domcontentloaded" });
    await p.waitForSelector('[data-testid="snap-group-todo"], [data-testid="snap-group-todo"]', { timeout: 30000 });
    await p.waitForTimeout(250);
    await p.screenshot({ path: `${OUT}/gameday-${tag}.png`, fullPage: true });
    console.log(`wrote ${OUT}/gameday-${tag}.png`);
    await ctx.close();
  }
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
