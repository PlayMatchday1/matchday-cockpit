// Phase 19 Step 3a — RUNTIME suite for the DOCKED player chat (read-only shell). The dock is state
// in the CRM provider (crmConversation) rendered by match-ops/layout on every Match Ops screen
// EXCEPT Player Chats itself. It drives the real app: pin a thread on Player Chats, then leave for
// Player Lookup and assert the docked conversation follows.
//
// PROCESS (adopted this commit): when an assertion implements a check from a written spec, the SPEC
// ITEM is in the message ("gate N: …") — a weaker implementation then reads as weaker in the
// output instead of just reading as green. 23/0 once looked like it covered the spec and didn't.
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
  id: o.id, phone_number: o.phone, player_id: o.pid ?? null, match_ambiguous: o.amb ?? false,
  last_message_at: o.lastAt, last_message_preview: o.preview, last_message_direction: "inbound",
  last_message_is_template: false, created_at: iso(4000), assigned_to_user_id: null, assigned_at: null,
  channel: o.channel, status: "open", closed_at: null, closed_by_user_id: null, no_reply_needed_at: null,
  player: o.player, assignee: null, is_unread: o.unread ?? false, is_follow_up: false, waiting_since: null,
});
const P_FREDY = { id: 1001, first_name: "Fredy", last_name: "Alvarez", preferable_city_normalized: "HOU", is_member: false };
const P_MARCO = { id: 1002, first_name: "Marco", last_name: "Ruiz", preferable_city_normalized: "ATX", is_member: true };
const P_SOON = { id: 1004, first_name: "Sana", last_name: "Iqbal", preferable_city_normalized: "DAL", is_member: false };
const P_SMS = { id: 1005, first_name: "Tomas", last_name: "Reyes", preferable_city_normalized: "HOU", is_member: false };
const P_FAILED = { id: 1006, first_name: "Wendy", last_name: "Cho", preferable_city_normalized: "ATX", is_member: true };
const P_EXP = { id: 1007, first_name: "Yusuf", last_name: "Diallo", preferable_city_normalized: "DAL", is_member: false };
const THREADS = [
  baseThread({ id: "t-fredy", phone: "+13468134860", pid: 1001, player: P_FREDY, channel: "whatsapp", lastAt: iso(10), preview: "the 2 $38 charges", unread: true }),
  baseThread({ id: "t-marco", phone: "+15124409921", pid: 1002, player: P_MARCO, channel: "whatsapp", lastAt: iso(30), preview: "is my son allowed" }),
  // Unlinked: no player account attached to this number (item 1).
  baseThread({ id: "t-unlinked", phone: "+13105550137", pid: null, player: null, channel: "whatsapp", lastAt: iso(50), preview: "who is this" }),
  // Window fixtures (Step 3b) — all unread:false so the switcher test still sees only t-fredy.
  baseThread({ id: "t-soon", phone: "+12145550188", pid: 1004, player: P_SOON, channel: "whatsapp", lastAt: iso(22 * 60 + 30), preview: "still on?" }),
  baseThread({ id: "t-sms", phone: "+17135550111", pid: 1005, player: P_SMS, channel: "sms", lastAt: iso(30), preview: "text me" }),
  baseThread({ id: "t-failed", phone: "+15125550166", pid: 1006, player: P_FAILED, channel: "whatsapp", lastAt: iso(10), preview: "did it send?" }),
  baseThread({ id: "t-expired", phone: "+14695550122", pid: 1007, player: P_EXP, channel: "whatsapp", lastAt: iso(25 * 60), preview: "hello?" }),
];
const msg = (o) => ({ id: o.id, thread_id: o.tid, direction: o.dir, body: o.body, sent_at: o.at, sent_by_user_id: o.dir === "outbound" ? "op-1" : null, channel: o.channel ?? "whatsapp", delivery_status: o.status ?? (o.dir === "outbound" ? "sent" : "delivered"), media_kind: null, sender: null, signed_media_url: null });
const DETAIL = {
  "t-fredy": { thread: THREADS[0], messages: [msg({ id: "f1", tid: "t-fredy", dir: "inbound", body: "the charges didnt go through", at: iso(20) }), msg({ id: "f2", tid: "t-fredy", dir: "inbound", body: "theyre pending", at: iso(15) }), msg({ id: "f3", tid: "t-fredy", dir: "outbound", body: "let me check", at: iso(5) })], assignee: null, latest_inbound_at: iso(10) },
  "t-marco": { thread: THREADS[1], messages: [msg({ id: "mo1", tid: "t-marco", dir: "inbound", body: "is my son allowed to sub in", at: iso(30) })], assignee: null, latest_inbound_at: iso(30) },
  "t-unlinked": { thread: THREADS[2], messages: [msg({ id: "u1", tid: "t-unlinked", dir: "inbound", body: "who is this", at: iso(50) })], assignee: null, latest_inbound_at: iso(50) },
  "t-soon": { thread: THREADS[3], messages: [msg({ id: "so1", tid: "t-soon", dir: "inbound", body: "still on for tonight?", at: iso(22 * 60 + 30) })], assignee: null, latest_inbound_at: iso(22 * 60 + 30) },
  "t-sms": { thread: THREADS[4], messages: [msg({ id: "sm1", tid: "t-sms", dir: "inbound", body: "text me back", at: iso(30), channel: "sms" })], assignee: null, latest_inbound_at: iso(30) },
  "t-failed": { thread: THREADS[5], messages: [msg({ id: "fa1", tid: "t-failed", dir: "inbound", body: "did my message send?", at: iso(10) }), msg({ id: "fa2", tid: "t-failed", dir: "outbound", body: "checking now", at: iso(4), status: "failed" })], assignee: null, latest_inbound_at: iso(10) },
  "t-expired": { thread: THREADS[6], messages: [msg({ id: "ex1", tid: "t-expired", dir: "inbound", body: "hello? anyone there", at: iso(25 * 60) })], assignee: null, latest_inbound_at: iso(25 * 60) },
};
const COUNTS = { open: THREADS.length, mine: 0, starred: 0, closed: 0, awaiting: 3 };
// Controllable /api/crm/send: count POSTs (no-retry proof), toggle failure, add latency so a
// double-click lands inside the in-flight window (Step 3b, items 5/6/13).
const sendState = { fail: false, expire422: false, delayMs: 0, posts: [] };
const OTHER_PID = 2002; // a different player, loaded via Player Lookup → mismatches the docked thread
const otherProfile = (id) => ({
  player: { id, name: "Priya Nayar", email: null, phone: null, phoneVerified: false, city: null, level: null, registered: null, goals: 0, cityManager: false, credits: 0, status: "ok", banReason: null, bannedAt: null, banExpiredAt: null, matchesPlayed: 0, upcoming: 0 },
  membership: null, matches: [], strikes: { activeCount: 0, limit: 3, isSuspended: false, suspendedTo: null, expiredAt: null, firstStrikeAt: null, logs: [] }, accountHistory: [],
});

const grantChats = (ctx, canSend = true) => ctx.route("**/rest/v1/app_users*", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  const res = await route.fetch(); let j = await res.json().catch(() => null);
  const p = (r) => ({ ...r, is_admin: true, can_access_chats: true, can_access_matchops: true, can_send_messages: canSend });
  j = Array.isArray(j) ? j.map(p) : (j && typeof j === "object" ? p(j) : j);
  return route.fulfill({ status: res.status(), contentType: "application/json", body: JSON.stringify(j) });
});

async function routes(ctx, canSend = true) {
  // Broad fallbacks FIRST (lowest priority — Playwright matches most-recently-added first), so the
  // /home round-trip in the channel-leak test doesn't error on unmocked data reads.
  await ctx.route("**/rest/v1/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await ctx.route("**/api/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await ctx.route("**/api/crm/**", async (route) => {
    const url = new URL(route.request().url()); const path = url.pathname; const method = route.request().method();
    const json = (o, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(o) });
    if (path.endsWith("/api/crm/send") && method === "POST") {
      const b = JSON.parse(route.request().postData() || "{}");
      sendState.posts.push(b);
      if (sendState.delayMs) await new Promise((r) => setTimeout(r, sendState.delayMs));
      // The 24h window closed between the client check and the server (the race): 422, no row inserted.
      if (sendState.expire422) return json({ error: "WhatsApp session expired — player must message first to reopen the 24-hour window.", reason: "window_expired", last_inbound_at: iso(25 * 60) }, 422);
      if (sendState.fail) return json({ error: "send failed", send_error: "provider rejected" }, 502);
      return json({ message: msg({ id: `sent-${sendState.posts.length}-${sendState.posts.length}`, tid: b.thread_id, dir: "outbound", body: b.body, at: new Date(NOW).toISOString(), channel: DETAIL[b.thread_id]?.thread.channel ?? "whatsapp" }) });
    }
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
  await ctx.route("**/api/lookup/**", (route) => {
    const url = new URL(route.request().url());
    const json = (o, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(o) });
    const id = url.searchParams.get("id");
    if (id) return json(otherProfile(Number(id)));
    if (url.pathname.includes("/payments")) return json({ charges: [] });
    return json({ results: [{ id: OTHER_PID, name: "Priya Nayar", email: null, phone: null, city: null, status: "ok", hasMembership: false }] });
  });
  await grantChats(ctx, canSend);
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
  const bannerAText = () => page.$eval('[data-testid="dock-banner-a"]', (e) => e.textContent.trim());
  const dockedId = () => page.$eval('[data-testid="dock-root"]', (e) => e.getAttribute("data-docked-thread-id"));
  const selectThread = async (id, expected) => {
    await page.click(`[data-testid="crm-thread-row"][data-thread-id="${id}"]`);
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="crm-message"]').length === n, expected, { timeout: 8000 });
  };
  const fireRealtime = (event, table, newRow) => page.evaluate(({ event, table, newRow }) => {
    const rec = (window.__CRM_TEST_REALTIME__ || []).filter((c) => !c.removed).find((c) => c.handlers.some((h) => h.filter && h.filter.event === event && h.filter.table === table));
    const h = rec && rec.handlers.find((x) => x.filter && x.filter.event === event && x.filter.table === table);
    if (!h) return false;
    h.cb({ new: newRow, eventType: event });
    return true;
  }, { event, table, newRow });

  // ── pin t-marco on Player Chats (leaving t-fredy unread for the switcher) ──
  await page.goto(CHATS, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="crm-thread-row"]', { timeout: 30000 });
  await selectThread("t-marco", 1);        // marco becomes the open conversation (fredy stays unread)
  await page.click('[data-testid="dock-pin-current"]');
  await page.waitForTimeout(150);
  eq("gate: pin — DOCKED pill on the header (data-docked=1)", await page.$eval('[data-testid="dock-pin-current"]', (e) => e.getAttribute("data-docked")), "1");
  eq("gate: dock is NOT rendered on Player Chats itself", await has('[data-testid="dock-root"]'), false);

  // ── follow onto Player Lookup via client-side nav ──
  await page.locator('a[href="/match-ops/player-lookup"]').first().click();
  await page.waitForSelector('[data-testid="dock-root"]', { timeout: 15000 });
  eq("gate: docked chat follows to another screen (guard=ready)", await page.$eval('[data-testid="dock-root"]', (e) => e.getAttribute("data-guard")), "ready");
  eq("gate: follows the pinned thread (t-marco)", await dockedId(), "t-marco");
  { const n = await bannerAText(); (/Marco Ruiz/.test(n)) ? ok("gate: Banner A attributes the chat to the docked player (Marco Ruiz)") : bad("Banner A name", n); }

  // keep the distinct-NAME check (catches a second differently-named channel; weaker than the leak test below)
  { const names = await page.evaluate(() => Array.from(new Set((window.__CRM_TEST_REALTIME__ || []).filter((c) => c.handlers.some((h) => h.filter && h.filter.event === "INSERT" && h.filter.table === "crm_messages")).map((c) => c.name))));
    eq("gate: channel identity — one distinct crm_messages channel NAME (keep)", names.length, 1); }

  eq("gate: no mismatch banner without a screen subject", await has('[data-testid="dock-banner-b"]'), false);

  // ── dedup-safe realtime into the docked (non-selected) conversation ──
  { const before = await dockMsgCount();
    await fireRealtime("INSERT", "crm_messages", { id: "rt-marco-1", thread_id: "t-marco", direction: "inbound", body: "DOCK-RT-1", sent_at: new Date().toISOString(), channel: "whatsapp", delivery_status: "delivered", media_kind: null, is_auto_reply: false, template_name: null });
    await page.waitForTimeout(200);
    eq("gate: realtime INSERT paints the DOCKED conversation exactly once", await dockMsgCount(), before + 1); }
  { const before = await dockMsgCount();
    await fireRealtime("INSERT", "crm_messages", { id: "rt-marco-1", thread_id: "t-marco", direction: "inbound", body: "DOCK-RT-1", sent_at: new Date().toISOString(), channel: "whatsapp", delivery_status: "delivered", media_kind: null, is_auto_reply: false, template_name: null });
    await page.waitForTimeout(200);
    eq("gate: duplicate message id does not double-append (dedup on id)", await dockMsgCount(), before); }

  // ── item 5: crm_threads UPDATE surfaces the shared-number (ambiguous) banner ──
  await fireRealtime("UPDATE", "crm_threads", { id: "t-marco", last_message_at: new Date().toISOString(), last_message_preview: "x", match_ambiguous: true, player_id: 1002, assigned_to_user_id: null, assigned_at: null, status: "open", closed_at: null, closed_by_user_id: null, no_reply_needed_at: null });
  await page.waitForTimeout(200);
  { const shown = await has('[data-testid="dock-ambiguous"]');
    const txt = shown ? await page.$eval('[data-testid="dock-ambiguous"]', (e) => e.textContent) : "";
    (shown && /more than one account/.test(txt) && /may not be who is writing/.test(txt)) ? ok("gate: crm_threads UPDATE surfaces the shared-number banner (dock-ambiguous), honest copy") : bad("dock-ambiguous", `shown=${shown} txt=${txt.slice(0, 80)}`); }

  // ── item 4: switcher — unread-only, ≤4, most recent first; click docks + clears; absent at zero ──
  { const ids = await page.$$eval('[data-testid="dock-switcher"] [data-testid^="dock-switch-"]', (els) => els.map((e) => e.getAttribute("data-testid")));
    eq("gate: switcher lists unread-only, most-recent-first, ≤4 (t-fredy only)", ids, ["dock-switch-t-fredy"]); }
  await page.click('[data-testid="dock-switch-t-fredy"]');
  // wait for the docked thread AND its detail to load (the loading state has no dock-banner-a)
  await page.waitForFunction(() => {
    const root = document.querySelector('[data-testid="dock-root"]');
    const b = document.querySelector('[data-testid="dock-banner-a"]');
    return root?.getAttribute("data-docked-thread-id") === "t-fredy" && b && /Fredy/.test(b.textContent);
  }, null, { timeout: 8000 });
  { const n = await bannerAText(); (/Fredy Alvarez/.test(n)) ? ok("gate: clicking a switcher row docks it (→ Fredy) and clears its unread") : bad("switcher dock", n); }
  await page.waitForTimeout(150);
  eq("gate: switcher region ABSENT from the DOM at zero unread", await has('[data-testid="dock-switcher"]'), false);

  // ── Banner B: a DIFFERENT player on the screen (fredy=1001 vs subject 2002) ──
  await page.fill('input[placeholder="Phone, email, name or player ID"]', String(OTHER_PID));
  await page.waitForTimeout(400);
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="dock-banner-b"]', { timeout: 8000 });
  { const txt = await page.$eval('[data-testid="dock-banner-b"]', (e) => e.textContent);
    const mm = await page.$eval('[data-testid="dock-root"]', (e) => e.getAttribute("data-mismatch"));
    (mm === "1" && /Priya Nayar/.test(txt) && /Fredy/.test(txt)) ? ok("gate: Banner B warns when screen subject ≠ docked player") : bad("Banner B", `mismatch=${mm} txt=${txt.slice(0, 80)}`); }
  await page.click('[data-testid="lookup-back"]');
  await page.waitForTimeout(300);
  eq("gate: Banner B clears when the screen subject clears", await has('[data-testid="dock-banner-b"]'), false);

  // ══ item 2: THE REAL CHANNEL-LEAK TEST ══
  // Nav fully OUT of match-ops and back x3 (client-side, provider unmounts+remounts, dock restores
  // from sessionStorage). If unmount doesn't clean up, prior same-named channels stay LIVE and one
  // INSERT paints twice. Assert exactly ONE live crm_messages subscription, and that one INSERT
  // delivered to ALL live channels grows the docked conversation by exactly 1 (one bubble).
  for (let i = 0; i < 3; i++) {
    await page.locator('a[href="/home"]').first().click();
    await page.waitForURL(/\/home\b/, { timeout: 10000 });
    await page.goBack();
    await page.waitForSelector('[data-testid="dock-root"]', { timeout: 15000 });
  }
  await page.waitForTimeout(400); // let StrictMode setup/cleanup/setup settle
  { const live = await page.evaluate(() => (window.__CRM_TEST_REALTIME__ || []).filter((c) => !c.removed && c.handlers.some((h) => h.filter && h.filter.event === "INSERT" && h.filter.table === "crm_messages")).length);
    eq("gate: channel leak — nav out/back x3 leaves exactly ONE live crm_messages subscription", live, 1); }
  { const did = await dockedId(); const before = await dockMsgCount();
    const delivered = await page.evaluate(({ tid }) => {
      const live = (window.__CRM_TEST_REALTIME__ || []).filter((c) => !c.removed && c.handlers.some((h) => h.filter && h.filter.event === "INSERT" && h.filter.table === "crm_messages"));
      let n = 0;
      for (const c of live) { const h = c.handlers.find((x) => x.filter && x.filter.event === "INSERT" && x.filter.table === "crm_messages"); h.cb({ new: { id: "leak-probe-1", thread_id: tid, direction: "inbound", body: "LEAK-PROBE", sent_at: new Date().toISOString(), channel: "whatsapp", delivery_status: "delivered", media_kind: null, is_auto_reply: false, template_name: null } }); n++; }
      return n;
    }, { tid: did });
    await page.waitForTimeout(250);
    const after = await dockMsgCount();
    const bubbles = await page.$$eval('[data-testid="dock-messages"] [data-testid="crm-message"]', (els) => els.filter((e) => /LEAK-PROBE/.test(e.textContent)).length);
    (after === before + 1) ? ok(`gate: channel leak — one INSERT (delivered to ${delivered} live ch) grew the docked conversation by exactly 1`) : bad("leak: messages growth", `before=${before} after=${after} delivered=${delivered}`);
    eq("gate: channel leak — the message paints EXACTLY ONE bubble (dedup holds under delivery)", bubbles, 1); }

  // ── collapse ↔ rail ──
  await page.click('[data-testid="dock-collapse"]');
  await page.waitForTimeout(150);
  eq("gate: collapse hides the panel and shows the right-edge rail", { rail: await has('[data-testid="dock-rail"]'), msgs: await has('[data-testid="dock-messages"]') }, { rail: true, msgs: false });
  await page.click('[data-testid="dock-rail"]');
  await page.waitForTimeout(150);
  eq("gate: rail re-opens the panel", await has('[data-testid="dock-messages"]'), true);

  // ── item 3: no horizontal overflow at four widths in BOTH open AND collapsed states ──
  // Below sm (640px) the collapsed form is the BUBBLE (the rail is display:none); at/above sm it's
  // the RAIL. Click whichever is VISIBLE, not merely present in the DOM.
  const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  const reopenDock = async () => {
    const railVisible = await page.locator('[data-testid="dock-rail"]').isVisible().catch(() => false);
    await page.click(railVisible ? '[data-testid="dock-rail"]' : '[data-testid="dock-bubble"]');
    await page.waitForSelector('[data-testid="dock-messages"]', { timeout: 5000 });
  };
  for (const w of [1600, 1180, 900, 390]) {
    await page.setViewportSize({ width: w, height: 900 });
    if (!(await has('[data-testid="dock-messages"]'))) await reopenDock();
    await page.waitForTimeout(120);
    eq(`gate: no horizontal overflow at ${w}px — dock OPEN`, await noOverflow(), true);
    // collapsed (rail on desktop, bubble on phone) — a fixed right-offset element is exactly what pushes a narrow doc wider
    await page.click('[data-testid="dock-collapse"]');
    await page.waitForTimeout(120);
    eq(`gate: no horizontal overflow at ${w}px — dock COLLAPSED`, await noOverflow(), true);
    await reopenDock();
    await page.waitForTimeout(120);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });

  // ── item 1: an UNLINKED thread is an identity, not a phone-number-as-name ──
  await page.goto(CHATS, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="crm-thread-row"]', { timeout: 30000 });
  await selectThread("t-unlinked", 1);
  await page.click('[data-testid="dock-pin-current"]');
  await page.locator('a[href="/match-ops/player-lookup"]').first().click();
  await page.waitForSelector('[data-testid="dock-root"]', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="dock-root"]')?.getAttribute("data-docked-thread-id") === "t-unlinked", null, { timeout: 8000 });
  eq("gate: unlinked — dock-guard-unlinked note is shown", await has('[data-testid="dock-guard-unlinked"]'), true);
  { const a = await bannerAText();
    const hasChip = await has('[data-testid="dock-unlinked-chip"]');
    (hasChip && /3105550137/.test(a) && !/UNK/.test(a)) ? ok("gate: unlinked — phone shown with UNLINKED chip, no name, no 'UNK' city") : bad("unlinked header", `chip=${hasChip} a=${a.slice(0, 60)}`); }
  eq("gate: unlinked — the note text is 'No player account is linked to this number.'", await page.$eval('[data-testid="dock-guard-unlinked"]', (e) => e.textContent.trim()), "No player account is linked to this number.");

  // ── Reply in Player Chats hands off to the full pane (and the dock hides there) ──
  await page.click('[data-testid="dock-reply"]');
  await page.waitForURL(/\/match-ops\/player-chats\?threadId=t-unlinked\b/, { timeout: 10000 });
  await page.waitForTimeout(300);
  eq("gate: Reply in Player Chats opens the thread in the full pane and hides the dock", { url: /threadId=t-unlinked/.test(page.url()), dock: await has('[data-testid="dock-root"]') }, { url: true, dock: false });

  // ── sessionStorage round-trip + dead-thread restore clears ──
  await page.goto(LOOKUP, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="dock-root"]', { timeout: 15000 });
  eq("gate: a hard reload restores the docked chat from sessionStorage", await dockedId(), "t-unlinked");
  await page.evaluate(() => sessionStorage.setItem("crm:dockedThreadId", "t-ghost"));
  await page.goto(LOOKUP, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  { const dockShown = await has('[data-testid="dock-root"]');
    const cleared = await page.evaluate(() => sessionStorage.getItem("crm:dockedThreadId"));
    (!dockShown && cleared === null) ? ok("gate: a dead docked thread (404) clears silently on restore") : bad("dead-thread restore", `dockShown=${dockShown} stored=${cleared}`); }

  // ── useDockSubject is inert with nothing docked ──
  await page.fill('input[placeholder="Phone, email, name or player ID"]', String(OTHER_PID));
  await page.waitForTimeout(400);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  eq("gate: useDockSubject is inert when nothing is docked (subject sets no dock UI)", await has('[data-testid="dock-root"]'), false);

  // ══════════════ STEP 3b — the composer + send path ══════════════
  const DTA = '[data-testid="dock-root"] [data-testid="crm-composer"]';
  const DSEND = '[data-testid="dock-root"] [data-testid="crm-send"]';
  const composerVal = () => page.$eval(DTA, (e) => e.value);
  const sendDisabled = () => page.$eval(DSEND, (e) => e.disabled);
  const sendLabelText = () => page.$eval(DSEND, (e) => e.textContent.replace(/\s+/g, " ").trim());
  const resetSend = () => { sendState.fail = false; sendState.expire422 = false; sendState.delayMs = 0; sendState.posts.length = 0; };
  // Dock an arbitrary thread fast via the sessionStorage restore path, optionally seeding a draft.
  const setDock = async (id, draft) => {
    await page.evaluate(({ id, draft }) => {
      sessionStorage.setItem("crm:dockedThreadId", id);
      sessionStorage.setItem("crm:dockOpen", "1");
      if (draft != null) sessionStorage.setItem("crm:draft", JSON.stringify({ threadId: id, text: draft }));
      else sessionStorage.removeItem("crm:draft");
    }, { id, draft: draft ?? null });
    await page.goto(LOOKUP, { waitUntil: "domcontentloaded" });
    await page.waitForFunction((x) => document.querySelector('[data-testid="dock-root"]')?.getAttribute("data-docked-thread-id") === x, id, { timeout: 15000 });
    await page.waitForSelector(DTA, { timeout: 8000 });
  };

  // ── item 11: the Send button NAMES the recipient — linked, unlinked, mismatch ──
  await setDock("t-fredy");
  { const l = await sendLabelText(); (/Send to Fredy Alvarez/.test(l) && !/not /.test(l)) ? ok("gate3b: send label — linked reads 'Send to {name}'") : bad("send label linked", l); }
  await setDock("t-unlinked");
  { const l = await sendLabelText(); (/Send to \+13105550137/.test(l)) ? ok("gate3b: send label — unlinked reads 'Send to {phone}'") : bad("send label unlinked", l); }
  await setDock("t-fredy");
  await page.fill('input[placeholder="Phone, email, name or player ID"]', String(OTHER_PID));
  await page.waitForTimeout(400); await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="dock-banner-b"]', { timeout: 8000 });
  { const l = await sendLabelText(); (/Send to Fredy Alvarez, not Priya Nayar/.test(l)) ? ok("gate3b: send label — mismatch reads 'Send to {chat}, not {subject}' (no modal)") : bad("send label mismatch", l); }

  // ── item 10: SMS thread — no window gate applied ──
  await setDock("t-sms", "hey, quick question");
  eq("gate3b: SMS thread has no window gate (no soon/expired banners, Send enabled)", {
    soon: await has('[data-testid="dock-root"] [data-testid="crm-window-soon"]'),
    expired: await has('[data-testid="dock-root"] [data-testid="crm-window-expired"]'),
    sendDisabled: await sendDisabled(),
  }, { soon: false, expired: false, sendDisabled: false });

  // ── item 8: WhatsApp under 2h — warning shows the REAL remaining time ──
  await setDock("t-soon", "on my way");
  { const shown = await has('[data-testid="dock-root"] [data-testid="crm-window-soon"]');
    const timeTxt = shown ? await page.$eval('[data-testid="crm-window-soon-time"]', (e) => e.textContent.trim()) : "";
    (shown && /^1h \d{1,2}m$/.test(timeTxt) && !(await sendDisabled())) ? ok(`gate3b: window <2h shows the real remaining time ("${timeTxt}"), Send still enabled`) : bad("window soon", `shown=${shown} time="${timeTxt}"`); }

  // ── items 7 + 9: window closes MID-DRAFT via a crm_threads UPDATE — re-evaluates, draft kept ──
  await setDock("t-fredy", "");
  await page.fill(DTA, "keep me while the window closes");
  await fireRealtime("UPDATE", "crm_threads", { id: "t-fredy", last_message_at: new Date(NOW).toISOString(), last_message_preview: "x", match_ambiguous: false, player_id: 1001, latest_inbound_at: iso(25 * 60), assigned_to_user_id: null, assigned_at: null, status: "open", closed_at: null, closed_by_user_id: null, no_reply_needed_at: null });
  await page.waitForSelector('[data-testid="dock-root"] [data-testid="crm-window-expired"]', { timeout: 6000 });
  { const reason = await page.$eval('[data-testid="crm-window-expired"]', (e) => e.textContent);
    (await sendDisabled() && /\/send-template/.test(reason) && await has('[data-testid="crm-send-template"]') && (await composerVal()) === "keep me while the window closes")
      ? ok("gate3b: window closes mid-draft (no reload) → Send disabled, reason names /send-template, DRAFT KEPT")
      : bad("window mid-draft close", `disabled=${await sendDisabled()} reasonNamesTemplate=${/\/send-template/.test(reason)} val="${await composerVal()}"`); }

  // ── item 5 + item 3(failure) + item 4: confirm-then-append; draft kept on failure, cleared on success ──
  await setDock("t-marco", "");
  resetSend(); sendState.fail = true;
  { const before = await dockMsgCount();
    await page.fill(DTA, "this send will fail");
    await page.click(DSEND); await page.waitForTimeout(500);
    (await dockMsgCount() === before && await composerVal() === "this send will fail" && sendState.posts.length === 1)
      ? ok("gate3b: send FAILS → no bubble appended (confirm-then-append) AND draft kept (item 3)")
      : bad("send failure", `msgsΔ=${(await dockMsgCount()) - before} val="${await composerVal()}" posts=${sendState.posts.length}`); }
  resetSend();
  { const before = await dockMsgCount();
    await page.fill(DTA, "this one lands");
    await page.click(DSEND);
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="dock-messages"] [data-testid="crm-message"]').length === n, before + 1, { timeout: 6000 });
    (await dockMsgCount() === before + 1 && await composerVal() === "" && sendState.posts.length === 1)
      ? ok("gate3b: send SUCCEEDS → exactly one bubble appended AND draft cleared (item 4)")
      : bad("send success", `msgsΔ=${(await dockMsgCount()) - before} val="${await composerVal()}" posts=${sendState.posts.length}`); }

  // ── item 6: NO retry — one click = one POST; a double-click still = one POST ──
  resetSend(); sendState.delayMs = 500;
  await page.fill(DTA, "single click");
  await page.click(DSEND); await page.waitForTimeout(900);
  eq("gate3b: one click produces exactly one POST", sendState.posts.length, 1);
  resetSend(); sendState.delayMs = 500;
  await page.fill(DTA, "double click");
  await page.dblclick(DSEND); await page.waitForTimeout(900);
  eq("gate3b: a double-click still produces exactly one POST (no duplicate message)", sendState.posts.length, 1);

  // ── item 13: Resend on a failed bubble — one POST, button disabled in flight ──
  await setDock("t-failed");
  eq("gate3b: a delivery-failed outbound bubble shows a Resend", await has('[data-testid="dock-resend-fa2"]'), true);
  resetSend(); sendState.delayMs = 500;
  await page.click('[data-testid="dock-resend-fa2"]');
  const resendDisabledInFlight = await page.$eval('[data-testid="dock-resend-fa2"]', (e) => e.disabled);
  await page.waitForTimeout(900);
  (resendDisabledInFlight && sendState.posts.length === 1)
    ? ok("gate3b: Resend sends exactly one POST and is disabled while in flight")
    : bad("resend", `disabledInFlight=${resendDisabledInFlight} posts=${sendState.posts.length}`);

  // ── item 14: snippet click INSERTS into the draft and sends nothing ──
  await setDock("t-marco", "");
  { const hasSnips = await has('[data-testid="dock-snippets"]');
    resetSend();
    const before = await composerVal();
    if (hasSnips) await page.click('[data-testid="dock-snippet-0"]');
    await page.waitForTimeout(200);
    const after = await composerVal();
    (hasSnips && after.length > before.length && sendState.posts.length === 0)
      ? ok("gate3b: a snippet click inserts into the draft and sends nothing (0 POSTs)")
      : bad("snippet", `hasSnips=${hasSnips} before="${before}" after="${after}" posts=${sendState.posts.length}`); }

  // ── item 1: draft survives navigation between two match-ops routes ──
  await setDock("t-marco", "");
  await page.fill(DTA, "draft across nav");
  await page.locator('a[href="/match-ops/gameday"]').first().click();
  await page.waitForFunction(() => location.pathname === "/match-ops/gameday", null, { timeout: 10000 });
  await page.waitForSelector(DTA, { timeout: 8000 });
  eq("gate3b: draft survives navigation between two match-ops routes", await composerVal(), "draft across nav");

  // ── item 2: draft survives reload; a draft for an UNDOCKED thread is not resurrected ──
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(DTA, { timeout: 8000 });
  eq("gate3b: draft survives reload via sessionStorage", await composerVal(), "draft across nav");
  await page.evaluate(() => sessionStorage.setItem("crm:draft", JSON.stringify({ threadId: "t-ghost-thread", text: "GHOST" })));
  await page.goto(LOOKUP, { waitUntil: "domcontentloaded" });
  await page.waitForFunction((x) => document.querySelector('[data-testid="dock-root"]')?.getAttribute("data-docked-thread-id") === x, "t-marco", { timeout: 15000 });
  await page.waitForSelector(DTA, { timeout: 8000 });
  eq("gate3b: a draft whose thread is not the docked one is NOT resurrected", await composerVal(), "");

  // ── item 3(undock): draft is NOT cleared on undock (in-session re-dock, no reload) ──
  await setDock("t-marco", "");
  await page.fill(DTA, "undock keeps this");
  await page.click('[data-testid="dock-close"]');           // undock → dock gone, draft stays in-memory
  await page.waitForSelector('[data-testid="dock-root"]', { state: "detached", timeout: 6000 }).catch(() => {});
  await page.locator('a[href="/match-ops/player-chats"]').first().click(); // client-nav (provider persists)
  await page.waitForSelector('[data-testid="crm-thread-row"]', { timeout: 15000 });
  await page.click('[data-testid="crm-thread-row"][data-thread-id="t-marco"]');
  await page.waitForSelector('[data-testid="dock-pin-current"]', { timeout: 8000 });
  await page.click('[data-testid="dock-pin-current"]');     // re-dock t-marco (dockThread, no reload)
  await page.locator('a[href="/match-ops/player-lookup"]').first().click();
  await page.waitForSelector(DTA, { timeout: 15000 });
  eq("gate3b: draft is NOT cleared on undock (survives undock + re-dock)", await composerVal(), "undock keeps this");

  // ── item 12: NO can_send_messages → NO composer at all (not a greyed one) ──
  { const roCtx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState });
    await routes(roCtx, false);
    const ro = await roCtx.newPage();
    await ro.addInitScript(() => { window.__CRM_TEST_REALTIME__ = []; sessionStorage.setItem("crm:dockedThreadId", "t-marco"); sessionStorage.setItem("crm:dockOpen", "1"); });
    await ro.goto(LOOKUP, { waitUntil: "domcontentloaded" });
    await ro.waitForSelector('[data-testid="dock-root"]', { timeout: 15000 });
    await ro.waitForTimeout(400);
    const composerCount = await ro.$$eval('[data-testid="dock-root"] [data-testid="crm-composer"]', (e) => e.length);
    const readonly = await ro.$('[data-testid="dock-readonly"]') !== null;
    eq("gate3b: no can_send_messages → NO composer rendered (count 0), read-only line shown", { composerCount, readonly }, { composerCount: 0, readonly: true });
    await roCtx.close(); }

  // ── item 15: layout at 1600 and 390 with the composer present (CLAUDE.md rule) ──
  await setDock("t-fredy", "layout check draft");
  for (const w of [1600, 390]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => {
      const noOverflow = document.documentElement.scrollWidth <= window.innerWidth + 1;
      const root = document.querySelector('[data-testid="dock-root"]');
      const rr = root.getBoundingClientRect();
      const fits = rr.right <= window.innerWidth + 1 && rr.left >= -1;
      // no mobile-only leak: the composer is present and its own textarea isn't wrapping to a huge stack
      const ta = document.querySelector('[data-testid="dock-root"] [data-testid="crm-composer"]');
      const composerShown = !!ta && getComputedStyle(ta).display !== "none";
      return { noOverflow, fits, composerShown };
    });
    (r.noOverflow && r.fits && r.composerShown)
      ? ok(`gate3b: layout OK at ${w}px with composer — no overflow, dock fits, composer present`)
      : bad(`layout ${w}px`, JSON.stringify(r));
  }
  await page.setViewportSize({ width: 1440, height: 1000 });

  // ── item 1 (the race): server 422s an EXPIRED window the client believed OPEN ──
  await setDock("t-marco", "");
  resetSend(); sendState.expire422 = true;
  { const before = await dockMsgCount();
    await page.fill(DTA, "sending into a just-closed window");
    await page.click(DSEND);
    await page.waitForSelector('[data-testid="dock-root"] [data-testid="crm-window-expired"]', { timeout: 6000 });
    const noBubble = (await dockMsgCount()) === before;
    const draftKept = (await composerVal()) === "sending into a just-closed window";
    const nowDisabled = await sendDisabled();
    const noFailedResend = !(await has('[data-testid="dock-root"] [data-testid^="dock-resend-"]'));
    const reasonNamesTemplate = /\/send-template/.test(await page.$eval('[data-testid="crm-window-expired"]', (e) => e.textContent));
    (noBubble && draftKept && nowDisabled && noFailedResend && reasonNamesTemplate)
      ? ok("gate3b: 422 expired-window RACE → no bubble, draft kept, composer flips to EXPIRED (not a failed bubble/Resend)")
      : bad("422 race", `noBubble=${noBubble} draftKept=${draftKept} disabled=${nowDisabled} noResend=${noFailedResend} reasonNamesTemplate=${reasonNamesTemplate}`); }
  resetSend();

  // ── item 2: the dock's expired escape is a LINK to the full pane, not a control that "sends" ──
  { const label = await page.$eval('[data-testid="crm-send-template"]', (e) => e.textContent.replace(/\s+/g, " ").trim());
    await page.click('[data-testid="crm-send-template"]');
    await page.waitForURL(/\/match-ops\/player-chats\?threadId=t-marco\b/, { timeout: 10000 });
    (/Player Chats/.test(label) && /threadId=t-marco/.test(page.url()))
      ? ok(`gate3b: dock expired-escape is a LINK to the full pane ("${label}"), not a send-from-dock control`)
      : bad("expired escape", `label="${label}" url=${page.url()}`); }

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await browser.close();
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
