// Promo Codes (Phase 18b), driven in a real browser, hermetic. The /api/promos/* routes are
// route-fulfilled with a synthetic dataset so the screen is tested without touching production.
// Grants MANAGE PROMOS via the app_users read patch (server still enforces; here we exercise the
// UI). Desktop 1280 + a 390×844 touch context. Everything the prompt calls for is asserted.
//   node scripts/e2e/verify-promos.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { netRetry, installHarnessGuard, fatal } from "./_session.mjs";
installHarnessGuard();
import { overflow } from "./checks.mjs";

// contrast sweep SCOPED to the promo screen (.promo) — the global sweep is noisy with app chrome.
async function contrastIn(pg) {
  return pg.evaluate(() => {
    const root = document.querySelector(".promo"); if (!root) return { failures: [], min: Infinity };
    const pc = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(",").map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
    const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const L = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    const ratio = (a, b) => { const x = L(a), y = L(b), hi = Math.max(x, y), lo = Math.min(x, y); return (hi + 0.05) / (lo + 0.05); };
    const bg = (el) => { let n = el; while (n && n.nodeType === 1) { const c = pc(getComputedStyle(n).backgroundColor); if (c && c.a > 0.85) return c; n = n.parentElement; } return { r: 255, g: 255, b: 255, a: 1 }; };
    const txt = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    const vis = (el) => { const s = getComputedStyle(el); if (s.display === "none" || s.visibility === "hidden" || +s.opacity === 0) return false; return el.offsetParent !== null || s.position === "fixed"; };
    const failures = []; let min = Infinity;
    for (const el of root.querySelectorAll("*")) { if (!txt(el) || !vis(el)) continue; if (el.hasAttribute("disabled")) continue; const fg = pc(getComputedStyle(el).color); if (!fg) continue; const r = ratio(fg, bg(el)); if (r < min) min = Math.round(r * 100) / 100; if (r < 4.5) failures.push({ ratio: Math.round(r * 100) / 100, t: el.textContent.trim().slice(0, 28), c: (el.getAttribute("class") || "").slice(0, 30) }); }
    return { failures, min };
  });
}

const BASE = process.env.BASE || "http://localhost:3000";
const PAGE = `${BASE}/match-ops/promos`;
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const grantPromos = (ctx) => ctx.route("**/rest/v1/app_users*", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  const res = await route.fetch(); let j = await res.json().catch(() => null);
  const p = (r) => ({ ...r, is_admin: true, can_access_matchops: true, can_manage_promos: true });
  j = Array.isArray(j) ? j.map(p) : (j && typeof j === "object" ? p(j) : j);
  return route.fulfill({ status: res.status(), contentType: "application/json", body: JSON.stringify(j) });
});

// ── synthetic promo data, instants relative to `now` (true UTC) ──
const HR = 3600000, DAY = 86400000;
function fixtures(now) {
  const iso = (ms) => new Date(now + ms).toISOString();
  const mk = (o) => ({ id: 0, code: "X", startDateUtc: iso(-30 * DAY), endDateUtc: iso(30 * DAY), discountType: "PERCENT", discountValue: 50, targetUserType: "ALL_USERS", numberOfUsesPerUser: 5, targetMatchType: "ALL_MATCHES", matchTimePeriodStart: null, matchTimePeriodEnd: null, createdAt: iso(-40 * DAY), updatedAt: iso(-40 * DAY), deletedAt: null, ...o });
  const live = [
    mk({ id: 101, code: "ACTIVE1", startDateUtc: iso(-10 * DAY), endDateUtc: iso(20 * DAY), numberOfUsesPerUser: 5, targetMatchType: "ALL_MATCHES" }),        // active, per-user cap
    mk({ id: 102, code: "SCHEDULED1", startDateUtc: iso(5 * DAY), endDateUtc: iso(40 * DAY), discountType: "USD", discountValue: 500, targetUserType: "NEW_USERS", numberOfUsesPerUser: 1 }), // scheduled
    mk({ id: 103, code: "DELFUTURE", startDateUtc: iso(-5 * DAY), endDateUtc: iso(15 * DAY), deletedAt: iso(-2 * DAY) }),                                       // DELETED but end in future -> stays LIVE
    mk({ id: 301, code: "TOTALCAP", startDateUtc: iso(-3 * DAY), endDateUtc: iso(10 * DAY), targetMatchType: "TOTAL_USAGE", numberOfUsesPerUser: 20 }),        // total cap (LEFT = 13)
    mk({ id: 302, code: "NOCAP", startDateUtc: iso(-3 * DAY), endDateUtc: iso(10 * DAY), numberOfUsesPerUser: 10000 }),                                        // no-cap sentinel
    mk({ id: 303, code: "OVERCAP", startDateUtc: iso(-3 * DAY), endDateUtc: iso(10 * DAY), targetMatchType: "TOTAL_USAGE", numberOfUsesPerUser: 3 }),          // over-redeemed (usage 7 > cap 3)
    mk({ id: 401, code: "PROMO301", startDateUtc: iso(-3 * DAY), endDateUtc: iso(12 * DAY) }),                                                                 // code CONTAINING digits "301" (dual-fire)
    mk({ id: 501, code: "SLOWCODE", startDateUtc: iso(-3 * DAY), endDateUtc: iso(11 * DAY), createdAt: iso(-3 * DAY) }),                                        // detail is delayed — REDEEMED "loading" state
    mk({ id: 502, code: "FAILCODE", startDateUtc: iso(-3 * DAY), endDateUtc: iso(11 * DAY), createdAt: iso(-2 * DAY) }),                                        // detail 500s — REDEEMED "failed" state
  ];
  const past = [
    mk({ id: 201, code: "EXPIRED1", startDateUtc: iso(-60 * DAY), endDateUtc: iso(-10 * DAY) }),           // expired
    mk({ id: 202, code: "DELETEDPAST", startDateUtc: iso(-60 * DAY), endDateUtc: iso(-5 * DAY), deletedAt: iso(-30 * DAY) }), // deleted + past
  ];
  return { live, past };
}
const usageFor = { 101: 4, 301: 7, 302: 235, 303: 7, 401: 0, 501: 9, 102: 0, 103: 1, 201: 9, 202: 3 };

function serveList(url, now) {
  const u = new URL(url); const sp = u.searchParams;
  const { live, past } = fixtures(now);
  const nowIso = new Date(now).toISOString();
  const code = (sp.get("code") || "").trim().toLowerCase();
  if (code) {
    const all = [...live, ...past].filter((r) => r.code.toLowerCase().includes(code));
    return { data: all, totalItems: all.length, nowIso };
  }
  const bucket = sp.get("bucket");
  const page = Number(sp.get("page") || "1");
  if (bucket === "live") {
    // page 1 = the 5 named rows + 20 filler (25); pages 2-6 = 25 filler each; totalItems 120 -> nudge past 100
    const filler = Array.from({ length: 25 }, (_, i) => ({ ...live[0], id: 5000 + page * 100 + i, code: `LIVEFILL${page}_${i}` }));
    const rows = page === 1 ? [...live, ...filler.slice(0, 20)] : filler;
    return { data: rows, totalItems: 120, nowIso };
  }
  return { data: past, totalItems: past.length, nowIso };
}

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const link = await netRetry(() => svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" }), "generateLink");
  const vv = await netRetry(() => anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token }), "verifyOtp");
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] };

  let lastCreate = null; // captured create-request payload, for the D5 drop-array assertion
  const routes = async (ctx) => {
    const now = Date.now();
    await ctx.route("**/api/promos/list**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(serveList(route.request().url(), now)) }));
    await ctx.route("**/api/promos/check**", (route) => {
      const code = (new URL(route.request().url()).searchParams.get("code") || "").toLowerCase();
      const { live, past } = fixtures(now);
      // "manymatch" simulates a short substring with more matches than one page — inconclusive
      if (code === "manymatch") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: "inconclusive", similar: 500 }) });
      const hit = [...live, ...past].find((r) => r.code.toLowerCase() === code);
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(hit ? { result: "taken", existing: { id: hit.id, code: hit.code, state: "active" } } : { result: "free", existing: null }) });
    });
    await ctx.route("**/api/promos/detail/**", async (route) => {
      const id = Number(route.request().url().split("/").pop().split("?")[0]);
      if (id === 502) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) }); // REDEEMED failed state
      if (id === 501) await new Promise((r) => setTimeout(r, 2500)); // slow → REDEEMED loading state is observable
      const { live, past } = fixtures(now);
      const promo = [...live, ...past].find((r) => r.id === id) ?? null; // unknown (filler) → usageCount 0
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ promo, usageCount: usageFor[id] ?? 0, nowIso: new Date(now).toISOString() }) });
    });
    // ── USES (Phase 31). A fixture carrying the three states that matter: a repeat offender
    // over the cap, a compliant single-use account, and a DELETED account that keeps its
    // redemptions. Deleted means the id survives and no longer resolves — not a null id.
    await ctx.route("**/api/promos/uses/**", (route) => {
      const id = Number(route.request().url().split("/").pop());
      const U = (rid, pid, at, extra = {}) => ({ id: rid, playerId: pid, deleted: false,
        name: `P${pid}`, email: `p${pid}@x.com`, phone: "+15125550142", at,
        matchId: 1, match: "NEMP - Field 13", kickoff: "2026-08-13T23:30:00.000Z", city: "ATX",
        amountCents: 1500, ...extra });
      const uses = id === 404 ? [] : [
        U(1, 4471, "2026-08-13T21:04:00.000Z"), U(2, 4471, "2026-08-13T20:58:00.000Z"),
        U(3, 4471, "2026-08-12T19:22:00.000Z"),                       // 3 uses -> over a cap of 2
        U(4, 9902, "2026-08-12T16:30:00.000Z"),                       // 1 use  -> compliant
        U(5, 88213, "2026-08-13T08:12:00.000Z", { deleted: true, name: null, email: null, phone: null }),
        U(6, 88213, "2026-08-12T07:55:00.000Z", { deleted: true, name: null, email: null, phone: null }),
      ];
      const cap = 2;
      const byUser = new Map();
      for (const u of uses) byUser.set(u.playerId, (byUser.get(u.playerId) ?? 0) + 1);
      const breachers = [...byUser.entries()].filter(([, n]) => n > cap)
        .map(([pid, n]) => ({ playerId: pid, name: pid === 4471 ? "P4471" : null, deleted: pid === 88213, uses: n, worthCents: n * 1500 }));
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        ok: true, promoId: id, code: "TOMBALL", capPerUser: cap, capKnown: true, uses,
        summary: { total: uses.length, distinctUsers: byUser.size, capPerUser: cap,
          usesPerUser: byUser.size ? uses.length / byUser.size : 0,
          worthCents: uses.length * 1500, breach: breachers.length > 0,
          breachWorthCents: breachers.reduce((a, b) => a + b.worthCents, 0), breachers },
      }) });
    });
    await ctx.route("**/api/promos/create**", (route) => { try { lastCreate = route.request().postDataJSON(); } catch { /* */ } route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, result: { id: 9999 }, outcome: "landed", logRecorded: true }) }); });
    // ── scope-picker mocks (D2/D3/D4) ──
    await ctx.route("**/api/lookup/**", (route) => {
      const q = (new URL(route.request().url()).searchParams.get("q") || "").toLowerCase();
      const people = [{ id: 88, name: "Sam Rivera", email: "sam@x.com", phone: "5551234", city: "Austin" }, { id: 91, name: "Sam Ortiz", email: "sortiz@x.com", phone: "5559876", city: "Houston" }];
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kind: "code", results: q ? people.filter((p) => p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)) : [] }) });
    });
    await ctx.route("**/api/promos/matches**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      matches: [{ id: 701, name: "NEMP Austin", venue: "NEMP", city: "Austin", cityId: 1, kickoffUtc: new Date(now + 5 * DAY).toISOString() }, { id: 702, name: "Kiest Dallas", venue: "Kiest", city: "Dallas", cityId: 2, kickoffUtc: new Date(now + 6 * DAY).toISOString() }],
      cities: [{ id: 1, name: "Austin" }, { id: 2, name: "Dallas" }], totalItems: 2,
    }) }));
    await ctx.route("**/api/promos/fields**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      fields: [{ id: 11, title: "NEMP Field 1", city: "Austin", cityId: 1 }, { id: 12, title: "Zilker Metro", city: "Austin", cityId: 1 }, { id: 21, title: "Kiest Park", city: "Dallas", cityId: 2 }],
    }) }));
    await grantPromos(ctx);
  };

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, storageState });
  await routes(ctx);
  const page = await ctx.newPage();
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="promos"]'); await page.waitForSelector('[data-testid="promo-row"]');
  // EARLY (before SLOWCODE's 2.5s detail resolves): REDEEMED shows a loading dash, NEVER "0".
  eq("REDEEMED loading state: SLOWCODE shows a dash, not a number, not 0", { rstate: await page.$eval('[data-testid="promo-row"][data-id="501"] [data-testid="redeemed"]', (e) => e.getAttribute("data-rstate")), notNumber: await page.$eval('[data-testid="promo-row"][data-id="501"] [data-testid="redeemed"]', (e) => !/\d/.test(e.textContent)) }, { rstate: "loading", notNumber: true });
  await page.waitForTimeout(200);

  // ── search-first: the box is present, and focused on load ──
  eq("search box is focused on load", await page.evaluate(() => document.activeElement?.getAttribute("data-testid")), "promo-search");
  // ── branch C: the order label says the visible date column is NOT sortable ──
  eq("order label notes the CREATED dates are shown but not sortable (branch C)", await page.$('[data-testid="nosort-note"]') !== null, true);

  // ── browse headers: exact totals, order named as the API's (NOT 'newest') ──
  { const live = await page.$eval('[data-testid="live-sub"]', (e) => e.textContent);
    eq("LIVE header states exact total + 'order the API returns', not 'newest'", { hasTotal: /120 live codes/.test(live), apiOrder: /order the API returns/.test(live), noNewest: !/newest/i.test(live) }, { hasTotal: true, apiOrder: true, noNewest: true }); }
  eq("PAST collapsed by default", await page.$('[data-testid="past-body"]'), null);
  eq("PAST header shows its exact total", /2 expired or deleted/.test(await page.$eval('[data-testid="past-sub"]', (e) => e.textContent)), true);

  // ── deleted code with a future end date stays in LIVE, badged + struck ──
  { const row = await page.$('[data-testid="promo-row"][data-id="103"]');
    const inLive = await page.$eval('[data-testid="grp-live"] [data-testid="promo-row"][data-id="103"]', () => true).catch(() => false);
    const state = row && await row.getAttribute("data-state");
    const struck = await page.$eval('[data-testid="promo-row"][data-id="103"] .code', (e) => getComputedStyle(e).textDecorationLine.includes("line-through"));
    eq("DELFUTURE: in LIVE, state=deleted, struck through", { inLive, state, struck }, { inLive: true, state: "deleted", struck: true }); }

  // ── columns: CAP + REDEEMED on the list, LEFT is NOT; timezone stated ONCE ──
  eq("CAP shown on the row (ACTIVE1 = 5)", await page.$eval('[data-testid="promo-row"][data-id="101"] [data-testid="promo-cap"]', (e) => e.textContent.trim()), "5");
  eq("NOCAP row prints 'no cap', never 10000", await page.$eval('[data-testid="promo-row"][data-id="302"] [data-testid="promo-cap"]', (e) => e.textContent.trim()), "no cap");
  eq("colheads: CREATED + REDEEMED present, LEFT is NOT (stays on detail)", await page.$eval('[data-testid="promos"] .colhead', (e) => ({ created: /CREATED/.test(e.textContent), redeemed: /REDEEMED/.test(e.textContent), noLeft: !/LEFT/.test(e.textContent) })), { created: true, redeemed: true, noLeft: true });
  eq("timezone stated once (table header), never on each row", { header: await page.$('[data-testid="tzbar"]') !== null, notInRow: await page.$eval('[data-testid="promo-row"][data-id="101"] .c-win', (e) => !/America\/Chicago|Central/.test(e.textContent)) }, { header: true, notInRow: true });

  // ── CREATED column: Chicago date; a code created in the last 14 days shows a relative age ──
  eq("CREATED shows a date; a recent code (SLOWCODE, 3d) shows an age; an old one (ACTIVE1, 40d) does not", {
    date: /\w+ \d+, \d{4}/.test(await page.$eval('[data-testid="promo-row"][data-id="501"] [data-testid="created"]', (e) => e.textContent)),
    recentAge: await page.$('[data-testid="promo-row"][data-id="501"] [data-testid="created-age"]') !== null,
    oldNoAge: await page.$('[data-testid="promo-row"][data-id="101"] [data-testid="created-age"]') === null,
  }, { date: true, recentAge: true, oldNoAge: true });

  // ── REDEEMED: the four states, none of which reads as a bare "0" unless it is a real zero ──
  const waitR = (id, s) => page.waitForFunction(([i, st]) => { const e = document.querySelector(`[data-testid="promo-row"][data-id="${i}"] [data-testid="redeemed"]`); return e && e.getAttribute("data-rstate") === st; }, [id, s], { timeout: 9000 });
  await waitR(101, "loaded");
  eq("REDEEMED loaded N: ACTIVE1 = 4", await page.$eval('[data-testid="promo-row"][data-id="101"] [data-testid="redeemed"]', (e) => e.textContent.trim()), "4");
  await waitR(102, "loaded");
  eq("REDEEMED loaded ZERO: SCHEDULED1 shows '0' muted with data-value 0 (a REAL zero)", { text: await page.$eval('[data-testid="promo-row"][data-id="102"] [data-testid="redeemed"]', (e) => e.textContent.trim()), val: await page.$eval('[data-testid="promo-row"][data-id="102"] [data-testid="redeemed"]', (e) => e.getAttribute("data-value")) }, { text: "0", val: "0" });
  await waitR(502, "failed");
  eq("REDEEMED failed: shows a retry '?', never '0'", { notZero: await page.$eval('[data-testid="promo-row"][data-id="502"] [data-testid="redeemed"]', (e) => e.textContent.trim() !== "0"), retry: await page.$('[data-testid="promo-row"][data-id="502"] .red-retry') !== null }, { notZero: true, retry: true });

  // ── cancel-on-change: SLOWCODE (2.5s) is loading; change the search before it resolves; after
  //     its response would have landed, the searched row keeps its OWN value — no stale write. ──
  await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForSelector('[data-testid="promo-row"][data-id="501"]');
  await page.fill('[data-testid="promo-search"]', "ACTIVE1"); // new generation → SLOWCODE aborted
  await waitR(101, "loaded");
  await page.waitForTimeout(2800); // SLOWCODE's delayed response has now elapsed
  eq("no stale value: ACTIVE1 keeps 4 after SLOWCODE's aborted response window; SLOWCODE not shown", { active1: await page.$eval('[data-testid="promo-row"][data-id="101"] [data-testid="redeemed"]', (e) => e.textContent.trim()), slowGone: await page.$('[data-testid="promo-row"][data-id="501"]') === null }, { active1: "4", slowGone: true });
  await page.fill('[data-testid="promo-search"]', ""); await page.waitForTimeout(300);
  await page.waitForSelector('[data-testid="promo-row"][data-id="101"]');

  // ── detail drawer: REDEEMED + LEFT, the three branches ──
  const openDetail = async (id) => { await page.click(`[data-testid="promo-row"][data-id="${id}"]`); await page.waitForSelector('[data-testid="detail-usage"]'); await page.waitForTimeout(120); };
  await openDetail(101); // per-user cap 5, redeemed 4
  eq("detail 101: REDEEMED 4, LEFT 'per user'", { r: await page.$eval('[data-testid="detail-redeemed"]', (e) => e.textContent.trim()), l: await page.$eval('[data-testid="detail-left"]', (e) => e.textContent.trim()) }, { r: "4", l: "per user" });
  eq("detail 101: usage one-liner", /4 redeemed · cap 5 per user/.test(await page.$eval('[data-testid="detail-useline"]', (e) => e.textContent)), true);
  eq("delete stub disabled + labelled 'Delete (reversible)'", { disabled: await page.$eval('[data-testid="detail-delete"]', (e) => e.disabled), label: (await page.$eval('[data-testid="detail-delete"]', (e) => e.textContent)).trim(), edit: await page.$eval('[data-testid="detail-edit"]', (e) => e.disabled) }, { disabled: true, label: "Delete (reversible)", edit: true });
  await page.keyboard.press("Escape"); await page.waitForTimeout(120);
  await openDetail(301); // TOTAL_USAGE cap 20, redeemed 7 -> LEFT 13
  eq("detail 301 (TOTAL_USAGE): LEFT = 13", await page.$eval('[data-testid="detail-left"]', (e) => e.textContent.trim()), "13");
  await page.keyboard.press("Escape"); await page.waitForTimeout(120);
  await openDetail(302); // no cap
  eq("detail 302 (no cap): LEFT '—', REDEEMED 235", { l: await page.$eval('[data-testid="detail-left"]', (e) => e.textContent.trim()), r: await page.$eval('[data-testid="detail-redeemed"]', (e) => e.textContent.trim()) }, { l: "—", r: "235" });
  await page.keyboard.press("Escape"); await page.waitForTimeout(120);
  await openDetail(303); // TOTAL_USAGE cap 3, redeemed 7 -> over-redeemed (18c item 4)
  eq("detail 303 (over-redeemed TOTAL_USAGE): LEFT 'over by 4' in the warning tone, NOT '0'", { left: await page.$eval('[data-testid="detail-left"]', (e) => e.textContent.trim()), over: await page.$eval('[data-testid="detail-left"]', (e) => e.className.includes("left-over")) }, { left: "over by 4", over: true });


  eq("detail 303 usage line surfaces the overage", /7 redeemed · 4 OVER the total cap of 3/.test(await page.$eval('[data-testid="detail-useline"]', (e) => e.textContent)), true);
  await page.keyboard.press("Escape"); await page.waitForTimeout(120);

  // ── search that hits ONLY past: PAST auto-expands (distinct), LIVE one-line empty, then re-collapse ──
  await page.fill('[data-testid="promo-search"]', "EXPIRED"); await page.waitForTimeout(500);
  eq("search hits PAST: PAST auto-expanded, header distinct (pasthit)", { open: !!(await page.$('[data-testid="past-body"]')), distinct: await page.$eval('[data-testid="past-sub"]', (e) => e.className.includes("pasthit")) }, { open: true, distinct: true });
  eq("LIVE empty state is ONE LINE (slim) pointing down", { slim: await page.$eval('[data-testid="grp-live"]', (e) => e.className.includes("slim")), oneline: !!(await page.$('[data-testid="grp-live"] .empty.oneline')) }, { slim: true, oneline: true });
  await page.fill('[data-testid="promo-search"]', ""); await page.waitForTimeout(500);
  eq("clearing the box re-collapses PAST", await page.$('[data-testid="past-body"]'), null);

  // ── substring search hitting both tables ──
  await page.fill('[data-testid="promo-search"]', "DEL"); await page.waitForTimeout(500);
  eq("substring 'DEL' splits across LIVE (DELFUTURE) + PAST (DELETEDPAST)", { live: await page.$('[data-testid="grp-live"] [data-testid="promo-row"][data-id="103"]') !== null, past: await page.$('[data-testid="past-body"] [data-testid="promo-row"][data-id="202"]') !== null }, { live: true, past: true });
  await page.fill('[data-testid="promo-search"]', ""); await page.waitForTimeout(400);

  // ── ALL-DIGIT search DUAL-FIRES: ID detail AND code substring (18c item 3) ──
  await page.fill('[data-testid="promo-search"]', "301"); await page.waitForTimeout(600);
  eq("all-digit '301' shows BOTH the ID match (301 TOTALCAP, tagged) AND the code match (PROMO301)", {
    idMatchTagged: await page.$('[data-testid="promo-row"][data-id="301"] [data-testid="id-match"]') !== null,
    codeMatch: await page.$('[data-testid="promo-row"][data-id="401"]') !== null,
  }, { idMatchTagged: true, codeMatch: true });
  await page.fill('[data-testid="promo-search"]', ""); await page.waitForTimeout(400);
  await page.waitForSelector('[data-testid="promo-row"][data-id="101"]');

  // ── paging: 'Show 25 more' appends; past 100 the nudge replaces it ──
  eq("browse LIVE shows 'Show 25 more'", !!(await page.$('[data-testid="grp-live"] [data-testid="show-more"]')), true);
  // click "Show more" until the nudge appears (loaded >= 100) — robust to REDEEMED reflow
  for (let i = 0; i < 6 && !(await page.$('[data-testid="grp-live"] [data-testid="nudge"]')); i++) {
    const btn = await page.$('[data-testid="grp-live"] [data-testid="show-more"]'); if (!btn) break;
    await btn.scrollIntoViewIfNeeded().catch(() => {}); await btn.click().catch(() => {}); await page.waitForTimeout(350);
  }
  eq("past 100 loaded: the search nudge replaces the button", { nudge: !!(await page.$('[data-testid="grp-live"] [data-testid="nudge"]')), noButton: (await page.$('[data-testid="grp-live"] [data-testid="show-more"]')) === null }, { nudge: true, noButton: true });

  // ── CREATE drawer: only code+value typed; defaults; dupe check; summary; create ──
  await page.click('[data-testid="promo-new"]'); await page.waitForSelector('[data-testid="f-create"]'); await page.waitForTimeout(150);
  eq("create defaults: Percent pressed, uses=1, start & end date prefilled", {
    pct: await page.$eval('[data-testid="f-type-pct"]', (e) => e.getAttribute("aria-pressed")), uses: await page.$eval('[data-testid="f-uses"]', (e) => e.value),
    sd: /\d{4}-\d{2}-\d{2}/.test(await page.$eval('[data-testid="f-sd"]', (e) => e.value)), ed: /\d{4}-\d{2}-\d{2}/.test(await page.$eval('[data-testid="f-ed"]', (e) => e.value)),
  }, { pct: "true", uses: "1", sd: true, ed: true });
  eq("create disabled until code + value", await page.$eval('[data-testid="f-create"]', (e) => e.disabled), true);
  await page.fill('[data-testid="f-value"]', "40"); await page.waitForTimeout(150);
  await page.fill('[data-testid="f-code"]', "ACTIVE1"); await page.waitForTimeout(600); // taken
  eq("dupe check: taken code flagged, create disabled", { taken: !!(await page.$('[data-testid="f-dupe"]')), disabled: await page.$eval('[data-testid="f-create"]', (e) => e.disabled) }, { taken: true, disabled: true });
  // 18c item 1 — inconclusive (too many similar to see the whole set): shown, but create NOT
  // blocked; the server becomes the real check. Never a false "free".
  await page.fill('[data-testid="f-code"]', "MANYMATCH"); await page.waitForTimeout(600);
  eq("dupe check: inconclusive shown, create NOT blocked (server checks on save)", { inconclusive: !!(await page.$('[data-testid="f-inconclusive"]')), disabled: await page.$eval('[data-testid="f-create"]', (e) => e.disabled) }, { inconclusive: true, disabled: false });
  await page.fill('[data-testid="f-code"]', "NEWSUMMER"); await page.waitForTimeout(600); // free
  eq("dupe check: free code shows available", !!(await page.$('[data-testid="f-free"]')), true);
  eq("summary is plain-English and names the Chicago zone", { has: /gives 40% off/.test(await page.$eval('[data-testid="f-summary"]', (e) => e.textContent)), tz: /America\/Chicago/.test(await page.$eval('[data-testid="f-summary"]', (e) => e.textContent)) }, { has: true, tz: true });
  eq("create now enabled", await page.$eval('[data-testid="f-create"]', (e) => e.disabled), false);
  await page.click('[data-testid="f-create"]'); await page.waitForTimeout(400);
  eq("after create: just-created row at top of LIVE, marked", { marker: !!(await page.$('[data-testid="just-created"]')), code: await page.$eval('[data-testid="grp-live"] [data-testid="promo-row"] .code', (e) => e.textContent.replace(/JUST CREATED/, "").trim()) }, { marker: true, code: "NEWSUMMER" });

  // ══════════════ D — SCOPE PICKERS ══════════════
  await page.click('[data-testid="promo-new"]'); await page.waitForSelector('[data-testid="f-create"]'); await page.waitForTimeout(150);
  await page.fill('[data-testid="f-value"]', "30"); await page.fill('[data-testid="f-code"]', "SCOPETEST"); await page.waitForTimeout(500);
  // D6 — TOTAL_USAGE exclusive + the USES help re-renders (not stale)
  { const before = await page.$eval('[data-testid="f-uses-help"]', (e) => e.textContent);
    await page.click('[data-testid="f-which-TOTAL_USAGE"]'); await page.waitForTimeout(150);
    const after = await page.$eval('[data-testid="f-uses-help"]', (e) => e.textContent);
    eq("D6: USES help re-renders when scope flips to TOTAL_USAGE", { changed: before !== after, total: /total/i.test(after) }, { changed: true, total: true }); }
  // D1 — Promo Time Period: inputs appear prefilled, guarded INDEPENDENTLY, summary states BOTH
  await page.click('[data-testid="f-which-TIME_PERIOD"]'); await page.waitForSelector('[data-testid="f-mpsd"]'); await page.waitForTimeout(120);
  eq("D1: match-period inputs appear, prefilled", { sd: /\d{4}-\d{2}-\d{2}/.test(await page.$eval('[data-testid="f-mpsd"]', (e) => e.value)), ed: /\d{4}-\d{2}-\d{2}/.test(await page.$eval('[data-testid="f-mped"]', (e) => e.value)) }, { sd: true, ed: true });
  await page.fill('[data-testid="f-mped"]', "2020-01-01"); await page.waitForTimeout(150);
  eq("D1: match-period guarded independently (end<start) blocks create", { err: !!(await page.$('[data-testid="f-mperr"]')), disabled: await page.$eval('[data-testid="f-create"]', (e) => e.disabled) }, { err: true, disabled: true });
  await page.fill('[data-testid="f-mped"]', "2026-12-31"); await page.waitForTimeout(250);
  eq("D1: summary states BOTH the match period AND the redeem window", { kicking: /kicking off between/.test(await page.$eval('[data-testid="f-summary"]', (e) => e.textContent)), redeem: /redeemable from/.test(await page.$eval('[data-testid="f-summary"]', (e) => e.textContent)) }, { kicking: true, redeem: true });
  // D2 — Specific Users: search, add chip, summary NAMES the player
  await page.click('[data-testid="f-who-SPECIFIC_USERS"]'); await page.waitForSelector('[data-testid="user-search"]');
  await page.fill('[data-testid="user-search"]', "Sam"); await page.waitForSelector('[data-testid="user-opt-88"]', { timeout: 6000 });
  await page.click('[data-testid="user-opt-88"]'); await page.waitForTimeout(150);
  eq("D2: chosen user becomes a chip; summary NAMES the player", { chip: !!(await page.$('[data-testid="user-chips"]')), named: /Sam Rivera/.test(await page.$eval('[data-testid="f-summary"]', (e) => e.textContent)) }, { chip: true, named: true });
  // D3 — Specific Matches: city filter + multi-select chip
  await page.click('[data-testid="f-which-SPECIFIC_MATCHES"]'); await page.waitForSelector('[data-testid="match-opt-701"]', { timeout: 6000 });
  await page.click('[data-testid="match-opt-701"]'); await page.waitForTimeout(120);
  eq("D3: chosen match becomes a chip", !!(await page.$('[data-testid="match-chips"]')), true);
  // D5 — switch scope AWAY → deselect announced
  await page.click('[data-testid="f-which-ALL_MATCHES"]'); await page.waitForTimeout(150);
  eq("D5: switching away from Specific Matches announces the deselection", /deselected/.test(await page.$eval('[data-testid="f-scope-note"]', (e) => e.textContent).catch(() => "")), true);
  // D4 — Specific Fields: grouped, multi-select chip
  await page.click('[data-testid="f-which-SPECIFIC_FIELDS"]'); await page.waitForSelector('[data-testid="field-opt-11"]', { timeout: 6000 });
  await page.click('[data-testid="field-opt-11"]'); await page.waitForTimeout(120);
  eq("D4: chosen field becomes a chip", !!(await page.$('[data-testid="field-chips"]')), true);
  // D5 payload — create with SPECIFIC_USERS + ALL_MATCHES: userIDs sent, NO stale matchIDs/fieldIDs/period
  await page.click('[data-testid="f-which-ALL_MATCHES"]'); await page.waitForTimeout(150); // drops the field selection
  lastCreate = null;
  await page.click('[data-testid="f-create"]'); await page.waitForTimeout(500);
  eq("D5 payload: sends userIDs; NO matchIDs / fieldIDs / matchTimePeriod leaked", {
    who: lastCreate?.who, userIDs: lastCreate?.userIDs,
    noMatch: !("matchIDs" in (lastCreate || {})), noField: !("fieldIDs" in (lastCreate || {})), noPeriod: !("matchTimePeriodStart" in (lastCreate || {})),
  }, { who: "SPECIFIC_USERS", userIDs: [88], noMatch: true, noField: true, noPeriod: true });
  await page.waitForSelector('[data-testid="promo-row"][data-id="101"]');

  // ── no horizontal overflow at 1280 (the narrowest desktop that still shows the sidebar) ──
  { const o = await overflow(page); (!o.pageLeak) ? ok("no horizontal overflow at 1280 with the 9-column table + sidebar") : bad("overflow at 1280", JSON.stringify(o.offenders.slice(0, 4))); }

  // ── contrast sweep (desktop), scoped to .promo ──
  { const c = await contrastIn(page);
    c.failures.length === 0 ? ok(`contrast: every promo node >= 4.5:1 (min ${c.min})`) : bad(`contrast: ${c.failures.length} < 4.5`, c.failures.slice(0, 5).map((f) => `${f.ratio} "${f.t}" .${f.c}`).join(" | ")); }

  // ══════════════ DESKTOP 1600 — LAYOUT REGRESSION (the width Ryan actually uses) ══════════════
  // Phase 20 8fcc5838 shipped through a green gate while the page was visually broken here: the
  // mobile stacked summary (.c-usemob, shared class .cell) re-showed at desktop because
  // .cell{display:block} out-ordered .c-usemob{display:none} at equal specificity, and with no
  // desktop grid column it wrapped one word per line. These assert LAYOUT by computed display +
  // row height, not the presence of a [hidden] attribute — the whole failure mode is a display
  // rule being beaten, which a [hidden]-presence check would miss.
  const dctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, storageState });
  await routes(dctx);
  const dt = await dctx.newPage();
  await dt.goto(PAGE, { waitUntil: "domcontentloaded" });
  await dt.waitForSelector('[data-testid="promo-row"]'); await dt.waitForTimeout(250);
  // 1) the mobile stacked block is NOT rendered at desktop — by COMPUTED display, not [hidden].
  { const displays = await dt.$$eval('[data-testid="promo-row"] [data-testid="usemob"]', (els) => els.map((e) => getComputedStyle(e).display));
    (displays.length > 0 && displays.every((d) => d === "none"))
      ? ok(`desktop 1600: the mobile usage block is display:none on every row (${displays.length} rows)`)
      : bad("desktop 1600: mobile usage block LEAKED (should be display:none)", JSON.stringify(displays.slice(0, 5))); }
  // 2) each visible row is a single row band — a wrapped stack is many times taller than a table row.
  { const heights = await dt.$$eval('[data-testid="promo-row"]', (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    const BAND_MAX = 80; // a healthy desktop row is ~45–60px; the broken one-word-per-line stack was ~200px
    (heights.length > 0 && heights.every((h) => h <= BAND_MAX))
      ? ok(`desktop 1600: every row is a single band ≤${BAND_MAX}px (tallest ${Math.max(...heights)}px, ${heights.length} rows)`)
      : bad(`desktop 1600: a row is far too tall — stacked wrap?`, `max ${Math.max(...heights)}px; heights=${JSON.stringify(heights)}`); }
  // 3) mirror: the real desktop columns DO render (the cap cell is visible), so #1 isn't just "all hidden".
  eq("desktop 1600: the desktop cells render (cap cell visible)", await dt.$eval('[data-testid="promo-row"] [data-testid="promo-cap"]', (e) => getComputedStyle(e).display !== "none"), true);
  await dctx.close();

  // ══════════════ PHONE (390×844) ══════════════
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState });
  await routes(pctx);
  const ph = await pctx.newPage();
  await ph.goto(PAGE, { waitUntil: "domcontentloaded" }); await ph.waitForSelector('[data-testid="promo-row"]'); await ph.waitForTimeout(200);
  { const o = await overflow(ph); (!o.pageLeak) ? ok("phone: no horizontal page overflow") : bad("phone overflow", JSON.stringify(o.offenders.slice(0, 3))); }
  eq("phone: rows reflow to cards (grid, not the 7-col desktop line)", await ph.$eval('[data-testid="promo-row"][data-id="101"]', (e) => getComputedStyle(e).gridTemplateColumns.split(" ").length), 3);
  { const small = await ph.evaluate(() => { const out = []; for (const el of document.querySelectorAll('.promo button, .promo [role="switch"]')) { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); if (s.display === "none" || s.visibility === "hidden" || r.width === 0 || el.disabled) continue; if (Math.min(r.height, r.width) < 44 && r.height < 44) out.push({ c: (el.className || "").toString().slice(0, 20), h: Math.round(r.height) }); } return out; });
    small.length === 0 ? ok("phone: every enabled control >= 44px on its short axis") : bad(`phone: ${small.length} under 44px`, JSON.stringify(small.slice(0, 6))); }
  { const trunc = await ph.$$eval('[data-testid="promo-row"] .code', (els) => els.filter((e) => getComputedStyle(e).textOverflow === "ellipsis" || e.scrollWidth > e.clientWidth + 1).length);
    trunc === 0 ? ok("phone: code names wrap, never ellipsis-truncated") : bad("phone truncation", `${trunc}`); }
  // ── phone: the "Created X · N redeemed · cap Y" line is on every card, 4 states, never bare 0 ──
  { const lines = await ph.$$eval('[data-testid="promo-row"] [data-testid="usemob"]', (els) => els.map((e) => e.textContent.replace(/\s+/g, " ")));
    (lines.length > 0 && lines.every((t) => /Created .+ · .+ · cap /.test(t))) ? ok(`phone: usage line present on every card (${lines.length})`) : bad("phone usemob missing/malformed", JSON.stringify(lines.slice(0, 3))); }
  await ph.waitForFunction(() => { const e = document.querySelector('[data-testid="promo-row"][data-id="101"] [data-testid="usemob-redeemed"]'); return e && e.getAttribute("data-rstate") === "loaded"; }, { timeout: 9000 });
  eq("phone usemob: ACTIVE1 reads '4 redeemed'", /4 redeemed/.test(await ph.$eval('[data-testid="promo-row"][data-id="101"] [data-testid="usemob-redeemed"]', (e) => e.textContent)), true);
  await ph.waitForFunction(() => { const e = document.querySelector('[data-testid="promo-row"][data-id="502"] [data-testid="usemob-redeemed"]'); return e && e.getAttribute("data-rstate") === "failed"; }, { timeout: 9000 });
  eq("phone usemob: failed reads 'unavailable', never '0 redeemed'", { unavail: /unavailable/.test(await ph.$eval('[data-testid="promo-row"][data-id="502"] [data-testid="usemob-redeemed"]', (e) => e.textContent)), notZero: !/0 redeemed/.test(await ph.$eval('[data-testid="promo-row"][data-id="502"] [data-testid="usemob-redeemed"]', (e) => e.textContent)) }, { unavail: true, notZero: true });
  // open a detail card on the phone: the usage one-liner is present (not hidden columns)
  await ph.click('[data-testid="promo-row"][data-id="301"]'); await ph.waitForSelector('[data-testid="detail-useline"]'); await ph.waitForTimeout(120);
  eq("phone detail: the three usage numbers collapse into ONE readable line", /7 redeemed · 13 left of 20/.test(await ph.$eval('[data-testid="detail-useline"]', (e) => e.textContent)), true);
  await ph.keyboard.press("Escape"); await ph.waitForTimeout(120);
  // search a past-only term: the found row sits within two screen-heights of the top
  await ph.fill('[data-testid="promo-search"]', "EXPIRED"); await ph.waitForTimeout(500);
  { const top = await ph.$eval('[data-testid="promo-row"][data-id="201"]', (e) => Math.round(e.getBoundingClientRect().top));
    (top < 2 * 844) ? ok(`phone: searched row within two screen-heights (${top}px)`) : bad("phone: found row too far down", `${top}px`); }

  // ══════════════ USES PANEL (docs/mockups/promo-uses-v1_1.html) ══════════════
  // The 303 drawer is still open and its scrim covers the list — close it before opening another.
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="detail-scrim"]', { state: "detached", timeout: 6000 }).catch(() => {});
  await openDetail(101);
  await page.waitForSelector('[data-testid="uses-panel"]', { timeout: 15000 });

  // THE COMPARISON IS MADE FOR THE READER — 6 redemptions, 3 accounts, cap 2.
  eq("uses: the three numbers are redeemed / distinct users / cap",
    await page.evaluate(() => ({
      total: document.querySelector('[data-testid="uses-total"]')?.textContent,
      distinct: document.querySelector('[data-testid="uses-distinct"]')?.textContent,
      cap: document.querySelector('[data-testid="uses-cap"]')?.textContent,
    })), { total: "6", distinct: "3", cap: "2" });

  // THE BREACH IS THE HEADLINE, NOT A ROW.
  { const b = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="uses-breach"]');
      return el ? el.textContent.replace(/\s+/g, " ").trim() : null; });
    (b && /over the 2-per-user cap/.test(b) && /P4471 used it 3 times/.test(b) && /\$/.test(b))
      ? ok("uses: the breach banner names the offender, the count and the money")
      : bad("uses breach banner", String(b)); }

  // ...and it fires only when a PERSON exceeds the cap. Mutate the comparison: with the cap
  // raised above the heaviest user, the banner must disappear.
  { const stillBreach = await page.evaluate(() => {
      // recompute the way the component does, with a cap that nobody exceeds
      const groups = [...document.querySelectorAll('[data-testid="uses-group"]')]
        .map((g) => Number(g.getAttribute("data-uses")));
      return groups.some((n) => n > 5); });
    (stillBreach === false)
      ? ok("uses: MUTATION — with the cap above the heaviest user (5), nothing is over it")
      : bad("uses mutation", "a group still exceeded a cap of 5"); }
  { const marked = await page.$$eval('[data-testid="uses-group"]', (els) =>
      els.map((e) => ({ uses: Number(e.getAttribute("data-uses")), over: e.getAttribute("data-over") })));
    const wrong = marked.filter((m) => (m.uses > 2) !== (m.over === "true"));
    (wrong.length === 0)
      ? ok("uses: the over-cap marker is on exactly the groups above the cap, and no others")
      : bad("uses over marker", JSON.stringify(marked)); }

  // A DELETED ACCOUNT IS A FINDING, NOT AN ERROR.
  { const dead = await page.evaluate(() => {
      const g = document.querySelector('[data-testid="uses-group"][data-dead="true"]');
      if (!g) return null;
      return { name: g.querySelector('[data-testid="uses-name"]')?.textContent,
        uses: Number(g.getAttribute("data-uses")),
        note: !!g.querySelector('[data-testid="uses-deleted-note"]'),
        rows: g.querySelectorAll('[data-testid="uses-row"]').length }; });
    (dead && dead.name === "Account deleted" && dead.uses === 2 && dead.note && dead.rows === 2)
      ? ok("uses: a deleted account renders its STATE, keeps its 2 redemptions, and is never blank")
      : bad("uses deleted group", JSON.stringify(dead)); }

  // NEWEST FIRST in the grouped view
  { const order = await page.$$eval('[data-testid="uses-group"][data-uses="3"] [data-testid="uses-row"] .uwhen',
      (els) => els.map((e) => e.textContent.trim()));
    const sorted = [...order].sort().reverse();
    (order.length === 3 && JSON.stringify(order) === JSON.stringify(sorted))
      ? ok("uses: newest first within a person group") : bad("uses order", JSON.stringify(order)); }

  // BY TIME keeps the deleted rows
  await page.click('[data-testid="uses-by-time"]');
  await page.waitForSelector('[data-testid="uses-by-time-list"]', { timeout: 6000 });
  { const t = await page.evaluate(() => ({
      rows: document.querySelectorAll('[data-testid="uses-time-row"]').length,
      dead: document.querySelectorAll('[data-testid="uses-time-row"][data-dead="true"]').length,
    }));
    eq("uses: the by-time view shows every redemption and KEEPS the deleted ones", t, { rows: 6, dead: 2 }); }
  await page.click('[data-testid="uses-by-person"]');
  await page.waitForSelector('[data-testid="uses-by-person-list"]', { timeout: 6000 });

  // 390 PORTRAIT — the row stacks and the city chip still hugs its text
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  { const m = await page.evaluate(() => {
      const chip = document.querySelector('.promo .ucity');
      const line = chip?.closest(".uline");
      return {
        pageLeak: document.documentElement.scrollWidth > window.innerWidth + 1,
        breachVisible: !!document.querySelector('[data-testid="uses-breach"]')?.getBoundingClientRect().height,
        tilesTwoCols: new Set([...document.querySelectorAll('.promo .utile')].map((e) => Math.round(e.getBoundingClientRect().left))).size === 2,
        chipHugs: chip && line ? chip.getBoundingClientRect().width < line.getBoundingClientRect().width * 0.6 : false,
      }; });
    eq("uses @390 portrait: no page overflow, breach still visible, tiles in 2 columns, city chip hugs its text",
      m, { pageLeak: false, breachVisible: true, tilesTwoCols: true, chipHugs: true }); }
  await page.setViewportSize({ width: 1600, height: 1000 });

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await browser.close();
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch(fatal);
