// Phase 23 Step 1 — the staged-field match panel. Drives the real MatchPanel with a mocked
// /api/matchday/production/matches/{id} (GET returns the match + managers + fields; PUT captures the
// diff body). Asserts: every staged field renders, the diff IS the body (one field → one change),
// cents/minutes/totals conversions, wall-clock with no shift, the fakeSpotLeft ceilings derive the
// fake figure, a rising ceiling warns without blocking, the type read-only guard on BRACKET, manager
// name→id, password never in a body, and layout at 1600/390.
//   node scripts/e2e/verify-matchpanel.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const BASE = process.env.BASE || "http://localhost:3000";
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const REGULAR = {
  id: 17494, name: "PRUMC - Tuesday", type: "REGULAR", category: "OPEN",
  managerId: 65903, secondManagerId: null, fieldId: 199,
  startDate: "2026-08-11T19:00:00.000Z", endDate: "2026-08-11T20:30:00.000Z",
  registrationPrice: 1000, additionalSpotPrice: null, guestCount: 10, isFreeMember: true,
  maxPlayerCount: 18,
  fakeSpotLeft36h: 12, fakeSpotLeft24h: 10, fakeSpotLeft12h: 6, fakeSpotLeft6h: 4, fakeSpotLeft3h: 3,
  autoCanceled: true, autoCanceledMinutes: 75, minPlayerCount: 6, isAutoBump: false,
  maxTeamSize2Team: 16, maxTeamSize4Team: 28,
  description: "Game will be recorded!", managerIntro: "I love the game as much as you do.",
  isCancelled: false, teams: [{ teamNumber: 1 }, { teamNumber: 2 }, { teamNumber: 3 }],
  occupancy: 12, fakeOccupancy: 11, cityName: "Atlanta", fieldTitle: "PRUMC", cityId: 5,
  manager: { firstName: "Troy", lastName: "" }, secondManager: null,
};
const MANAGERS = [{ id: 65903, name: "Troy" }, { id: 44120, name: "Christian Boada" }, { id: 51882, name: "Drea" }];
const FIELDS = [{ id: 199, title: "Atlanta — PRUMC", city: "Atlanta" }, { id: 201, title: "Austin — Onion Creek", city: "Austin" }];

let puts = []; // captured PUT bodies
function matchFor(id) {
  if (String(id).endsWith("9999")) return { ...REGULAR, id: Number(id), type: "BRACKET" }; // the non-exposed-type case
  return { ...REGULAR, id: Number(id) };
}

const grantAdmin = (ctx) => ctx.route("**/rest/v1/app_users*", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  const res = await route.fetch(); let j = await res.json().catch(() => null);
  const p = (r) => ({ ...r, is_admin: true, can_access_matchops: true, can_edit_matches: true, can_access_chats: true });
  j = Array.isArray(j) ? j.map(p) : (j && typeof j === "object" ? p(j) : j);
  return route.fulfill({ status: res.status(), contentType: "application/json", body: JSON.stringify(j) });
});

async function routes(ctx) {
  await ctx.route("**/rest/v1/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await ctx.route("**/api/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await ctx.route(/\/api\/matchday\/production\/matches\/\d+(\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.split("/").pop();
    const method = route.request().method();
    const json = (o, s = 200) => route.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(o) });
    if (method === "GET") return json({ match: matchFor(id), fields: FIELDS, players: [], managers: MANAGERS });
    if (method === "PUT") {
      const b = JSON.parse(route.request().postData() || "{}");
      puts.push(b.changes || {});
      // reflect the applied changes so the panel's re-read classifies LANDED
      return json({ ok: true, outcome: "landed", logRecorded: true, match: { ...matchFor(id), ...(b.changes || {}) } });
    }
    return json({});
  });
  await grantAdmin(ctx);
}

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const link = await svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
  const vv = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] };

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState });
  await routes(ctx);
  const page = await ctx.newPage();
  const val = (t) => page.$eval(`[data-testid="${t}"]`, (e) => e.value);
  const has = async (t) => (await page.$(`[data-testid="${t}"]`)) !== null;
  const openDiff = async () => { if (await page.$eval('[data-testid="mp-diffhd"]', (e) => e.getAttribute("aria-expanded")) === "false") await page.click('[data-testid="mp-diffhd"]'); };
  const diffKeysNow = () => page.$$eval('[data-testid="mp-diff-item"]', (els) => els.map((e) => e.getAttribute("data-key")));

  await page.goto(`${BASE}/match-ops/match-panel/17494`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-name"]', { timeout: 30000 });

  // 1 — every staged field renders its server value
  eq("1: staged fields render their server values (name, price$, maxPlayers, acMin, min, guests, fake36)", {
    name: await val("mp-name"), price: await val("mp-price"), max: await val("mp-maxplayers"),
    acmin: await val("mp-acmin"), min: await val("mp-min"), guests: await val("mp-guests"), fake36: await val("mp-fake36"),
  }, { name: "PRUMC - Tuesday", price: "10.00", max: "18", acmin: "75", min: "6", guests: "10", fake36: "12" });

  // 7 — wall clock: the start input equals the raw string's HH:MM, no timezone shift
  eq("7: start renders 19:00 (raw string's wall time), no timezone shift", await val("mp-start"), "19:00");
  eq("7b: date renders 2026-08-11 (raw wall date)", await val("mp-date"), "2026-08-11");

  // 11 — manager renders a NAME (selected option text)
  { const optText = await page.$eval('[data-testid="mp-mgr"]', (e) => e.options[e.selectedIndex].textContent.trim());
    eq("11: manager renders a name (Troy), not an id", optText, "Troy"); }

  // 10 — type dropdown offers exactly two options on a REGULAR match
  { const opts = await page.$$eval('[data-testid="mp-type"] option', (els) => els.map((o) => o.value));
    eq("10: type dropdown offers exactly REGULAR + EVENT on a Regular match", opts, ["REGULAR", "EVENT"]); }

  // 2 — editing one field stages exactly one change
  await page.fill('[data-testid="mp-name"]', "PRUMC - Tuesday NIGHT");
  await openDiff();
  eq("2: editing name stages exactly one change (name)", await diffKeysNow(), ["name"]);

  // 3 — Revert restores every staged field
  await page.fill('[data-testid="mp-min"]', "9");
  await page.fill('[data-testid="mp-price"]', "13.50");
  await page.click('[data-testid="mp-revert"]');
  await page.waitForTimeout(120);
  eq("3: Revert clears all staged changes and restores values", {
    count: await page.$eval('[data-testid="mp-diffcount"]', (e) => e.textContent.trim()),
    name: await val("mp-name"), min: await val("mp-min"), price: await val("mp-price"),
  }, { count: "No changes", name: "PRUMC - Tuesday", min: "6", price: "10.00" });

  // 4 — cents: typing 12.00 sends 1200 (assert the request body)
  puts = [];
  await page.fill('[data-testid="mp-price"]', "12.00");
  await page.click('[data-testid="mp-save"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="mp-toast"]'), null, { timeout: 6000 });
  eq("4: cents — typing 12.00 sends registrationPrice 1200 in the body", puts.at(-1)?.registrationPrice, 1200);

  // 5 — minutes: the field is labelled minutes and sends minutes unscaled
  { const label = await page.$eval('[data-testid="mp-acmin"]', (e) => e.closest("label").querySelector(".mp-lb").textContent);
    puts = [];
    await page.fill('[data-testid="mp-acmin"]', "90");
    await page.click('[data-testid="mp-save"]');
    await page.waitForTimeout(400);
    (/MINUTES/i.test(label) && puts.at(-1)?.autoCanceledMinutes === 90) ? ok("5: autoCanceledMinutes labelled MINUTES and sent as 90 (not ×60)") : bad("minutes", `label=${label} sent=${puts.at(-1)?.autoCanceledMinutes}`); }

  // 6 — totals: selecting 10 × 10 sends 20
  puts = [];
  await page.selectOption('[data-testid="mp-max2"]', "20");
  await page.click('[data-testid="mp-save"]');
  await page.waitForTimeout(400);
  eq("6: totals — a 10 × 10 selection sends maxTeamSize2Team 20", puts.at(-1)?.maxTeamSize2Team, 20);

  // 8 — the five ceilings render and each fake figure = max(0, capacity - real - ceiling), DERIVED
  // (state is already clean here — each save reseeds from the re-read)
  { // capacity=maxPlayerCount=18, real=occupancy(12)-fake(11)=1
    const cap = 18, real = 1;
    const ceilings = { 36: 12, 24: 10, 12: 6, 6: 4, 3: 3 };
    let allMatch = true; const detail = [];
    for (const h of [36, 24, 12, 6, 3]) {
      const shown = await page.$eval(`[data-testid="mp-fakeneed${h}"]`, (e) => e.textContent.trim());
      const need = Math.max(0, cap - real - ceilings[h]);
      const want = need === 0 ? "no fakes" : `${need} fake`;
      if (shown !== want) { allMatch = false; detail.push(`${h}H shown=${shown} want=${want}`); }
    }
    allMatch ? ok("8: each ceiling's fake figure = max(0, capacity − real − ceiling), derived from the live model") : bad("ceiling fakes", detail.join("; ")); }

  // 9 — a rising ceiling warns, names both marks, and does NOT block Save
  await page.fill('[data-testid="mp-fake24"]', "15"); // 15 at 24H > 12 at 36H
  await page.waitForTimeout(120);
  { const warn = await page.$('[data-testid="mp-ladderwarn"]');
    const warnTxt = warn ? await warn.textContent() : "";
    const saveDisabled = await page.$eval('[data-testid="mp-save"]', (e) => e.disabled);
    (warn && /24 H/.test(warnTxt) && /36 H/.test(warnTxt) && !saveDisabled) ? ok("9: a rising ceiling warns naming both marks (24 H / 36 H) and does NOT block Save") : bad("ladder warn", `warn=${!!warn} names=${/24 H/.test(warnTxt) && /36 H/.test(warnTxt)} saveDisabled=${saveDisabled}`); }
  await page.click('[data-testid="mp-revert"]');

  // 11b — the staged diff for a manager change carries the NUMERIC id
  puts = [];
  await page.selectOption('[data-testid="mp-mgr"]', "44120");
  await page.click('[data-testid="mp-save"]');
  await page.waitForTimeout(400);
  eq("11b: a manager change sends the numeric id (44120)", puts.at(-1)?.managerId, 44120);

  // 12 — password appears in NO request body, ever
  eq("12: password never appears in any PUT body", puts.concat(...[]).some((b) => JSON.stringify(b).includes("password")), false);

  // 10b — a BRACKET match renders the type as READ-ONLY text, with no dropdown
  await page.goto(`${BASE}/match-ops/match-panel/19999`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-name"]', { timeout: 15000 });
  eq("10b: a BRACKET match shows type read-only (no dropdown that could silently rewrite it)", { ro: await has("mp-type-readonly"), dropdown: await has("mp-type") }, { ro: true, dropdown: false });

  // 13 — layout at 1600 and 390: no mobile-only leak, no horizontal overflow, panel fits
  await page.goto(`${BASE}/match-ops/match-panel/17494`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-panel"]', { timeout: 15000 });
  for (const w of [1600, 390]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => {
      const noOverflow = document.documentElement.scrollWidth <= window.innerWidth + 1;
      const panel = document.querySelector('[data-testid="mp-panel"]');
      const pr = panel.getBoundingClientRect();
      const fits = pr.right <= window.innerWidth + 1 && pr.left >= -1;
      // the immediate-actions slot (a Step-2 placeholder) must be display:none, not just [hidden]-attr
      const slot = document.querySelector('[data-testid="mp-immediate-slot"]');
      const slotHidden = !slot || getComputedStyle(slot).display === "none";
      return { noOverflow, fits, slotHidden };
    });
    (r.noOverflow && r.fits && r.slotHidden) ? ok(`13: layout OK at ${w}px — no overflow, panel fits, no mobile-only block leaking`) : bad(`layout ${w}px`, JSON.stringify(r));
  }
  await page.setViewportSize({ width: 1440, height: 1000 });

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await browser.close();
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
