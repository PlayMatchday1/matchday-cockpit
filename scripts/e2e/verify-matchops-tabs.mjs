// Phase 24 — Match Ops split into DAILY OPS + BACK OFFICE, in the NAV ONLY.
//
// THE ROUTES DID NOT MOVE. Gate 4 is the one that matters: crossing between the two tabs is an
// ordinary in-layout navigation, so the docked chat and its single realtime subscription survive
// it. If anyone later "tidies" this into two route groups, that gate is what fails.
//   node scripts/e2e/verify-matchops-tabs.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { netRetry, installHarnessGuard, fatal } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

// The expected nav, spelled out here rather than imported — a test that reads the same config the
// page reads would pass no matter how the config changed.
const DAILY = { items: ["gameday", "player-lookup", "promos", "reviews", "match-chats", "player-chats"], groups: ["Operations", "Conversations"] };
const BACK = { items: ["master", "slate-review", "pipeline", "ops", "inventory", "manager-pay", "partner-dashboards", "change-log"], groups: ["Scheduling", "Fields", "People", "System"] };

const NOW = Date.now();
const iso = (minsAgo) => new Date(NOW - minsAgo * 60000).toISOString();
const THREAD = {
  id: "t-1", phone_number: "+13468134860", player_id: 1001, match_ambiguous: false,
  last_message_at: iso(10), last_message_preview: "the 2 charges", last_message_direction: "inbound",
  last_message_is_template: false, created_at: iso(400), assigned_to_user_id: null, assigned_at: null,
  channel: "whatsapp", status: "open", closed_at: null, closed_by_user_id: null, no_reply_needed_at: null,
  player: { id: 1001, first_name: "Fredy", last_name: "Alvarez", preferable_city_normalized: "ATL", is_member: false },
  assignee: null, is_unread: false, is_follow_up: false, waiting_since: null,
};
const M = (id, body) => ({ id, thread_id: "t-1", direction: "inbound", body, sent_at: iso(12), sent_by_user_id: null, channel: "whatsapp", delivery_status: "delivered", media_kind: null, sender: null, signed_media_url: null });
const DETAIL = { "t-1": { thread: THREAD, messages: [M("m1", "the charges didn't go through")], assignee: null, latest_inbound_at: iso(10) } };

async function routes(ctx) {
  // NOTE: rest/v1 is deliberately NOT blanket-stubbed. Stubbing every table to [] feeds these
  // pages shapes they don't expect (Manager Pay does .flatMap on an object it assumes exists) and
  // trips the route error boundary, which then swallows the nav we are actually testing. This suite
  // is about the NAV, not page content, so page data comes from the real DB and only the CRM API
  // (for a deterministic docked thread) and the app_users flags are mocked.
  await ctx.route("**/api/crm/**", (route) => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    const j = (o, s = 200) => route.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(o) });
    if (path.endsWith("/api/crm/threads")) return j({ threads: [THREAD], counts: { open: 1, mine: 0, starred: 0, closed: 0, awaiting: 1 } });
    if (path.endsWith("/api/crm/operators")) return j({ operators: [] });
    if (path.endsWith("/unread-count")) return j({ count: 0 });
    if (path.endsWith("/awaiting-count")) return j({ count: 1 });
    if (/\/api\/crm\/threads\/[^/]+\/context$/.test(path)) return j({ player: null, membership: null, recent_matches: [], upcoming_matches: [], historical_account_count: null });
    if (/\/api\/crm\/threads\/[^/]+\/mark-read$/.test(path) && method === "POST") return j({ ok: true });
    const dm = /\/api\/crm\/threads\/([^/]+)$/.exec(path);
    if (dm && method === "GET") { const d = DETAIL[dm[1]]; return d ? j(d) : j({ error: "not found" }, 404); }
    return j({});
  });
  // app_users must reach the REAL row — a blanket [] bounces to /login?error=not_authorized.
  await ctx.route("**/rest/v1/app_users*", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch(); let b = await res.json().catch(() => null);
    const p = (r) => ({ ...r, is_admin: true, can_access_matchops: true, can_access_chats: true, can_manage_promos: true });
    b = Array.isArray(b) ? b.map(p) : (b && typeof b === "object" ? p(b) : b);
    return route.fulfill({ status: res.status(), contentType: "application/json", body: JSON.stringify(b) });
  });
}

const railKeys = (page) => page.$$eval('[data-testid="rail-item"]', (a) => a.map((e) => e.getAttribute("data-key")));
const railGroups = (page) => page.$$eval('[data-testid="rail-group"]', (a) => a.map((e) => e.getAttribute("data-group")));
const activeTabs = (page) => page.$$eval('[data-testid="topnav-tab"][data-active="true"]', (a) => a.map((e) => e.getAttribute("data-tab")));
const allTabs = (page) => page.$$eval('[data-testid="topnav-tab"]', (a) => a.map((e) => e.getAttribute("data-tab")));

async function go(page, path) {
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="rail-item"]', { timeout: 25000 });
  await page.waitForTimeout(300);
}

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const link = await netRetry(() => svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" }), "generateLink");
  const vv = await netRetry(() => anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token }), "verifyOtp");
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] };

  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, storageState });
    await routes(ctx);
    const page = await ctx.newPage();
    await page.addInitScript(() => { window.__CRM_TEST_REALTIME__ = []; });

    // ── GATE 1 — both tabs render; the right one is active on a route from each section ──
    await go(page, "/match-ops/gameday");
    eq("gate1a: both tabs render and DAILY OPS is active on a Daily Ops route", {
      present: (await allTabs(page)).filter((t) => t === "Daily Ops" || t === "Back Office"),
      active: await activeTabs(page),
    }, { present: ["Daily Ops", "Back Office"], active: ["Daily Ops"] });
    await go(page, "/match-ops/manager-pay");
    eq("gate1b: BACK OFFICE is active on a Back Office route (and only it)", await activeTabs(page), ["Back Office"]);

    // ── GATE 2 — the Daily Ops sidebar is EXACTLY its items, by count ──
    await go(page, "/match-ops/gameday");
    const dKeys = await railKeys(page), dGroups = await railGroups(page);
    eq("gate2: Daily Ops sidebar = exactly its 6 items in 2 groups, and none of Back Office's", {
      count: dKeys.length, keys: dKeys, groups: dGroups,
      backLeaked: dKeys.filter((k) => BACK.items.includes(k)),
    }, { count: DAILY.items.length, keys: DAILY.items, groups: DAILY.groups, backLeaked: [] });

    // ── GATE 3 — the reverse for Back Office ──
    await go(page, "/match-ops/master-schedule");
    const bKeys = await railKeys(page), bGroups = await railGroups(page);
    eq("gate3: Back Office sidebar = exactly its 8 items in 4 groups, and none of Daily Ops's", {
      count: bKeys.length, keys: bKeys, groups: bGroups,
      dailyLeaked: bKeys.filter((k) => DAILY.items.includes(k)),
    }, { count: BACK.items.length, keys: BACK.items, groups: BACK.groups, dailyLeaked: [] });
    // the Partner Dashboard badge still renders, now in Back Office
    eq("gate3b: the Partner Dashboards item still lives in the nav (badge intact), now under Back Office",
      bKeys.includes("partner-dashboards"), true);

    // ── GATE 4 — THE CROSSING TEST ──
    // Dock a thread on a DAILY OPS route, cross to a BACK OFFICE route through the top nav (a real
    // in-app navigation, not a reload), then fire ONE synthetic crm_messages INSERT delivered to
    // EVERY live channel.
    //
    // IF THIS FAILS, SOMEONE SPLIT THE LAYOUT. Two route groups = two layouts = the
    // CrmConversationProvider unmounts on the crossing and its crm-stream-v2 channel is torn down
    // and rebuilt. You will see either 0 new bubbles (subscription died) or 2 (the old channel
    // leaked and both delivered). Put the routes back under one layout — do not "fix" this test.
    await page.addInitScript(() => {
      sessionStorage.setItem("crm:dockedThreadId", "t-1");
      sessionStorage.setItem("crm:dockOpen", "1");
    });
    await go(page, "/match-ops/gameday");
    await page.waitForSelector('[data-testid="dock-root"]', { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('[data-testid="dock-root"]')?.getAttribute("data-guard") === "ready", null, { timeout: 15000 });
    const dockCount = () => page.$$eval('[data-testid="dock-messages"] [data-testid="crm-message"]', (e) => e.length);
    const before = await dockCount();

    // cross tabs via the top nav — client-side navigation inside the SAME layout
    await page.click('[data-testid="topnav-tab"][data-tab="Back Office"]');
    await page.waitForFunction(() => location.pathname.startsWith("/match-ops/master-schedule"), null, { timeout: 15000 });
    await page.waitForTimeout(600);
    eq("gate4a: after crossing, we are on a Back Office route with its sidebar and the dock intact", {
      path: new URL(page.url()).pathname,
      tab: await activeTabs(page),
      railCount: (await railKeys(page)).length,
      dockStillThere: await page.$eval('[data-testid="dock-root"]', (e) => e.getAttribute("data-docked-thread-id")),
    }, { path: "/match-ops/master-schedule", tab: ["Back Office"], railCount: BACK.items.length, dockStillThere: "t-1" });

    const live = await page.evaluate(() => (window.__CRM_TEST_REALTIME__ || []).filter((c) => !c.removed && c.handlers.some((h) => h.filter && h.filter.event === "INSERT" && h.filter.table === "crm_messages")).length);
    const painted = await page.evaluate(() => {
      const chans = (window.__CRM_TEST_REALTIME__ || []).filter((c) => !c.removed && c.handlers.some((h) => h.filter && h.filter.event === "INSERT" && h.filter.table === "crm_messages"));
      const row = { id: "rt-cross-1", thread_id: "t-1", direction: "inbound", body: "CROSSING-RT", sent_at: new Date().toISOString(), channel: "whatsapp", delivery_status: "delivered", media_kind: null, is_auto_reply: false, template_name: null };
      // deliver to EVERY live channel — a leaked second subscription would paint twice
      for (const c of chans) for (const h of c.handlers) if (h.filter && h.filter.event === "INSERT" && h.filter.table === "crm_messages") h.cb({ new: row, eventType: "INSERT" });
      return chans.length;
    });
    await page.waitForTimeout(700);
    eq("gate4b: CROSSING TEST — one INSERT after crossing tabs paints EXACTLY one bubble, on EXACTLY one live subscription (if this fails, the layout was split)",
      { liveSubscriptions: live, deliveredTo: painted, bubbles: await dockCount() },
      { liveSubscriptions: 1, deliveredTo: 1, bubbles: before + 1 });

    // ── GATE 5 — deep link straight into Back Office: right tab, right sidebar, no wrong-section flash ──
    const page2 = await ctx.newPage();
    const wrongFlash = [];
    // sample from first paint: if the Daily sidebar ever renders on this Back Office deep link, the
    // active tab was state rather than derived and we would catch it mid-flight.
    await page2.addInitScript(() => {
      window.__NAV_SAMPLES__ = [];
      const tick = () => {
        const keys = [...document.querySelectorAll('[data-testid="rail-item"]')].map((e) => e.getAttribute("data-key"));
        if (keys.length) window.__NAV_SAMPLES__.push(keys.join(","));
        if (window.__NAV_SAMPLES__.length < 40) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page2.goto(`${BASE}/match-ops/change-log`, { waitUntil: "domcontentloaded" });
    await page2.waitForSelector('[data-testid="rail-item"]', { timeout: 25000 });
    await page2.waitForTimeout(800);
    const samples = await page2.evaluate(() => window.__NAV_SAMPLES__ || []);
    for (const s of new Set(samples)) if (DAILY.items.some((k) => s.split(",").includes(k))) wrongFlash.push(s);
    eq("gate5: a Back Office deep link shows the right tab and sidebar, with no flash of Daily Ops", {
      tab: await activeTabs(page2),
      keys: await railKeys(page2),
      sampledFrames: samples.length > 0,
      wrongSectionFrames: wrongFlash.length,
    }, { tab: ["Back Office"], keys: BACK.items, sampledFrames: true, wrongSectionFrames: 0 });

    await ctx.close();
  } finally {
    await browser.close();
  }

  console.log(`\n${PASS} passed, ${FAIL} failed`);
  if (FAIL) { console.log(fails.map((f) => `  ✗ ${f}`).join("\n")); process.exit(1); }
}

main().catch(fatal);
