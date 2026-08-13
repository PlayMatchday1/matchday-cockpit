// Phase 23 Step 2 Part B — the match panel wired into Gameday Ops, and the dock COLLISION.
// The old side drawer + "Open full editor" are gone; clicking a tile opens the in-place MatchPanel.
// The CRM chat dock already owns the right edge, so: >=1600 they coexist (panel left of the dock,
// no overlap, no overflow); <1600 opening the panel COLLAPSES the dock to its rail WITHOUT losing the
// thread or the draft, does not auto-reopen on close, and says so once.
//   node scripts/e2e/verify-gday-panel.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { netRetry, installHarnessGuard, fatal } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";
const GAMEDAY = `${BASE}/match-ops/gameday`;
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const NOW = Date.now();
const iso = (msFromNow) => new Date(NOW + msFromNow).toISOString();

// ── one docked chat thread (whatsapp, recent inbound so the composer is live) ──
const THREAD = {
  id: "t-1", phone_number: "+13468134860", player_id: 1001, match_ambiguous: false,
  last_message_at: iso(-10 * 60000), last_message_preview: "the 2 charges", last_message_direction: "inbound",
  last_message_is_template: false, created_at: iso(-4000 * 60000), assigned_to_user_id: null, assigned_at: null,
  channel: "whatsapp", status: "open", closed_at: null, closed_by_user_id: null, no_reply_needed_at: null,
  player: { id: 1001, first_name: "Fredy", last_name: "Alvarez", preferable_city_normalized: "ATL", is_member: false },
  assignee: null, is_unread: false, is_follow_up: false, waiting_since: null,
};
const M = (o) => ({ id: o.id, thread_id: "t-1", direction: o.dir, body: o.body, sent_at: o.at, sent_by_user_id: o.dir === "outbound" ? "op-1" : null, channel: "whatsapp", delivery_status: o.dir === "outbound" ? "sent" : "delivered", media_kind: null, sender: null, signed_media_url: null });
const DETAIL = { "t-1": { thread: THREAD, messages: [M({ id: "m1", dir: "inbound", body: "the charges didn't go through", at: iso(-12 * 60000) })], assignee: null, latest_inbound_at: iso(-10 * 60000) } };
const COUNTS = { open: 1, mine: 0, starred: 0, closed: 0, awaiting: 1 };

// ── one upcoming board match (id 501) so a tile renders in the "todo" band ──
const boardMatch = () => [{
  id: 501, name: "PRUMC Tuesday", isCancelled: false, autoCanceledMinutes: 75, minPlayerCount: 10, maxPlayerCount: 20,
  registrationPrice: 1200, additionalSpotPrice: 400, fakeSpotLeft36h: 0, fakeSpotLeft24h: 0, fakeSpotLeft12h: 0, fakeSpotLeft6h: 0, fakeSpotLeft3h: 0,
  isAutoBump: false, category: "OPEN", type: "REGULAR", _count: { players: 6, fakePlayers: 0 }, manager: { firstName: "Troy", lastName: "" },
  teams: [{ teamNumber: 1 }, { teamNumber: 2 }], startDate: "2026-08-12T19:00:00.000", startDateUtc: iso(2 * 3600000),
  field: { title: "PRUMC", city: { id: 5, name: "Atlanta", timeZone: { abbr: "EDT" } } },
}];

const grantChats = (ctx) => ctx.route("**/rest/v1/app_users*", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  const res = await route.fetch(); let j = await res.json().catch(() => null);
  const p = (r) => ({ ...r, is_admin: true, can_access_matchops: true, can_edit_matches: true, can_access_chats: true, can_send_messages: true });
  j = Array.isArray(j) ? j.map(p) : (j && typeof j === "object" ? p(j) : j);
  return route.fulfill({ status: res.status(), contentType: "application/json", body: JSON.stringify(j) });
});

async function routes(ctx) {
  await ctx.route("**/rest/v1/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await ctx.route("**/api/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await ctx.route("**/api/matchday/**/gameday**", (route) => {
    const date = new URL(route.request().url()).searchParams.get("date");
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ date, env: "production", matches: boardMatch() }) });
  });
  await ctx.route("**/api/veo**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ matches: [] }) }));
  await ctx.route(/\/api\/matchday\/production\/matches\/\d+(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ match: { id: 501, name: "PRUMC Tuesday", type: "REGULAR", managerId: null, secondManagerId: null, fieldId: 1, startDate: "2026-08-12T19:00:00.000Z", endDate: "2026-08-12T20:00:00.000Z", registrationPrice: 1200, additionalSpotPrice: null, guestCount: 0, isFreeMember: false, maxPlayerCount: 20, fakeSpotLeft36h: 0, fakeSpotLeft24h: 0, fakeSpotLeft12h: 0, fakeSpotLeft6h: 0, fakeSpotLeft3h: 0, autoCanceled: false, autoCanceledMinutes: 75, minPlayerCount: 10, isAutoBump: false, maxTeamSize2Team: 20, maxTeamSize4Team: 40, description: "", managerIntro: "", teams: [{ teamNumber: 1 }, { teamNumber: 2 }], occupancy: 0, realOccupancy: 0, cityName: "Atlanta", fieldTitle: "PRUMC" }, fields: [], players: [], managers: [] }) }));
  await ctx.route(/\/api\/matchday\/production\/roster\/\d+(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ matchId: 501, name: "PRUMC Tuesday", teams: [{ id: 1, teamNumber: 1, name: "Green", locked: false }, { id: 2, teamNumber: 2, name: "Blue", locked: false }], players: [], shape: { teamN: 2, perTeam: 10 }, maxPlayerCount: 20, occupancy: 0 }) }));
  await ctx.route("**/api/crm/**", (route) => {
    const path = new URL(route.request().url()).pathname; const method = route.request().method();
    const json = (o, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(o) });
    if (path.endsWith("/api/crm/threads")) return json({ threads: [THREAD], counts: COUNTS });
    if (path.endsWith("/api/crm/operators")) return json({ operators: [] });
    if (path.endsWith("/unread-count")) return json({ count: 0 });
    if (path.endsWith("/awaiting-count")) return json({ count: COUNTS.awaiting });
    if (/\/api\/crm\/threads\/[^/]+\/context$/.test(path)) return json({ player: null, membership: null, recent_matches: [], upcoming_matches: [], historical_account_count: null });
    if (/\/api\/crm\/threads\/[^/]+\/mark-read$/.test(path) && method === "POST") return json({ ok: true });
    const dm = /\/api\/crm\/threads\/([^/]+)$/.exec(path);
    if (dm && method === "GET") { const d = DETAIL[dm[1]]; return d ? json(d) : json({ error: "not found" }, 404); }
    return json({});
  });
  await grantChats(ctx);
}

const has = (page, sel) => page.$(sel).then((e) => e !== null);
const DTA = '[data-testid="dock-root"] [data-testid="crm-composer"]';

// seed the dock via the sessionStorage restore path, then load Gameday so the layout's provider
// rehydrates the docked thread + draft.
async function openGamedayWithDock(page, draft) {
  await page.addInitScript(({ draft }) => {
    sessionStorage.setItem("crm:dockedThreadId", "t-1");
    sessionStorage.setItem("crm:dockOpen", "1");
    if (draft != null) sessionStorage.setItem("crm:draft", JSON.stringify({ threadId: "t-1", text: draft }));
  }, { draft: draft ?? null });
  await page.goto(GAMEDAY, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="snap-group-todo"]', { timeout: 20000 });
  await page.waitForSelector('[data-testid="dock-root"]', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="dock-root"]')?.getAttribute("data-guard") === "ready", null, { timeout: 15000 });
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

  // ══════════════ <1600 (1180): opening the panel COLLAPSES the dock; thread + draft survive ══════════════
  { const ctx = await browser.newContext({ viewport: { width: 1180, height: 900 }, storageState });
    await routes(ctx);
    const page = await ctx.newPage();
    await openGamedayWithDock(page, "my unsent draft");
    // the dock is expanded and carries the seeded draft
    eq("setup: dock expanded on Gameday with the docked thread + seeded draft", {
      docked: await page.$eval('[data-testid="dock-root"]', (e) => e.getAttribute("data-docked-thread-id")),
      expanded: await has(page, '[data-testid="dock-messages"]'),
      draft: await page.$eval(DTA, (e) => e.value),
    }, { docked: "t-1", expanded: true, draft: "my unsent draft" });

    // open the panel by clicking the tile
    await page.click('[data-testid="snap-row"][data-id="501"]');
    await page.waitForSelector('[data-testid="gday-panel"]', { timeout: 8000 });
    await page.waitForTimeout(250);
    // GATE — the dock collapsed to its rail; panel body no longer present; a one-time line said so
    eq("gate4a: opening the panel <1600 collapses the dock to its rail (panel gone, rail shown) and says so once", {
      panel: await has(page, '[data-testid="gday-panel"]'),
      dockMsgs: await has(page, '[data-testid="dock-messages"]'),
      rail: await has(page, '[data-testid="dock-rail"]'),
      notice: await has(page, '[data-testid="gday-dock-notice"]'),
    }, { panel: true, dockMsgs: false, rail: true, notice: true });
    // the thread + draft were NOT destroyed — still in sessionStorage
    eq("gate4b: the docked thread + draft are preserved through the collapse (nothing undocked/lost)", await page.evaluate(() => ({
      thread: sessionStorage.getItem("crm:dockedThreadId"),
      draft: JSON.parse(sessionStorage.getItem("crm:draft") || "{}").text,
    })), { thread: "t-1", draft: "my unsent draft" });

    // close the panel — the dock does NOT auto-reopen (operator's choice)
    await page.click('[data-testid="gday-panel-close"]');
    await page.waitForTimeout(250);
    eq("gate4c: closing the panel does NOT auto-reopen the dock (rail still, no panel)", {
      dockMsgs: await has(page, '[data-testid="dock-messages"]'), rail: await has(page, '[data-testid="dock-rail"]'),
    }, { dockMsgs: false, rail: true });

    // reopen the dock from the rail — same thread, same draft
    await page.click('[data-testid="dock-rail"]');
    await page.waitForSelector('[data-testid="dock-messages"]', { timeout: 8000 });
    await page.waitForSelector(DTA, { timeout: 8000 });
    eq("gate4d: reopening the dock restores the SAME thread and the SAME draft", {
      docked: await page.$eval('[data-testid="dock-root"]', (e) => e.getAttribute("data-docked-thread-id")),
      draft: await page.$eval(DTA, (e) => e.value),
    }, { docked: "t-1", draft: "my unsent draft" });
    await ctx.close();
  }

  // ══════════════ >=1600: the panel and the dock COEXIST — no overlap, no overflow ══════════════
  { const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, storageState });
    await routes(ctx);
    const page = await ctx.newPage();
    await openGamedayWithDock(page, "keep me");
    await page.click('[data-testid="snap-row"][data-id="501"]');
    await page.waitForSelector('[data-testid="gday-panel"]', { timeout: 8000 });
    await page.waitForTimeout(300);
    // dock stays expanded (NOT collapsed) at >=1600
    eq("gate5a: at >=1600 the dock stays open alongside the panel (no forced collapse)", {
      panel: await has(page, '[data-testid="gday-panel"]'), dockMsgs: await has(page, '[data-testid="dock-messages"]'),
    }, { panel: true, dockMsgs: true });
    // no overlap and no horizontal page overflow
    const geo = await page.evaluate(() => {
      const p = document.querySelector('[data-testid="gday-panel"]').getBoundingClientRect();
      const d = document.querySelector('[data-testid="dock-root"]').getBoundingClientRect();
      return { noOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1, panelLeftOfDock: Math.round(p.right) <= Math.round(d.left) + 1, panelFits: p.right <= window.innerWidth + 1, dockFits: d.right <= window.innerWidth + 1 };
    });
    eq("gate5b: panel sits left of the dock, both fit, no horizontal overflow", geo, { noOverflow: true, panelLeftOfDock: true, panelFits: true, dockFits: true });
    await ctx.close();
  }

  // ══════════════ the standalone roster route is gone (404) — no live link points at it ══════════════
  { const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState });
    await routes(ctx);
    const page = await ctx.newPage();
    const resp = await page.goto(`${BASE}/match-ops/matches/501/roster`, { waitUntil: "domcontentloaded" }).catch(() => null);
    eq("gate3: the deleted roster route returns 404", resp ? resp.status() : "no-response", 404);
    await ctx.close();
  }

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await browser.close();
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch(fatal);
