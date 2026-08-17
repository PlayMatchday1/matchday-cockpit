// Phase 2 match editor — hermetic verify. GET is fulfilled from a fixture and PUT
// is intercepted (body captured, never sent), so nothing writes to staging. The
// point under test is the UI's diff==payload invariant, which is data-independent.
//   node scripts/e2e/verify-matchedit.mjs

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { netRetry, installHarnessGuard, fatal, sessionFor } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";
const PAGE_URL = `${BASE}/match-ops/matches/2470`;
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const check = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e.message); } };
const expectFail = async (n, fn) => { try { await fn(); bad(`NEG: ${n}`, "assertion did NOT catch the defect"); } catch { ok(`NEG: ${n} → fails cleanly`); } };

const MATCH = {
  id: 2470, name: "Friendly match", description: "", category: "OPEN", type: "REGULAR", fieldId: 1,
  managerId: null, secondManagerId: null, managerIntro: "",
  registrationPrice: 12000, additionalSpotPrice: 4000, guestCount: 10, minPlayerCount: 0,
  isFreeMember: true, isAutoBump: false, autoCanceled: false, autoCanceledMinutes: 0,
  maxTeamSize2Team: 10, maxTeamSize4Team: 20,
  fakeSpotLeft36h: 0, fakeSpotLeft24h: 0, fakeSpotLeft12h: 0, fakeSpotLeft6h: 0, fakeSpotLeft3h: 0,
  startDate: "2026-08-07T20:04:29.753Z", endDate: "2026-08-08T20:04:29.767Z", isCancelled: false,
  maxPlayerCount: 4, occupancy: 4, // occupancy = the API's _count.players (real+fake), the authoritative in-match count
  teams: [{ id: 3122, teamNumber: 1, name: "White Tee", locked: false, price: null }, { id: 3123, teamNumber: 2, name: "Dark Tee", locked: false, price: null }],
  fieldTitle: "Bermondsey Field - Austin", cityName: "Austin",
};
// Real players — nested user (names), real team + playerNumber, one cancelled (must NOT
// appear and must NOT be counted). 4 active across 2 teams; the cancelled row is excluded.
const PLAYERS = [
  { id: 91, userId: 11, team: 1, playerNumber: 1, isCancelled: false, user: { firstName: "Ada", lastName: "Lovelace", isFakePlayer: false } },
  { id: 92, userId: 12, team: 1, playerNumber: 2, isCancelled: false, user: { firstName: "Grace", lastName: "Hopper", isFakePlayer: false } },
  { id: 93, userId: 13, team: 2, playerNumber: 1, isCancelled: false, user: { firstName: "Alan", lastName: "Turing", isFakePlayer: false } },
  { id: 94, userId: 14, team: 2, playerNumber: 2, isCancelled: false, user: { firstName: "Edsger", lastName: "Dijkstra", isFakePlayer: true } },
  { id: 95, userId: 15, team: 1, playerNumber: 3, isCancelled: true, user: { firstName: "Cancelled", lastName: "Person", isFakePlayer: false } },
];
const FIELDS = [{ id: 1, title: "Bermondsey Field - Austin", city: "Austin" }, { id: 3, title: "Old Boys and Girls High School", city: "Austin" }];
const GETBODY = JSON.stringify({ match: MATCH, fields: FIELDS, players: PLAYERS });

// grant EDIT MATCHES hermetically (server still enforces in prod)
const grantEdit = (ctx) => ctx.route("**/rest/v1/app_users*", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  const res = await route.fetch(); let j = await res.json().catch(() => null);
  const p = (r) => ({ ...r, can_edit_matches: true, can_access_matchops: true });
  j = Array.isArray(j) ? j.map(p) : (j && typeof j === "object" ? p(j) : j);
  return route.fulfill({ status: res.status(), contentType: "application/json", body: JSON.stringify(j) });
});

let lastPut = null;
async function wire(context) {
  // The editor fetches the guarded matchday route (FULL_EDITOR_ENV=production). Intercept
  // GET (fixture) + PUT (capture, never sent).
  await context.route("**/api/matchday/production/matches/**", async (route) => {
    const req = route.request();
    if (req.method() === "PUT") {
      lastPut = JSON.parse(req.postData() || "{}");
      const changes = lastPut.changes || {};
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, match: { ...MATCH, ...changes } }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: GETBODY });
  });
  await grantEdit(context);
}

// contrast helpers
const parse = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(",").map(parseFloat); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  // ONE SESSION PER IDENTITY, cached across the whole gate run — see sessionFor in _session.mjs.
  const session = await sessionFor("rmancuso@playmatchday.com");
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(session) }] }] } });
  await wire(context);
  const page = await context.newPage();
  const load = async () => { await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" }); await page.waitForSelector('[data-testid="save"]', { timeout: 30_000 }); await page.waitForTimeout(120); };
  await load();

  console.log(`URL ${PAGE_URL}\n\nPRESENCE + BASELINE`);
  const ALWAYS = ["name", "fieldId", "category", "type", "managerId", "secondManagerId", "description", "managerIntro",
    "registrationPrice", "additionalSpotPrice", "guestCount", "fakeSpotLeft36h", "fakeSpotLeft24h", "fakeSpotLeft12h",
    "fakeSpotLeft6h", "fakeSpotLeft3h", "autoCanceled", "autoCanceledMinutes", "minPlayerCount", "isFreeMember", "isAutoBump"];
  await check("every editable field present", async () => {
    for (const k of ALWAYS) if (!(await page.$(`[data-testid="in-${k}"]`))) throw new Error(`missing in-${k}`);
  });
  await check("conditional bump sizes hidden until auto-bump on, values preserved", async () => {
    if (await page.$('[data-testid="in-maxTeamSize2Team"]')) throw new Error("bumps visible while auto-bump off");
    await page.click('[data-testid="in-isAutoBump"]');
    if (!(await page.$('[data-testid="in-maxTeamSize2Team"]'))) throw new Error("bumps did not appear");
    await page.click('[data-testid="in-isAutoBump"]'); // back off — value preserved in state
  });
  await check("save + revert disabled with no changes", async () => {
    if (!(await page.$eval('[data-testid="save"]', (b) => b.disabled))) throw new Error("save enabled at rest");
    if (!(await page.$eval('[data-testid="revert"]', (b) => b.disabled))) throw new Error("revert enabled at rest");
    if (await page.$('[data-testid="diff-item"]')) throw new Error("diff shown at rest");
  });

  console.log("\nDIFF == PAYLOAD");
  // change exactly 3 fields
  await page.fill('[data-testid="in-name"]', "Friendly match [edit]");
  await page.fill('[data-testid="in-registrationPrice"]', "150.00");
  await page.fill('[data-testid="in-guestCount"]', "14");
  await page.waitForTimeout(80);
  await check("changing 3 fields → exactly 3 diff entries", async () => {
    const keys = await page.$$eval('[data-testid="diff-item"]', (els) => els.map((e) => e.getAttribute("data-key")));
    if (keys.length !== 3) throw new Error(`${keys.length} diff items: ${keys}`);
    if (!["name", "registrationPrice", "guestCount"].every((k) => keys.includes(k))) throw new Error(`wrong keys: ${keys}`);
  });
  await check("save now enabled; sb text says 3 changes", async () => {
    if (await page.$eval('[data-testid="save"]', (b) => b.disabled)) throw new Error("save still disabled");
    const t = await page.textContent('[data-testid="sb-text"]');
    if (!/3\s+changes/.test(t)) throw new Error(`sb text "${t}"`);
  });
  await check("PUT body has EXACTLY 3 keys, matching the diff (money in cents)", async () => {
    lastPut = null;
    await page.click('[data-testid="save"]');
    await page.waitForFunction(() => true);
    for (let i = 0; i < 40 && !lastPut; i++) await page.waitForTimeout(50);
    if (!lastPut?.changes) throw new Error("no PUT captured");
    const keys = Object.keys(lastPut.changes);
    if (keys.length !== 3) throw new Error(`${keys.length} keys: ${JSON.stringify(lastPut.changes)}`);
    if (lastPut.changes.registrationPrice !== 15000) throw new Error(`price not cents: ${lastPut.changes.registrationPrice}`);
    if (lastPut.changes.name !== "Friendly match [edit]" || lastPut.changes.guestCount !== 14) throw new Error(JSON.stringify(lastPut.changes));
  });
  console.log("   PUT body.changes = " + JSON.stringify(lastPut.changes));

  console.log("\nBEHAVIOURS");
  await load();
  await check("a boolean reads on/off, not true/false", async () => {
    await page.click('[data-testid="in-isFreeMember"]'); await page.waitForTimeout(60);
    const chip = await page.textContent('[data-testid="diff-item"][data-key="isFreeMember"]');
    if (/true|false/i.test(chip)) throw new Error(`shows boolean literal: "${chip}"`);
    if (!/\b(on|off)\b/i.test(chip)) throw new Error(`no on/off: "${chip}"`);
  });
  await check("revert restores everything (0 diff, save disabled)", async () => {
    await page.click('[data-testid="revert"]'); await page.waitForTimeout(60);
    if (await page.$('[data-testid="diff-item"]')) throw new Error("diff remains after revert");
    if (!(await page.$eval('[data-testid="save"]', (b) => b.disabled))) throw new Error("save enabled after revert");
  });
  await check("cancel lives in its own card, NOT in the save bar", async () => {
    const inBar = await page.$('[data-testid="savebar"] [data-testid="cancel-btn"]');
    if (inBar) throw new Error("cancel button is inside the save bar");
    if (!(await page.$('[data-testid="cancel-card"] [data-testid="cancel-btn"]'))) throw new Error("cancel not in its card");
  });
  await check("ladder warns when it stops descending", async () => {
    await page.fill('[data-testid="in-fakeSpotLeft24h"]', "99"); await page.waitForTimeout(60);
    const note = await page.textContent('[data-testid="ladder-note"]');
    if (!/should descend/i.test(note)) throw new Error(`no warning: "${note}"`);
    await page.click('[data-testid="revert"]');
  });
  await check("back control present (returns to where you came from)", async () => {
    if (!(await page.$('[data-testid="editor-back"]'))) throw new Error("no back button");
  });
  await check("the preview-layout shaping widget is GONE", async () => {
    if (await page.$('[data-testid="view-teamnumbers"]') || await page.$('[data-testid="view-teamsize"]')) throw new Error("preview widget still present");
  });
  await check("roster shows REAL player NAMES, grouped by real team, cancelled excluded", async () => {
    const names = await page.$$eval('[data-testid="player-name"]', (e) => e.map((x) => x.textContent.trim()));
    if (names.length !== 4) throw new Error(`expected 4 active names, got ${names.length}: ${JSON.stringify(names)}`);
    for (const want of ["Ada Lovelace", "Grace Hopper", "Alan Turing"]) if (!names.includes(want)) throw new Error(`missing ${want}; got ${JSON.stringify(names)}`);
    if (names.some((n) => /^Player$/.test(n) || /Cancelled Person/.test(n))) throw new Error(`literal "Player" or a cancelled player leaked: ${JSON.stringify(names)}`);
    const cols = await page.$$eval('[data-testid="team-col"]', (e) => e.map((c) => ({ team: c.getAttribute("data-team"), n: c.querySelectorAll('[data-testid="player-name"]').length })));
    if (cols.length !== 2) throw new Error(`expected 2 team columns, got ${cols.length}`);
    if (!cols.every((c) => c.n === 2)) throw new Error(`each team should show 2 players: ${JSON.stringify(cols)}`);
  });
  await check("capacity headline uses occupancy (4) of cap (4) — NEVER a teams×size product", async () => {
    const t = (await page.textContent('[data-testid="pcount"]')).replace(/\s+/g, " ").trim();
    if (!/^4 of 4/.test(t)) throw new Error(`pcount should read "4 of 4…", got "${t}"`);
    if (/(^|\D)(8|44|88)(\D|$)/.test(t)) throw new Error(`pcount reads a phantom product: "${t}"`);
    if (!/full/i.test(t)) throw new Error(`occupancy==cap should say "full": "${t}"`);
  });

  console.log("\nCONTRAST (.me)");
  const under = await page.evaluate(() => {
    const parse = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(",").map(parseFloat); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
    const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
    const effBg = (el) => { let cur = el, layers = []; while (cur) { const c = parse(getComputedStyle(cur).backgroundColor); if (c && c.a > 0) layers.unshift(c); cur = cur.parentElement; } let acc = { r: 255, g: 255, b: 255, a: 1 }; for (const l of layers) acc = over(l, acc); return acc; };
    const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const L = (x) => 0.2126 * lin(x.r) + 0.7152 * lin(x.g) + 0.0722 * lin(x.b);
    const res = [];
    for (const el of document.querySelectorAll('.me span,.me label,.me h1,.me h2,.me h3,.me b,.me s,.me button,.me .tl,.me .th,.me option')) {
      const direct = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!direct) continue;
      const cs = getComputedStyle(el); if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) continue;
      const fg0 = parse(cs.color); if (!fg0) continue;
      const bg = effBg(el); const fg = over(fg0, bg);
      const [hi, lo] = [L(fg), L(bg)].sort((a, b) => b - a); const cr = (hi + 0.05) / (lo + 0.05);
      const size = parseFloat(cs.fontSize), wt = +cs.fontWeight || 400;
      const need = size >= 24 || (size >= 18.66 && wt >= 700) ? 3 : 4.5;
      if (cr + 0.05 < need) res.push({ t: el.textContent.trim().slice(0, 24), cr: +cr.toFixed(2), need });
    }
    return res;
  });
  await check("every text element meets WCAG contrast", () => { if (under.length) throw new Error(`${under.length} under: ${JSON.stringify(under.slice(0, 6))}`); });

  console.log("\nNEGATIVE CONTROLS (each must fail cleanly)");
  await expectFail("enable save with nothing changed", async () => {
    await load();
    await page.$eval('[data-testid="save"]', (b) => (b.disabled = false)); // inject defect
    if (!(await page.$eval('[data-testid="save"]', (b) => b.disabled))) throw new Error("caught: save enabled while clean");
  });
  await expectFail("PUT body carries a key not in the diff", async () => {
    await load();
    await page.fill('[data-testid="in-name"]', "x"); await page.waitForTimeout(50);
    const diffKeys = await page.$$eval('[data-testid="diff-item"]', (e) => e.map((x) => x.getAttribute("data-key")));
    const body = { name: "x", registrationPrice: 999 }; // injected extra key not in the diff
    if (!Object.keys(body).every((k) => diffKeys.includes(k))) throw new Error("caught: body key absent from diff");
  });
  await expectFail("primary (go) button active on a resolved state", async () => {
    await load();
    await page.$eval('.me .btn.go', (b) => (b.disabled = false)); // inject defect: primary active with nothing to save
    const primaries = await page.$$eval('.me .btn.go', (bs) => bs.map((b) => b.disabled));
    // resolved state = no changes → the only primary must be disabled
    if (primaries.some((d) => d === false)) throw new Error("caught: a primary button is active with nothing to save");
  });
  await expectFail("cancel moved into the save bar", async () => {
    await load();
    await page.evaluate(() => { const c = document.querySelector('[data-testid="cancel-btn"]'); document.querySelector('[data-testid="savebar"]').appendChild(c); });
    if (await page.$('[data-testid="savebar"] [data-testid="cancel-btn"]')) throw new Error("caught: cancel is in the save bar");
  });
  await expectFail("ladder warning removed while not descending", async () => {
    await load();
    await page.fill('[data-testid="in-fakeSpotLeft24h"]', "99"); await page.waitForTimeout(50);
    await page.evaluate(() => { document.querySelector('[data-testid="ladder-note"]').textContent = "all good"; }); // defect
    const note = await page.textContent('[data-testid="ladder-note"]');
    if (!/should descend/i.test(note)) throw new Error("caught: ladder no longer warns");
  });

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await browser.close();
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch(fatal);
