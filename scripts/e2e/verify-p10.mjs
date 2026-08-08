// PHASE 10 PART 3 - full contrast sweep + DOM mutation tests + drawer re-verify
// against the PRODUCTION route mock. Hermetic (fixtures). Admin session injected.
//   node scripts/e2e/verify-p10.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const BASE = process.env.BASE || "http://localhost:3000";
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  XX  ${n} — ${d}`); };
const is = (n, got, exp) => (JSON.stringify(got) === JSON.stringify(exp) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(exp)}`));

const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const MATCHES = [
  { apiId: 3101, city: "Atlanta", dayIdx: 0, time: "7:00 PM", minutes: 1140, venue: "PRUMC", name: "Monday PRUMC", veo: true, hasEmoji: true },
  { apiId: 2470, city: "Austin", dayIdx: 4, time: "6:30 PM", minutes: 1110, venue: "NEMP", name: "Big Success Clubhouse", veo: false, hasEmoji: false },
  { apiId: 2415, city: "Austin", dayIdx: 4, time: "8:30 PM", minutes: 1230, venue: "NEMP", name: "Friday Late NEMP", veo: true, hasEmoji: false },
];
const veoWeek = () => ({
  weekStart: "2026-08-03",
  days: [0, 1, 2, 3, 4, 5, 6].map((i) => ({ dow: DAYS[i], date: 3 + i, iso: `2026-08-0${3 + i}`, today: i === 4 })),
  cities: [{ city: "Atlanta", cameras: 1 }, { city: "Austin", cameras: 1 }],
  matches: MATCHES, codesRef: [], seededThisWeek: 0, generatedAt: "2026-08-07T00:00:00.000Z",
});
const FIELDS = [
  { id: 1, title: "NEMP", city: "Austin" }, { id: 2, title: "Onion Creek", city: "Austin" },
  { id: 11, title: "PRUMC", city: "Atlanta" },
];
const MANAGERS = [{ id: 101, name: "Marcus Webb" }, { id: 102, name: "Dani Ferreira" }, { id: 104, name: "Sam Okafor" }];
function prodDetail(id) {
  const base = {
    id, name: "Big Success Clubhouse", fieldId: 1, cityName: "Austin", cityId: 3,
    startDate: "2026-08-07T18:30:00.000Z", endDate: "2026-08-08T18:30:00.000Z",
    registrationPrice: 12000, additionalSpotPrice: 4000, guestCount: null,
    managerId: 101, secondManagerId: 999, manager: { id: 101, firstName: "Marcus", lastName: "Webb" },
    secondManager: { id: 999, deletedAt: "2025-01-01T00:00:00.000Z" }, maxPlayerCount: 40, teams: [{}, {}, {}, {}], isCancelled: false,
  };
  return { match: base, fields: FIELDS, players: [], managers: MANAGERS };
}
// full editor (staging route) capacity fixture: consistent caps (perTeam 10, 2 teams)
const EMPTY_EDIT = { category: null, type: null, description: null, managerIntro: null, fakeSpotLeft36h: null, fakeSpotLeft24h: null, fakeSpotLeft12h: null, fakeSpotLeft6h: null, fakeSpotLeft3h: null, autoCanceled: false, autoCanceledMinutes: null, minPlayerCount: null, isFreeMember: false, isAutoBump: false, managerId: null, secondManagerId: null, additionalSpotPrice: null, guestCount: null, registrationPrice: 1000 };
// 2480 = clean 2-team (no contradiction). 2481 = 4-team match whose 4-team total
// is 0 (genuine contradiction). 2482 = 17256-style independent caps (40/0/40, four
// teams) — valid, must NOT be flagged (that is the 81% anti-noise case).
function stageDetail(id) {
  const per = {
    2480: { teams: [{}, {}], maxTeamSize2Team: 20, maxTeamSize4Team: 40, maxPlayerCount: 20 },
    2481: { teams: [{}, {}, {}, {}], maxTeamSize2Team: 20, maxTeamSize4Team: 0, maxPlayerCount: 40 },
    2482: { teams: [{}, {}, {}, {}], isAutoBump: true, maxTeamSize2Team: 0, maxTeamSize4Team: 40, maxPlayerCount: 40 },
  };
  const p = per[id] || per[2480];
  return { match: { id, ...EMPTY_EDIT, ...p, name: "Cap Test", fieldId: 1, startDate: "2026-08-07T18:30:00.000Z", endDate: "2026-08-07T20:30:00.000Z", isCancelled: false, manager: null, secondManager: null, fieldTitle: "NEMP", cityName: "Austin" }, fields: FIELDS, players: [] };
}

// full painted-background contrast sweep over every element with a direct text node
// within `root` (the Phase 7/10 screen — excludes the shared nav chrome).
async function contrastSweep(page, label, root = ".vms") {
  const failsArr = await page.evaluate((rootSel) => {
    const paintedBg = (el) => { let n = el; while (n) { const c = getComputedStyle(n).backgroundColor; if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c; n = n.parentElement; } return "rgb(255, 255, 255)"; };
    const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const parse = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(",").map(Number); if (p[3] === 0) return null; return [p[0], p[1], p[2]]; };
    const out = [];
    const scope = document.querySelector(rootSel);
    for (const el of (scope ? scope.querySelectorAll("*") : [])) {
      const txt = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("").trim();
      if (!txt) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
      const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue;
      const fg = parse(cs.color), bg = parse(paintedBg(el)); if (!fg || !bg) continue;
      const L1 = lum(fg), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const size = parseFloat(cs.fontSize), weight = Number(cs.fontWeight) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const need = large ? 3.0 : 4.5;
      if (ratio < need - 0.01) out.push({ txt: txt.slice(0, 44), ratio: +ratio.toFixed(2), need, fg: cs.color, bg: paintedBg(el), size, weight });
    }
    return out;
  }, root);
  if (failsArr.length === 0) ok(`contrast sweep [${label}]: all text nodes pass`);
  else { bad(`contrast sweep [${label}]`, `${failsArr.length} failures`); failsArr.slice(0, 20).forEach((f) => console.log(`       "${f.txt}" ratio ${f.ratio} < ${f.need}  ${f.fg} on ${f.bg} (${f.size}px/${f.weight})`)); }
}

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const link = await svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
  const vv = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] } });

  let lastPut = null;
  await context.route("**/api/veo**", (route) => {
    const u = route.request().url();
    if (u.includes("/veo/intent") || u.includes("/veo/cameras")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(veoWeek()) });
  });
  // Both the drawer AND the full editor (Phase 11) hit /api/matchday/production.
  // The capacity fixture ids (248x) get the editor-shaped stageDetail; drawer ids
  // get prodDetail.
  const detailFor = (id) => ([2480, 2481, 2482].includes(id) ? stageDetail(id) : prodDetail(id));
  await context.route("**/api/matchday/production/matches/**", (route) => {
    const req = route.request(); const id = Number(req.url().split("/").pop().split("?")[0]);
    if (req.method() === "PUT") { lastPut = JSON.parse(req.postData() || "{}").changes; return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, match: { ...detailFor(id).match, ...lastPut } }) }); }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(detailFor(id)) });
  });

  const page = await context.newPage();
  const T = (t) => page.locator(`[data-testid="${t}"]`);
  const openCard = async (id) => { lastPut = null; if (await T("drawer").count()) { const rev = T("dr-revert"); if (await rev.count() && !(await rev.isDisabled())) await rev.click(); } await page.locator(`[data-testid="card"][data-id="${id}"]`).click(); await T("drawer").waitFor(); await page.waitForFunction(() => !!document.querySelector('[data-testid="dr-save"]')); await page.waitForTimeout(150); };

  console.log("\n== contrast sweep (Schedule / Veo / drawer / full editor) ==");
  await page.goto(`${BASE}/match-ops/master-schedule`, { waitUntil: "domcontentloaded" });
  await T("card").first().waitFor({ timeout: 30000 }); await page.waitForTimeout(200);
  await contrastSweep(page, "Schedule view");
  await page.getByRole("tab", { name: "Veo coverage" }).click(); await page.waitForTimeout(200);
  await contrastSweep(page, "Veo view");
  await page.getByRole("tab", { name: "Schedule" }).click(); await page.waitForTimeout(150);
  await openCard(2470);
  await contrastSweep(page, "drawer open");
  // Non-gating: the shared nav chrome (TopNav/sidebar) is outside Phase 10's
  // screens; report any failures there so they are on record.
  const chrome = await page.evaluate(() => {
    const paintedBg = (el) => { let n = el; while (n) { const c = getComputedStyle(n).backgroundColor; if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c; n = n.parentElement; } return "rgb(255, 255, 255)"; };
    const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const parse = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(",").map(Number); if (p[3] === 0) return null; return [p[0], p[1], p[2]]; };
    const out = [];
    for (const el of document.querySelectorAll("body *")) {
      if (el.closest(".vms") || el.closest(".me")) continue; // Phase 10 screens covered by the gate
      const txt = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("").trim();
      if (!txt) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
      const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue;
      const fg = parse(cs.color), bg = parse(paintedBg(el)); if (!fg || !bg) continue;
      const L1 = lum(fg), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const size = parseFloat(cs.fontSize), weight = Number(cs.fontWeight) || 400;
      const need = size >= 24 || (size >= 18.66 && weight >= 700) ? 3.0 : 4.5;
      if (ratio < need - 0.01) out.push({ txt: txt.slice(0, 30), ratio: +ratio.toFixed(2), need });
    }
    return out;
  });
  console.log(`  NOTE shared nav chrome (outside Phase 10 scope): ${chrome.length} contrast failures${chrome.length ? " — " + chrome.map((c) => `"${c.txt}"(${c.ratio}<${c.need})`).join(", ") : ""}`);

  console.log("\n== drawer re-verify against PRODUCTION route ==");
  await openCard(2470);
  await T("in-name").fill("Renamed");
  await T("in-registrationPrice").fill("130.00");
  await T("in-guestCount").fill("5");
  await T("dr-save").click(); await page.waitForFunction(() => document.querySelector('[data-testid="dr-msg"]'));
  is("3 fields changed -> 3 keys via production route", lastPut ? Object.keys(lastPut).sort() : [], ["guestCount", "name", "registrationPrice"]);

  console.log("\n== manager dropdown (PART 2) ==");
  await openCard(2470);
  const mgrOpts = await T("in-managerId").locator("option").allTextContents();
  is("manager dropdown lists city managers + none", mgrOpts.includes("Marcus Webb") && mgrOpts.includes("— none —"), true);
  is("manager select value = current managerId (101)", await T("in-managerId").inputValue(), "101");
  // secondManagerId 999 is NOT in the list -> stays selected + labelled
  is("deleted 2nd manager stays selected (999)", await T("in-secondManagerId").inputValue(), "999");
  const sm = await T("in-secondManagerId").locator("option").allTextContents();
  is("deleted 2nd manager labelled 'not in ... list'", sm.some((t) => /not in .* list/.test(t)), true);
  is("deleted manager note shown", await T("dr-delnote").isVisible(), true);

  console.log("\n== Defect 1: price display — '$' must not overlap the leading digit ==");
  await openCard(2415); // fresh id -> refetch; prodDetail registrationPrice 12000 -> "120.00" (over $100, leading 1)
  is("price input.value = 120.00 (correct)", await T("in-registrationPrice").inputValue(), "120.00");
  const priceGeo = await T("in-registrationPrice").evaluate((inp) => {
    const money = inp.closest(".mdw-money"); const span = money.querySelector("span");
    const ir = inp.getBoundingClientRect(), sr = span.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(inp).paddingLeft);
    return { textStart: ir.left + pad, dollarRight: sr.right, pad };
  });
  is(`price padding-left applied (24px, was 11px)`, priceGeo.pad >= 20, true);
  is(`'$' right edge (${Math.round(priceGeo.dollarRight)}) <= input text start (${Math.round(priceGeo.textStart)}) — digit visible`, priceGeo.dollarRight <= priceGeo.textStart + 0.5, true);

  console.log("\n== Defect 2: environment badge derived + production distinct ==");
  is("badge text says PRODUCTION (derived)", /PRODUCTION/.test(await T("dr-envbadge").textContent()), true);
  is("badge does NOT say STAGING on a production drawer", /STAGING/.test(await T("dr-envbadge").textContent()), false);
  is("drawer data-env = production (same value that routes the request)", await T("drawer").getAttribute("data-env"), "production");
  is("badge has the prod tone class (distinct treatment)", await T("dr-envbadge").evaluate((e) => e.classList.contains("prod")), true);
  is("production drawer carries the red rail (mdw-prod)", await T("drawer").evaluate((e) => e.classList.contains("mdw-prod")), true);
  is("no 'STAGING' text anywhere in the production drawer", (await page.locator(".mdw").innerText()).includes("STAGING"), false);

  console.log("\n== MUTATION (DOM): push-grid clearance ==");
  await openCard(2470);
  const dbox = await T("drawer").boundingBox();
  const days = await page.locator(".vms-day").all();
  const lastDay = await days[days.length - 1].boundingBox();
  is(`real push guard: last column right (${Math.round(lastDay.x + lastDay.width)}) <= drawer left (${Math.round(dbox.x)})`, lastDay.x + lastDay.width <= dbox.x + 1, true);
  // BREAK the guard in the running page: remove the push margin, re-measure -> assertion must FAIL
  await page.evaluate(() => { const el = document.querySelector(".vms"); el.style.marginRight = "0px"; el.style.maxWidth = "none"; el.style.width = "100vw"; });
  await page.waitForTimeout(150);
  const days2 = await page.locator(".vms-day").all();
  const lastDay2 = await days2[days2.length - 1].boundingBox();
  const stillClear = lastDay2.x + lastDay2.width <= dbox.x + 1;
  is("[mutation] push guard removed -> assertion FAILS (column now under drawer)", stillClear, false);

  console.log("\n== unsaved-changes guard (two-sided) ==");
  await openCard(2470);
  await T("in-name").fill("dirty");
  await page.waitForTimeout(60);
  await page.keyboard.press("Escape"); await page.waitForTimeout(120);
  is("dirty: Escape blocked (drawer stays open)", await T("drawer").isVisible(), true);
  await T("dr-revert").click(); await page.waitForTimeout(60);
  await page.keyboard.press("Escape"); await page.waitForTimeout(150);
  is("clean: Escape closes (two-sided control)", await T("drawer").count(), 0);

  console.log("\n== full editor: PRODUCTION (Phase 11) ==");
  await page.goto(`${BASE}/match-ops/matches/2480`, { waitUntil: "domcontentloaded" });
  await T("savebar").waitFor({ timeout: 30000 }); await page.waitForTimeout(200);
  // Defect-2-class: the editor badge is derived + production, no STAGING text
  is("editor badge says PRODUCTION (derived)", /PRODUCTION/.test(await T("ed-envbadge").textContent()), true);
  is("editor badge does NOT say STAGING", /STAGING/.test(await page.locator(".me .hmeta").innerText()), false);
  is("editor badge has prod tone class", await T("ed-envbadge").evaluate((e) => e.classList.contains("prod")), true);
  // clean load: empty diff + disabled Save
  is("clean load: Save disabled", await T("save").isDisabled(), true);
  is("clean load: no diff-list", await T("diff-list").count(), 0);
  // N fields changed -> exactly N keys (1,2,3), written to the PRODUCTION route
  await T("in-name").fill("P11 A"); await page.waitForTimeout(50); await T("save").click(); await page.waitForFunction(() => document.querySelector('[data-testid="sb-msg"]'));
  is("editor 1 field -> 1 key", lastPut ? Object.keys(lastPut).sort() : [], ["name"]);
  await T("in-name").fill("P11 B"); await T("in-minPlayerCount").fill("7"); await page.waitForTimeout(50); await T("save").click(); await page.waitForFunction(() => document.querySelector('[data-testid="sb-msg"]'));
  is("editor 2 fields -> 2 keys", lastPut ? Object.keys(lastPut).sort() : [], ["minPlayerCount", "name"]);
  await T("in-name").fill("P11 C"); await T("in-minPlayerCount").fill("8"); await T("in-description").fill("desc p11"); await page.waitForTimeout(50); await T("save").click(); await page.waitForFunction(() => document.querySelector('[data-testid="sb-msg"]'));
  is("editor 3 fields -> 3 keys", lastPut ? Object.keys(lastPut).sort() : [], ["description", "minPlayerCount", "name"]);

  console.log("\n== full editor capacity model (Phase 10.1 revert: 3 independent totals) ==");
  await page.goto(`${BASE}/match-ops/matches/2480`, { waitUntil: "domcontentloaded" });
  await T("savebar").waitFor({ timeout: 30000 }); await page.waitForTimeout(200);
  await contrastSweep(page, "full editor", ".me");
  is("labels: 'Capacity now' present", (await page.locator(".me").innerText()).toLowerCase().includes("capacity now"), true);
  is("per-side hint on capacity-now (20 total, 10 a side)", (await T("perside-maxPlayerCount").textContent())?.trim(), "20 total, 10 a side");
  is("clean 2-team match: no contradiction flag", await T("cap-contradiction").count(), 0);
  // three caps are INDEPENDENT: editing capacity-now sends only that key
  await T("in-maxPlayerCount").fill("18");
  await page.waitForTimeout(80);
  await T("save").click(); await page.waitForTimeout(300);
  is("editing capacity-now sends only maxPlayerCount (independent)", lastPut ? Object.keys(lastPut).sort() : [], ["maxPlayerCount"]);
  is("  maxPlayerCount = 18 (verbatim, not derived)", lastPut && lastPut.maxPlayerCount, 18);
  // genuine contradiction: 4-team match whose 4-team total is 0
  await page.goto(`${BASE}/match-ops/matches/2481`, { waitUntil: "domcontentloaded" });
  await T("savebar").waitFor({ timeout: 30000 }); await page.waitForTimeout(200);
  is("4-team match with 4-team total 0: contradiction flag shown", await T("cap-contradiction").isVisible(), true);
  // 17256-style independent caps (40/0/40, four teams) must NOT be flagged (anti-noise)
  await page.goto(`${BASE}/match-ops/matches/2482`, { waitUntil: "domcontentloaded" });
  await T("savebar").waitFor({ timeout: 30000 }); await page.waitForTimeout(200);
  is("[anti-noise] 17256-style 40/0/40 four-team: NO contradiction flag", await T("cap-contradiction").count(), 0);
  is("  2-team total 0 shows 'not available as a 2-team match'", (await T("perside-maxTeamSize2Team").textContent())?.trim(), "not available as a 2-team match");
  is("  4-team total 40 shows '40 total, 10 a side'", (await T("perside-maxTeamSize4Team").textContent())?.trim(), "40 total, 10 a side");

  console.log(`\n================ RESULT ================\n${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await browser.close();
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
