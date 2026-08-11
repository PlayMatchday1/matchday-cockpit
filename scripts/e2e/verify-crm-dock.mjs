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
const THREADS = [
  baseThread({ id: "t-fredy", phone: "+13468134860", pid: 1001, player: P_FREDY, channel: "whatsapp", lastAt: iso(10), preview: "the 2 $38 charges", unread: true }),
  baseThread({ id: "t-marco", phone: "+15124409921", pid: 1002, player: P_MARCO, channel: "whatsapp", lastAt: iso(30), preview: "is my son allowed" }),
  // Unlinked: no player account attached to this number (item 1).
  baseThread({ id: "t-unlinked", phone: "+13105550137", pid: null, player: null, channel: "whatsapp", lastAt: iso(50), preview: "who is this" }),
];
const msg = (o) => ({ id: o.id, thread_id: o.tid, direction: o.dir, body: o.body, sent_at: o.at, sent_by_user_id: o.dir === "outbound" ? "op-1" : null, channel: o.channel ?? "whatsapp", delivery_status: o.dir === "outbound" ? "sent" : "delivered", media_kind: null, sender: null, signed_media_url: null });
const DETAIL = {
  "t-fredy": { thread: THREADS[0], messages: [msg({ id: "f1", tid: "t-fredy", dir: "inbound", body: "the charges didnt go through", at: iso(20) }), msg({ id: "f2", tid: "t-fredy", dir: "inbound", body: "theyre pending", at: iso(15) }), msg({ id: "f3", tid: "t-fredy", dir: "outbound", body: "let me check", at: iso(5) })], assignee: null, latest_inbound_at: iso(10) },
  "t-marco": { thread: THREADS[1], messages: [msg({ id: "mo1", tid: "t-marco", dir: "inbound", body: "is my son allowed to sub in", at: iso(30) })], assignee: null, latest_inbound_at: iso(30) },
  "t-unlinked": { thread: THREADS[2], messages: [msg({ id: "u1", tid: "t-unlinked", dir: "inbound", body: "who is this", at: iso(50) })], assignee: null, latest_inbound_at: iso(50) },
};
const COUNTS = { open: 3, mine: 0, starred: 0, closed: 0, awaiting: 3 };
const OTHER_PID = 2002; // a different player, loaded via Player Lookup → mismatches the docked thread
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
  // Broad fallbacks FIRST (lowest priority — Playwright matches most-recently-added first), so the
  // /home round-trip in the channel-leak test doesn't error on unmocked data reads.
  await ctx.route("**/rest/v1/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await ctx.route("**/api/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
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
  await ctx.route("**/api/lookup/**", (route) => {
    const url = new URL(route.request().url());
    const json = (o, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(o) });
    const id = url.searchParams.get("id");
    if (id) return json(otherProfile(Number(id)));
    if (url.pathname.includes("/payments")) return json({ charges: [] });
    return json({ results: [{ id: OTHER_PID, name: "Priya Nayar", email: null, phone: null, city: null, status: "ok", hasMembership: false }] });
  });
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

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await browser.close();
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
