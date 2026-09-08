/* THE MATCH PANEL SCROLLS, ON EVERY HOST AND AT EVERY WIDTH.
 *
 * WHY THIS EXISTS. MatchSidePanel's stylesheet was once two copies, and the export Master Schedule
 * used was missing the four height-chain rules. Without them <fieldset class="mp-fs"> takes its
 * CONTENT height, .mp-body inside it never gets a bounded one, and an overflow-y:auto box with
 * nothing to overflow does not scroll — the wheel or the touch goes to the page behind the panel
 * instead. Measured on the broken build at 1440: .mp-body's own centre sat at y=1817 in a 1000px
 * viewport, elementFromPoint there returned NOTHING, and a 600px wheel moved the WINDOW by 600 and
 * .mp-body by 0.
 *
 * IT WAS FOUND TWICE BECAUSE IT WAS CHECKED ONCE. The first fix was verified only at 390px, where
 * the @media blocks at 639.98px carry the layout; the base rules that apply at 1440 were never
 * measured on that host. So this asserts the CROSS PRODUCT — two hosts x two widths — and asserts
 * the behaviour (does a wheel move it) rather than only the computed style.
 *
 *   node scripts/e2e/verify-panel-chain.mjs
 *   BREAK_CHAIN=1 node scripts/e2e/verify-panel-chain.mjs   # positive control: must FAIL
 */
import { chromium } from "playwright";
import { storageStateFor, installHarnessGuard } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  XX  ${n} — ${d}`); };
const yes = (n, c, d = "") => (c ? ok(n) : bad(n, d));
const is = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const HOSTS = [
  ["Master Schedule", "/match-ops/master-schedule", '[data-testid="card"]'],
  ["Gameday Ops", "/match-ops/gameday", '[data-testid="gday-row"]'],
];
const WIDTHS = [["desktop 1440", 1440, 1000], ["phone 390", 390, 844]];

/* THE DELIBERATE BREAK. It removes exactly the rule whose absence caused this — the fieldset's
   flex — so the control proves the assertion is sensitive to the real defect and not to something
   incidental. */
const BREAK = `.gpanel-body>.mp>.mp-panel>.mp-fs{flex:0 1 auto !important;min-height:auto !important}`;

async function main() {
  process.loadEnvFile(".env.local");
  const { storageState } = await storageStateFor("rmancuso@playmatchday.com", BASE);
  const browser = await chromium.launch({ headless: true });
  const breaking = !!process.env.BREAK_CHAIN;
  if (breaking) console.log("\n!! BREAK_CHAIN set — the height chain is disabled on purpose. Every scroll assertion below MUST fail.\n");

  for (const [host, url, opener] of HOSTS) {
    for (const [label, w, h] of WIDTHS) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, storageState, isMobile: w < 500, hasTouch: w < 500 });
      const page = await ctx.newPage();
      await page.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(opener, { timeout: 60000 });
      await page.waitForTimeout(2500);
      await page.click(opener);
      await page.waitForSelector('[data-testid="gday-panel"]', { timeout: 30000 });
      await page.waitForTimeout(7000);
      if (breaking) await page.addStyleTag({ content: BREAK });
      await page.waitForTimeout(600);

      const tag = `${host} @ ${label}`;
      console.log(`\n— ${tag} —`);

      /* THE CHAIN, LINK BY LINK. Each must exist and each must be bounded; a MISSING row means a
         selector stopped matching, which is a different failure from a wrong value. */
      const chain = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="gday-panel"]');
        const body = panel?.querySelector(".gpanel-body:not(.gpanel-chat)");
        const mp = body?.querySelector(":scope > .mp");
        const pan = mp?.querySelector(":scope > .mp-panel");
        const fs = pan?.querySelector(":scope > .mp-fs");
        const bd = fs?.querySelector(":scope > .mp-body");
        const one = (el) => (el ? { h: Math.round(el.getBoundingClientRect().height), flex: getComputedStyle(el).flex, minH: getComputedStyle(el).minHeight } : null);
        return {
          panelH: panel ? Math.round(panel.getBoundingClientRect().height) : null,
          links: { "gpanel-body": one(body), ".mp": one(mp), ".mp-panel": one(pan), ".mp-fs": one(fs), ".mp-body": one(bd) },
          bodyClientH: bd?.clientHeight ?? null, bodyScrollH: bd?.scrollHeight ?? null,
          overflowY: bd ? getComputedStyle(bd).overflowY : null,
          vh: window.innerHeight,
        };
      });
      for (const [name, v] of Object.entries(chain.links)) {
        if (!v) { bad(`${tag}: ${name} exists`, "selector did not match"); continue; }
        console.log(`     ${name.padEnd(12)} h=${String(v.h).padStart(5)} flex=${v.flex}`);
      }
      /* EVERY LINK FITS INSIDE THE PANEL. An unbounded chain shows up here first: on the broken
         build .mp-fs was 4184px inside an 844px panel. */
      for (const [name, v] of Object.entries(chain.links)) {
        if (v) yes(`${tag}: ${name} is bounded by the panel`, v.h <= chain.panelH + 1, `${v.h} > panel ${chain.panelH}`);
      }
      yes(`${tag}: .mp-body has something to scroll`, (chain.bodyScrollH ?? 0) > (chain.bodyClientH ?? 0) + 2,
        `client ${chain.bodyClientH} scroll ${chain.bodyScrollH}`);
      is(`${tag}: .mp-body is the scroller`, chain.overflowY, "auto");

      /* AND THE BEHAVIOUR, not only the styles. A wheel over the panel must move the PANEL and not
         the window — the exact thing Ryan reported and the thing a computed-style check can miss. */
      const pt = await page.evaluate(() => {
        const bd = document.querySelector('[data-testid="gday-panel"] .mp-body');
        const r = bd.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), inView: r.top >= 0 && r.bottom <= window.innerHeight + 1 };
      });
      yes(`${tag}: .mp-body is inside the viewport`, pt.inView, `centre at y=${pt.y} in ${chain.vh}px`);
      const hit = await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        return el ? !!el.closest(".mp-body") : false;
      }, pt);
      yes(`${tag}: nothing covers the panel at that point`, hit);
      const before = await page.evaluate(() => ({ b: document.querySelector('[data-testid="gday-panel"] .mp-body').scrollTop, w: window.scrollY }));
      await page.mouse.move(pt.x, pt.y);
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(900);
      const after = await page.evaluate(() => ({ b: document.querySelector('[data-testid="gday-panel"] .mp-body').scrollTop, w: window.scrollY }));
      console.log(`     wheel 600 → .mp-body ${before.b}→${after.b} · window ${before.w}→${after.w}`);
      yes(`${tag}: a wheel scrolls the panel`, after.b > before.b, `.mp-body moved ${after.b - before.b}`);
      is(`${tag}: …and NOT the page behind it`, after.w - before.w, 0);

      /* SAVE IS REACHABLE without scrolling past the form. */
      const foot = await page.evaluate(() => {
        const f = document.querySelector('[data-testid="gday-panel"] .mp-foot');
        if (!f) return null; const r = f.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight };
      });
      if (foot) yes(`${tag}: the save bar is on screen`, foot.top < foot.vh, `foot top ${foot.top} in ${foot.vh}px`);
      await ctx.close();
    }
  }

  /* THE STANDALONE PAGE IS NOT A PANEL and must not be trapped in one: it scrolls with the window
     and keeps its width cap. Every chain rule is scoped under .gpanel-body so none can reach it. */
  for (const [label, w, h] of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, storageState, isMobile: w < 500 });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/match-ops/match-panel/17494`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".mp-panel", { timeout: 50000 });
    await page.waitForTimeout(6000);
    const m = await page.evaluate(() => ({
      docScrollBy: document.documentElement.scrollHeight - window.innerHeight,
      maxW: getComputedStyle(document.querySelector(".mp-panel")).maxWidth,
      fsFlex: getComputedStyle(document.querySelector(".mp-fs")).flex,
    }));
    console.log(`\n— standalone /match-panel @ ${label} —\n     ${JSON.stringify(m)}`);
    yes(`standalone @ ${label}: scrolls with the window`, m.docScrollBy > 0, `${m.docScrollBy}px`);
    yes(`standalone @ ${label}: keeps its width cap`, m.maxW !== "none", m.maxW);
    yes(`standalone @ ${label}: the panel's flex never reached it`, m.fsFlex === "0 1 auto", m.fsFlex);
    await ctx.close();
  }

  await browser.close();
  console.log(`\nverify-panel-chain: ${PASS} passed, ${FAIL} failed`);
  if (FAIL) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
}
main();
