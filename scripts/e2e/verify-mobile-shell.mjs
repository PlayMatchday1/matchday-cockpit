// ONE APP BAR AT THE TOP OF EVERY PHONE SCREEN.
//
// Ryan: "On mobile alot of the pages have this big massive space. They all should have the same
// shared hamburger view with no extra space up top. I think we can also make the hamburger view
// better it's kind of mini."
//
// THE GAP WAS THE NOTCH INSET PAID TWICE: AuthGate's <main> and the bar that lived inside it. The
// shell owns the bar now and is the only thing that pays it.
//
// IT FORCES --sat: 59px the way globals.css says a harness may, so the gap is a measured number
// rather than a screenshot. The force happens AFTER hydration: setting it before the page's own
// styles land is overwritten, and a harness that silently measures a 0px notch is a harness that
// cannot see this bug at all.
//
// NOTHING IS WRITTEN. Every non-GET is intercepted.
//
//   node scripts/e2e/verify-mobile-shell.mjs
import { chromium } from "playwright";
import { installHarnessGuard, fatal, closeContext, closeBrowser, storageStateFor, nonEmpty } from "./_session.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
const ADMIN = "rmancuso@playmatchday.com";
const SAT = 59;

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} - ${d}`); console.log(`  XX  ${n} - ${d}`); };
const is = (n, got, exp) => (JSON.stringify(got) === JSON.stringify(exp) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(exp)}`));
const yes = (n, got, d = "") => (got === true ? ok(n) : bad(n, d || `got ${JSON.stringify(got)}`));

const READ = () => {
  const q = (s) => document.querySelector(s);
  const T = (s) => q(s)?.textContent.replace(/\s+/g, " ").trim() ?? null;
  const R = (e) => { const b = e.getBoundingClientRect();
    return { t: Math.round(b.top), b: Math.round(b.bottom), h: Math.round(b.height), w: Math.round(b.width) }; };
  const vw = document.documentElement.clientWidth;
  const bars = [...document.querySelectorAll('[data-testid="mo-mobile-header"]')];
  const band = bars[0]?.querySelector("div") ?? null;
  const titleEl = q('[data-testid="mo-screen-picker"], [data-testid="mo-screen-title"]');
  const main = q("main");
  const h1 = q("main h1");
  return {
    vw, vh: window.innerHeight,
    hscroll: document.documentElement.scrollWidth > vw + 2,
    bars: bars.length,
    siblings: bars[0]?.getAttribute("data-siblings") ?? null,
    band: band ? R(band) : null,
    title: titleEl ? { ...R(titleEl), tag: titleEl.tagName, text: titleEl.textContent.replace(/\s+/g, " ").trim() } : null,
    chevron: T('[data-testid="mo-screen-picker"]')?.includes("▾") ?? false,
    main: main ? { ...R(main), pt: getComputedStyle(main).paddingTop } : null,
    /* THE CONTROL FOR ITEM 1: how many elements ANYWHERE pay at least the inset. Exactly one, and
     * it must be the bar. Counting only <main> would miss a page that pays it some other way. */
    payers: [...document.querySelectorAll("body *")]
      .filter((e) => parseFloat(getComputedStyle(e).paddingTop) >= 59)
      .map((e) => e.closest('[data-testid="mo-mobile-header"]') ? "in-the-bar" : (e.getAttribute("data-testid") ?? e.tagName + "." + String(e.className).slice(0, 24))),
    h1: h1 ? {
      text: h1.textContent.replace(/\s+/g, " ").trim(),
      /* THE HEADING'S OWN TEXT, ignoring children — the description lives in an <i> inside it. */
      ownText: [...h1.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").replace(/\s+/g, " ").trim(),
      dupNode: h1.hasAttribute("data-dup-title"),
      dupText: h1.getAttribute("data-dup-title") ? [...h1.childNodes].filter((n) => n.nodeType === 3)
        .map((n) => n.textContent).join("").replace(/\s+/g, " ").trim() : null,
      /* COLLAPSED, NOT DISPLAY:NONE — the description nested inside it has to survive. */
      dupHidden: parseFloat(getComputedStyle(h1).fontSize) === 0,
      ...R(h1) } : null,
    firstCardTop: (() => {
      const c = q("main [class*='rounded'], main section, main table");
      return c ? Math.round(c.getBoundingClientRect().top) : null;
    })(),
  };
};

const SHEET = () => {
  const q = (s) => document.querySelector(s);
  const T = (s) => q(s)?.textContent.replace(/\s+/g, " ").trim() ?? null;
  const panel = q('[data-testid="screen-sheet"] > div:nth-child(2)');
  const list = q('[data-testid="sheet-list"]');
  const scrim = q('[data-testid="screen-sheet"] > button');
  const rows = [...document.querySelectorAll('[data-testid^="screen-dest-"]')];
  const search = q('[data-testid="sheet-search"]');
  const close = q('[data-testid="sheet-close"]');
  const cur = rows.find((r) => r.getAttribute("aria-current") === "page");
  const other = rows.find((r) => r.getAttribute("aria-current") !== "page");
  const mark = (r) => r ? {
    ariaCurrent: r.getAttribute("aria-current"),
    tick: r.querySelectorAll("svg").length > 1,
    tinted: getComputedStyle(r).backgroundColor,
    weight: getComputedStyle(r.querySelector("span > span")).fontWeight,
    h: Math.round(r.getBoundingClientRect().height),
  } : null;
  return {
    vh: window.innerHeight,
    open: q('[data-testid="screen-sheet"]') != null,
    panel: panel ? { h: Math.round(panel.getBoundingClientRect().height),
      pct: +(panel.getBoundingClientRect().height / window.innerHeight * 100).toFixed(1) } : null,
    scrimTop: scrim ? Math.round(scrim.getBoundingClientRect().top) : null,
    list: list ? { sh: list.scrollHeight, ch: list.clientHeight } : null,
    groups: [...document.querySelectorAll('[data-testid="sheet-group"]')].map((e) => e.textContent.trim()),
    search: search ? { h: Math.round(search.getBoundingClientRect().height) } : null,
    close: close ? { h: Math.round(close.getBoundingClientRect().height) } : null,
    sub: T('[data-testid="sheet-sub"]'),
    foot: T('[data-testid="sheet-foot"]'),
    fade: q('[data-testid="sheet-fade"]')?.getAttribute("data-on") ?? null,
    /* ROWS WHOLLY INSIDE THE LIST'S BOX. "rendered" is not "visible": the whole bug was seven rows
     * rendered and two on screen. */
    visible: (() => { const l = q('[data-testid="sheet-list"]'); if (!l) return null;
      const lb = l.getBoundingClientRect();
      return [...document.querySelectorAll('[data-testid^="screen-dest-"]')]
        .filter((r) => { const b = r.getBoundingClientRect(); return b.top >= lb.top - 1 && b.bottom <= lb.bottom + 1; }).length; })(),
    rowsTotalH: [...document.querySelectorAll('[data-testid^="screen-dest-"]')]
      .reduce((a, r) => a + r.getBoundingClientRect().height, 0),
    padB: (() => { const pn = q('[data-testid="screen-sheet"] > div:nth-child(2)');
      return pn ? parseFloat(getComputedStyle(pn).paddingBottom) : null; })(),
    navH: (() => { const v = getComputedStyle(document.documentElement).getPropertyValue("--bottom-nav-h").trim();
      const d = document.createElement("div"); d.style.height = v; document.body.appendChild(d);
      const h = d.getBoundingClientRect().height; d.remove(); return h; })(),
    rows: rows.length,
    rowMinH: rows.length ? Math.min(...rows.map((r) => Math.round(r.getBoundingClientRect().height))) : null,
    clipped: rows.filter((r) => { const n = r.querySelector("span > span"); return n && n.scrollWidth > n.clientWidth + 1; })
      .map((r) => r.textContent.trim().slice(0, 24)),
    current: mark(cur),
    other: mark(other),
    lastRowBottom: rows.length ? Math.round(rows[rows.length - 1].getBoundingClientRect().bottom) : null,
    navTop: (() => { const n = [...document.querySelectorAll("nav, [class*='fixed']")]
      .find((e) => /bottom-0|inset-x-0/.test(String(e.className)) && e.getBoundingClientRect().height > 40);
      return n ? Math.round(n.getBoundingClientRect().top) : null; })(),
  };
};

async function boot(browser, storageState, width) {
  const ctx = await browser.newContext({ storageState, viewport: { width, height: 844 },
    ...(width < 900 ? { isMobile: true, hasTouch: true } : {}) });
  const writes = [];
  await ctx.route("**/rest/v1/**", async (route) => {
    const m = route.request().method();
    if (m === "GET" || m === "HEAD") return route.fallback();
    writes.push(m);
    return route.fulfill({ status: 204, body: "" });
  });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e)));
  return { ctx, p, writes, errs };
}

/** Load, settle, then force the notch. Returns nothing; every assertion reads after this. */
async function go(p, route, wait = 2600) {
  await p.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: 150000 });
  await p.waitForTimeout(wait);
  await p.evaluate((v) => document.documentElement.style.setProperty("--sat", `${v}px`), SAT);
  await p.waitForTimeout(450);
}

async function main() {
  const { storageState } = await storageStateFor(ADMIN, BASE);
  const browser = await chromium.launch();

  // ══ 1, 2, 3, 4. THE GAP ═══════════════════════════════════════════════════════════════════
  {
    const { ctx, p, errs } = await boot(browser, storageState, 390);
    console.log("\n-- the gap, with a forced 59px notch --");
    await go(p, "/growth/field-pipeline");
    let d = await p.evaluate(READ);
    is("  no page error", errs, []);
    /* THE INSET IS PAID ONCE, AND BY THE BAR. */
    is("  exactly one element pays the inset", d.payers.length, 1);
    is("  and it is inside the bar", d.payers[0], "in-the-bar");
    is("  <main> pays nothing below the rail breakpoint", d.main.pt, "0px");
    is(`  the title sits at ${d.title.t}px, which is the status bar and a hair`, d.title.t, SAT + 4);
    // 3. THE BAND.
    is(`  the bar's own band is 44px under the inset (${d.band.h} total)`, d.band.h - SAT, 44);
    yes(`  and its title is a ${d.title.h}px tap target`, d.title.h >= 36);
    // 2. CONTENT STARTS WHERE THE BAR ENDS.
    is("  content starts exactly where the bar ends, with nothing between", d.main.t, d.band.b);
    // 4. ONE BAR, NEVER TWO.
    is("  one bar", d.bars, 1);
    for (const r of ["/match-ops/gameday", "/match-ops/match-chats", "/match-ops/master-schedule"]) {
      await go(p, r);
      d = await p.evaluate(READ);
      is(`  one bar on ${r}`, d.bars, 1);
      is(`    and one payer of the inset`, d.payers.length, 1);
      is(`    the title still sits at ${SAT + 4}px`, d.title.t, SAT + 4);
    }
    await closeContext(ctx);
  }

  // ══ 2b. THE DUPLICATED HEADING ════════════════════════════════════════════════════════════
  {
    const { ctx, p, errs } = await boot(browser, storageState, 390);
    console.log("\n-- the heading printed twice --");
    await go(p, "/growth/field-pipeline");
    /* WAIT FOR THE SUPPRESSION, do not race it. The board re-renders when its data lands, which
     * restores the text node and the observer re-wraps it; reading at a fixed 3s sometimes lands
     * between those two. A presence wait is the ready signal. */
    /* POLL, DO NOT SAMPLE. The board re-renders when its data lands, which restores the text node;
     * the observer re-wraps it a tick later. A single read can land in that window, and did. */
    const wrapped = await p.waitForFunction(
      () => document.querySelector("main h1[data-dup-title]") != null,
      { timeout: 25000 },
    ).then(() => true).catch(() => false);
    const d = await p.evaluate(READ);
    if (!wrapped) {
      console.log("     DIAG:", JSON.stringify(await p.evaluate(() => {
        const h1 = document.querySelector("main h1");
        return { h1s: document.querySelectorAll("main h1").length,
          kids: h1 ? [...h1.childNodes].map((n) => n.nodeType === 3 ? "TEXT:" + n.textContent.trim().slice(0, 18) : n.nodeName) : null,
          anyDup: document.querySelectorAll("[data-dup-title]").length,
          h1fs: h1 ? getComputedStyle(h1).fontSize : null,
          wide: window.matchMedia("(min-width: 900px)").matches,
          bars: document.querySelectorAll('[data-testid="mo-mobile-header"]').length };
      })));
    }
    yes("  the duplicate title is wrapped for hiding", wrapped);
    is("  no page error", errs, []);
    yes(`  the page's heading repeats the bar's title ("${d.title.text.replace("▾", "").trim()}")`,
      ((d.h1?.ownText || d.h1?.dupText) ?? "").toLowerCase() === d.title.text.replace("▾", "").trim().toLowerCase());
    is("  and the heading is marked as the duplicate it is", d.h1.dupNode, true);
    is("  its own text is actually collapsed, not just marked", d.h1.dupHidden, true);
    /* THE DESCRIPTION AND THE CHIPS STAY. They are not duplicates of anything and the chips are
     * the only place the counts live. */
    const kept = await p.evaluate(() => {
      const t = document.querySelector("main")?.innerText ?? "";
      return { desc: /Every field by stage/i.test(t), chips: /fields/i.test(t) && /cities/i.test(t) };
    });
    yes("  CONTROL: the description line stays", kept.desc);
    yes("  CONTROL: and so do the stat chips", kept.chips);
    /* CONTROL: A PAGE WHOSE H1 IS NOT THE BAR'S TITLE KEEPS IT. */
    await go(p, "/home");
    const h = await p.evaluate(READ);
    yes(`  CONTROL: /home's H1 ("${(h.h1?.text ?? "").slice(0, 34)}…") is not the bar's title`,
      (h.h1?.text ?? "").toLowerCase() !== (h.title?.text ?? "").toLowerCase());
    is("  CONTROL: so nothing of it is suppressed", h.h1?.dupNode ?? false, false);
    await closeContext(ctx);
  }

  // ══ 2d, 2e. A PAGE WITH NO SIBLINGS, AND THE TWO SECTIONS THAT HAD NO BAR ═════════════════
  {
    const { ctx, p, errs } = await boot(browser, storageState, 390);
    console.log("\n-- a page with no siblings --");
    for (const r of ["/data", "/admin"]) {
      await go(p, r);
      const d = await p.evaluate(READ);
      is(`  ${r}: one bar`, d.bars, 1);
      is(`    at the same offset`, d.title.t, SAT + 4);
      is(`    marked as having no siblings`, d.siblings, "0");
      is(`    and the title is NOT a button`, d.title.tag, "H2");
      is(`    with no chevron`, d.title.text.includes("▾"), false);
    }
    console.log("-- and the sections that had none --");
    for (const [r, want] of [["/tech/tech-roadmap", "1"], ["/membership", "1"]]) {
      await go(p, r);
      const d = await p.evaluate(READ);
      is(`  ${r}: has a bar`, d.bars, 1);
      is(`    CONTROL: with siblings, so the title IS a control`, d.siblings, want);
      is(`    and it is a button`, d.title.tag, "BUTTON");
    }
    is("  no page error", errs, []);
    await closeContext(ctx);
  }

  // ══ 5, 2c. THE CHAT CONSOLES ══════════════════════════════════════════════════════════════
  {
    const { ctx, p, errs } = await boot(browser, storageState, 390);
    console.log("\n-- the chat consoles --");
    for (const r of ["/match-ops/match-chats", "/match-ops/player-chats"]) {
      await go(p, r, 3400);
      const d = await p.evaluate(READ);
      is(`  ${r}: one bar`, d.bars, 1);
      is(`    one payer`, d.payers.length, 1);
      is(`    title at ${SAT + 4}px like every other route`, d.title.t, SAT + 4);
      /* THE SHELL MUST NOT OVERFLOW THE VIEWPORT. It is 100dvh minus the bar now, because the bar
       * is above it rather than inside it. */
      const shell = await p.evaluate(() => {
        /* THE 100dvh SHELL ITSELF, found by its own height rule rather than by a class that also
         * matches inner scrollers. */
        const e = [...document.querySelectorAll("main > div, main > div > div")]
          .find((x) => /100dvh/.test(x.getAttribute("class") ?? "") || /calc\(100dvh/.test(x.style.height ?? ""));
        return e ? { h: Math.round(e.getBoundingClientRect().height) } : null;
      });
      yes(`    the 100dvh shell still fits the viewport (${shell?.h}px in ${d.vh})`,
        shell != null && shell.h <= d.vh);
      is(`    CONTROL: no horizontal scroll`, d.hscroll, false);
    }
    is("  no page error", errs, []);
    await closeContext(ctx);
  }

  // ══ 6. DESKTOP IS UNCHANGED ═══════════════════════════════════════════════════════════════
  {
    const { ctx, p, errs } = await boot(browser, storageState, 1280);
    console.log("\n-- desktop --");
    await go(p, "/growth/field-pipeline");
    /* NO FORCED NOTCH ON DESKTOP. --main-pt is max(var(--sat), 26px), so a forced 59px inset would
     * correctly make it 59 — which is right, and not what this item is about. */
    await p.evaluate(() => document.documentElement.style.setProperty("--sat", "0px"));
    await p.waitForTimeout(300);
    const d = await p.evaluate(READ);
    is("  no page error", errs, []);
    const barShown = await p.evaluate(() => {
      const b = document.querySelector('[data-testid="mo-mobile-header"]');
      return b ? getComputedStyle(b).display !== "none" : false;
    });
    is("  the bar is hidden above the rail breakpoint", barShown, false);
    is("  <main> still pays its 26px", d.main.pt, "26px");
    is("  CONTROL: and nothing in the heading is suppressed", d.h1?.dupNode ?? false, false);
    await closeContext(ctx);
  }

  // ══ 7-13. THE SHEET ═══════════════════════════════════════════════════════════════════════
  {
    const { ctx, p, errs } = await boot(browser, storageState, 390);
    console.log("\n-- the sheet --");
    const open = async (route) => {
      await go(p, route);
      await p.click('[data-testid="mo-screen-picker"]');
      await p.waitForSelector('[data-testid="screen-sheet"]', { timeout: 20000 });
      await p.waitForTimeout(600);
      return p.evaluate(SHEET);
    };
    const g = await open("/growth/field-pipeline");
    const g2 = await open("/match-ops/gameday");
    const m = await open("/match-ops/master-schedule");
    is("  no page error", errs, []);
    // 7. THE SAME HEIGHT WHATEVER IS IN IT.
    is(`  Growth (${g.rows} screens) and Daily Ops (${g2.rows}) open at the same height`, g.panel.h, g2.panel.h);
    is(`  and so does Back Office (${m.rows})`, g.panel.h, m.panel.h);
    yes(`  and it is ${g.panel.pct}% of the viewport`, g.panel.pct >= 60);
    yes(`  CONTROL: and no more than 90%`, g.panel.pct <= 90);
    // 8. GROUPS.
    is("  Growth renders its two group headings", g.groups, ["Fields", "Fundraising"]);
    is(`  CONTROL: Match Ops renders four (${m.groups.join(", ")})`, m.groups.length, 4);
    is("  each once", new Set(m.groups).size, m.groups.length);
    // 1. ALL SEVEN OF DAILY OPS, AND NONE BELOW THE FOLD.
    is(`  Daily Ops renders all ${g2.rows} of its screens`, g2.rows, 7);
    is(`  and every one is on screen (list ${g2.list.ch}px for ${Math.round(g2.rowsTotalH)}px of rows)`,
      g2.visible, g2.rows);
    yes(`  with ${g2.list.ch - Math.round(g2.rowsTotalH)}px of margin, not by a hair`,
      g2.list.ch - g2.rowsTotalH > 0);
    // 2. THE NAV IS CLEARED ONCE.
    yes(`  the sheet's bottom padding (${g2.padB}px) no longer includes the nav height (${g2.navH}px)`,
      g2.padB < g2.navH);
    // 3. NO SEARCH FIELD ANYWHERE.
    is(`  CONTROL: no search field at ${g2.rows} screens`, g2.search, null);
    is(`  CONTROL: nor at ${m.rows}, the largest list in the app`, m.search, null);

    // 11. THE CURRENT SCREEN, THREE SIGNALS.
    is("  the current screen carries aria-current", m.current.ariaCurrent, "page");
    yes("  a tick", m.current.tick);
    yes(`  and a tinted row (${m.current.tinted})`, m.current.tinted !== m.other.tinted);
    yes(`  CONTROL: another row carries none of the three`,
      m.other.ariaCurrent == null && !m.other.tick && m.other.tinted !== m.current.tinted);
    // 4. THE FADE SAYS THERE IS MORE BELOW.
    is(`  Back Office scrolls (${m.list.sh} in ${m.list.ch}) and shows the fade`, m.fade, "1");
    is(`  CONTROL: Daily Ops fits, so it shows none`, g2.fade, "0");
    is(`  CONTROL: nor does Growth's four`, g.fade, "0");

    // 13. THE SCRIM.
    is(`  the scrim starts below the status band`, m.scrimTop, SAT);
    // header + footer
    yes(`  the header says where you are: "${m.sub}"`, /screens · you are on/.test(m.sub ?? ""));
    yes(`  and the footer draws the boundary: "${(m.foot ?? "").slice(0, 46)}…"`,
      /Sections live in the bar at the bottom/.test(m.foot ?? ""));
    is("  CONTROL: no em-dash in either", /—/.test((m.sub ?? "") + (m.foot ?? "")), false);

    // 12. THE LAST ROW CLEARS THE BOTTOM NAV. This is the :57 bug, re-proven.
    const scrolled = await p.evaluate(() => {
      const l = document.querySelector('[data-testid="sheet-list"]');
      l.scrollTop = l.scrollHeight;
      const rows = [...document.querySelectorAll('[data-testid^="screen-dest-"]')];
      const nav = [...document.querySelectorAll("nav, div")]
        .find((e) => /fixed/.test(String(e.className)) && /bottom-0|inset-x-0/.test(String(e.className))
          && e.getBoundingClientRect().height > 40 && e.getBoundingClientRect().bottom >= window.innerHeight - 2);
      return { sh: l.scrollHeight, ch: l.clientHeight,
        last: Math.round(rows[rows.length - 1].getBoundingClientRect().bottom),
        navTop: nav ? Math.round(nav.getBoundingClientRect().top) : null,
        vh: window.innerHeight };
    });
    yes(`  the list genuinely scrolls (${scrolled.sh} in ${scrolled.ch})`, scrolled.sh > scrolled.ch);
    if (scrolled.navTop != null) {
      yes(`  and scrolled to the end the last row clears the bottom nav (${scrolled.last} vs ${scrolled.navTop})`,
        scrolled.last <= scrolled.navTop);
    } else {
      yes(`  and scrolled to the end the last row is on screen (${scrolled.last} in ${scrolled.vh})`,
        scrolled.last <= scrolled.vh);
    }
    is(`  CONTROL: a four-item list does not invent a scrollbar`, g.list.sh > g.list.ch, false);
    is(`  CONTROL: nor does Daily Ops' seven`, g2.list.sh > g2.list.ch, false);
    /* THE FADE TURNS OFF AT THE END. On while there is something below, off once there is not. */
    /* THE SCROLL IS SET FROM SCRIPT, so React has not flushed the resulting state when the next
     * evaluate runs. Poll for the off state rather than sampling it one tick too early. */
    const atEnd = await p.waitForFunction(
      () => document.querySelector('[data-testid="sheet-fade"]')?.getAttribute("data-on") === "0",
      { timeout: 8000 },
    ).then(() => "0").catch(async () =>
      p.evaluate(() => document.querySelector('[data-testid="sheet-fade"]')?.getAttribute("data-on")));
    is("  and the fade turns off at the end of the list", atEnd, "0");
    await closeContext(ctx);
  }

  // ══ 14. 390 AND 430 ═══════════════════════════════════════════════════════════════════════
  for (const w of [390, 430]) {
    const { ctx, p, errs } = await boot(browser, storageState, w);
    console.log(`\n-- ${w}px --`);
    await go(p, "/match-ops/master-schedule");
    let d = await p.evaluate(READ);
    is("  no page error", errs, []);
    is("  no horizontal scroll on the page", d.hscroll, false);
    await p.click('[data-testid="mo-screen-picker"]');
    await p.waitForSelector('[data-testid="screen-sheet"]', { timeout: 20000 });
    await p.waitForTimeout(600);
    const s = await p.evaluate(SHEET);
    d = await p.evaluate(READ);
    is("  no horizontal scroll with the sheet open", d.hscroll, false);
    yes(`  rows are ${s.rowMinH}px`, s.rowMinH >= 56);
    is("  CONTROL: and still no search field", s.search, null);
    yes(`  the close button is ${s.close.h}px`, s.close.h >= 38);
    /* GUARDED: "nothing is clipped" is zero, and a sheet with no rows prints the same zero. */
    yes(`  CONTROL: there are ${nonEmpty(new Array(s.rows).fill(0), "sheet rows").length} rows to clip`, s.rows > 0);
    is("  no screen name is clipped", s.clipped, []);
    await closeContext(ctx);
  }

  await closeBrowser(browser);
  console.log(`\nmobile-shell: ${PASS} passed, ${FAIL} failed`);
  if (FAIL) { for (const f of fails) console.log(`  XX ${f}`); process.exit(1); }
}

main().catch(fatal);
