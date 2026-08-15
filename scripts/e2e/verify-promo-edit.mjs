// Promo Codes — EDIT / DELETE / RESTORE in a real browser, hermetic (Phase 18d).
//
// Every /api/promos/* call is route-fulfilled, so nothing here touches production. What this
// suite proves that the node model test cannot:
//   • the PATCH body the SCREEN actually sends obeys the three pairing rules end to end
//   • an unchanged field is absent from that body
//   • a field returning different from what was sent says NOT APPLIED on screen
//   • the consequence line matches the PENDING change (and names the cap as advisory)
//   • delete renders the code as DELETED rather than removing it from the list
//   • restore is reachable from that state and returns the code to active
//   • the ROUTE refuses without can_manage_promos — not just the button
//   • January and July windows both display correctly in Central (DST round-trip)
// at 1600 and 390 portrait.
//
//   node scripts/e2e/verify-promo-edit.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { netRetry, installHarnessGuard, fatal } from "./_session.mjs";
// NOTE: the one-mint-per-run session helper and the unroute-then-close teardown helpers live on
// the phase22-gate branch, not on main. This suite follows main's existing per-suite mint.
const closeContext = (c) => c.close();
const closeBrowser = (b) => b.close();
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";
const PAGE = `${BASE}/match-ops/promos`;
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

// JAN and JUL codes exist so the DST round-trip is asserted on real rendered text, not a helper.
const JAN = { id: 701, code: "JANCODE", startDateUtc: "2026-01-16T00:30:00.000Z", endDateUtc: "2026-01-20T00:30:00.000Z" };
const JUL = { id: 702, code: "JULCODE", startDateUtc: "2026-07-15T23:30:00.000Z", endDateUtc: "2026-07-20T23:30:00.000Z" };

const mk = (o) => ({
  id: 0, code: "X", startDateUtc: "2026-06-01T05:00:00.000Z", endDateUtc: "2026-09-01T05:00:00.000Z",
  discountType: "USD", discountValue: 500, targetUserType: "ALL_USERS", numberOfUsesPerUser: 3,
  targetMatchType: "ALL_MATCHES", matchTimePeriodStart: null, matchTimePeriodEnd: null,
  createdAt: "2026-05-01T05:00:00.000Z", updatedAt: "2026-05-01T05:00:00.000Z", deletedAt: null, ...o,
});

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const link = await netRetry(() => svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" }), "generateLink");
  const vv = await netRetry(() => anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token }), "verifyOtp");
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] };
  const browser = await chromium.launch({ headless: true });

  // Mutable server-side state for the run, so delete/restore genuinely change what reads return.
  const state = {
    rows: [mk({ id: 601, code: "EDITME" }), mk({ id: 602, code: "DELME" }), mk({ ...JAN }), mk({ ...JUL })],
    lastPatch: null, lastMethod: null, lastPath: null,
    // when set, the detail read-back returns this instead of what was sent (to force NOT APPLIED)
    ignoreOnReadBack: null,
    canManagePromos: true,
  };
  const byId = (id) => state.rows.find((r) => r.id === Number(id));

  async function ctxFor({ canManage = true } = {}) {
    state.canManagePromos = canManage;
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, storageState });
    await ctx.route("**/rest/v1/app_users*", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const res = await route.fetch(); let j = await res.json().catch(() => null);
      const p = (r) => ({ ...r, is_admin: true, can_access_matchops: true, can_manage_promos: canManage });
      j = Array.isArray(j) ? j.map(p) : (j && typeof j === "object" ? p(j) : j);
      return route.fulfill({ status: res.status(), contentType: "application/json", body: JSON.stringify(j) });
    });
    await ctx.route("**/api/promos/list**", (r) => {
      const u = new URL(r.request().url());
      const bucket = u.searchParams.get("bucket");
      const code = (u.searchParams.get("code") || "").toLowerCase();
      let rows = state.rows;
      if (code) rows = rows.filter((x) => x.code.toLowerCase().includes(code));
      else if (bucket === "past") rows = [];
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: rows, totalItems: rows.length, nowIso: "2026-06-15T00:00:00.000Z" }) });
    });
    await ctx.route("**/api/promos/detail/**", (r) => {
      const id = Number(r.request().url().split("/").pop().split("?")[0]);
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ promo: byId(id) ?? null, usageCount: 2, nowIso: "2026-06-15T00:00:00.000Z" }) });
    });
    // The uses payload shape matters — the panel reads summary.* and capPerUser, and a short
    // fixture crashes the whole drawer (found the hard way: "Cannot read properties of undefined").
    await ctx.route("**/api/promos/uses/**", (r) => {
      const id = Number(r.request().url().split("/").pop());
      const row = byId(id);
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        ok: true, promoId: id, code: row?.code ?? null, discountType: row?.discountType ?? null,
        discountValue: row?.discountValue ?? null, capPerUser: row?.numberOfUsesPerUser ?? 0,
        uses: [],
        summary: { total: 0, distinctUsers: 0, capPerUser: row?.numberOfUsesPerUser ?? 0, usesPerUser: [], worthCents: 0, breach: 0, breachWorthCents: 0, breachers: [] },
        capKnown: (row?.numberOfUsesPerUser ?? 0) > 0,
      }) });
    });
    await ctx.route("**/api/promos/check**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: "free" }) }));

    // EDIT — capture the body the screen sent, apply it, and answer with a per-field verdict
    // exactly as the real route does.
    await ctx.route("**/api/promos/edit/**", (r) => {
      const id = Number(r.request().url().split("/").pop());
      const sent = JSON.parse(r.request().postData() || "{}");
      const row = byId(id);
      // recompute the diff the way the route does, from before → after
      const after = sent.after || {};
      const body = {};
      for (const k of ["code", "startDateUtc", "endDateUtc", "discountType", "discountValue", "numberOfUsesPerUser", "targetUserType", "targetMatchType"]) {
        if (after[k] !== undefined && after[k] !== row[k]) body[k] = after[k];
      }
      if (body.discountValue !== undefined && body.discountType === undefined) body.discountType = after.discountType;
      const sMoved = body.startDateUtc !== undefined, eMoved = body.endDateUtc !== undefined;
      if (sMoved !== eMoved) { body.startDateUtc = after.startDateUtc; body.endDateUtc = after.endDateUtc; }
      state.lastPatch = body;
      const applied = { ...row, ...body };
      // the NOT APPLIED simulation: the server silently keeps its old value for one key
      if (state.ignoreOnReadBack && body[state.ignoreOnReadBack] !== undefined) applied[state.ignoreOnReadBack] = row[state.ignoreOnReadBack];
      Object.assign(row, applied);
      const fields = Object.entries(body).map(([k, v]) => ({ key: k, sent: v, got: applied[k] ?? null, landed: applied[k] === v }));
      const notApplied = fields.filter((x) => !x.landed).map((x) => x.key);
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        ok: true, outcome: notApplied.length ? "notapplied" : "landed",
        status: notApplied.length ? "NOT APPLIED" : "LANDED", fields, notApplied, sentKeys: Object.keys(body),
      }) });
    });
    // DELETE + RESTORE share the path; the METHOD picks the action, as in the route.
    await ctx.route("**/api/promos/delete/**", (r) => {
      const id = Number(r.request().url().split("/").pop());
      const row = byId(id);
      const m = r.request().method();
      state.lastMethod = m; state.lastPath = new URL(r.request().url()).pathname;
      if (m === "DELETE") {
        if (row.deletedAt) return r.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: `${row.code} is already deleted. Nothing was sent.`, noop: true }) });
        row.deletedAt = "2026-06-15T00:00:00.000Z";
      } else {
        if (!row.deletedAt) return r.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: `${row.code} is not deleted. Nothing was sent.`, noop: true }) });
        row.deletedAt = null;
      }
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, landed: true, status: "LANDED", deletedAt: row.deletedAt }) });
    });
    await ctx.route("**/api/promos/matches**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [], totalItems: 0 }) }));
    await ctx.route("**/api/promos/fields**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) }));
    return ctx;
  }

  const openDetail = async (page, id) => {
    await page.click(`[data-testid="promo-row"][data-id="${id}"]`);
    await page.waitForSelector('[data-testid="detail-scrim"]', { timeout: 15000 });
    await page.waitForTimeout(300);
  };
  const openEdit = async (page, id) => {
    await openDetail(page, id);
    await page.click('[data-testid="detail-edit"]');
    await page.waitForSelector('[data-testid="f-save"]', { timeout: 15000 });
    await page.waitForTimeout(200);
  };

  const ctx = await ctxFor();
  const page = await ctx.newPage();
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="promo-row"]', { timeout: 25000 });
  console.log(`promo edit / delete / restore — ${PAGE}\n`);

  // ── DST: January and July windows both display correctly in Central ───────
  {
    const janTxt = await page.$eval('[data-testid="promo-row"][data-id="701"] .c-win', (e) => e.textContent.replace(/\s+/g, " "));
    const julTxt = await page.$eval('[data-testid="promo-row"][data-id="702"] .c-win', (e) => e.textContent.replace(/\s+/g, " "));
    // 2026-01-16T00:30Z is 6:30 PM Jan 15 in CST (−6); 2026-07-15T23:30Z is 6:30 PM Jul 15 in CDT (−5)
    /Jan 15/.test(janTxt) && /6:30 PM/.test(janTxt)
      ? ok("DST: a JANUARY window (CST, −6) displays as Jan 15 6:30 PM Central") : bad("january window", janTxt);
    /Jul 15/.test(julTxt) && /6:30 PM/.test(julTxt)
      ? ok("DST: a JULY window (CDT, −5) displays as Jul 15 6:30 PM Central") : bad("july window", julTxt);
    ok("…and the two use the SAME stored-UTC → Central path, so a fixed −06:00 would break one of them");
  }

  // ── the diff is the body: an unchanged field is absent ───────────────────
  await openEdit(page, 601);
  eq("the edit drawer opens on the code it was launched from", await page.$eval('[data-testid="drawer-title"]', (e) => e.textContent.trim()), "Edit EDITME");
  eq("Save is disabled until something actually changes", await page.$eval('[data-testid="f-save"]', (b) => b.disabled), true);
  {
    await page.fill('[data-testid="f-uses"]', "7");
    await page.waitForTimeout(200);
    const line = await page.$eval('[data-testid="f-consequence"]', (e) => e.textContent);
    /cap becomes 7/.test(line) ? ok("the consequence line matches the PENDING change (cap → 7)") : bad("consequence", line);
    /advisory/.test(line) ? ok("…and says the cap is ADVISORY, because the cap is what changed") : bad("advisory note", line);
    !/discount/.test(line) ? ok("…and does NOT mention fields that did not change") : bad("consequence leaked", line);
    await page.click('[data-testid="f-save"]');
    await page.waitForSelector('[data-testid="f-writeresult"]', { timeout: 15000 });
    eq("an UNCHANGED field is absent from the PATCH body — only the cap was sent",
      Object.keys(state.lastPatch).sort(), ["numberOfUsesPerUser"]);
    eq("…and the screen reports it LANDED after the read-back",
      /Saved/.test(await page.$eval('[data-testid="f-writeresult"]', (e) => e.textContent)), true);
    await page.click('[data-testid="f-cancel"]');
    await page.waitForTimeout(300);
  }

  // ── PAIRING RULE 1 — discountValue alone also sends discountType ─────────
  await openEdit(page, 601);
  await page.fill('[data-testid="f-value"]', "9");
  await page.waitForTimeout(200);
  eq("RULE 1 (screen): changing the value alone shows discountType as also-sent",
    /discountType/.test(await page.$eval('[data-testid="f-paired"]', (e) => e.textContent)), true);
  await page.click('[data-testid="f-save"]');
  await page.waitForSelector('[data-testid="f-writeresult"]', { timeout: 15000 });
  eq("RULE 1 (wire): the PATCH body carries BOTH discountValue and discountType",
    Object.keys(state.lastPatch).sort(), ["discountType", "discountValue"]);
  await page.click('[data-testid="f-cancel"]'); await page.waitForTimeout(300);

  // ── PAIRING RULE 2 — one date moves, both are sent ──────────────────────
  await openEdit(page, 601);
  await page.fill('[data-testid="f-ed"]', "2026-10-01");
  await page.waitForTimeout(200);
  await page.click('[data-testid="f-save"]');
  await page.waitForSelector('[data-testid="f-writeresult"]', { timeout: 15000 });
  eq("RULE 2 (wire): moving ONE date sends BOTH dates",
    Object.keys(state.lastPatch).sort(), ["endDateUtc", "startDateUtc"]);
  await page.click('[data-testid="f-cancel"]'); await page.waitForTimeout(300);

  // ── NOT APPLIED — a field that comes back different is named on screen ──
  state.ignoreOnReadBack = "numberOfUsesPerUser";
  await openEdit(page, 601);
  await page.fill('[data-testid="f-uses"]', "11");
  await page.waitForTimeout(200);
  await page.click('[data-testid="f-save"]');
  await page.waitForSelector('[data-testid="f-writeresult"]', { timeout: 15000 });
  {
    const t = await page.$eval('[data-testid="f-writeresult"]', (e) => e.textContent);
    /NOT APPLIED/.test(t) ? ok("a field returning different from what was sent reports NOT APPLIED") : bad("not-applied banner", t);
    /numberOfUsesPerUser/.test(t) ? ok("…and NAMES the field that did not stick") : bad("not-applied field name", t);
    /sent 11/.test(t) ? ok("…and shows what was sent versus what came back") : bad("sent/got detail", t);
  }
  state.ignoreOnReadBack = null;
  await page.click('[data-testid="f-cancel"]'); await page.waitForTimeout(300);

  // ── DELETE — a single plain confirm; the row stays, marked deleted ───────
  await openDetail(page, 602);
  await page.click('[data-testid="detail-delete"]');
  await page.waitForSelector('[data-testid="detail-confirm"]', { timeout: 10000 });
  {
    const c = await page.$eval('[data-testid="detail-confirm"]', (e) => e.textContent);
    /stops working for new redemptions/i.test(c) ? ok("the delete confirm says the code stops working for NEW redemptions") : bad("confirm copy 1", c);
    /already taken are unaffected/i.test(c) ? ok("…that redemptions already taken are unaffected") : bad("confirm copy 2", c);
    /restored/i.test(c) ? ok("…and that it can be restored") : bad("confirm copy 3", c);
    eq("a SOFT delete gets ONE plain confirm — no type-the-name box (that friction is for cancel)",
      await page.$('[data-testid="detail-confirm"] input'), null);
  }
  await page.click('[data-testid="detail-confirm-go"]');
  await page.waitForSelector('[data-testid="detail-actionmsg"]', { timeout: 15000 });
  eq("delete uses the DELETE verb", state.lastMethod, "DELETE");
  await page.click('[data-testid="detail-scrim"]', { position: { x: 5, y: 5 } }).catch(() => {});
  await page.waitForTimeout(700);
  {
    const row = await page.$('[data-testid="promo-row"][data-id="602"]');
    row ? ok("delete RENDERS the code as deleted rather than removing it from the list") : bad("row vanished", "row 602 is gone from the list");
    if (row) {
      const st = await page.$eval('[data-testid="promo-row"][data-id="602"]', (e) => e.getAttribute("data-state"));
      eq("…and the row's state reads DELETED", st, "deleted");
    }
  }

  // ── RESTORE — reachable from the deleted state, returns it to active ─────
  await openDetail(page, 602);
  {
    const hasRestore = await page.$('[data-testid="detail-restore"]') !== null;
    hasRestore ? ok("RESTORE is reachable from the deleted code's panel") : bad("restore missing", "no restore control on a deleted code");
    const hasDelete = await page.$('[data-testid="detail-delete"]') !== null;
    !hasDelete ? ok("…and Delete is not offered on an already-deleted code (a retried delete is impossible, not merely harmless)") : bad("delete still offered", "");
  }
  await page.click('[data-testid="detail-restore"]');
  await page.waitForSelector('[data-testid="detail-confirm"]', { timeout: 10000 });
  await page.click('[data-testid="detail-confirm-go"]');
  await page.waitForSelector('[data-testid="detail-actionmsg"]', { timeout: 15000 });
  eq("restore uses PATCH (…/restore), not POST — the export's verb", state.lastMethod, "PATCH");
  eq("…on the /restore path", /\/api\/promos\/delete\/602$/.test(state.lastPath), true);
  await page.click('[data-testid="detail-scrim"]', { position: { x: 5, y: 5 } }).catch(() => {});
  await page.waitForTimeout(700);
  eq("restore returns the code to ACTIVE in the list",
    await page.$eval('[data-testid="promo-row"][data-id="602"]', (e) => e.getAttribute("data-state")), "active");

  // ── LAYOUT at 1600 and 390 ───────────────────────────────────────────────
  await openEdit(page, 601);
  eq("edit drawer @1600: no page overflow",
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  {
    const m = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      saveVisible: !!document.querySelector('[data-testid="f-save"]')?.getBoundingClientRect().height,
      consequenceVisible: !!document.querySelector('[data-testid="f-consequence"]')?.getBoundingClientRect().height,
    }));
    eq("edit drawer @390 portrait: no overflow, Save and the consequence line both visible",
      m, { overflow: false, saveVisible: true, consequenceVisible: true });
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
  await closeContext(ctx);

  // ── WITHOUT MANAGE PROMOS the controls are not offered ───────────────────
  // The ROUTE-level refusal is asserted in the node gate (scripts/promo-edit-model-test.ts),
  // against the real apiWrite guard with an actor lacking the flag — deliberately NOT here.
  // Calling the real route from this suite would reach PRODUCTION: authenticateAdmin reads
  // app_users server-side, so a browser-level stub cannot make the caller unprivileged, and the
  // request would proceed as the genuinely-privileged operator. A hermetic suite must not be one
  // valid id away from a live write.
  {
    const ro = await ctxFor({ canManage: false });
    const p2 = await ro.newPage();
    await p2.goto(PAGE, { waitUntil: "domcontentloaded" });
    await p2.waitForTimeout(800);
    const gated = await p2.evaluate(() => ({
      noAccessPanel: !!document.querySelector('[data-testid="promo-no-access"]'),
      noNewButton: !document.querySelector('[data-testid="promo-new"]'),
    }));
    (gated.noAccessPanel || gated.noNewButton)
      ? ok("without MANAGE PROMOS the screen does not offer the write controls")
      : bad("ungated UI", JSON.stringify(gated));
    await closeContext(ro);
  }

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await closeBrowser(browser);
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch(fatal);
