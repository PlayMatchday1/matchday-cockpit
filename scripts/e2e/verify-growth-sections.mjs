// GROWTH — six routed sections instead of one long scroll.
//
// THIS WAS A MOVE, NOT A REBUILD, so the assertions are about ROUTING and PLACEMENT: that each
// section renders its existing panel, that the rail is the app's own, and that the time period bar
// and the three-start-dates note appear only where they apply. Nothing here re-asserts what the
// charts compute — those panels are unchanged and already covered by their own numbers.
//
// THE PERIOD BAR PER PAGE IS THE POINT. On the single-scroll page it was global, and needed an
// "applies to 4 of 7 cards" line plus a three-dot legend to explain which cards it governed.
// Retention and Churn never followed it. Per section that ambiguity cannot exist, so both the
// count line and the legend must be gone.
//
//   node scripts/e2e/verify-growth-sections.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { netRetry, installHarnessGuard, fatal, closeContext, closeBrowser } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const RAIL = ["Player Funnel", "Player Behavior", "Revenue per Player", "Retention", "Churn", "Player Data Room"];

// path, title, does it follow the period, does it carry the start-dates note, a marker proving the
// PANEL rendered (not just the frame).
const SECTIONS = [
  ["/growth/funnel", "Player Funnel", true, true, /App downloads/i],
  ["/growth/behavior", "Player Behavior", true, true, /behaviou?r/i],
  ["/growth/revenue-per-player", "Revenue per Player", true, true, /per (active )?player|ARPP/i],
  ["/growth/retention", "Retention", false, false, /cohort/i],
  ["/growth/churn", "Churn", false, false, /inactive/i],
  ["/growth/data-room", "Player Data Room", true, false, /player/i],
];

async function main() {
  process.loadEnvFile(".env.local");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const svc = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const link = await netRetry(() => svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" }), "generateLink");
  const vv = await netRetry(() => anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token }), "verifyOtp");
  const ref = new URL(url).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] };

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1200 }, storageState });
  const page = await ctx.newPage();
  // A SECTION IS READY when its title is up AND the frame has left the loading state — every
  // absence check below is meaningless against "Loading growth analytics…".
  const open = async (path) => {
    await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="growth-title"]', { timeout: 60000 });
    await page.waitForFunction(() => !/Loading growth analytics/.test(document.body.innerText), null, { timeout: 60000 });
    await page.waitForTimeout(250);
  };

  console.log("growth — six sections\n");

  // ── THE LANDING ──────────────────────────────────────────────────────────
  console.log("/growth is the funnel:");
  {
    await page.goto(`${BASE}/growth`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => location.pathname === "/growth/funnel", null, { timeout: 30000 }).catch(() => {});
    eq("/growth redirects to /growth/funnel", new URL(page.url()).pathname, "/growth/funnel");
  }

  // ── EACH SECTION ─────────────────────────────────────────────────────────
  for (const [path, title, followsPeriod, startDates, panelMark] of SECTIONS) {
    console.log(`\n${path}:`);
    await open(path);
    const r = await page.evaluate(() => ({
      title: document.querySelector('[data-testid="growth-title"]')?.textContent?.trim() ?? null,
      period: !!document.querySelector('[data-testid="growth-period"]'),
      starts: !!document.querySelector('[data-testid="growth-start-dates"]'),
      rail: [...document.querySelectorAll('[data-testid="app-rail"] [data-testid="rail-item"]')].map((a) => a.textContent.trim()),
      sw: !!document.querySelector('[data-testid="section-switch"]'),
      groups: document.querySelectorAll('[data-testid="rail-group"]').length,
      text: document.body.innerText,
      subtitle: document.querySelector('[data-testid="growth-subtitle"]')?.textContent?.trim() ?? "",
    }));
    eq("the title is the section", r.title, title);
    eq("…the panel itself rendered", panelMark.test(r.text), true);
    eq("…the rail is the app's own six, flat and in order", r.rail, RAIL);
    eq("…with no Daily Ops / Back Office switch and no group headings", { sw: r.sw, groups: r.groups }, { sw: false, groups: 0 });
    eq(`…the time period bar is ${followsPeriod ? "present" : "absent"}`, r.period, followsPeriod);
    if (!followsPeriod) {
      // A PAGE THAT IGNORES THE PERIOD SAYS SO IN ITS OWN SUBTITLE — that is what replaced the
      // three-dot legend, so its absence must not be silent.
      eq("…and the subtitle says why it has no period bar", /own (cohort and city )?filters|does not follow|all time/i.test(r.subtitle), true);
    }
    eq(`…the three-start-dates note is ${startDates ? "present" : "absent"}`, r.starts, startDates);
    eq("…the 'applies to N of N cards' line is gone", /applies to \d+ of \d+ cards/.test(r.text), false);
    eq("…and the three-dot scope legend is gone", /Follows the time period above/.test(r.text), false);
  }

  // ── THE DOWNLOADS CARD AND THE FUNNEL'S DOWNLOADS COLUMN ─────────────────
  // Three defects, all on the same number:
  //   1. the card printed a PERIOD figure beside each store's DATA COVERAGE window, so "iOS 9,066
  //      · Aug 2025 – Aug 2026" read as a year of downloads;
  //   2. the funnel TABLE summed androidByMonth ALONE while the card summed both, so one page
  //      showed 2,241 and 11,307 for the same metric and period — visible as a 2551.3%
  //      download → registration conversion in the Aug 2026 row;
  //   3. the Registrations card printed "— of downloads (store sync not connected)", a hardcoded
  //      dash whose parenthetical stopped being true the day both stores landed.
  console.log("\nthe downloads card and column:");
  {
    await open("/growth/funnel");
    const card = await page.evaluate(() => {
      const lab = [...document.querySelectorAll("div")].find((d) => d.textContent?.trim() === "App downloads · iOS + Android");
      return lab?.parentElement?.innerText.trim().split("\n").map((l) => l.trim()) ?? null;
    });
    eq("the card renders", Array.isArray(card), true);
    if (card) {
      // THREE NUMBERS AND THE PERIOD. The caveats moved to the banner.
      eq("…the card is down to three numbers plus the period", card.length, 5);
      const RANGE = /[A-Z][a-z]{2} \d{4}\s*[–-]\s*[A-Z][a-z]{2} \d{4}/;
      const platform = card.filter((l) => /^(iOS|Android)\b/.test(l));
      eq("…one line per platform", platform.length, 2);
      eq("…and neither carries a date range beside its number", platform.filter((l) => RANGE.test(l)), []);
      eq("…the 'counted differently' caveat is not on the card", card.filter((l) => /like-for-like/.test(l)), []);
    }
    const text = await page.evaluate(() => document.body.innerText);
    eq("the false '(store sync not connected)' line is gone from the page", /store sync not connected/.test(text), false);
    eq("…and no 'of downloads' conversion is claimed", /of downloads/.test(text), false);

    // THE CAVEATS LIVE IN THE BANNER, and only where downloads are shown.
    eq("the store-history sentence is in the banner on the funnel",
      await page.$('[data-testid="growth-store-history"]') !== null, true);
    eq("…it says the one-year retention is permanent, not a pending backfill",
      /retained for one year|cannot be recovered/i.test(text), true);
    eq("…and it carries the not-like-for-like warning", /not like-for-like/.test(text), true);
    await open("/growth/behavior");
    eq("…and it does NOT repeat on a section with no download figures",
      await page.$('[data-testid="growth-store-history"]'), null);

    // THE COLUMN NOW MATCHES THE CARD, and marks its own store coverage.
    await open("/growth/funnel");
    const dl = await page.evaluate(() => {
      const stages = [...document.querySelectorAll("[class*='funnelStage']")];
      const byRow = new Map();
      for (const s of stages) { const r = s.parentElement; if (!byRow.has(r)) byRow.set(r, []); byRow.get(r).push(s); }
      return [...byRow].map(([, cells]) => ({
        vals: cells.map((c) => Number((c.querySelector("[class*='funnelSnum']")?.textContent ?? "").replace(/[^0-9]/g, ""))),
        note: cells[0].querySelector('[data-testid="funnel-dl-coverage"]')?.textContent?.trim() ?? null,
      }));
    });
    eq("the table renders rows", dl.length > 0, true);
    // THE BAR'S DENOMINATOR IS THE ROW MAX, so "share of the funnel's top" is only true while
    // Downloads IS the row max. That was false when the column was Android-only.
    eq("Downloads is the largest stage in every row", dl.filter((r) => r.vals[0] < Math.max(...r.vals)).length, 0);
    // A fully-covered row carries no mark; the marking is asserted across coverage cases below.
    const covered = dl.filter((r) => r.note == null);
    eq("…and a fully-covered row carries no coverage mark", covered.length > 0, true);
  }

  // ── STORE COVERAGE IS MARKED, NOT BACKFILLED ─────────────────────────────
  // Apple retains monthly reports for ONE YEAR and does not regenerate them, so pre-Aug-2025 iOS
  // months are permanently gone. A row the two stores do not both cover must say so, or the step
  // up when iOS appears reads as growth.
  console.log("\nstore coverage per row:");
  {
    const setRange = async (a, z) => {
      await page.fill("#funnelCustomStart", a);
      await page.fill("#funnelCustomEnd", z);
      await page.waitForTimeout(700);
      return page.evaluate(() => {
        const stages = [...document.querySelectorAll("[class*='funnelStage']")];
        const byRow = new Map();
        for (const s of stages) { const r = s.parentElement; if (!byRow.has(r)) byRow.set(r, []); byRow.get(r).push(s); }
        const rows = [...byRow];
        const last = rows[rows.length - 1][1];
        return last[0].querySelector('[data-testid="funnel-dl-coverage"]')?.textContent?.trim() ?? null;
      });
    };
    eq("a range entirely before iOS is marked Android-only, permanently",
      await setRange("2023-03", "2024-12"), "Android only · no iOS data exists");
    eq("a range straddling the iOS floor names the boundary",
      await setRange("2025-01", "2025-12"), "Android only before Aug 2025");
    eq("a fully-covered range is NOT marked", await setRange("2025-08", "2026-07"), null);
  }

  // ── THE MOVE DID NOT DUPLICATE THE FETCH ─────────────────────────────────
  console.log("\nswitching sections in the rail does not refetch:");
  {
    await open("/growth/funnel");
    let calls = 0;
    const count = (req) => { if (req.url().includes("/api/growth")) calls++; };
    page.on("request", count);
    await page.click('[data-testid="rail-item"][data-key="growth-behavior"]');
    await page.waitForFunction(() => location.pathname === "/growth/behavior", null, { timeout: 20000 });
    await page.waitForTimeout(1200);
    page.off("request", count);
    eq("navigating funnel → behavior issues NO new /api/growth request", calls, 0);
    // POSITIVE CONTROL — the navigation actually happened, or "no requests" is trivially true.
    eq("…and the section really did change", await page.$eval('[data-testid="growth-title"]', (e) => e.textContent.trim()), "Player Behavior");
  }

  // ── THE START-DATES NOTE IS NOT REPEATED SIX TIMES ───────────────────────
  {
    const withNote = SECTIONS.filter(([, , , s]) => s).length;
    (withNote > 0 && withNote < SECTIONS.length)
      ? ok(`the start-dates note appears on ${withNote} of ${SECTIONS.length} sections, not all six`)
      : bad("start-dates placement", `${withNote} of ${SECTIONS.length}`);
  }
  await closeContext(ctx);

  // ── PHONE ────────────────────────────────────────────────────────────────
  console.log("\nphone at 390:");
  {
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState });
    const mp = await mctx.newPage();
    await mp.goto(`${BASE}/growth/funnel`, { waitUntil: "domcontentloaded" });
    await mp.waitForSelector('[data-testid="growth-title"]', { timeout: 60000 });
    await mp.waitForTimeout(600);
    eq("the desktop rail is not rendered at 390",
      await mp.evaluate(() => { const r = document.querySelector('[data-testid="app-rail"]'); return r ? getComputedStyle(r.closest("div")).display : "absent"; }), "none");
    // The shared app bar carries navigation below the rail breakpoint, exactly as Match Ops does.
    await mp.click('[data-testid="mo-screen-picker"]');
    await mp.waitForSelector('[data-testid="screen-sheet"]', { timeout: 10000 });
    eq("…and the screen sheet offers the same six, with no switch", await mp.evaluate(() => ({
      items: [...document.querySelectorAll('[data-testid="screen-sheet"] [data-testid^="screen-dest-"]')].map((b) => b.querySelector("span span")?.textContent?.trim()),
      sw: !!document.querySelector('[data-testid="screen-sheet"] [data-testid="section-switch"]'),
    })), { items: RAIL, sw: false });
    await mp.keyboard.press("Escape");
    await mp.waitForTimeout(300);
    eq("no horizontal overflow at 390",
      await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
    await closeContext(mctx);
  }

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await closeBrowser(browser);
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch(fatal);
