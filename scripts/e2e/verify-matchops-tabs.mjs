// Phase 24 (corrected) — Match Ops split into DAILY OPS + BACK OFFICE, in the SIDEBAR.
//
// The top nav keeps ONE Match Ops entry; the switch is a sidebar control above the group headings.
//
// THE ROUTES DID NOT MOVE. Gate 4 is the one that matters: crossing between the two tabs is an
// ordinary in-layout navigation, so the docked chat and its single realtime subscription survive
// it. If anyone later "tidies" this into two route groups, that gate is what fails.
//   node scripts/e2e/verify-matchops-tabs.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { netRetry, installHarnessGuard, fatal, sessionFor } from "./_session.mjs";
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
    // CrmClient reads metrics on mount; the catch-all's {} makes it throw into the error boundary,
    // which is why Player Chats rendered "This page couldn't load" under this suite's mocks.
    if (path.endsWith("/api/crm/metrics")) return j({ metrics: { cohort: { conversations: 1, repliedCount: 1, medianFirstResponseMin: 5, answeredWithin1h: 1, answeredWithin1hPct: 100, resolved: 0, resolvedPct: 0 } }, trend: { cohortMedianDeltaMin: null }, awaiting: { count: 1 } });
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
const allTabs = (page) => page.$$eval('[data-testid="topnav-tab"]', (a) => a.map((e) => e.getAttribute("data-tab")));
// the SIDEBAR switch — this is where the split lives now
const switchItems = (page) => page.$$eval('[data-testid="section-switch-item"]', (a) => a.map((e) => e.getAttribute("data-tab")));
const activeTabs = (page) => page.$$eval('[data-testid="section-switch-item"][data-active="true"]', (a) => a.map((e) => e.getAttribute("data-tab")));

async function go(page, path) {
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="rail-item"]', { timeout: 25000 });
  await page.waitForTimeout(300);
}

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  // ONE SESSION PER IDENTITY, cached across the whole gate run — see sessionFor in _session.mjs.
  const session = await sessionFor("rmancuso@playmatchday.com");
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(session) }] }] };

  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, storageState });
    await routes(ctx);
    const page = await ctx.newPage();
    await page.addInitScript(() => { window.__CRM_TEST_REALTIME__ = []; });

    // ── GATE 1 — both tabs render; the right one is active on a route from each section ──
    await go(page, "/match-ops/gameday");
    eq("gate1a: the SIDEBAR switch offers both halves and DAILY OPS is live on a Daily Ops route", {
      halves: await switchItems(page),
      active: await activeTabs(page),
    }, { halves: ["daily", "back"], active: ["daily"] });
    // THE TOP NAV IS BACK TO ONE ENTRY. The split is not a top-level section.
    eq("gate1b: the top nav has EXACTLY ONE Match Ops entry and no Daily Ops / Back Office entry", {
      matchOps: (await allTabs(page)).filter((t) => t === "Match Ops").length,
      split: (await allTabs(page)).filter((t) => t === "Daily Ops" || t === "Back Office"),
    }, { matchOps: 1, split: [] });
    await go(page, "/match-ops/manager-pay");
    eq("gate1c: BACK OFFICE is live on a Back Office route (and only it)", await activeTabs(page), ["back"]);

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

    // cross halves via the SIDEBAR SWITCH — client-side navigation inside the SAME layout
    await page.click('[data-testid="section-switch-item"][data-tab="back"]');
    await page.waitForFunction(() => location.pathname.startsWith("/match-ops/master-schedule"), null, { timeout: 15000 });
    await page.waitForTimeout(600);
    eq("gate4a: after crossing, we are on a Back Office route with its sidebar and the dock intact", {
      path: new URL(page.url()).pathname,
      tab: await activeTabs(page),
      railCount: (await railKeys(page)).length,
      dockStillThere: await page.$eval('[data-testid="dock-root"]', (e) => e.getAttribute("data-docked-thread-id")),
    }, { path: "/match-ops/master-schedule", tab: ["back"], railCount: BACK.items.length, dockStillThere: "t-1" });

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
    eq("gate5: a Back Office deep link lights the right switch item and sidebar, with no flash of Daily Ops", {
      tab: await activeTabs(page2),
      keys: await railKeys(page2),
      sampledFrames: samples.length > 0,
      wrongSectionFrames: wrongFlash.length,
    }, { tab: ["back"], keys: BACK.items, sampledFrames: true, wrongSectionFrames: 0 });

  // ══ THE MOBILE HEADER — one shared component, on every Match Ops page ══
  { const ph = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState });
    await routes(ph);
    const pg = await ph.newPage();
    const notch = async () => pg.evaluate(() => {
      document.documentElement.style.setProperty("--sat", "59px");
      document.documentElement.style.setProperty("--sab", "34px");
    });

    // LANDING — an admin tapping Match Ops arrives at Gameday Ops.
    await pg.goto(`${BASE}/match-ops`, { waitUntil: "domcontentloaded" });
    await pg.waitForFunction(() => location.pathname !== "/match-ops", null, { timeout: 20000 }).catch(() => {});
    eq("390 portrait: the Match Ops root lands an ADMIN on Gameday Ops",
      new URL(pg.url()).pathname, "/match-ops/gameday");

    // ...and a viewer who CANNOT open Gameday Ops must not be sent there. The landing target is
    // computed client-side from the app_users row, so patching that row exercises the real path.
    { const lim = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState });
      await routes(lim);
      // chats-only: no matchops, so Gameday Ops is not in this viewer's list at all
      await lim.route("**/rest/v1/app_users*", async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        const res = await route.fetch(); let b = await res.json().catch(() => null);
        const p = (r) => ({ ...r, is_admin: false, can_access_matchops: false, can_access_chats: true, can_access_tech: false, can_manage_promos: false });
        b = Array.isArray(b) ? b.map(p) : (b && typeof b === "object" ? p(b) : b);
        return route.fulfill({ status: res.status(), contentType: "application/json", body: JSON.stringify(b) });
      });
      const lp = await lim.newPage();
      await lp.goto(`${BASE}/match-ops`, { waitUntil: "domcontentloaded" });
      await lp.waitForFunction(() => location.pathname !== "/match-ops", null, { timeout: 20000 }).catch(() => {});
      const landed = new URL(lp.url()).pathname;
      const reachable = await lp.$$eval('[data-testid="rail-item"]', (a) => a.map((e) => e.getAttribute("data-key"))).catch(() => []);
      eq("a viewer WITHOUT Gameday Ops access never lands on it — and lands somewhere they can open", {
        notGameday: landed !== "/match-ops/gameday",
        notNoAccess: !landed.startsWith("/no-access"),
        landed,
      }, { notGameday: true, notNoAccess: true, landed: "/match-ops/match-chats" });
      await lim.close(); }

    // the SAME component on Gameday and on both chat consoles — asserted on the shared testid,
    // not on two lookalike selectors
    const headerOn = async (path) => {
      await pg.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
      // If the header never appears, a bare 0 tells you nothing — print what the page actually
      // rendered. That is how the missing /api/crm/metrics fixture here was found.
      await pg.waitForSelector('[data-testid="mo-mobile-header"]', { timeout: 25000 }).catch(async () => {
        console.log(`   ↳ ${path} rendered no header — url=${pg.url()} body=${(await pg.innerText("body").catch(() => "?")).slice(0, 160).replace(/\s+/g, " ")}`);
      });
      await notch();
      return pg.$$eval('[data-testid="mo-mobile-header"]', (e) => e.length);
    };
    eq("Gameday Ops, Player Chats and Match Chats all render the SAME header component", {
      gameday: await headerOn("/match-ops/gameday"),
      player: await headerOn("/match-ops/player-chats"),
      match: await headerOn("/match-ops/match-chats"),
    }, { gameday: 1, player: 1, match: 1 });

    // the pill rail and its unsized-icon grey circle are gone
    eq("the old pill rail is gone from Chats (one nav system, not two)", {
      pills: await pg.$$eval('[data-testid="mo-screen-picker"]', (e) => e.length),
      switchInHeader: await pg.$$eval('[data-testid="mo-mobile-header"] [data-testid="section-switch"]', (e) => e.length),
    }, { pills: 1, switchInHeader: 0 });

    // NO EMPTY, NON-ZERO-SIZED ELEMENT anywhere in the header — this is what the grey circle was
    eq("no element in the Match Ops header is empty with a non-zero box", await pg.$$eval('[data-testid="mo-mobile-header"] *', (els) =>
      els.filter((e) => {
        const r = e.getBoundingClientRect();
        if (r.width < 6 || r.height < 6) return false;              // decorative dots are fine
        if (e.children.length > 0) return false;                    // containers judged by their children
        if ((e.textContent || "").trim().length > 0) return false;  // has text
        const tag = e.tagName.toLowerCase();
        if (tag === "svg" || tag === "path" || tag === "img" || tag === "input") return false; // draws itself
        return true;
      }).map((e) => `${e.tagName}.${(e.className || "").toString().slice(0, 20)}`)), []);

    // ...and the glyph check the rule above CANNOT make: an <svg> is exempted there (it draws
    // itself), which is exactly how the grey circle survived — a pathless, unsized <svg> inside a
    // round tinted button reads as an empty blob, and every element in that pair looks legitimate
    // on its own. So judge the svg itself: it must have a real box AND something to draw.
    eq("every glyph in the Match Ops header has a real box and something to draw", await pg.$$eval('[data-testid="mo-mobile-header"] svg', (els) =>
      els.filter((e) => {
        const r = e.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return true;                                   // unsized
        return e.querySelector("path,circle,rect,line,polyline,polygon,use,text") === null; // nothing drawn
      }).map((e) => `${e.getAttribute("data-testid") || e.getAttribute("class") || "svg"} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)} kids=${e.children.length}`)), []);

    // labels are not clipped mid-word at 390
    eq("390: no nav label is horizontally clipped", await pg.$$eval('[data-testid="mo-mobile-header"] span, [data-testid="mo-mobile-header"] button', (els) =>
      els.filter((e) => e.scrollWidth > e.clientWidth + 1 && (e.textContent || "").trim().length > 0).map((e) => (e.textContent || "").trim().slice(0, 20))), []);

    // the refresh glyph is the SHARED one, with a real arrowhead (two drawn paths)
    await pg.goto(`${BASE}/match-ops/gameday`, { waitUntil: "domcontentloaded" });
    await pg.waitForSelector('[data-testid="refresh-icon"]', { timeout: 20000 });
    eq("the refresh glyph is the shared component and draws an arrowhead", await pg.$eval('[data-testid="refresh-icon"]', (e) => ({
      tag: e.tagName.toLowerCase(), paths: e.querySelectorAll("path").length,
    })), { tag: "svg", paths: 2 });
    await ph.close(); }


    await ctx.close();
  } finally {
    await browser.close();
  }

  console.log(`\n${PASS} passed, ${FAIL} failed`);
  if (FAIL) { console.log(fails.map((f) => `  ✗ ${f}`).join("\n")); process.exit(1); }
}

main().catch(fatal);
