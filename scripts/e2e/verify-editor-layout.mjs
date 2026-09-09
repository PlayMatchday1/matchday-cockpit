/* THE MATCH EDITOR'S GEOMETRY, measured on the real panel in every state it renders in.
 *
 * WHY EVERY STATE. The last several builds each missed one the check did not cover — mobile-only,
 * then desktop-only, then Week-only. This panel is opened from Gameday Ops and from Master
 * Schedule's Week AND Month views, at phone and desktop widths, so all of those are walked.
 *
 *   node scripts/e2e/verify-editor-layout.mjs
 *   BREAK_ALIGN=1 node ...   # positive control: the alignment assertions MUST fail
 */
import { chromium } from "playwright";
import { storageStateFor, installHarnessGuard } from "./_session.mjs";
installHarnessGuard();
const BASE = process.env.BASE || "http://localhost:3000";
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  XX  ${n} — ${d}`); };
const yes = (n, c, d = "") => (c ? ok(n) : bad(n, d));
const is = (n, g, w) => (JSON.stringify(g) === JSON.stringify(w) ? ok(n) : bad(n, `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`));

/* Puts the 9px margin back on grid items — the exact defect, so the control proves the alignment
   assertions are sensitive to it and not to something incidental. */
const BREAK = `.mp-grid > .mp-f + .mp-f, .mp-grid3 > .mp-f + .mp-f{margin-top:9px !important}`;
/* Removes the one-rhythm rule, restoring the six-value spacing it replaced — so the uniformity
   assertions have a control that reproduces the real defect, zeros included. */
const BREAK_RHYTHM = `.mp-secbd > * + *{margin-top:0 !important}
.mp-f + .mp-f,.mp-grid + .mp-grid{margin-top:9px !important}`;

const CASES = [
  { host: "Gameday Ops", url: "/match-ops/gameday", opener: '[data-testid="gday-row"]', pre: null, widths: ["desktop", "phone"] },
  { host: "Master Schedule · Week", url: "/match-ops/master-schedule", opener: '[data-testid="card"]', pre: null, widths: ["desktop", "phone"] },
  { host: "Master Schedule · Month", url: "/match-ops/master-schedule", opener: '[data-testid="month-match"]', pre: '[data-testid="view-month"]', widths: ["desktop"] },
];
const WIDTHS = { desktop: ["desktop 1440", 1440, 1000], phone: ["phone 390", 390, 844] };

async function main() {
  process.loadEnvFile(".env.local");
  const { storageState } = await storageStateFor("rmancuso@playmatchday.com", BASE);
  const browser = await chromium.launch({ headless: true });
  const breaking = !!process.env.BREAK_ALIGN;
  if (breaking) console.log("\n!! BREAK_ALIGN set — the 9px is back on purpose. Alignment MUST fail.\n");

  for (const c of CASES) for (const wk of c.widths) {
    const [label, w, h] = WIDTHS[wk];
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, storageState, isMobile: w < 500, hasTouch: w < 500 });
    const page = await ctx.newPage();
    await page.goto(`${BASE}${c.url}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(c.pre ? '[data-testid="card"]' : c.opener, { timeout: 60000 });
    await page.waitForTimeout(2500);
    if (c.pre) { await page.click(c.pre); await page.waitForSelector(c.opener, { timeout: 45000 }); await page.waitForTimeout(4000); }
    await page.click(c.opener);
    await page.waitForSelector('[data-testid="gday-panel"] .mp-fs', { timeout: 45000 });
    await page.waitForTimeout(2500);
    if (breaking) await page.addStyleTag({ content: BREAK });
    if (process.env.BREAK_RHYTHM) await page.addStyleTag({ content: BREAK_RHYTHM });
    await page.waitForTimeout(400);
    const tag = `${c.host} @ ${label}`;
    console.log(`\n— ${tag} —`);

    const m = await page.evaluate(() => {
      const P = '[data-testid="gday-panel"] ';
      const q = (s) => document.querySelector(P + s);
      const grids = [...document.querySelectorAll(P + ".mp-grid, " + P + ".mp-grid3")];
      const rows = grids.map((g) => {
        const fs = [...g.children].filter((e) => e.classList.contains("mp-f"));
        /* GROUPED BY GRID ROW. A 2-column grid holding 3 fields has TWO rows, and the third
           field is CORRECTLY lower than the first two — comparing every field in a grid would
           call that a failure. Rows are derived from the column count. */
        const cols = getComputedStyle(g).gridTemplateColumns.split(" ").length;
        const top = (e) => Math.round(e.getBoundingClientRect().top);
        const lTop = (e) => { const l = e.querySelector(".mp-lb"); return l ? Math.round(l.getBoundingClientRect().top) : null; };
        const byRow = [];
        for (let i = 0; i < fs.length; i += cols) byRow.push(fs.slice(i, i + cols));
        return {
          n: fs.length, cols,
          margins: fs.slice(1).map((e) => getComputedStyle(e).marginTop),
          rowTops: byRow.map((r) => r.map(top)),
          rowLabelTops: byRow.map((r) => r.map(lTop)),
          gap: getComputedStyle(g).rowGap,
        };
      });
      /* ── THE SECTION RHYTHM. Every top-level child of a section body, and the gap above it.
       * The old rule set named three adjacencies out of a dozen, so the rest fell to ZERO: measured
       * six distinct gaps for one conceptual space — 0, 8, 9, 11, 12, 14 — with MATCH NAME flush
       * against the CATEGORY grid. Sections are opened first so every gap is measurable. */
      document.querySelectorAll(P + '.mp-sechd[aria-expanded="false"]').forEach((e) => e.click());
      const gaps = [];
      document.querySelectorAll(P + ".mp-sec").forEach((sec) => {
        const bd = sec.querySelector(".mp-secbd"); if (!bd) return;
        const kids = [...bd.children].filter((e) => getComputedStyle(e).display !== "none");
        for (let i = 1; i < kids.length; i++) {
          const prev = kids[i - 1], cur = kids[i];
          gaps.push({
            gap: Math.round(cur.getBoundingClientRect().top - prev.getBoundingClientRect().bottom),
            divider: prev.classList.contains("mp-secrule") || cur.classList.contains("mp-secrule"),
            from: (prev.querySelector(".mp-lb")?.textContent?.trim() || prev.className.split(" ")[0] || prev.tagName).slice(0, 20),
            to: (cur.querySelector(".mp-lb")?.textContent?.trim() || cur.className.split(" ")[0] || cur.tagName).slice(0, 20),
          });
        }
      });
      const inlineMargins = [...document.querySelectorAll(P + "[style]")]
        .filter((e) => /margin-top/.test(e.getAttribute("style") || ""))
        .filter((e) => e.parentElement?.classList.contains("mp-secbd"))
        .map((e) => e.getAttribute("style"));

      const box = (s) => { const e = q(s); if (!e) return null; const r = e.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left) }; };
      const acmin = box('[data-testid="mp-acmin"]');
      const step = (() => { const e = q('[data-testid="mp-min"]')?.closest(".mp-step"); if (!e) return null;
        const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left) }; })();
      const btn = box('[data-testid="mp-min-down"]');
      // the $ mark against the first digit
      const cur = q(".mp-cur i"), inp = q('[data-testid="mp-price"]');
      const gap = cur && inp ? Math.round(inp.getBoundingClientRect().left + parseFloat(getComputedStyle(inp).paddingLeft) - cur.getBoundingClientRect().right) : null;
      return {
        rows, gaps, inlineMargins,
        acmin, step, btn,
        stepIn: box('[data-testid="mp-min"]'),
        minLabel: q('[data-testid="mp-min-field"] .mp-lb')?.textContent ?? null,
        hints: [...document.querySelectorAll(P + ".mp-lb em")].map((e) => e.textContent),
        curMarks: document.querySelectorAll(P + ".mp-cur i").length,
        curPointer: cur ? getComputedStyle(cur).pointerEvents : null,
        curGap: gap,
        spotPlaceholder: q('[data-testid="mp-spot"]')?.getAttribute("placeholder") ?? null,
        /* THE MONEY GRID, not every .mp-grid3 — SPOTS/SHOWN uses the same class, and pooling the
           two makes "share a baseline" fail on rows that were never meant to share one. */
        moneyLabelTops: (() => { const g = q('[data-testid="mp-price"]')?.closest(".mp-grid3");
          return g ? [...g.querySelectorAll(".mp-lb")].map((e) => Math.round(e.getBoundingClientRect().top)) : []; })(),
        moneyInputHeights: (() => { const g = q('[data-testid="mp-price"]')?.closest(".mp-grid3");
          return g ? [...g.querySelectorAll("input")].map((e) => Math.round(e.getBoundingClientRect().height)) : []; })(),
        linked: document.querySelectorAll(P + ".mp-linked").length,
        /* THE CONTROL: .mp-f + .mp-f OUTSIDE A GRID MUST STILL BE 9px.
         * THE PANEL HAS NO LIVE SUBJECT FOR IT. The only stacked pair outside a grid is
         * DESCRIPTION / MANAGER INTRO, and MANAGER INTRO carries style={{ marginTop: 12 }}
         * INLINE — which beats every stylesheet rule and did so before this change too. So the
         * subject is INJECTED: two bare .mp-f siblings in a non-grid container, measured, then
         * removed. A synthetic subject, said out loud, beats asserting on the wrong element. */
        stackedGap: (() => {
          const host = document.querySelector(P + ".mp-secbd");
          if (!host) return null;
          const a = document.createElement("label"), b = document.createElement("label");
          a.className = "mp-f"; b.className = "mp-f";
          host.appendChild(a); host.appendChild(b);
          const got = getComputedStyle(b).marginTop;
          a.remove(); b.remove();
          return got;
        })(),
        inlineOverride: (() => { const e = document.querySelector(P + '[data-testid="mp-intro"]')?.closest(".mp-f");
          return e ? e.getAttribute("style") : null; })(),   // null once the inline margin is gone
      };
    });

    const twoUp = m.rows.filter((r) => r.n >= 2);
    console.log(`     ${m.rows.length} grids · ${twoUp.length} with 2+ fields · cols ${JSON.stringify([...new Set(m.rows.map(r=>r.cols))])}`);
    is(`${tag}: every grid item's margin-top is 0`, [...new Set(twoUp.flatMap((r) => r.margins))], ["0px"]);
    const allRows = m.rows.flatMap((r) => r.rowTops).filter((r) => r.length > 1);
    const allLabelRows = m.rows.flatMap((r) => r.rowLabelTops).filter((r) => r.length > 1);
    /* AT ONE COLUMN THERE ARE NO TWO-UP ROWS. Under 560px the grids collapse by design, so the
       alignment assertion has no subject — reported as such rather than passed or failed. */
    if (allRows.length === 0) ok(`${tag}: one column here, so no two-up row to align (media query at 560px)`);
    else yes(`${tag}: every field in a grid ROW shares a top (${allRows.length} rows)`,
      allRows.every((r) => new Set(r).size === 1), JSON.stringify(allRows));
    yes(`${tag}: …and their labels share a baseline`,
      allLabelRows.every((r) => new Set(r.filter((x) => x != null)).size === 1), JSON.stringify(allLabelRows));
    is(`${tag}: row spacing is the grid's own 12px gap`, [...new Set(m.rows.map((r) => r.gap))], ["12px"]);
    /* THE CONTROL THAT MUST NOT MOVE: stacked fields outside a grid keep their 9px. */
    /* ── THE SECTION RHYTHM: one number between blocks, and no zeros. ── */
    const plain = m.gaps.filter((g) => !g.divider);
    console.log(`     ${m.gaps.length} top-level gaps · ${plain.length} plain · values ${JSON.stringify([...new Set(m.gaps.map((g) => g.gap))].sort((a, b) => a - b))}`);
    yes(`${tag}: no top-level gap is 0`, m.gaps.every((g) => g.gap !== 0),
      JSON.stringify(m.gaps.filter((g) => g.gap === 0).map((g) => `${g.from} -> ${g.to}`)));
    is(`${tag}: every non-divider gap is the same 12px`, [...new Set(plain.map((g) => g.gap))], [12]);
    yes(`${tag}: the divider still reads as a divider (more room than a plain gap)`,
      m.gaps.filter((g) => g.divider).every((g) => g.gap > 12), JSON.stringify(m.gaps.filter((g) => g.divider).map((g) => g.gap)));
    is(`${tag}: no inline margin-top survives on a section child`, m.inlineMargins, []);
        /* THE 9px IS GONE, AND THAT IS THIS BUILD'S POINT. The previous version of this assertion
     * expected 9px between stacked fields outside a grid, on the belief that the rule did real work
     * there. It did not: .mp-f + .mp-f named three adjacencies out of a dozen and left the rest at
     * ZERO. A stacked pair now takes the same 12px as every other block, from .mp-secbd > * + *. */
    is(`${tag}: an injected stacked .mp-f pair outside a grid takes the same 12px`, m.stackedGap, "12px");
    is(`${tag}: …and MANAGER INTRO no longer carries an inline margin`, m.inlineOverride, null);

    if (m.step && m.acmin) {
      console.log(`     MIN PLAYERS ${m.step.w}x${m.step.h}@top${m.step.top} · AUTO-CANCEL MINUTES ${m.acmin.w}x${m.acmin.h}@top${m.acmin.top} · button ${m.btn?.w}x${m.btn?.h} · typing area ${m.stepIn?.w}`);
      is(`${tag}: MIN PLAYERS is the same size as AUTO-CANCEL MINUTES`, [m.step.w, m.step.h], [m.acmin.w, m.acmin.h]);
      /* SIDE BY SIDE ONLY WHEN THE GRID IS TWO-UP. Under 560px it collapses to one column and
         MIN PLAYERS sits BELOW auto-cancel minutes, which is correct, not a misalignment. */
      const twoCol = m.rows.some((r) => r.cols > 1);
      if (twoCol) is(`${tag}: …and the same top`, m.step.top, m.acmin.top);
      else ok(`${tag}: …stacked below it at one column, as the media query intends`);
    } else bad(`${tag}: the MIN PLAYERS stepper exists`, "not found");
    is(`${tag}: MIN PLAYERS has no hint`, m.minLabel, "MIN PLAYERS");
    yes(`${tag}: the other hints are untouched`, ["optional", "before kickoff", "total"].every((x) => m.hints.some((h) => h?.includes(x))), JSON.stringify(m.hints));
    is(`${tag}: no .mp-linked anywhere`, m.linked, 0);

    is(`${tag}: a $ renders inside both money inputs`, m.curMarks, 2);
    is(`${tag}: …and does not swallow a click`, m.curPointer, "none");
    yes(`${tag}: …sitting within 4px of the first digit`, m.curGap != null && Math.abs(m.curGap) <= 4, `${m.curGap}px`);
    is(`${tag}: SPOT PRICE placeholder`, m.spotPlaceholder, "same as price");
    const moneyTwoUp = m.rows.some((r) => r.cols > 1);
    if (!moneyTwoUp) ok(`${tag}: MONEY stacks at one column, so its labels do not share a baseline`);
    else yes(`${tag}: all three MONEY labels share a baseline`, new Set(m.moneyLabelTops).size === 1, JSON.stringify(m.moneyLabelTops));
    yes(`${tag}: …and all three inputs are the same height`, new Set(m.moneyInputHeights).size === 1, JSON.stringify(m.moneyInputHeights));

    /* THE STEPPER WORKS: type, increment, decrement, and disable with auto-cancel off. */
    if (!breaking && c.host === "Gameday Ops" && wk === "desktop") {
      const val = () => page.$eval('[data-testid="mp-min"]', (e) => e.value);
      const before = await val();
      await page.fill('[data-testid="mp-min"]', "9");
      is(`${tag}: typing works`, await val(), "9");
      await page.click('[data-testid="mp-min-up"]'); await page.waitForTimeout(250);
      is(`${tag}: + increments`, await val(), "10");
      await page.click('[data-testid="mp-min-down"]'); await page.waitForTimeout(250);
      is(`${tag}: − decrements`, await val(), "9");
      await page.fill('[data-testid="mp-min"]', "2"); await page.waitForTimeout(250);
      is(`${tag}: − is disabled at the floor of 2`, await page.$eval('[data-testid="mp-min-down"]', (e) => e.disabled), true);
      const dirty = await page.$eval('[data-testid="mp-min"]', (e) => e.closest(".mp-step").className.includes("mp-chg"));
      yes(`${tag}: the dirty mark is on the whole frame`, dirty);
      await page.fill('[data-testid="mp-min"]', before);
      /* AUTO-CANCEL OFF DISABLES ALL THREE PARTS. Toggled and toggled back; nothing is saved. */
      await page.click('[data-testid="mp-ac"]'); await page.waitForTimeout(400);
      const dis = await page.evaluate(() => ["mp-min-down", "mp-min", "mp-min-up"]
        .map((t) => document.querySelector(`[data-testid="${t}"]`)?.disabled));
      is(`${tag}: all three parts disable with auto-cancel off`, dis, [true, true, true]);
      await page.click('[data-testid="mp-ac"]'); await page.waitForTimeout(300);
    }
    await ctx.close();
  }

  await browser.close();
  console.log(`\nverify-editor-layout: ${PASS} passed, ${FAIL} failed`);
  if (FAIL) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
}
main();
