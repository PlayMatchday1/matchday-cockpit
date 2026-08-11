// Phase 19 Step 0b — RUNTIME characterization of the CURRENT Player Chats screen, before the
// Step-2 split. Step 0 pinned the low-risk invariants (a pure fn + source facts); this pins the
// RENDERING a 2,364-line extraction actually threatens: the list, the click-to-load, the send
// paint, the composer's expiry gate, the nav badge — and the realtime paint, stubbed at the
// subscription boundary (no live socket). Drives the REAL CrmClient with mocked /api/crm/* and
// the data-testid hooks added in the same commit. Must stay green after Step 2 moves the code.
//   node scripts/e2e/verify-crm-characterize.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const BASE = process.env.BASE || "http://localhost:3000";
const PAGE = `${BASE}/match-ops/player-chats`;
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const NOW = Date.now();
const iso = (minAgo) => new Date(NOW - minAgo * 60000).toISOString();

// Thread-row shape = crm_threads columns + { player, assignee, is_unread, is_follow_up,
// waiting_since } (from /api/crm/threads). Three threads exercise the three composer states.
const baseThread = (o) => ({
  id: o.id, phone_number: o.phone, player_id: o.pid ?? null, match_ambiguous: false,
  last_message_at: o.lastAt, last_message_preview: o.preview, last_message_direction: "inbound",
  last_message_is_template: false, created_at: iso(4000), assigned_to_user_id: null, assigned_at: null,
  channel: o.channel, status: "open", closed_at: null, closed_by_user_id: null, no_reply_needed_at: null,
  player: o.player, assignee: null, is_unread: o.unread ?? false, is_follow_up: false, waiting_since: null,
});
const P_FREDY = { id: 1001, first_name: "Fredy", last_name: "Alvarez", preferable_city_normalized: "HOU", is_member: false };
const P_MARCO = { id: 1002, first_name: "Marco", last_name: "Ruiz", preferable_city_normalized: "ATX", is_member: true };
const P_SAM = { id: 1003, first_name: "Sam", last_name: "Ochoa", preferable_city_normalized: "DAL", is_member: false };
const THREADS = [
  baseThread({ id: "t-fredy", phone: "+13468134860", pid: 1001, player: P_FREDY, channel: "whatsapp", lastAt: iso(10), preview: "the 2 $38 charges", unread: true }),
  baseThread({ id: "t-marco", phone: "+15124409921", pid: 1002, player: P_MARCO, channel: "whatsapp", lastAt: iso(1800), preview: "is my son allowed" }),
  baseThread({ id: "t-sms", phone: "+12145550101", pid: 1003, player: P_SAM, channel: "sms", lastAt: iso(1800), preview: "text me back" }),
];
const msg = (o) => ({ id: o.id, thread_id: o.tid, direction: o.dir, body: o.body, sent_at: o.at, sent_by_user_id: o.dir === "outbound" ? "op-1" : null, channel: o.channel ?? "whatsapp", delivery_status: o.dir === "outbound" ? "sent" : "delivered", media_kind: null, sender: null, signed_media_url: null });
// Detail per thread: thread row + messages + latest_inbound_at (drives the 24h window).
const DETAIL = {
  "t-fredy": { thread: THREADS[0], messages: [msg({ id: "m1", tid: "t-fredy", dir: "inbound", body: "hey the 2 $38 charges didnt go through", at: iso(20) }), msg({ id: "m2", tid: "t-fredy", dir: "inbound", body: "they're pending", at: iso(15) }), msg({ id: "m3", tid: "t-fredy", dir: "outbound", body: "let me check", at: iso(5) })], assignee: null, latest_inbound_at: iso(10) },
  "t-marco": { thread: THREADS[1], messages: [msg({ id: "m4", tid: "t-marco", dir: "inbound", body: "is my son allowed", at: iso(1800) })], assignee: null, latest_inbound_at: iso(1800) },
  // Sam gets 2 messages (distinct count from Marco's 1) so selectThread's message-count wait is
  // unambiguous — otherwise a Marco→Sam switch could satisfy `=== 1` before Sam's detail loads.
  "t-sms": { thread: THREADS[2], messages: [msg({ id: "m5", tid: "t-sms", dir: "inbound", body: "text me back", at: iso(1900), channel: "sms" }), msg({ id: "m6", tid: "t-sms", dir: "outbound", body: "will do", at: iso(1800), channel: "sms" })], assignee: null, latest_inbound_at: iso(1900) },
};
const COUNTS = { open: 3, mine: 0, starred: 0, closed: 0, awaiting: 4 };
let listFetches = 0; // counts GET /api/crm/threads (the inbox list) — proves debounced reloads fire

const grantChats = (ctx, canSend = true) => ctx.route("**/rest/v1/app_users*", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  const res = await route.fetch(); let j = await res.json().catch(() => null);
  const p = (r) => ({ ...r, is_admin: true, can_access_chats: true, can_access_matchops: true, can_send_messages: canSend });
  j = Array.isArray(j) ? j.map(p) : (j && typeof j === "object" ? p(j) : j);
  return route.fulfill({ status: res.status(), contentType: "application/json", body: JSON.stringify(j) });
});

async function crmRoutes(ctx, canSend = true) {
  await ctx.route("**/api/crm/**", (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const json = (o, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(o) });
    if (path.endsWith("/api/crm/send") && method === "POST") {
      const b = JSON.parse(route.request().postData() || "{}");
      return json({ message: msg({ id: `sent-${Date.now()}`, tid: b.thread_id, dir: "outbound", body: b.body, at: new Date().toISOString(), channel: DETAIL[b.thread_id]?.thread.channel ?? "whatsapp" }) });
    }
    if (path.endsWith("/unread-count")) return json({ count: 2 });
    if (path.endsWith("/awaiting-count")) return json({ count: COUNTS.awaiting });
    if (path.endsWith("/api/crm/threads")) { listFetches++; return json({ threads: THREADS, counts: COUNTS }); }
    if (path.endsWith("/api/crm/operators")) return json({ operators: [] });
    if (path.endsWith("/api/crm/metrics")) return json({ metrics: { cohort: { conversations: COUNTS.open, repliedCount: 2, medianFirstResponseMin: 12, answeredWithin1h: 2, answeredWithin1hPct: 100, resolved: 1, resolvedPct: 33 } }, trend: { cohortMedianDeltaMin: null }, awaiting: { count: COUNTS.awaiting } });
    if (/\/api\/crm\/threads\/[^/]+\/mark-read$/.test(path) && method === "POST") return json({ ok: true });
    if (/\/api\/crm\/threads\/[^/]+\/context$/.test(path)) return json({ player: null, membership: null, recent_matches: [], upcoming_matches: [], historical_account_count: null });
    const detailMatch = /\/api\/crm\/threads\/([^/]+)$/.exec(path);
    if (detailMatch && method === "GET") { const d = DETAIL[detailMatch[1]]; return d ? json(d) : json({ error: "not found" }, 404); }
    return json({}); // permissive catch-all for any other crm sub-route
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
  await crmRoutes(ctx);
  const page = await ctx.newPage();
  // Arm the realtime capture seam (src/lib/supabase.ts) BEFORE any app script runs.
  await page.addInitScript(() => { window.__CRM_TEST_REALTIME__ = []; });
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="crm-thread-row"]', { timeout: 30000 });
  await page.waitForTimeout(300);
  const rowCount = () => page.$$eval('[data-testid="crm-thread-row"]', (els) => els.length);
  const msgCount = () => page.$$eval('[data-testid="crm-message"]', (els) => els.length);
  // Click a thread and WAIT for its detail to paint the expected number of messages (the detail
  // fetch + render is async; a fixed sleep races it).
  const selectThread = async (id, expectedMsgs) => {
    await page.click(`[data-testid="crm-thread-row"][data-thread-id="${id}"]`);
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="crm-message"]').length === n, expectedMsgs, { timeout: 8000 });
  };

  // ── the thread list renders ──
  eq("thread list renders one row per thread (3)", await rowCount(), 3);

  // ── filter narrows the list client-side (no refetch) ──
  await page.fill('[data-testid="crm-search"]', "Marco"); await page.waitForTimeout(200);
  { const names = await page.$$eval('[data-testid="crm-thread-name"]', (els) => els.map((e) => e.textContent.trim()));
    eq("typing 'Marco' filters the list to just Marco", names, ["Marco Ruiz"]); }
  await page.fill('[data-testid="crm-search"]', ""); await page.waitForTimeout(200);
  eq("clearing the filter restores all rows", await rowCount(), 3);

  // ── clicking a thread loads its messages ──
  await selectThread("t-fredy", 3);
  eq("clicking Fredy's thread loads its 3 messages", await msgCount(), 3);

  // ── the composer sends and the message appears AFTER res.ok (confirm-then-append) ──
  { const before = await msgCount();
    await page.fill('[data-testid="crm-composer"]', "your two authorizations will drop off");
    await page.click('[data-testid="crm-send"]'); await page.waitForTimeout(500);
    const after = await msgCount();
    const lastOut = await page.$$eval('[data-testid="crm-message"][data-direction="outbound"]', (els) => els[els.length - 1]?.textContent ?? "");
    (after === before + 1 && /two authorizations will drop off/.test(lastOut)) ? ok("composer send appends the outbound message after the 2xx (confirm-then-append)") : bad("send did not append", `before=${before} after=${after} last=${lastOut.slice(0, 40)}`);
    const box = await page.$eval('[data-testid="crm-composer"]', (e) => e.value);
    eq("composer clears after a successful send", box, ""); }

  // ── the composer's expiry gate: WhatsApp inside window enabled, expired disabled, SMS enabled ──
  eq("Fredy (WhatsApp, inbound 10m ago) — composer ENABLED", await page.$eval('[data-testid="crm-composer"]', (e) => e.disabled), false);
  await selectThread("t-marco", 1);
  eq("Marco (WhatsApp, inbound 30h ago) — composer DISABLED (window expired)", await page.$eval('[data-testid="crm-composer"]', (e) => e.disabled), true);
  await selectThread("t-sms", 2);
  eq("Sam (SMS, inbound 30h ago) — composer ENABLED (SMS has no window)", await page.$eval('[data-testid="crm-composer"]', (e) => e.disabled), false);

  // ── the nav unread badge reflects the awaiting count ──
  { const badge = await page.$('[data-testid="crm-unread-badge"]');
    const count = badge ? await badge.getAttribute("data-count") : null;
    eq("nav unread badge shows the awaiting count (4)", count, "4"); }

  // ── the realtime paint — STUBBED at the subscription boundary (no live socket) ──
  // Exactly one subscription for the whole feature, and invoking its crm_messages INSERT
  // callback directly paints the new message.
  await selectThread("t-fredy", 3);
  // NOTE ON THE FORM OF THIS ASSERTION (Phase 19, carry-over B). This suite runs against the DEV
  // build (`npm run dev`, which the e2e runner starts), where React StrictMode double-invokes
  // effects and re-creates the SAME channel (all named "crm-stream-v2", each cleaned up). A raw
  // count of channel OBJECTS is therefore >1 in dev and is noise, NOT a bug. So the assertion is
  // the DISTINCT channel-NAME count on crm_messages — which is the exact guard for the historical
  // bug the spec cares about (a second, DIFFERENTLY-NAMED channel on crm_messages took every page
  // down). This is the strongest form available against a dev build; it is deliberately NOT the
  // "one subscription object" count, because that only holds under a production build (no
  // StrictMode). If this suite is ever moved onto a prod-build harness (like verify-week's
  // next-start), restore the strict object count there.
  { const names = await page.evaluate(() => Array.from(new Set((window.__CRM_TEST_REALTIME__ || []).filter((c) => c.handlers.some((h) => h.filter && h.filter.event === "INSERT" && h.filter.table === "crm_messages")).map((c) => c.name))));
    eq("exactly ONE subscription identity (distinct name) on crm_messages", names.length, 1); }
  { const before = await msgCount();
    const fired = await page.evaluate(() => {
      const rec = (window.__CRM_TEST_REALTIME__ || []).find((c) => c.handlers.some((h) => h.filter && h.filter.event === "INSERT" && h.filter.table === "crm_messages"));
      const h = rec && rec.handlers.find((x) => x.filter && x.filter.event === "INSERT" && x.filter.table === "crm_messages");
      if (!h) return false;
      h.cb({ new: { id: "rt-synth-1", thread_id: "t-fredy", direction: "inbound", body: "SYNTHETIC REALTIME PAINT", sent_at: new Date().toISOString(), channel: "whatsapp", delivery_status: "delivered", media_kind: null, is_auto_reply: false, template_name: null } });
      return true;
    });
    await page.waitForTimeout(300);
    const after = await msgCount();
    const painted = await page.$$eval('[data-testid="crm-message"]', (els) => els.some((e) => /SYNTHETIC REALTIME PAINT/.test(e.textContent)));
    (fired && after === before + 1 && painted) ? ok("a synthetic realtime INSERT paints the new message with no refetch") : bad("realtime paint failed", `fired=${fired} before=${before} after=${after} painted=${painted}`); }

  // ══════════════ Phase 19 Step 2: one assertion PER realtime handler ══════════════
  // The Step-2 lift moves the ONE subscription's five handlers into a provider. One assertion per
  // handler — driven through the SAME subscription-boundary seam as the paint test — so a move
  // that drops or mis-wires any single handler is caught by name. This EXTENDS the net; the
  // original 13 assertion bodies are untouched.
  const fireRealtime = (event, table, newRow) => page.evaluate(({ event, table, newRow }) => {
    const rec = (window.__CRM_TEST_REALTIME__ || []).find((c) => c.handlers.some((h) => h.filter && h.filter.event === event && h.filter.table === table));
    const h = rec && rec.handlers.find((x) => x.filter && x.filter.event === event && x.filter.table === table);
    if (!h) return false;
    h.cb({ new: newRow, eventType: event });
    return true;
  }, { event, table, newRow });

  // (1) crm_messages INSERT → the list row's preview AND its waiting-since update.
  { const prevOf = (id) => page.$eval(`[data-testid="crm-thread-row"][data-thread-id="${id}"] [data-testid="crm-thread-preview"]`, (e) => e.textContent);
    const waitOf = (id) => page.$eval(`[data-testid="crm-thread-row"][data-thread-id="${id}"]`, (e) => e.getAttribute("data-waiting"));
    await fireRealtime("INSERT", "crm_messages", { id: "rt-out", thread_id: "t-marco", direction: "outbound", body: "handled, closing out", sent_at: new Date().toISOString(), channel: "whatsapp", delivery_status: "sent", media_kind: null, is_auto_reply: false, template_name: null });
    await page.waitForTimeout(150);
    const wAfterOut = await waitOf("t-marco"); // an outbound reply clears waiting-since
    await fireRealtime("INSERT", "crm_messages", { id: "rt-in", thread_id: "t-marco", direction: "inbound", body: "RT-PREVIEW-MARKER", sent_at: new Date().toISOString(), channel: "whatsapp", delivery_status: "delivered", media_kind: null, is_auto_reply: false, template_name: null });
    await page.waitForTimeout(200);
    const prev = await prevOf("t-marco"); const wAfterIn = await waitOf("t-marco"); // an inbound sets it + preview
    (/RT-PREVIEW-MARKER/.test(prev) && wAfterOut === "0" && wAfterIn === "1") ? ok("§handler crm_messages INSERT: list preview updates AND waiting-since flips (outbound clears, inbound sets)") : bad("crm_messages INSERT handler", `preview=${prev.slice(0, 30)} waitOut=${wAfterOut} waitIn=${wAfterIn}`); }

  // (2) crm_messages UPDATE → delivery status flips in the OPEN conversation.
  // Switch away and back so t-fredy reloads to its 3 fixture messages (the paint test left it at 4).
  await selectThread("t-sms", 2); await selectThread("t-fredy", 3);
  { const delOf = () => page.$$eval('[data-testid="crm-message"][data-direction="outbound"]', (els) => els[els.length - 1]?.getAttribute("data-delivery"));
    const before = await delOf();
    await fireRealtime("UPDATE", "crm_messages", { id: "m3", thread_id: "t-fredy", direction: "outbound", body: "let me check", sent_at: iso(5), channel: "whatsapp", delivery_status: "read", media_kind: null });
    await page.waitForTimeout(200);
    const after = await delOf();
    (before !== "read" && after === "read") ? ok("§handler crm_messages UPDATE: the open thread's outbound flips delivery status (→ read)") : bad("crm_messages UPDATE handler", `before=${before} after=${after}`); }

  // (3) crm_threads UPDATE → the list row AND the open thread's header both update.
  { const headerAmb = () => page.$eval('[data-testid="crm-conv-header"]', (e) => e.getAttribute("data-amb"));
    const beforeAmb = await headerAmb();
    await fireRealtime("UPDATE", "crm_threads", { id: "t-fredy", last_message_at: new Date().toISOString(), last_message_preview: "RT-THREAD-UPD", match_ambiguous: true, player_id: 1001, assigned_to_user_id: null, assigned_at: null, status: "open", closed_at: null, closed_by_user_id: null, no_reply_needed_at: null });
    await page.waitForTimeout(200);
    const rowPrev = await page.$eval('[data-testid="crm-thread-row"][data-thread-id="t-fredy"] [data-testid="crm-thread-preview"]', (e) => e.textContent);
    const afterAmb = await headerAmb();
    (/RT-THREAD-UPD/.test(rowPrev) && beforeAmb === "0" && afterAmb === "1") ? ok("§handler crm_threads UPDATE: list row preview updates AND the open header reflects it (match_ambiguous)") : bad("crm_threads UPDATE handler", `rowPrev=${rowPrev.slice(0, 24)} ambBefore=${beforeAmb} ambAfter=${afterAmb}`); }

  // (4) crm_threads INSERT → a debounced inbox reload (a fresh GET /api/crm/threads, >300ms debounce).
  { const before = listFetches;
    await fireRealtime("INSERT", "crm_threads", { id: "t-new", status: "open" });
    await page.waitForTimeout(600);
    (listFetches > before) ? ok("§handler crm_threads INSERT: fires the debounced inbox reload") : bad("crm_threads INSERT handler", `fetches ${before} → ${listFetches}`); }

  // (5) crm_thread_reads change → a debounced inbox reload.
  { const before = listFetches;
    await fireRealtime("*", "crm_thread_reads", { user_id: "op-1", thread_id: "t-fredy" });
    await page.waitForTimeout(600);
    (listFetches > before) ? ok("§handler crm_thread_reads: fires the debounced inbox reload") : bad("crm_thread_reads handler", `fetches ${before} → ${listFetches}`); }

  // ── Phase 19 Step 1: WITHOUT can_send_messages the composer is a disabled, read-only box ──
  // Separate context whose app_users grant sets can_send_messages=false — proves the courtesy-grey.
  { const roCtx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState });
    await crmRoutes(roCtx, false);
    const ro = await roCtx.newPage();
    await ro.addInitScript(() => { window.__CRM_TEST_REALTIME__ = []; });
    await ro.goto(PAGE, { waitUntil: "domcontentloaded" });
    await ro.waitForSelector('[data-testid="crm-thread-row"]', { timeout: 30000 });
    await ro.click('[data-testid="crm-thread-row"][data-thread-id="t-fredy"]');
    await ro.waitForFunction(() => document.querySelectorAll('[data-testid="crm-message"]').length === 3, null, { timeout: 8000 });
    const dis = await ro.$eval('[data-testid="crm-composer"]', (e) => e.disabled);
    const ph = await ro.$eval('[data-testid="crm-composer"]', (e) => e.placeholder);
    const sendDis = await ro.$eval('[data-testid="crm-send"]', (e) => e.disabled);
    (dis && sendDis && /permission|read-only/i.test(ph)) ? ok(`Step 1: without can_send_messages the composer is disabled read-only (\"${ph}\")`) : bad("read-only composer", `disabled=${dis} sendDisabled=${sendDis} placeholder=${ph}`);
    await roCtx.close(); }

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await browser.close();
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
