// Phase 23 Step 1 — the staged-field match panel. Drives the real MatchPanel with a mocked
// /api/matchday/production/matches/{id} (GET → match + managers + fields; PUT captures the diff body).
// Deep coverage: EVERY staged field renders its server value AND edits to exactly its own key (a
// wrong-key wiring is the likeliest bug in a panel this wide); multi-field diff; each of the five
// fakeSpotLeft ceilings independently; cents/minutes/totals conversions in the BODY; wall-clock with
// no shift; rising-ceiling warns-not-blocks; type read-only on a non-exposed type; manager name→id;
// password never in a body; layout at 1600 and 390 separately.
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
  autoCanceled: true, autoCanceledMinutes: 75, minPlayerCount: 6, isAutoBump: true,
  maxTeamSize2Team: 16, maxTeamSize4Team: 28,
  description: "Game will be recorded!", managerIntro: "I love the game as much as you do.",
  isCancelled: false, teams: [{ teamNumber: 1 }, { teamNumber: 2 }, { teamNumber: 3 }],
  occupancy: 12, realOccupancy: 1, cityName: "Atlanta", fieldTitle: "PRUMC", cityId: 5,
  manager: { firstName: "Troy", lastName: "" }, secondManager: null,
};
const MANAGERS = [{ id: 65903, name: "Troy" }, { id: 44120, name: "Christian Boada" }, { id: 51882, name: "Drea" }];
const FIELDS = [{ id: 199, title: "Atlanta — PRUMC", city: "Atlanta" }, { id: 201, title: "Austin — Onion Creek", city: "Austin" }];

let puts = [];
function matchFor(id) {
  if (String(id).endsWith("9999")) return { ...REGULAR, id: Number(id), type: "BRACKET" };
  if (String(id).endsWith("8888")) return { ...REGULAR, id: Number(id), maxPlayerCount: 18, teams: [{ teamNumber: 1 }, { teamNumber: 2 }, { teamNumber: 3 }, { teamNumber: 4 }] }; // 18/4 = 4.5, non-divisible
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
    const id = new URL(route.request().url()).pathname.split("/").pop();
    const method = route.request().method();
    const json = (o) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
    if (method === "GET") return json({ match: matchFor(id), fields: FIELDS, players: [], managers: MANAGERS });
    if (method === "PUT") {
      const b = JSON.parse(route.request().postData() || "{}");
      puts.push(b.changes || {});
      return json({ ok: true, outcome: "landed", logRecorded: true, match: { ...matchFor(id), ...(b.changes || {}) } });
    }
    return json({});
  });
  await grantAdmin(ctx);
}

// every staged field: testid, key, its rendered server value, and an edit that changes it
const FLD = [
  { t: "mp-name", key: "name", kind: "text", render: "PRUMC - Tuesday", edit: { fill: "PRUMC NIGHT" } },
  { t: "mp-price", key: "registrationPrice", kind: "text", render: "10.00", edit: { fill: "20.00" } },
  { t: "mp-spot", key: "additionalSpotPrice", kind: "text", render: "", edit: { fill: "3.00" } },
  { t: "mp-guests", key: "guestCount", kind: "text", render: "10", edit: { fill: "5" } },
  { t: "mp-maxplayers", key: "maxPlayerCount", kind: "text", render: "18", edit: { fill: "24" } },
  { t: "mp-acmin", key: "autoCanceledMinutes", kind: "text", render: "75", edit: { fill: "90" } },
  { t: "mp-min", key: "minPlayerCount", kind: "text", render: "6", edit: { fill: "9" } },
  { t: "mp-fake36", key: "fakeSpotLeft36h", kind: "text", render: "12", edit: { fill: "14" } },
  { t: "mp-fake24", key: "fakeSpotLeft24h", kind: "text", render: "10", edit: { fill: "9" } },
  { t: "mp-fake12", key: "fakeSpotLeft12h", kind: "text", render: "6", edit: { fill: "5" } },
  { t: "mp-fake6", key: "fakeSpotLeft6h", kind: "text", render: "4", edit: { fill: "3" } },
  { t: "mp-fake3", key: "fakeSpotLeft3h", kind: "text", render: "3", edit: { fill: "2" } },
  { t: "mp-desc", key: "description", kind: "text", render: "Game will be recorded!", edit: { fill: "new description text" } },
  { t: "mp-intro", key: "managerIntro", kind: "text", render: "I love the game as much as you do.", edit: { fill: "new intro text" } },
  { t: "mp-type", key: "type", kind: "select", render: "REGULAR", edit: { select: "EVENT" } },
  { t: "mp-field", key: "fieldId", kind: "select", render: "199", edit: { select: "201" } },
  { t: "mp-mgr", key: "managerId", kind: "select", render: "65903", edit: { select: "44120" } },
  { t: "mp-mgr2", key: "secondManagerId", kind: "select", render: "", edit: { select: "51882" } },
  { t: "mp-max2", key: "maxTeamSize2Team", kind: "select", render: "16", edit: { select: "20" } },
  { t: "mp-max4", key: "maxTeamSize4Team", kind: "select", render: "28", edit: { select: "36" } },
  { t: "mp-free", key: "isFreeMember", kind: "toggle", render: true, edit: { click: true } },
  { t: "mp-ac", key: "autoCanceled", kind: "toggle", render: true, edit: { click: true } },
  { t: "mp-bump", key: "isAutoBump", kind: "toggle", render: true, edit: { click: true } },
];

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
  const openDiff = async () => { if (await page.$eval('[data-testid="mp-diffhd"]', (e) => e.getAttribute("aria-expanded")) === "false") await page.click('[data-testid="mp-diffhd"]'); };
  const diffKeysNow = () => page.$$eval('[data-testid="mp-diff-item"]', (els) => els.map((e) => e.getAttribute("data-key")).sort());
  const val = (t) => page.$eval(`[data-testid="${t}"]`, (e) => e.value);
  const has = async (t) => (await page.$(`[data-testid="${t}"]`)) !== null;
  const doEdit = async (f) => {
    if (f.edit.fill != null) await page.fill(`[data-testid="${f.t}"]`, f.edit.fill);
    else if (f.edit.select != null) await page.selectOption(`[data-testid="${f.t}"]`, f.edit.select);
    else if (f.edit.click) await page.click(`[data-testid="${f.t}"]`);
  };

  await page.goto(`${BASE}/match-ops/match-panel/17494`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-name"]', { timeout: 30000 });

  // ── RENDER: every staged field shows its server value ──
  for (const f of FLD) {
    const got = f.kind === "toggle" ? await page.$eval(`[data-testid="${f.t}"]`, (e) => e.checked) : await val(f.t);
    eq(`render: ${f.key} shows its server value`, got, f.render);
  }
  eq("render: start = 19:00 (raw wall time, no shift)", await val("mp-start"), "19:00");
  eq("render: date = 2026-08-11 (raw wall date)", await val("mp-date"), "2026-08-11");

  // SPOTS — divisible capacity (18 over 3 teams = 6/team) shows a WHOLE per-team, no na note
  eq("spots: divisible capacity (18/3) shows 6 per team, no total-only note", { spt: await page.$eval('[data-testid="mp-spt"]', (e) => e.textContent.trim()), na: await has("mp-spt-na") }, { spt: "6", na: false });

  // ── ISOLATE: editing each field stages EXACTLY its own key ──
  for (const f of FLD) {
    await doEdit(f);
    await openDiff();
    eq(`isolate: editing ${f.key} stages exactly [${f.key}]`, await diffKeysNow(), [f.key]);
    await page.click('[data-testid="mp-revert"]');
    await page.waitForTimeout(50);
  }
  // WHEN is a duration-preserving PAIR: a start-time edit stages BOTH date fields
  await page.fill('[data-testid="mp-start"]', "20:00");
  await openDiff();
  eq("isolate: a start-time edit stages the pair [endDate, startDate]", await diffKeysNow(), ["endDate", "startDate"]);
  await page.click('[data-testid="mp-revert"]');

  // ── multi-field edit → the diff contains exactly those keys ──
  await page.fill('[data-testid="mp-name"]', "Multi");
  await page.fill('[data-testid="mp-min"]', "8");
  await page.fill('[data-testid="mp-price"]', "14.00");
  await openDiff();
  eq("multi: a 3-field edit stages exactly those keys", await diffKeysNow(), ["minPlayerCount", "name", "registrationPrice"]);
  await page.click('[data-testid="mp-revert"]');

  // ── the five fakeSpotLeft ceilings, EACH independently: fake = max(0, capacity − real − ceiling) ──
  { const cap = 18, real = 1, ceil = { 36: 12, 24: 10, 12: 6, 6: 4, 3: 3 }; // capacity=maxPlayerCount, real=realOccupancy
    for (const h of [36, 24, 12, 6, 3]) {
      const shown = await page.$eval(`[data-testid="mp-fakeneed${h}"]`, (e) => e.textContent.trim());
      const need = Math.max(0, cap - real - ceil[h]);
      eq(`ceiling ${h}H: fake figure = max(0, ${cap} − ${real} − ${ceil[h]}) = ${need}`, shown, need === 0 ? "no fakes" : `${need} fake`);
    } }

  // ── SAVE-BODY conversions (the diff IS the body) ──
  puts = []; await page.fill('[data-testid="mp-price"]', "12.00"); await page.click('[data-testid="mp-save"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="mp-toast"]'), null, { timeout: 6000 });
  eq("cents: typing 12.00 sends registrationPrice 1200 in the body", puts.at(-1)?.registrationPrice, 1200);

  { const label = await page.$eval('[data-testid="mp-acmin"]', (e) => e.closest("label").querySelector(".mp-lb").textContent);
    puts = []; await page.fill('[data-testid="mp-acmin"]', "90"); await page.click('[data-testid="mp-save"]'); await page.waitForTimeout(400);
    (/MINUTES/i.test(label) && puts.at(-1)?.autoCanceledMinutes === 90) ? ok("minutes: autoCanceledMinutes labelled MINUTES and sent as 90 (not ×60)") : bad("minutes", `label=${label} sent=${puts.at(-1)?.autoCanceledMinutes}`); }

  puts = []; await page.selectOption('[data-testid="mp-max2"]', "20"); await page.click('[data-testid="mp-save"]'); await page.waitForTimeout(400);
  eq("totals: a 10 × 10 selection sends maxTeamSize2Team 20", puts.at(-1)?.maxTeamSize2Team, 20);

  puts = []; await page.selectOption('[data-testid="mp-mgr"]', "44120"); await page.click('[data-testid="mp-save"]'); await page.waitForTimeout(400);
  eq("manager: the staged body carries the numeric id 44120", puts.at(-1)?.managerId, 44120);

  // ── password NEVER in any body ──
  eq("password never appears in any PUT body", puts.concat([]).some((b) => JSON.stringify(b).includes("password")), false);

  // ── manager renders a NAME, and TYPE offers exactly two options ──
  { const optText = await page.$eval('[data-testid="mp-mgr"]', (e) => e.options[e.selectedIndex].textContent.trim());
    eq("manager renders a name (not an id)", /Christian Boada|Troy/.test(optText), true); }
  { const opts = await page.$$eval('[data-testid="mp-type"] option', (els) => els.map((o) => o.value));
    eq("type dropdown offers exactly REGULAR + EVENT on a Regular match", opts, ["REGULAR", "EVENT"]); }

  // ── rising ceiling warns naming both marks and does NOT block Save ── (state is clean post-save)
  await page.fill('[data-testid="mp-fake24"]', "15");
  await page.waitForTimeout(120);
  { const warn = await page.$('[data-testid="mp-ladderwarn"]'); const txt = warn ? await warn.textContent() : "";
    const saveDisabled = await page.$eval('[data-testid="mp-save"]', (e) => e.disabled);
    (warn && /24 H/.test(txt) && /36 H/.test(txt) && !saveDisabled) ? ok("rising ceiling warns naming both marks (24 H / 36 H) and does NOT block Save") : bad("ladder warn", `warn=${!!warn} saveDisabled=${saveDisabled}`); }
  await page.click('[data-testid="mp-revert"]');

  // ── Revert restores everything ──
  await page.fill('[data-testid="mp-name"]', "x"); await page.fill('[data-testid="mp-min"]', "1");
  await page.click('[data-testid="mp-revert"]'); await page.waitForTimeout(80);
  eq("Revert clears all staged changes", { count: await page.$eval('[data-testid="mp-diffcount"]', (e) => e.textContent.trim()), name: await val("mp-name") }, { count: "No changes", name: "PRUMC - Tuesday" });

  // ── a non-exposed type renders READ-ONLY (no dropdown that could silently rewrite it) ──
  await page.goto(`${BASE}/match-ops/match-panel/19999`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-name"]', { timeout: 15000 });
  eq("BRACKET match shows type read-only, no dropdown", { ro: await has("mp-type-readonly"), dropdown: await has("mp-type") }, { ro: true, dropdown: false });

  // ── non-divisible capacity (18 over 4 teams = 4.5): hide per-team, show total-only, say why ──
  await page.goto(`${BASE}/match-ops/match-panel/18888`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-name"]', { timeout: 15000 });
  eq("spots: 18/4 hides the per-team figure + stepper, shows a total-only note", { na: await has("mp-spt-na"), perTeam: await has("mp-spt"), stepper: await has("mp-spt-plus") }, { na: true, perTeam: false, stepper: false });
  eq("spots: the note says why (doesn't divide evenly into 4 teams)", /doesn't divide evenly into 4 teams/.test(await page.$eval('[data-testid="mp-spt-na"]', (e) => e.textContent)), true);

  // ── layout at 1600 and 390 — SEPARATE assertions ──
  await page.goto(`${BASE}/match-ops/match-panel/17494`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-panel"]', { timeout: 15000 });
  for (const w of [1600, 390]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => {
      const noOverflow = document.documentElement.scrollWidth <= window.innerWidth + 1;
      const pr = document.querySelector('[data-testid="mp-panel"]').getBoundingClientRect();
      const fits = pr.right <= window.innerWidth + 1 && pr.left >= -1;
      const slot = document.querySelector('[data-testid="mp-immediate-slot"]');
      const slotHidden = !slot || getComputedStyle(slot).display === "none";
      return { noOverflow, fits, slotHidden };
    });
    (r.noOverflow && r.fits && r.slotHidden) ? ok(`layout at ${w}px — no overflow, panel fits, no mobile-only block leaking`) : bad(`layout ${w}px`, JSON.stringify(r));
  }
  await page.setViewportSize({ width: 1440, height: 1000 });

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await browser.close();
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
