// Phase 19 Step 3a — RUNTIME suite for the DOCKED player chat (read-only shell). The dock is state
// in the CRM provider (crmConversation) rendered by match-ops/layout on every Match Ops screen
// EXCEPT Player Chats itself. It drives the real app: pin a thread on Player Chats, then leave for
// Player Lookup and assert the docked conversation follows — identity banner, mismatch banner,
// dedup-safe realtime, collapse↔rail, switcher, sessionStorage restore (incl. a dead thread), the
// "Reply in Player Chats" hand-off, and no horizontal overflow at four widths.
//   node scripts/e2e/verify-crm-dock.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const BASE = process.env.BASE || "http://localhost:3000";
const CHATS = `${BASE}/match-ops/player-chats`;
const LOOKUP = `${BASE}/match-ops/player-lookup`;
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const NOW = Date.now();
const iso = (minAgo) => new Date(NOW - minAgo * 60000).toISOString();

const baseThread = (o) => ({
  id: o.id, phone_number: o.phone, player_id: o.pid ?? null, match_ambiguous: false,
  last_message_at: o.lastAt, last_message_preview: o.preview, last_message_direction: "inbound",
  last_message_is_template: false, created_at: iso(4000), assigned_to_user_id: null, assigned_at: null,
  channel: o.channel, status: "open", closed_at: null, closed_by_user_id: null, no_reply_needed_at: null,
  player: o.player, assignee: null, is_unread: o.unread ?? false, is_follow_up: false, waiting_since: null,
});
const P_FREDY = { id: 1001, first_name: "Fredy", last_name: "Alvarez", preferable_city_normalized: "HOU", is_member: false };
const P_MARCO = { id: 1002, first_name: "Marco", last_name: "Ruiz", preferable_city_normalized: "ATX", is_member: true };
const THREADS = [
  baseThread({ id: "t-fredy", phone: "+13468134860", pid: 1001, player: P_FREDY, channel: "whatsapp", lastAt: iso(10), preview: "the 2 $38 charges", unread: true }),
  baseThread({ id: "t-marco", phone: "+15124409921", pid: 1002, player: P_MARCO, channel: "whatsapp", lastAt: iso(30), preview: "is my son allowed" }),
];
const msg = (o) => ({ id: o.id, thread_id: o.tid, direction: o.dir, body: o.body, sent_at: o.at, sent_by_user_id: o.dir === "outbound" ? "op-1" : null, channel: o.channel ?? "whatsapp", delivery_status: o.dir === "outbound" ? "sent" : "delivered", media_kind: null, sender: null, signed_media_url: null });
const DETAIL = {
  "t-fredy": { thread: THREADS[0], messages: [msg({ id: "f1", tid: "t-fredy", dir: "inbound", body: "the charges didnt go through", at: iso(20) }), msg({ id: "f2", tid: "t-fredy", dir: "inbound", body: "theyre pending", at: iso(15) }), msg({ id: "f3", tid: "t-fredy", dir: "outbound", body: "let me check", at: iso(5) })], assignee: null, latest_inbound_at: iso(10) },
  "t-marco": { thread: THREADS[1], messages: [msg({ id: "mo1", tid: "t-marco", dir: "inbound", body: "is my son allowed to sub in", at: iso(30) })], assignee: null, latest_inbound_at: iso(30) },
};
const COUNTS = { open: 2, mine: 0, starred: 0, closed: 0, awaiting: 2 };

// A second player, loaded via Player Lookup, so its subject (id 2002) mismatches the docked thread.
const OTHER_PID = 2002;
const otherProfile = (id) => ({
  player: { id, name: "Priya Nayar", email: null, phone: null, phoneVerified: false, city: null, level: null, registered: null, goals: 0, cityManager: false, credits: 0, status: "ok", banReason: null, bannedAt: null, banExpiredAt: null, matchesPlayed: 0, upcoming: 0 },
  membership: null, matches: [], strikes: { activeCount: 0, limit: 3, isSuspended: false, suspendedTo: null, expiredAt: null, firstStrikeAt: null, logs: [] }, accountHistory: [],
});

const grantChats = (ctx) => ctx.route("**/rest/v1/app_users*", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  const res = await route.fetch(); let j = await res.json().catch(() => null);
  const p = (r) => ({ ...r, is_admin: true, can_access_chats: true, can_access_matchops: true, can_send_messages: true });
  j = Array.isArray(j) ? j.map(p) : (j && typeof j === "object" ? p(j) : j);
  return route.fulfill({ status: res.status(), contentType: "application/json", body: JSON.stringify(j) });
});

async function routes(ctx) {
  await ctx.route("**/api/crm/**", (route) => {
    const url = new URL(route.request().url()); const path = url.pathname; const method = route.request().method();
    const json = (o, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(o) });
    if (path.endsWith("/unread-count")) return json({ count: 2 });
    if (path.endsWith("/awaiting-count")) return json({ count: COUNTS.awaiting });
    if (path.endsWith("/api/crm/threads")) return json({ threads: THREADS, counts: COUNTS });
    if (path.endsWith("/api/crm/operators")) return json({ operators: [] });
    if (path.endsWith("/api/crm/metrics")) return json({ metrics: { cohort: { conversations: COUNTS.open, repliedCount: 2, medianFirstResponseMin: 12, answeredWithin1h: 2, answeredWithin1hPct: 100, resolved: 1, resolvedPct: 33 } }, trend: { cohortMedianDeltaMin: null }, awaiting: { count: COUNTS.awaiting } });
    if (/\/api\/crm\/threads\/[^/]+\/mark-read$/.test(path) && method === "POST") return json({ ok: true });
    if (/\/api\/crm\/threads\/[^/]+\/context$/.test(path)) return json({ player: null, membership: null, recent_matches: [], upcoming_matches: [], historical_account_count: null });
    const dm = /\/api\/crm\/threads\/([^/]+)$/.exec(path);
    if (dm && method === "GET") { const d = DETAIL[dm[1]]; return d ? json(d) : json({ error: "not found" }, 404); }
    return json({});
  });
  // Player Lookup reads — search returns one row; ?id= returns a profile for the mismatch subject.
  await ctx.route("**/api/lookup/**", (route) => {
    const url = new URL(route.request().url());
    const json = (o, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(o) });
    const id = url.searchParams.get("id");
    if (id) return json(otherProfile(Number(id)));
    if (url.pathname.includes("/payments")) return json({ charges: [] });
    return json({ results: [{ id: OTHER_PID, name: "Priya Nayar", email: null, phone: null, city: null, status: "ok", hasMembership: false }] });
  });
  await ctx.route("**/api/matchday/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) }));
  await grantChats(ctx);
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
  await page.addInitScript(() => { window.__CRM_TEST_REALTIME__ = []; });

  const has = async (sel) => (await page.$(sel)) !== null;
  const dockMsgCount = () => page.$$eval('[data-testid="dock-messages"] [data-testid="crm-message"]', (e) => e.length);
  const bannerAName = () => page.$eval('[data-testid="dock-banner-a"]', (e) => e.querySelector('[data-testid="dock-switcher"]')?.textContent?.trim() ?? e.textContent.trim());
  const dockedId = () => page.$eval('[data-testid="dock-root"]', (e) => e.getAttribute("data-docked-thread-id"));
  const selectThread = async (id, expected) => {
    await page.click(`[data-testid="crm-thread-row"][data-thread-id="${id}"]`);
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="crm-message"]').length === n, expected, { timeout: 8000 });
  };
  const fireRealtime = (event, table, newRow) => page.evaluate(({ event, table, newRow }) => {
    const rec = (window.__CRM_TEST_REALTIME__ || []).find((c) => c.handlers.some((h) => h.filter && h.filter.event === event && h.filter.table === table));
    const h = rec && rec.handlers.find((x) => x.filter && x.filter.event === event && x.filter.table === table);
    if (!h) return false;
    h.cb({ new: newRow, eventType: event });
    return true;
  }, { event, table, newRow });

  // ── pin a thread on Player Chats (where the dock itself is hidden) ──
  await page.goto(CHATS, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="crm-thread-row"]', { timeout: 30000 });
  await selectThread("t-fredy", 3);        // load fredy into the map (for the switcher later)
  await selectThread("t-marco", 1);        // then marco → it is the open conversation
  await page.click('[data-testid="dock-pin-current"]');
  await page.waitForTimeout(150);
  eq("pinning shows the DOCKED pill in the conversation header", await page.$eval('[data-testid="dock-pin-current"]', (e) => e.getAttribute("data-docked")), "1");
  eq("the dock is NOT rendered on Player Chats itself (full inbox is there)", await has('[data-testid="dock-root"]'), false);

  // ── leave for Player Lookup via client-side nav — the provider (and map) survive ──
  await page.locator('a[href="/match-ops/player-lookup"]').first().click();
  await page.waitForSelector('[data-testid="dock-root"]', { timeout: 15000 });
  eq("the docked chat follows onto Player Lookup (guard=ready)", await page.$eval('[data-testid="dock-root"]', (e) => e.getAttribute("data-guard")), "ready");
  eq("it is the pinned thread (t-marco)", await dockedId(), "t-marco");
  { const n = await bannerAName(); (/Marco Ruiz/.test(n)) ? ok("Banner A attributes the chat to the docked player (Marco Ruiz)") : bad("Banner A name", n); }

  // ── channel leak: the dock adds NO second subscription on crm_messages ──
  { const names = await page.evaluate(() => Array.from(new Set((window.__CRM_TEST_REALTIME__ || []).filter((c) => c.handlers.some((h) => h.filter && h.filter.event === "INSERT" && h.filter.table === "crm_messages")).map((c) => c.name))));
    eq("exactly ONE crm_messages subscription identity with the dock mounted (no channel leak)", names.length, 1); }

  // ── no Banner B until the screen has a (different) subject ──
  eq("no mismatch banner when the screen has no player subject", await has('[data-testid="dock-banner-b"]'), false);

  // ── dedup-safe realtime into the docked (non-selected) conversation ──
  { const before = await dockMsgCount();
    await fireRealtime("INSERT", "crm_messages", { id: "rt-marco-1", thread_id: "t-marco", direction: "inbound", body: "DOCK-RT-1", sent_at: new Date().toISOString(), channel: "whatsapp", delivery_status: "delivered", media_kind: null, is_auto_reply: false, template_name: null });
    await page.waitForTimeout(200);
    const after = await dockMsgCount();
    eq("a realtime INSERT paints into the DOCKED conversation exactly once", after, before + 1); }
  { const before = await dockMsgCount();
    await fireRealtime("INSERT", "crm_messages", { id: "rt-marco-1", thread_id: "t-marco", direction: "inbound", body: "DOCK-RT-1", sent_at: new Date().toISOString(), channel: "whatsapp", delivery_status: "delivered", media_kind: null, is_auto_reply: false, template_name: null });
    await page.waitForTimeout(200);
    eq("re-delivering the SAME message id does NOT double-append (dedup on id)", await dockMsgCount(), before); }

  // ── a crm_threads UPDATE patches the docked Banner A (historical caveat) ──
  await fireRealtime("UPDATE", "crm_threads", { id: "t-marco", last_message_at: new Date().toISOString(), last_message_preview: "x", match_ambiguous: true, player_id: 1002, assigned_to_user_id: null, assigned_at: null, status: "open", closed_at: null, closed_by_user_id: null, no_reply_needed_at: null });
  await page.waitForTimeout(200);
  eq("a crm_threads UPDATE reaches the docked header (historical caveat appears)", await has('[data-testid="dock-historical"]'), true);

  // ── collapse ↔ rail ──
  await page.click('[data-testid="dock-collapse"]');
  await page.waitForTimeout(150);
  eq("collapsing hides the panel and shows the right-edge rail", { rail: await has('[data-testid="dock-rail"]'), msgs: await has('[data-testid="dock-messages"]') }, { rail: true, msgs: false });
  await page.click('[data-testid="dock-rail"]');
  await page.waitForTimeout(150);
  eq("re-opening from the rail restores the panel", await has('[data-testid="dock-messages"]'), true);

  // ── switcher: swap the dock to the other conversation held in the map (fredy) ──
  await page.click('[data-testid="dock-switcher"]');
  await page.waitForSelector('[data-testid="dock-switch-t-fredy"]', { timeout: 4000 });
  await page.click('[data-testid="dock-switch-t-fredy"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="dock-root"]')?.getAttribute("data-docked-thread-id") === "t-fredy", null, { timeout: 8000 });
  { const n = await bannerAName(); (/Fredy Alvarez/.test(n)) ? ok("the switcher swaps the docked conversation (→ Fredy)") : bad("switcher", n); }

  // ── Banner B: load a DIFFERENT player on the screen; the mismatch warning fires ──
  await page.fill('input[placeholder="Phone, email, name or player ID"]', String(OTHER_PID));
  await page.waitForTimeout(400);
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="dock-banner-b"]', { timeout: 8000 });
  { const txt = await page.$eval('[data-testid="dock-banner-b"]', (e) => e.textContent);
    const mm = await page.$eval('[data-testid="dock-root"]', (e) => e.getAttribute("data-mismatch"));
    (mm === "1" && /Priya Nayar/.test(txt) && /Fredy/.test(txt)) ? ok("Banner B warns when the screen subject differs from the docked player") : bad("Banner B", `mismatch=${mm} txt=${txt.slice(0, 80)}`); }

  // ── Banner B clears when the subject clears ──
  await page.click('[data-testid="lookup-back"]');
  await page.waitForTimeout(300);
  eq("clearing the screen subject clears Banner B", await has('[data-testid="dock-banner-b"]'), false);

  // ── no horizontal overflow: the dock fits inside four viewport widths ──
  for (const w of [1600, 1180, 900, 390]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(150);
    const fits = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="dock-root"], [data-testid="dock-rail"], [data-testid="dock-bubble"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.right <= window.innerWidth + 1 && r.left >= -1;
    });
    eq(`dock fits within the viewport at ${w}px (no horizontal overflow)`, fits, true);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });

  // ── "Reply in Player Chats" hands off to the full pane (and the dock hides there) ──
  await page.waitForTimeout(150);
  await page.click('[data-testid="dock-reply"]');
  await page.waitForURL(/\/match-ops\/player-chats\?threadId=t-fredy\b/, { timeout: 10000 });
  await page.waitForTimeout(300);
  eq("Reply in Player Chats opens the thread in the full pane and hides the dock", { url: /threadId=t-fredy/.test(page.url()), dock: await has('[data-testid="dock-root"]') }, { url: true, dock: false });

  // ── sessionStorage round-trip: a hard reload of another screen restores the dock ──
  await page.goto(LOOKUP, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="dock-root"]', { timeout: 15000 });
  eq("a hard reload restores the docked chat from sessionStorage", await dockedId(), "t-fredy");

  // ── a DEAD docked thread (detail 404s) clears silently on restore ──
  await page.evaluate(() => sessionStorage.setItem("crm:dockedThreadId", "t-ghost"));
  await page.goto(LOOKUP, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  { const dockShown = await has('[data-testid="dock-root"]');
    const cleared = await page.evaluate(() => sessionStorage.getItem("crm:dockedThreadId"));
    (!dockShown && cleared === null) ? ok("a dead docked thread (404) clears silently on restore — no broken panel") : bad("dead-thread restore", `dockShown=${dockShown} stored=${cleared}`); }

  // ── useDockSubject is inert with nothing docked: a subject alone renders no dock ──
  await page.fill('input[placeholder="Phone, email, name or player ID"]', String(OTHER_PID));
  await page.waitForTimeout(400);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  eq("useDockSubject is inert when nothing is docked (subject sets no dock UI)", await has('[data-testid="dock-root"]'), false);

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await browser.close();
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
