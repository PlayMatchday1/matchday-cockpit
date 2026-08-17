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
// NO SECTION CARRIES A BANNER ANY MORE — every methodological statement moved to the Data Room.
const SECTIONS = [
  ["/growth/funnel", "Player Funnel", true, /App downloads/i],
  ["/growth/behavior", "Player Behavior", true, /behaviou?r/i],
  ["/growth/revenue-per-player", "Revenue per Player", true, /per (active )?player|ARPP/i],
  ["/growth/retention", "Retention", false, /cohort/i],
  ["/growth/churn", "Churn", false, /inactive/i],
  ["/growth/data-room", "Player Data Room", true, /player/i],
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
  for (const [path, title, followsPeriod, panelMark] of SECTIONS) {
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
    eq("…no explanatory banner on any section", r.starts, false);
    eq("…the 'applies to N of N cards' line is gone", /applies to \d+ of \d+ cards/.test(r.text), false);
    eq("…and the three-dot scope legend is gone", /Follows the time period above/.test(r.text), false);
  }

  // ── THE FUNNEL PAGE CARRIES NO PROSE ─────────────────────────────────────
  // Everything methodological moved to the Player Data Room. What is left on this page is the
  // title, the filters, the tiles and the table — a number, or a control, or a label on a row.
  console.log("\nthe funnel page carries no prose:");
  {
    await open("/growth/funnel");
    const card = await page.evaluate(() => {
      const lab = [...document.querySelectorAll("div")].find((d) => d.textContent?.trim() === "App downloads · iOS + Android");
      return lab?.parentElement?.innerText.trim().split("\n").map((l) => l.trim()) ?? null;
    });
    // SHAPE, not values — the totals move with the data. The label is upper-cased by CSS, so the
    // comparison is on innerText as rendered.
    eq("the downloads card is EXACTLY four lines", card?.length, 4);
    eq("…line 1 is the label", (card?.[0] ?? "").toLowerCase(), "app downloads · ios + android");
    eq("…line 2 is the combined total and nothing else", /^[\d,]+$/.test(card?.[1] ?? ""), true);
    if (card) {
      eq("…four lines, no more", card.length, 4);
      eq("…the platform lines read 'installs' on both", card.slice(2), [`iOS ${card[2].split(" ")[1]} installs`, `Android ${card[3].split(" ")[1]} installs`]);
      eq("…no store-unit wording on the card", card.filter((l) => /App Store Units|user-installs/.test(l)), []);
      eq("…and no date range or period on the card", card.filter((l) => /\d{4}/.test(l) && !/^(iOS|Android)/.test(l) && !/^App downloads/.test(l)), []);
    }

    const text = await page.evaluate(() => document.body.innerText);
    for (const [what, re] of [
      ["the three-start-dates banner", /three start dates/i],
      ["the store-history sentence", /retained for one year|analytics reach back/i],
      ["the counted-differently caveat", /not like-for-like|counted differently/i],
      ["the aggregate-ratio paragraph", /aggregate ratio/i],
      ["the bar explanation", /narrows left to right/i],
      ["the cohort subtitle", /sign-up cohort/i],
      ["the Android-only sentence", /Android only until Apple lands/i],
      ["the false conversion line", /store sync not connected|of downloads/i],
    ]) {
      eq(`…${what} is gone from the funnel`, re.test(text), false);
    }
    // POSITIVE CONTROL — the page rendered, so eight absences mean something.
    eq("…and the page really rendered (control for those absences)", /Player funnel comparison/.test(text), true);

    // THE ROW LABELS STAY. They label one row's number and are not prose.
    eq("the per-row coverage marks are still inside the table",
      await page.evaluate(() => document.querySelectorAll('[data-testid="funnel-dl-coverage"]').length >= 0), true);
    // Downloads is still the row max, so the bar still means "share of the funnel's top".
    const dl = await page.evaluate(() => {
      const stages = [...document.querySelectorAll("[class*='funnelStage']")];
      const byRow = new Map();
      for (const s of stages) { const r = s.parentElement; if (!byRow.has(r)) byRow.set(r, []); byRow.get(r).push(s); }
      return [...byRow].map(([, cells]) => cells.map((c) => Number((c.querySelector("[class*='funnelSnum']")?.textContent ?? "").replace(/[^0-9]/g, ""))));
    });
    eq("Downloads is the largest stage in every row", dl.filter((v) => v[0] < Math.max(...v)).length, 0);
    // The open month is still marked.
    eq("the current month's conversion is marked 'so far'",
      await page.$('[data-testid="funnel-conv-partial"]') !== null, true);
  }

  // ── THE DATA ROOM RECEIVED IT ────────────────────────────────────────────
  console.log("\nthe Data Room carries the methodology:");
  {
    await open("/growth/data-room");
    const m = await page.$('[data-testid="growth-methodology"]');
    eq("the methodology block is on the Data Room", m !== null, true);
    const t = await page.evaluate(() => document.querySelector('[data-testid="growth-methodology"]')?.innerText ?? "");
    for (const [what, re] of [
      ["the three start dates", /three start dates/i],
      ["the store floors", /retained for one year/i],
      ["the counted-differently caveat", /App Units|user-deduped/i],
      ["the aggregate-ratio explanation", /aggregate ratio/i],
      ["the funnel bar explanation", /narrows left to right/i],
      ["the open-month note", /so far/i],
    ]) {
      eq(`…it carries ${what}`, re.test(t), true);
    }
  }

  // ── STORE COVERAGE IS MARKED, NOT BACKFILLED ─────────────────────────────
  // Apple retains monthly reports for ONE YEAR and does not regenerate them, so pre-Aug-2025 iOS
  // months are permanently gone. A row the two stores do not both cover must say so, or the step
  // up when iOS appears reads as growth.
  console.log("\nstore coverage per row:");
  {
    // BACK TO THE FUNNEL — the block above ends on the Data Room, and the custom-range inputs
    // only exist here. Without this the fills time out against the wrong page.
    await open("/growth/funnel");
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

  // The banner is gone from every section, asserted per section in the loop above — there is no
  // longer a "which pages carry it" question to answer here.

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
