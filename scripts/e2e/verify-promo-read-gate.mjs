// THE PROMO SCREEN OPENS ON THE READ, NOT THE WRITE.
//
// THE BUG THIS PINS. /api/promos/list has been on the Match Ops READ gate since Phase 23 Part D
// (list/route.ts:19-20). The client never followed: PromoCodes.tsx gated the whole screen on
// canManagePromos, the WRITE flag, which exactly ONE account in the estate holds. Fifteen people —
// five of them admins, since canManagePromos deliberately does not short-circuit on is_admin —
// were shown "You do not hold MANAGE PROMOS" for a list the server would have returned.
//
// HOW THE SHAPES ARE SIMULATED. Server-side auth reads the REAL app_users row, so a browser cannot
// impersonate a non-admin against the API. What IS under test here is the CLIENT gate, so the
// app_users REST response is rewritten per case and the list endpoint is served a fixture. No
// account is created, no flag is granted, and no promo write is ever issued.
//
//   node scripts/e2e/verify-promo-read-gate.mjs
import { chromium } from "playwright";
import { installHarnessGuard, fatal, closeContext, closeBrowser, storageStateFor } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";
const ADMIN = "rmancuso@playmatchday.com";

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

// Two live codes and one past, enough to prove rows render and a detail drawer opens.
const NOW = "2026-08-18T00:00:00.000Z";
// A COMPLETE PromoRow (promoModel.ts:14-29). A partial one renders as zero rows, which would make
// every assertion below pass for the wrong reason.
const CODE = (id, code, end) => ({
  id, code,
  startDateUtc: "2026-08-01T00:00:00.000Z", endDateUtc: end,
  discountType: "PERCENT", discountValue: 20,
  targetUserType: "ALL", numberOfUsesPerUser: 1, targetMatchType: "ALL",
  matchTimePeriodStart: null, matchTimePeriodEnd: null,
  createdAt: "2026-07-01T00:00:00.000Z", deletedAt: null,
});
const LIVE = [CODE(9001, "GATEFIXTURE1", "2026-12-01T00:00:00.000Z"), CODE(9002, "GATEFIXTURE2", "2026-11-01T00:00:00.000Z")];
const PAST = [CODE(9003, "GATEFIXTURE3", "2026-01-01T00:00:00.000Z")];

async function openAs(browser, storageState, shape) {
  const ctx = await browser.newContext({ storageState, viewport: { width: 1600, height: 1000 } });
  // Rewrite ONLY the app_users row — everything else on rest/v1 passes through untouched, because
  // stubbing that path wholesale bounces the page to /login?error=not_authorized.
  await ctx.route("**/rest/v1/app_users**", async (route) => {
    const resp = await route.fetch();
    const body = await resp.json().catch(() => null);
    const row = Array.isArray(body) ? body[0] : body;
    await route.fulfill({ response: resp, body: JSON.stringify(row ? shape(row) : row),
      headers: { ...resp.headers(), "content-type": "application/json" } });
  });
  // The list fixture — this machine has no MatchDay read creds, and the gate under test is the
  // client's, not the API's.
  await ctx.route("**/api/promos/list**", async (route) => {
    const u = new URL(route.request().url());
    const rows = u.searchParams.get("bucket") === "live" ? LIVE : PAST;
    await route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ data: rows, totalItems: rows.length, nowIso: NOW, page: 1, pageSize: 25 }) });
  });
  await ctx.route("**/api/promos/detail/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ promo: LIVE[0], usageCount: 3, nowIso: NOW }) });
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/match-ops/promos`, { waitUntil: "domcontentloaded" });
  // A POSITIVE READY SIGNAL before any absence check: either the screen or the refusal resolved.
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="promos"], [data-testid="promo-no-access"]'),
    null, { timeout: 60000 },
  );
  // The rail is drawn by the Match Ops layout, not by this screen — wait for it separately, or a
  // "the rail lists Promo Codes" assertion reads an empty layout and fails for the wrong reason.
  await page.waitForSelector('[data-testid="rail-item"]', { timeout: 60000 }).catch(() => {});
  // If the screen opened, the fixture rows must be painted before anything reads them.
  if (await page.locator('[data-testid="promos"]').count()) {
    await page.waitForSelector('[data-testid="promo-row"]', { timeout: 60000 });
  }
  return { ctx, page };
}

const read = (page) => page.evaluate(() => {
  const t = (s) => document.querySelector(`[data-testid="${s}"]`);
  const btn = (s) => { const e = t(s); return e ? { present: true, disabled: e.disabled === true, why: e.getAttribute("title") } : { present: false }; };
  return {
    denial: t("promo-no-access")?.innerText.replace(/\n/g, " · ") ?? null,
    screen: !!t("promos"),
    codes: [...document.querySelectorAll('[data-testid="promo-row"]')].length,
    codeText: document.body.innerText.match(/GATEFIXTURE\d/g) ?? [],
    create: btn("promo-new"),
    createWhy: t("promo-new-why")?.innerText ?? null,
  };
});

async function main() {
  process.loadEnvFile(".env.local");
  const { storageState } = await storageStateFor(ADMIN, BASE);
  const browser = await chromium.launch();

  // Deonna's exact shape, and the five admins who do not hold the write flag.
  const DEONNA = (r) => ({ ...r, is_admin: false, can_access_matchops: true, can_manage_promos: false, is_city_manager: false, is_service_account: false });
  const ADMIN_NO_PROMOS = (r) => ({ ...r, is_admin: true, can_access_matchops: true, can_manage_promos: false });
  const HOLDER = (r) => ({ ...r, is_admin: false, can_access_matchops: true, can_manage_promos: true });
  const NEITHER = (r) => ({ ...r, is_admin: false, can_access_matchops: false, can_manage_promos: false, is_city_manager: false });

  console.log("a non-admin with Match Ops and NO manage-promos (Deonna's shape) can read the codes:");
  {
    const { ctx, page } = await openAs(browser, storageState, DEONNA);
    const r = await read(page);
    eq("no refusal is shown", r.denial, null);
    eq("the promo screen renders", r.screen, true);
    eq("the codes themselves are on the page", r.codeText.includes("GATEFIXTURE1") && r.codeText.includes("GATEFIXTURE2"), true);
    eq("'+ New promo code' is PRESENT (not hidden)", r.create.present, true);
    eq("…and DISABLED", r.create.disabled, true);
    eq("…and says why, on the control", /MANAGE PROMOS/.test(r.create.why ?? ""), true);
    eq("…and says why, beside it", r.createWhy, "Needs MANAGE PROMOS");
    // The rail must offer the page it may now open.
    const rail = await page.evaluate(() => !!document.querySelector('[data-testid="rail-item"][data-key="promos"]'));
    const railN = await page.evaluate(() => document.querySelectorAll('[data-testid="rail-item"]').length);
    eq("the rail lists Promo Codes", rail, true);
    eq("  control — the rail rendered at all", railN > 1, true);

    // Edit / Delete inside the detail drawer: reachable to LOOK at, refused to USE.
    await page.locator('[data-testid="promo-row"]').first().click();
    await page.waitForSelector('[data-testid="detail-edit"]', { timeout: 30000 });
    // READY SIGNAL, NOT JUST PRESENCE. Edit is disabled while `p` is undefined too, so asserting
    // on it mid-load reads "disabled" for a reason that has nothing to do with the permission.
    await page.waitForFunction(
      () => /GATEFIXTURE1/.test(document.querySelector('[data-testid="detail-scrim"]')?.innerText ?? ""),
      null, { timeout: 30000 },
    );
    const d = await page.evaluate(() => {
      const g = (s) => { const e = document.querySelector(`[data-testid="${s}"]`); return e ? { present: true, disabled: e.disabled === true, why: e.getAttribute("title") } : { present: false }; };
      return { edit: g("detail-edit"), del: g("detail-delete"), why: document.querySelector('[data-testid="detail-why"]')?.innerText ?? null };
    });
    eq("Edit is present but disabled", { p: d.edit.present, dis: d.edit.disabled }, { p: true, dis: true });
    eq("Delete is present but disabled", { p: d.del.present, dis: d.del.disabled }, { p: true, dis: true });
    eq("both carry the reason", /MANAGE PROMOS/.test(d.edit.why ?? "") && /MANAGE PROMOS/.test(d.del.why ?? ""), true);
    eq("…and it is stated beside them too", d.why, "Needs MANAGE PROMOS");
    await closeContext(ctx);
  }

  console.log("\nPOSITIVE CONTROL — the SAME selectors, with the flag held, are enabled:");
  {
    const { ctx, page } = await openAs(browser, storageState, HOLDER);
    const r = await read(page);
    eq("the screen renders", r.screen, true);
    eq("'+ New promo code' is ENABLED", { present: r.create.present, disabled: r.create.disabled }, { present: true, disabled: false });
    eq("…with no reason attached", r.create.why, null);
    eq("no 'needs the flag' note", r.createWhy, null);
    await page.locator('[data-testid="promo-row"]').first().click();
    await page.waitForSelector('[data-testid="detail-edit"]', { timeout: 30000 });
    // READY SIGNAL, NOT JUST PRESENCE. Edit is disabled while `p` is undefined too, so asserting
    // on it mid-load reads "disabled" for a reason that has nothing to do with the permission.
    await page.waitForFunction(
      () => /GATEFIXTURE1/.test(document.querySelector('[data-testid="detail-scrim"]')?.innerText ?? ""),
      null, { timeout: 30000 },
    );
    const d = await page.evaluate(() => {
      const g = (s) => { const e = document.querySelector(`[data-testid="${s}"]`); return e ? { present: true, disabled: e.disabled === true } : { present: false }; };
      return { edit: g("detail-edit"), del: g("detail-delete") };
    });
    // THIS is what makes the disabled-assertions above mean something: the same selectors find
    // enabled controls in the same run, so "disabled" is a real reading and not a missing element.
    eq("Edit is found and ENABLED", d.edit, { present: true, disabled: false });
    eq("Delete is found and ENABLED", d.del, { present: true, disabled: false });
    await closeContext(ctx);
  }

  console.log("\nan ADMIN without manage-promos reads the codes too (five of the six admins):");
  {
    const { ctx, page } = await openAs(browser, storageState, ADMIN_NO_PROMOS);
    const r = await read(page);
    eq("no refusal", r.denial, null);
    eq("codes render", r.codeText.includes("GATEFIXTURE1"), true);
    eq("create is still disabled — admin does not imply the write flag", r.create.disabled, true);
    await closeContext(ctx);
  }

  console.log("\na user with NEITHER flag is still refused, and told which access is missing:");
  {
    const { ctx, page } = await openAs(browser, storageState, NEITHER);
    const r = await read(page);
    eq("the screen does NOT render", r.screen, false);
    eq("a refusal IS shown", r.denial !== null, true);
    eq("it names Match Ops, the access actually missing", /Match Ops/.test(r.denial ?? ""), true);
    eq("no codes leak into the refusal", r.codeText.length, 0);
    // control for that zero: the same scrape found codes in the cases above.
    await closeContext(ctx);
  }

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await closeBrowser(browser);
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch(fatal);
