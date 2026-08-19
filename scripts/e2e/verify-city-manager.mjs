// Phase 25 Part B — the city manager's Manager Pay, RENDERED.
//
// No real city-manager account exists yet (deliberate), and server auth reads the real app_users
// row — so this suite mocks the ROW (to render the page) and the city-week API (to control the
// week). The SERVER-SIDE refusals are not mocked and not asserted here: they are proven as pure
// functions in scripts/city-manager-test.ts, which is where they belong.
//   node scripts/e2e/verify-city-manager.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { netRetry, installHarnessGuard, fatal, sessionFor } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";
const PAGE = `${BASE}/city/manager-pay`;
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const CITY = "DFW";
const mon = (() => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
const M = (id, o) => ({
  matchId: id, fieldTitle: o.field, startDate: `${mon}T19:00:00`, centralDate: mon,
  centralWeekday: o.day, centralTime: "7:00 PM", name: o.field, maxPlayerCount: o.max ?? 18,
  playerCount: 12, isCancelled: !!o.cancelled, primaryManagerName: o.mgr ?? null,
  primaryManagerEmail: o.email ?? null, secondManagerName: o.second ?? null, managerId: o.mgrId ?? null,
});
const MATCHES = [
  M(101, { field: "Crossbar", day: "Mon", mgr: "Rooby Amilcar", email: "rooby@x.com", mgrId: 1 }),
  M(102, { field: "Hattrick", day: "Tue", mgr: null }),                    // UNASSIGNED
  M(103, { field: "Oak Cliff", day: "Wed", cancelled: true, mgr: "Lemmy", mgrId: 2 }), // CANCELLED
  M(104, { field: "Rally", day: "Thu", mgr: "Lemmy", email: "lemmy@x.com", mgrId: 2, max: 30 }), // tournament
];
const MANAGERS = [
  { managerEmail: "rooby@x.com", managerName: "Rooby Amilcar", managerId: 1, matchCount: 1, baseTotal: 20, adjustment: 0, adjustmentNotes: null, total: 20 },
  { managerEmail: "lemmy@x.com", managerName: "Lemmy", managerId: 2, matchCount: 1, baseTotal: 30, adjustment: 10, adjustmentNotes: "late cover", total: 40 },
];
const PAYLOAD = {
  weekStart: mon, weekEnd: mon, payDate: mon, cityIdentifier: CITY,
  city: { cityIdentifier: CITY, managers: MANAGERS, matches: MATCHES, total: 60, baseTotal: 50, adjustment: 10 },
  managers: [{ id: 1, name: "Rooby Amilcar", email: "rooby@x.com" }, { id: 2, name: "Lemmy", email: "lemmy@x.com" }],
  you: { email: "rmancuso@playmatchday.com", matched: false, unmatchedAccount: true },
};

async function routes(ctx) {
  await ctx.route("**/api/manager-pay/city-week**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PAYLOAD) }));
  // the app_users ROW carries the tier so the page renders; the server gate is tested elsewhere
  await ctx.route("**/rest/v1/app_users*", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch(); let b = await res.json().catch(() => null);
    const p = (r) => ({ ...r, is_city_manager: true, city_identifier: CITY });
    b = Array.isArray(b) ? b.map(p) : (b && typeof b === "object" ? p(b) : b);
    return route.fulfill({ status: res.status(), contentType: "application/json", body: JSON.stringify(b) });
  });
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
    await page.goto(PAGE, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="match-card"]', { timeout: 25000 });

    // ── GATE 2 — no city filter, no "All cities" ──
    eq("gate2: a fixed city badge, no city filter, and no 'All cities' anywhere", {
      badge: await page.$eval('[data-testid="city-badge"]', (e) => e.textContent.trim()),
      allCities: (await page.content()).includes("All cities"),
      selects: await page.$$eval("select", (s) => s.length), // ZERO before a sheet opens
    }, { badge: CITY, allCities: false, selects: 0 });

    // ── GATE 3 — zero form controls before a sheet; exactly one inside it ──
    eq("gate3a: ZERO form controls on the page before a match is opened",
      await page.$$eval("input,select,textarea", (e) => e.length), 0);
    await page.click('[data-testid="match-card"][data-match-id="101"]');
    await page.waitForSelector('[data-testid="match-sheet"]', { timeout: 8000 });
    eq("gate3b: EXACTLY ONE form control inside the sheet — the manager dropdown", {
      controls: await page.$$eval('[data-testid="match-sheet"] input,[data-testid="match-sheet"] select,[data-testid="match-sheet"] textarea', (e) => e.length),
      isManager: await page.$eval('[data-testid="match-sheet"] select', (e) => e.getAttribute("data-testid")),
      scopeLine: await page.$eval('[data-testid="sheet-scope"]', (e) => e.textContent.trim()),
    }, { controls: 1, isManager: "sheet-manager", scopeLine: `Only managers in ${CITY} can be assigned.` });

    // ── GATE 7 — the impact line names both people and both new totals ──
    await page.selectOption('[data-testid="sheet-manager"]', "2");
    await page.waitForSelector('[data-testid="sheet-impact"]', { timeout: 5000 });
    eq("gate7: the impact line names both people and both new totals, before the click", {
      impact: await page.$eval('[data-testid="sheet-impact"]', (e) => e.textContent.replace(/\s+/g, " ").trim()),
      save: await page.$eval('[data-testid="sheet-save"]', (e) => e.textContent.trim()),
    }, { impact: "$20 moves from Rooby Amilcar to Lemmy. Rooby Amilcar's total becomes $0, Lemmy's becomes $60.", save: "Assign Lemmy" });
    await page.click('[data-testid="sheet-close"]');

    // ── GATE 8 — a cancelled match: control disabled, reason about PAY ──
    await page.click('[data-testid="match-card"][data-match-id="103"]');
    await page.waitForSelector('[data-testid="match-sheet"]', { timeout: 8000 });
    eq("gate8: a cancelled match's dropdown is DISABLED and the reason is about pay", {
      disabled: await page.$eval('[data-testid="sheet-manager"]', (e) => e.disabled),
      saveDisabled: await page.$eval('[data-testid="sheet-save"]', (e) => e.disabled),
      reason: await page.$eval('[data-testid="sheet-locked"]', (e) => e.textContent.trim()),
    }, { disabled: true, saveDisabled: true, reason: "This match was cancelled, so it pays nobody. Players were credited and told." });
    await page.click('[data-testid="sheet-close"]');

    // ── GATE 4 — no adjustment controls anywhere ──
    eq("gate4: no add-adjustment or edit-adjustment control, and pay is stated read-only", {
      addBtns: await page.$$eval("button,a", (els) => els.filter((e) => /adjust/i.test(e.textContent || "")).length),
      readonly: (await page.$eval('[data-testid="readonly-note"]', (e) => e.textContent)).includes("read-only"),
    }, { addBtns: 0, readonly: true });

    // ITEMISED: this asserted the unmatched-login WARNING rendered. It is deleted. Nothing is wrong
    // when the login email is not among a city's manager rows — the pay, the scope and every figure
    // are correct; the only effect is that no row carries the YOU chip. The warning announced a
    // problem that did not exist. The unassigned callout is unrelated and still asserted, which is
    // also the positive control: the same $$eval finds an element that SHOULD be there, so the zero
    // beside it is a real reading and not a page that failed to render.
    eq("the unassigned callout renders, and no unmatched-login warning does", {
      callout: await page.$$eval('[data-testid="unassigned-note"]', (e) => e.length),
      unmatched: await page.$$eval('[data-testid="unmatched-account"]', (e) => e.length),
    }, { callout: 1, unmatched: 0 });

    // ── GATE 12 — layout at 1600 and 390 ──
    const layout = async (w) => {
      await page.setViewportSize({ width: w, height: 1000 });
      await page.waitForTimeout(350);
      return page.evaluate(() => {
        const de = document.documentElement;
        const clipped = (el) => { let a = el.parentElement; while (a && a !== de) { const o = getComputedStyle(a).overflowX; if (o === "auto" || o === "hidden" || o === "scroll") return true; a = a.parentElement; } return false; };
        const over = [...document.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().right > de.clientWidth + 1 && !clipped(e)).length;
        // a mobile-only block must not show at desktop, by COMPUTED display
        const mobileOnly = [...document.querySelectorAll(".cm-only-mobile")].filter((e) => getComputedStyle(e).display !== "none").length;
        const week = document.querySelector('[data-testid="week"]');
        return { overflow: de.scrollWidth - de.clientWidth, unclipped: over, mobileOnlyShowing: mobileOnly, weekCols: week ? getComputedStyle(week).gridTemplateColumns.split(" ").length : 0 };
      });
    };
    const at1600 = await layout(1600);
    eq("gate12a: 1600 — no overflow, no mobile-only block leaking (computed display), week is 7 columns",
      at1600, { overflow: 0, unclipped: 0, mobileOnlyShowing: 0, weekCols: 7 });
    const at390 = await layout(390);
    eq("gate12b: 390 — no overflow, the week folds to one day per row, and the mobile-only line appears",
      { overflow: at390.overflow, unclipped: at390.unclipped, weekCols: at390.weekCols, mobileShows: at390.mobileOnlyShowing > 0 },
      { overflow: 0, unclipped: 0, weekCols: 1, mobileShows: true });

    await ctx.close();

    // ── the ADMIN BOUNCE — same login, app_users NOT patched with the tier ──
    // Ryan is is_admin and holds no city tier, so the page must send him to the admin Manager Pay
    // screen rather than rendering a page whose own API would 403 him.
    { const ctx2 = await browser.newContext({ viewport: { width: 1600, height: 1000 }, storageState });
      await ctx2.route("**/api/manager-pay/city-week**", (r) =>
        r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "City manager access required." }) }));
      const p2 = await ctx2.newPage();
      await p2.goto(PAGE, { waitUntil: "domcontentloaded" });
      await p2.waitForFunction(() => location.pathname !== "/city/manager-pay", null, { timeout: 20000 }).catch(() => {});
      eq("admin bounce: an admin without the tier is redirected to the admin Manager Pay screen",
        new URL(p2.url()).pathname, "/match-ops/manager-pay");
      await ctx2.close(); }
  } finally {
    await browser.close();
  }

  console.log(`\n${PASS} passed, ${FAIL} failed`);
  if (FAIL) { console.log(fails.map((f) => `  ✗ ${f}`).join("\n")); process.exit(1); }
}

main().catch(fatal);
