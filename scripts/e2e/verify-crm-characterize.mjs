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

const grantChats = (ctx) => ctx.route("**/rest/v1/app_users*", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  const res = await route.fetch(); let j = await res.json().catch(() => null);
  const p = (r) => ({ ...r, is_admin: true, can_access_chats: true, can_access_matchops: true });
  j = Array.isArray(j) ? j.map(p) : (j && typeof j === "object" ? p(j) : j);
  return route.fulfill({ status: res.status(), contentType: "application/json", body: JSON.stringify(j) });
});

async function crmRoutes(ctx) {
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
    if (path.endsWith("/api/crm/threads")) return json({ threads: THREADS, counts: COUNTS });
    if (path.endsWith("/api/crm/operators")) return json({ operators: [] });
    if (path.endsWith("/api/crm/metrics")) return json({ metrics: { cohort: { conversations: COUNTS.open, repliedCount: 2, medianFirstResponseMin: 12, answeredWithin1h: 2, answeredWithin1hPct: 100, resolved: 1, resolvedPct: 33 } }, trend: { cohortMedianDeltaMin: null }, awaiting: { count: COUNTS.awaiting } });
    if (/\/api\/crm\/threads\/[^/]+\/mark-read$/.test(path) && method === "POST") return json({ ok: true });
    if (/\/api\/crm\/threads\/[^/]+\/context$/.test(path)) return json({ player: null, membership: null, recent_matches: [], upcoming_matches: [], historical_account_count: null });
    const detailMatch = /\/api\/crm\/threads\/([^/]+)$/.exec(path);
    if (detailMatch && method === "GET") { const d = DETAIL[detailMatch[1]]; return d ? json(d) : json({ error: "not found" }, 404); }
    return json({}); // permissive catch-all for any other crm sub-route
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
  // Assert ONE subscription IDENTITY on crm_messages, not one channel object: React StrictMode +
  // effect re-runs re-create the SAME channel (all named "crm-stream-v2", each cleaned up), so a
  // cumulative object count is noise. The real invariant — and the bug the spec guards against (a
  // duplicate channel on crm_messages taking down pages) — is the number of DISTINCT channel names
  // that subscribe to crm_messages. That is 1.
  { const names = await page.evaluate(() => Array.from(new Set((window.__CRM_TEST_REALTIME__ || []).filter((c) => c.handlers.some((h) => h.filter && h.filter.event === "INSERT" && h.filter.table === "crm_messages")).map((c) => c.name))));
    eq("exactly ONE subscription identity on crm_messages (StrictMode re-creates the same channel)", names.length, 1); }
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

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await browser.close();
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
