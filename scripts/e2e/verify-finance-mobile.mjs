// FINANCE ON A PHONE — run at 393x852 AND 320x700, because the failures differ.
//
// WHAT THIS EXISTS TO CATCH. The Finance controls — three compare chips in an unwrapped row plus
// three fixed-width selects — came to ~591px. A 393px phone cannot show that, so the browser shrank
// the WHOLE APP to fit and window.innerWidth reported 591. Every control was legible-but-tiny for
// that one reason, and no assertion anywhere would have noticed: the page did not overflow, it
// zoomed. Reverting financeSection.module.css to its pre-fix state reproduces it — 13 of these
// assertions fail, starting with the first.
//
// NO SINGLE RULE ISOLATES IT. The rail rule and the select rule each hold the width down on their
// own, so mutating either alone still passes. That is a property of the bug, not a gap in the
// suite — stated here so nobody removes one of them thinking it is dead weight.
//
// SO THE FIRST ASSERTION IS innerWidth ITSELF. A page that fits because it was shrunk is not a page
// that fits.

import { chromium } from "playwright";
import { installHarnessGuard, closeContext, closeBrowser, storageStateFor } from "./_session.mjs";

installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
let passed = 0;
const failures = [];
const ok = (n) => { passed += 1; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const browser = await chromium.launch();
const { storageState } = await storageStateFor("rmancuso@playmatchday.com", BASE);
const errors = [];

/** Both phone sizes. 320 is where labels truncate; 393 is the common case. */
const SIZES = [[393, 852], [320, 700]];

for (const [W, H] of SIZES) {
  console.log(`\n════════ ${W}x${H} ════════`);
  const ctx = await browser.newContext({
    storageState, viewport: { width: W, height: H }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${W}: ${e}`));
  // FORCE A NOTCH. --sat/--sab exist so a harness can prove the layout survives one; a raw env()
  // cannot be overridden and therefore cannot be tested.
  // documentElement is NULL when an init script runs — it fires before the document exists. Setting
  // the notch after navigation is the only point at which there is a root element to set it on.
  const forceNotch = () => page.evaluate(() => {
    document.documentElement.style.setProperty("--sat", "59px");
    document.documentElement.style.setProperty("--sab", "34px");
  });
  await page.goto(`${BASE}/admin/finance/revenue`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="tile-revenue"]', { timeout: 240000 });
  await forceNotch();
  await page.waitForTimeout(2000);

  // ── 1. THE PAGE FITS, RATHER THAN HAVING BEEN SHRUNK TO FIT ─────────────────────────────────
  console.log("\n── the page fits ──");
  {
    const m = await page.evaluate(() => ({
      inner: window.innerWidth,
      scrollW: document.documentElement.scrollWidth,
      bodyW: document.body.scrollWidth,
    }));
    // THE ZOOM-OUT ASSERTION. innerWidth larger than the device means the layout viewport expanded
    // to fit oversized content — the page did not overflow, it shrank.
    eq(`the layout viewport is the device width (${W}), not shrunk to fit`, m.inner, W);
    eq("  …and the document does not scroll horizontally", m.scrollW <= m.inner, true);
    eq("  …nor does the body", m.bodyW <= m.inner, true);
  }

  // ── 2. ALL FOUR FIGURES ON THE FIRST SCREEN, IN TWO ROWS OF TWO ─────────────────────────────
  console.log("\n── the four figures ──");
  {
    const t = await page.evaluate(() => {
      const wrap = document.querySelector('[data-testid="tile-revenue"]')?.parentElement;
      const tiles = [...(wrap?.children ?? [])].map((el) => {
        const b = el.getBoundingClientRect();
        return { top: Math.round(b.top), left: Math.round(b.left), w: Math.round(b.width), bottom: Math.round(b.bottom) };
      });
      return { cols: wrap ? getComputedStyle(wrap).gridTemplateColumns.split(" ").length : 0, tiles };
    });
    eq("  control — four tiles rendered", t.tiles.length, 4);
    eq("the tile grid is exactly two columns", t.cols, 2);
    // TWO ROWS OF TWO, proven from geometry rather than from the column count alone: a grid can
    // declare two columns and still wrap to four rows if a tile is too wide.
    const rows = [...new Set(t.tiles.map((x) => x.top))];
    eq("  …laid out in exactly two rows", rows.length, 2);
    eq("  …two tiles per row", rows.map((r) => t.tiles.filter((x) => x.top === r).length), [2, 2]);
    const lowest = Math.max(...t.tiles.map((x) => x.bottom));
    eq(`all four figures are above the fold (${lowest} <= ${H})`, lowest <= H, true);
  }

  // ── 3. THE VIEW SELECTS ─────────────────────────────────────────────────────────────────────
  console.log("\n── the selects ──");
  {
    const sels = await page.evaluate(() => {
      const out = [];
      for (const s of document.querySelectorAll('[data-testid="pace-city"], [data-testid="pace-field"], [data-testid="pace-kind"]')) {
        const b = s.getBoundingClientRect();
        const cs = getComputedStyle(s);
        /* MEASURE THE TEXT, NOT THE BOX. A width floor passes on a control whose selected option is
         * truncated — which is the actual failure: "DPP + Membership" in a 106px box. The span is
         * built with the select's own computed font so the measurement is the real one. */
        const probe = document.createElement("span");
        probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${cs.font}`;
        probe.textContent = s.options[s.selectedIndex]?.text ?? "";
        document.body.appendChild(probe);
        const textW = probe.getBoundingClientRect().width;
        probe.remove();
        const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
        out.push({
          id: s.getAttribute("data-testid"), top: Math.round(b.top), left: Math.round(b.left),
          w: Math.round(b.width), right: Math.round(b.right), textW: Math.round(textW),
          fits: textW + padX <= b.width + 0.5, text: probe.textContent,
        });
      }
      return out;
    });
    eq("  control — all three selects rendered", sels.length, 3);
    eq("every select is fully on screen", sels.filter((s) => s.right > W).map((s) => s.id), []);
    const perRow = [...new Set(sels.map((s) => s.top))].map((t) => sels.filter((s) => s.top === t).length);
    eq("at most two selects per row", Math.max(...perRow), 2);
    for (const s of sels) {
      eq(`  ${s.id}: "${s.text}" fits its box (${s.textW}px of ${s.w}px)`, s.fits, true);
    }
  }

  // ── 4. THE COMPARE RAIL ─────────────────────────────────────────────────────────────────────
  console.log("\n── the compare rail ──");
  {
    const rail = await page.evaluate(() => {
      const wrap = document.querySelector('[data-testid="pace-cmp-rail"]');
      const scroller = wrap?.querySelector('[role="group"]');
      const last = document.querySelector('[data-testid="pace-cmp-year"]');
      const fade = wrap ? getComputedStyle(wrap, "::after") : null;
      return {
        hasWrap: !!wrap, scrollable: scroller ? scroller.scrollWidth > scroller.clientWidth + 1 : false,
        atEnd: wrap?.getAttribute("data-atend"),
        // THE GRADIENT ITSELF, not opacity — an empty pseudo-element also has opacity 1.
        fadeImage: fade?.backgroundImage ?? "none",
        lastRight: last ? Math.round(last.getBoundingClientRect().right) : null,
      };
    });
    eq("  control — the rail wrapper is present", rail.hasWrap, true);
    if (rail.scrollable) {
      eq("the rail scrolls, so the last chip is reachable", rail.scrollable, true);
      eq("  …and a fade is DRAWN (a gradient, not just an opaque box)", /gradient/.test(rail.fadeImage), true);
      eq("  …and it is on while there is more to reach", rail.atEnd, "false");
      // SCROLL TO THE END AND THE FADE MUST GO — a fade that never turns off says there is more
      // when there is not.
      await page.evaluate(() => {
        const sc = document.querySelector('[data-testid="pace-cmp-rail"] [role="group"]');
        if (sc) sc.scrollLeft = sc.scrollWidth;
      });
      await page.waitForTimeout(300);
      const after = await page.evaluate(() => ({
        atEnd: document.querySelector('[data-testid="pace-cmp-rail"]')?.getAttribute("data-atend"),
        lastRight: Math.round(document.querySelector('[data-testid="pace-cmp-year"]')?.getBoundingClientRect().right ?? 0),
      }));
      eq("scrolled to the end, the fade turns off", after.atEnd, "true");
      eq("  …and the last chip is fully on screen", after.lastRight <= W, true);
    } else {
      // A RAIL THAT FITS HAS NOTHING TO REVEAL and must not wear a fade either.
      eq("the rail fits, so it reports itself at the end", rail.atEnd, "true");
    }
  }

  // ── 5. THE CHART IS A CHART ─────────────────────────────────────────────────────────────────
  console.log("\n── the chart ──");
  {
    const c = await page.evaluate(() => {
      const svg = document.querySelector('[data-testid="pace-chart"]');
      if (!svg) return null;
      const labels = [...svg.querySelectorAll("text")];
      const axis = labels.filter((t) => !/^\$/.test(t.textContent ?? ""));
      const box = svg.getBoundingClientRect();
      // The RENDERED size of the type, after the viewBox scale — not the attribute.
      const scale = box.width / (svg.viewBox.baseVal.width || 1);
      return {
        h: Math.round(box.height),
        axisCount: axis.length,
        renderedFont: axis.length ? Math.round(parseFloat(getComputedStyle(axis[0]).fontSize) * scale * 10) / 10 : 0,
      };
    });
    eq("  control — the chart rendered", c != null, true);
    eq(`the plot has real height (${c?.h}px)`, (c?.h ?? 0) >= 200, true);
    eq(`  …with a readable number of x-labels (${c?.axisCount})`, (c?.axisCount ?? 99) <= 8, true);
    eq(`  …and nothing under 9px once scaled (${c?.renderedFont}px)`, (c?.renderedFont ?? 0) >= 9, true);
  }

  // ── 6. THE TAB BAR ──────────────────────────────────────────────────────────────────────────
  console.log("\n── the tab bar ──");
  {
    const nav = await page.evaluate(() => {
      const bar = document.querySelector('nav[aria-label="Primary"]');
      if (!bar) return null;
      const items = [...bar.querySelectorAll("a,button")].map((el) => {
        const b = el.getBoundingClientRect();
        const label = el.querySelector("span:last-child") ?? el;
        return {
          text: (el.textContent ?? "").replace(/\d+$/, "").trim(),
          w: Math.round(b.width), h: Math.round(b.height),
          // TRUNCATION, measured on the label element itself.
          truncated: label.scrollWidth > label.clientWidth + 1,
              // aria-current ONLY. Matching on the active class also caught the More button, which
          // carries the same colour when it thinks it owns the page — and that is a different
          // question, asserted separately below.
          active: el.getAttribute("aria-current") === "page",
        };
      });
      const bb = bar.getBoundingClientRect();
      return { items, barTop: Math.round(bb.top), barH: Math.round(bb.height) };
    });
    eq("  control — the bar rendered", nav != null, true);
    eq("five tabs", nav.items.length, 5);
    eq("  …and they are Home, Finance, Match Ops, Players, More",
      nav.items.map((i) => i.text), ["Home", "Finance", "Match Ops", "Players", "More"]);
    eq("every tab is at least 44px tall", nav.items.every((i) => i.h >= 44), true);
    eq("  …and at least 44px wide", nav.items.every((i) => i.w >= 44), true);
    eq("no tab label truncates", nav.items.filter((i) => i.truncated).map((i) => i.text), []);
    eq("exactly one tab is lit", nav.items.filter((i) => i.active).length, 1);
    eq("  …and it is Finance", nav.items.find((i) => i.active)?.text, "Finance");
    // MORE MUST NOT ALSO LOOK LIT. It has no aria-current, so only its styling can say so.
    const moreLit = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('nav[aria-label="Primary"] button')]
        .find((b) => (b.textContent ?? "").trim() === "More");
      return btn ? /text-deep-green/.test(btn.className) : null;
    });
    eq("  …and More is not lit as well", moreLit, false);

    // ── SCROLLED TO THE BOTTOM, THE LAST ROW CLEARS THE BAR ──────────────────────────────────
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(400);
    const clear = await page.evaluate(() => {
      const bar = document.querySelector('nav[aria-label="Primary"]').getBoundingClientRect();
      let lowest = 0, who = "";
      for (const el of document.querySelectorAll("main *, [data-testid]")) {
        if (el.closest('nav[aria-label="Primary"]')) continue;
        const b = el.getBoundingClientRect();
        if (b.height === 0 || b.width === 0) continue;
        if (b.bottom > lowest && b.bottom < window.innerHeight + 400) {
          lowest = b.bottom; who = el.getAttribute("data-testid") ?? el.tagName;
        }
      }
      return { lowest: Math.round(lowest), barTop: Math.round(bar.top), who };
    });
    eq(`the last content row clears the tab bar (${clear.lowest} <= ${clear.barTop}, "${clear.who}")`,
      clear.lowest <= clear.barTop + 1, true);
  }

  await closeContext(ctx);
}

eq("no uncaught page errors", errors, []);

console.log(`\n================ RESULT ================`);
console.log(`Assertions: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFAILURES:");
  for (const f of failures) console.log(`  ${f}`);
}
await closeBrowser(browser);
process.exit(failures.length ? 1 : 0);
