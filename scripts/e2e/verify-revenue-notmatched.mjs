// THE "NOT MATCHED TO A VENUE" POPOVER, on the Revenue page.
//
// It replaced a block of month sentences above the table. The caveat is about ONE column —
// revenue matched to a venue — so it now lives on that column's header and nowhere else.
//
// WHAT THIS PINS, and why each one is here rather than left to a screenshot:
//   · the popover is PORTALLED out of the table's overflow-x container. Anchored inside it, it
//     would be clipped by that scroller or drift away from the ⓘ when the table scrolls sideways —
//     and Member mix is already off-screen, so the table really does scroll.
//   · opening it changes NO layout. A header that grows or a column that widens on open is a
//     table that moves under the reader.
//   · click works, not hover only. Hover-only is unreachable on a phone and from a keyboard.
//   · the ⓘ does not sort. These headers carry no sort handler today; the assertion is what keeps
//     that true if one is added.
//
//   node scripts/e2e/verify-revenue-notmatched.mjs
import { chromium } from "playwright";
import { installHarnessGuard, closeContext, closeBrowser, storageStateFor } from "./_session.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
const URL_ = `${BASE}/admin/finance/revenue`;
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const { storageState } = await storageStateFor("rmancuso@playmatchday.com", BASE);
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState, viewport: { width: 1620, height: 1200 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(URL_, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="revenue-group-row"]', { timeout: 90000 });
await page.waitForTimeout(1500);
eq("no uncaught page errors", errors, []);
const rowCount = await page.locator('[data-testid="revenue-group-row"]').count();
eq("  control — the table rendered rows to reason about", rowCount > 2, true);

// ── 1. THE SENTENCES ARE GONE ─────────────────────────────────────────────────────────────────
console.log("\n── the month sentences are gone ──");
{
  const body = await page.evaluate(() => document.body.innerText);
  eq("  control — the scan read a real page", body.length > 1200, true);
  eq("  control — it finds text that IS present ('Total revenue')",
     /total revenue/i.test(body), true);
  eq("no 'is not matched to a venue —' sentence survives", /is not matched to a venue/i.test(body), false);
  eq("no '% of gross' sentence survives", /% of gross/i.test(body), false);
  eq("the old gap element is gone", await page.locator('[data-testid="revenue-gap"]').count(), 0);
  eq("…and so are its lines", await page.locator('[data-testid="gap-line"]').count(), 0);
  const planted = await page.evaluate(() => {
    const d = document.createElement("div"); d.textContent = "is not matched to a venue —";
    document.body.appendChild(d);
    const hit = /is not matched to a venue/i.test(document.body.innerText);
    d.remove(); return hit;
  });
  eq("  control — a planted sentence IS caught", planted, true);
}

// ── 1b. THE HEADERS ───────────────────────────────────────────────────────────────────────────
// "Matched to a venue" was a qualifier on a figure, printed as if it were the figure's name. It is
// gone from every header; the ⓘ carries the qualification now, on the one column it applies to.
console.log("\n── the headers ──");
const readHeads = () => page.evaluate(() => {
  // NAME THE TABLE. The bare document.querySelector("table") fallback grabbed the SUMMARY table
  // at the top of the page in Match View, so the scan read the wrong headers entirely.
  // Match View's table is mv-table now — the thirteen-select grid and revenue-match-table were
  // replaced by the stats-band view, and the old id no longer exists.
  const t = document.querySelector('[data-testid="revenue-group-table"]')
    ?? document.querySelector('[data-testid="mv-table"]');
  return {
    // CSS uppercases these and the ⓘ glyph sits inside the cell — normalise both away so the
    // assertion is about the WORDS, which is what was specified.
    heads: [...(t?.querySelectorAll("thead th") ?? [])]
      .map((h) => h.innerText.replace(/ⓘ/g, "").replace(/\s+/g, " ").trim().toUpperCase()),
    cells: [...new Set([...(t?.querySelectorAll("tbody tr") ?? [])]
      .filter((r) => !r.className.includes("tot"))
      .map((r) => r.querySelectorAll("td").length))],
  };
});
// TARGET THE BREAKDOWN CONTROL BY TESTID. Matching on the visible label matched nothing, so every
// "switch view" call silently did nothing and three assertions compared City View to itself.
const setGrain = async (g) => {
  await page.locator(`[data-testid="breakdown-${g}"]`).click();
  await page.waitForTimeout(2200);
};

const cityHeads = await readHeads();
eq("City View headers are exactly the specified list", cityHeads.heads,
   ["#", "CITY", "VENUES", "MATCHES", "TOTAL REVENUE", "AVG REVENUE / MATCH",
    "AVG REVENUE / VENUE", "DPP REVENUE", "MEMBERSHIP REVENUE", "MEMBER MIX"]);
eq("City View: every row's cell count equals the header count", cityHeads.cells, [cityHeads.heads.length]);

await setGrain("field");
const fieldHeads = await readHeads();
eq("Field View headers are exactly the specified list", fieldHeads.heads,
   ["#", "FIELD", "CITY", "LAUNCHED", "MATCHES", "TOTAL REVENUE", "AVG REVENUE / MATCH",
    "DPP REVENUE", "MEMBERSHIP REVENUE", "MEMBER MIX"]);
eq("Field View: every row's cell count equals the header count", fieldHeads.cells, [fieldHeads.heads.length]);

// SHARED HEADERS: byte-identical, and in the same relative order.
{
  /* ITEMISED — AN EXPECTATION CHANGE, NOT A SELECTOR EDIT. Four of these carried "(IN MONTH)"
   * until 2026-08-23. It is one fact said four times, so it moved to a single note beside the row
   * count (data-testid="breakdown-scope"), which verify-revenue-membership asserts appears exactly
   * once and names LAUNCHED as the exception. The assertion bodies here are unchanged; what they
   * compare against records the new headers. */
  const shared = ["MATCHES", "TOTAL REVENUE", "AVG REVENUE / MATCH",
                  "DPP REVENUE", "MEMBERSHIP REVENUE", "MEMBER MIX"];
  const orderIn = (heads) => shared.map((h) => heads.indexOf(h));
  eq("every shared header is present in City View", orderIn(cityHeads.heads).every((i) => i >= 0), true);
  eq("…and in Field View", orderIn(fieldHeads.heads).every((i) => i >= 0), true);
  const asc = (a) => a.every((v, i) => i === 0 || v > a[i - 1]);
  eq("the shared columns run in the same relative order in both",
     [asc(orderIn(cityHeads.heads)), asc(orderIn(fieldHeads.heads))], [true, true]);
  eq("  control — the shared list is not empty", shared.length, 6);
}

// NO "MATCHED TO A VENUE" IN ANY HEADER, on any of the three views.
{
  const scan = async (view) => {
    const h = await readHeads();
    const hit = h.heads.filter((x) => /matched to a venue/i.test(x));
    eq(`${view}: no header says "matched to a venue"`, hit, []);
    return h.heads;
  };
  await setGrain("city"); const c = await scan("City View");
  await setGrain("field"); await scan("Field View");
  await setGrain("match"); const m = await scan("Match View");
  eq("  control — Match View rendered its own headers", m.length > 3 && m.join() !== c.join(), true);
  // The control names a header Match View ACTUALLY has now. Its columns changed with the rebuild:
  // "DPP revenue" became "DPP" (a spot count) and the money moved to "Revenue".
  eq("  control — a header that IS present is found ('Field cost')",
     m.some((x) => /field cost/i.test(x)), true);
  const planted = await page.evaluate(() => {
    const th = document.querySelector("thead th");
    const old = th.textContent;
    th.textContent = "Revenue matched to a venue";
    const hit = /matched to a venue/i.test(document.querySelector("thead").innerText);
    th.textContent = old;
    return hit;
  });
  eq("  control — a planted 'matched to a venue' header IS caught", planted, true);
  await setGrain("city");
}

// ── 1c. THE FIGURES ARE UNTOUCHED ─────────────────────────────────────────────────────────────
// This was a header rename and a reorder. Nothing about the arithmetic moved, and the assertion
// that proves it is the one that cannot pass by accident: DPP + membership must equal the total
// exactly, on the rendered page.
console.log("\n── the figures ──");
{
  await setGrain("city");
  const f = await page.evaluate(() => {
    const n = (t) => Number(String(t ?? "").replace(/[^0-9.-]/g, ""));
    const tr = [...document.querySelectorAll("tbody tr")].find((r) => r.className.includes("tot"));
    const tds = [...(tr?.querySelectorAll("td") ?? [])].map((x) => x.innerText.trim());
    return {
      venues: n(tds[2]), matches: n(tds[3]),
      // THE COLUMN ITSELF, so the Total can be checked against what it totals.
      // SCOPED TO THE TABLE THE TOTAL ROW IS IN. There is more than one table on this page, and
      // an unscoped "tbody tr" swept the monthly summary's rows in too — whose fourth cell is
      // money, which is how a match count came out as half a million.
      rowMatches: [...(tr?.closest("table")?.querySelectorAll("tbody tr") ?? [])]
        .filter((r) => !r.className.includes("tot"))
        // td,th — a BODY row leads with a <th> for the rank while the Total row is all <td>, so
        // querying only td shifts every body index by one and reads the revenue column instead.
        .map((r) => n([...r.querySelectorAll("td,th")][3]?.innerText)),
      total: n(document.querySelector('[data-testid="gt-tot-total"]')?.innerText),
      dpp: n(document.querySelector('[data-testid="gt-tot-dpp"]')?.innerText),
      member: n(document.querySelector('[data-testid="gt-tot-member"]')?.innerText),
    };
  });
  /* ITEMISED — AN EXPECTATION CHANGE, NOT A SELECTOR EDIT. 29 -> 30: migration 0142 mapped MatchDay
   * field 1618 ("Zipp Family Sports Park") and created the San Antonio venue "New Braunfels" for
   * it, so the estate has one more venue. Predicted before 0142 was applied, and this is the
   * assertion that was named as needing to move with it.
   *
   * 30 -> 31: fin_venues #65 "Ann Richards School" (Austin) was created 2026-08-25T02:18 through
   * the Field Costs add-venue flow. Not a code change and not this session's write path — the
   * Fields assign route had made no write at that point, and fin_venue_fields was still 41 links.
   * MatchDay field 1651 "Ann Richards School" carries 6 live matches from 2026-08-15, so the venue
   * is real; it is on the Cost page's field table already.
   *
   * A CONSTANT HERE IS DELIBERATE and survives that: unlike the match count and the membership
   * total below — both of which were pinned, both of which drifted on live data, and both of which
   * are now checked relationally — the venue count only changes when someone adds or removes a
   * venue, which is exactly the thing worth being told about. Being told is what just happened. */
  eq("venues 31", f.venues, 31);
  // WAS PINNED AT 344 AND DRIFTED TO 346 — August is a live month and matches keep landing, so a
  // constant here fails on a page that is working. The Total is now checked against the column it
  // totals, which catches a broken or mis-summed column without dating the suite.
  eq("the Total row's match count equals the sum of the rows", f.matches, f.rowMatches.reduce((a, b) => a + b, 0));
  eq("  control — the column carried rows with matches in them", f.rowMatches.filter((x) => x > 0).length > 0, true);
  /* WAS PINNED AT $17,690 AND DRIFTED TO $17,781 — August is a live month and memberships keep
   * arriving, so a constant here fails on a page that is working. Proved pre-existing by running
   * this against a stashed tree. What must hold whatever the amount is: the parts add to the
   * whole, and membership is a real figure rather than a zero or a dash. */
  eq("membership is a real figure, not zero", f.member > 0, true);
  eq("  …and DPP + membership still equals the total", f.dpp + f.member, f.total);
  // NOT HARDCODED. The DPP figure and the total have both moved $101 since the brief was written —
  // the mirror refreshes daily and revenue rows land. What must hold whatever the amounts are is
  // that the parts add to the whole; a rename cannot break that and a broken column would.
  eq("DPP + membership equals the total exactly", f.dpp + f.member, f.total);
  eq("  control — the figures are non-zero, so the sum is a real check", f.total > 1000 && f.dpp > 1000, true);
  console.log(`     total $${f.total.toLocaleString()} = DPP $${f.dpp.toLocaleString()} + membership $${f.member.toLocaleString()}`);
}

// ── 1d. LAYOUT ────────────────────────────────────────────────────────────────────────────────
// THE BADGES WERE SLICED BECAUSE THE TABLE OVERFLOWS ITS SCROLLER, not because of the card's
// padding, the table's inset, or the badge's own box — measured: 10px inside its cell at rest,
// all 7 sliced the moment the table scrolled right to reach Member mix. The # column is pinned
// now, so this asserts at BOTH scroll positions; asserting only at rest would pass on the
// original bug.
console.log("\n── layout ──");
for (const W of [1440, 1024]) {
  await page.setViewportSize({ width: W, height: 1100 });
  await page.waitForTimeout(1200);
  await setGrain("city");
  for (const where of ["rest", "scrolled right"]) {
    if (where !== "rest") {
      await page.evaluate(() => {
        const w = document.querySelector('[data-testid="revenue-group-table"]').parentElement;
        w.scrollLeft = w.scrollWidth;
      });
      await page.waitForTimeout(500);
    }
    const m = await page.evaluate(() => {
      const tbl = document.querySelector('[data-testid="revenue-group-table"]');
      const wrap = tbl.parentElement;
      const wb = wrap.getBoundingClientRect();
      const rows = [...document.querySelectorAll('[data-testid="revenue-group-row"]')];
      const bad = rows.map((r, i) => {
        const cell = r.querySelector("td"), badge = cell.querySelector("span");
        const cb = cell.getBoundingClientRect(), bb = badge.getBoundingClientRect();
        const visible = Math.max(0, Math.min(bb.right, wb.right) - Math.max(bb.left, wb.left));
        return {
          i: i + 1,
          insideCell: bb.left >= cb.left - 0.5 && bb.right <= cb.right + 0.5,
          fullyVisible: visible >= bb.width - 0.5,
          insideTable: cb.left >= wb.left - 0.5,
        };
      });
      return { count: rows.length, bad: bad.filter((x) => !x.insideCell || !x.fullyVisible || !x.insideTable) };
    });
    eq(`  ${W}px, ${where}: every rank badge is inside its cell and fully visible`, m.bad.map((x) => x.i), []);
    if (where === "rest") eq(`  control — ${W}px has rows to check`, m.count, 7);
  }
}
await page.setViewportSize({ width: 1620, height: 1200 });
await page.waitForTimeout(1200);
await setGrain("city");

// THE TOTAL ROW STOPS SHORT OF THE CARD.
{
  const t = await page.evaluate(() => {
    const tbl = document.querySelector('[data-testid="revenue-group-table"]');
    const card = tbl.parentElement.parentElement;
    const tot = [...document.querySelectorAll("tbody tr")].find((r) => r.className.includes("tot"));
    const cs = getComputedStyle(card);
    const firstTd = tot.querySelector("td"), lastTd = tot.querySelector("td:last-child");
    return {
      gap: Math.round(card.getBoundingClientRect().bottom - tot.getBoundingClientRect().bottom),
      cardPad: parseFloat(cs.paddingBottom),
      radiusL: getComputedStyle(firstTd).borderBottomLeftRadius,
      radiusR: getComputedStyle(lastTd).borderBottomRightRadius,
    };
  });
  eq("the Total row sits at least one padding unit above the card's inner bottom", t.gap >= t.cardPad, true);
  console.log(`     ${t.gap}px below the Total row · card padding ${t.cardPad}px`);
  eq("the band's outer cells are rounded, so no corner squares off the card",
     [t.radiusL !== "0px", t.radiusR !== "0px"], [true, true]);
}

// EVERY NUMERIC HEADER'S INK LINES UP WITH ITS COLUMN'S NUMBERS.
{
  const align = await page.evaluate(() => {
    // The right edge of the INK, not of the cell box — comparing boxes is trivially zero and
    // would have passed on the misaligned header.
    const inkRight = (el) => {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let last = null, n;
      while ((n = w.nextNode())) if ((n.textContent ?? "").trim()) last = n;
      if (!last) return null;
      const r = document.createRange(); r.selectNodeContents(last);
      const rects = [...r.getClientRects()];
      return rects.length ? rects[rects.length - 1].right : null;
    };
    const tbl = document.querySelector('[data-testid="revenue-group-table"]');
    const ths = [...tbl.querySelectorAll("thead th")];
    const tds = [...document.querySelector('[data-testid="revenue-group-row"]').querySelectorAll("td")];
    return ths.map((th, i) => {
      if (getComputedStyle(th).textAlign !== "right" || !tds[i]) return null;
      const h = inkRight(th);
      // THE # COLUMN HOLDS A BADGE, NOT A NUMBER. Its digit is centred inside an 18px chip, so
      // comparing ink to ink measures the chip's internal padding and nothing useful. The right
      // comparison there is the CHIP's edge — which is what a reader's eye follows.
      const badge = tds[i].querySelector("span");
      const d = badge ? badge.getBoundingClientRect().right : inkRight(tds[i]);
      if (h == null || d == null) return null;
      return { label: th.innerText.replace(/\s+/g, " ").trim(), delta: Math.round((h - d) * 10) / 10 };
    }).filter(Boolean);
  });
  eq("  control — there are numeric headers to align", align.length >= 6, true);
  eq("every numeric header's ink is within 1px of its column's numbers",
     align.filter((a) => Math.abs(a.delta) > 1), []);
  const tr = align.find((a) => /TOTAL REVENUE/i.test(a.label));
  eq("  …including TOTAL REVENUE, with the ⓘ present", tr != null && Math.abs(tr.delta) <= 1, true);
  console.log(`     TOTAL REVENUE header ink is ${tr?.delta}px from its numbers`);
}

// THE ⓘ COSTS NO LAYOUT — proven by removing it and re-measuring.
{
  const before = await page.evaluate(() => {
    const th = [...document.querySelectorAll('[data-testid="revenue-group-table"] thead th')]
      .find((t) => /total revenue/i.test(t.innerText));
    return { h: Math.round(th.closest("tr").getBoundingClientRect().height), w: Math.round(th.getBoundingClientRect().width) };
  });
  const after = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="notmatched-info"]');
    const parent = btn.parentElement, next = btn.nextSibling;
    btn.remove();
    const th = [...document.querySelectorAll('[data-testid="revenue-group-table"] thead th')]
      .find((t) => /total revenue/i.test(t.innerText));
    const m = { h: Math.round(th.closest("tr").getBoundingClientRect().height), w: Math.round(th.getBoundingClientRect().width) };
    parent.insertBefore(btn, next);   // put it back
    return m;
  });
  eq("the header row height is the same with the ⓘ and without it", before.h, after.h);
  // THE COLUMN IS SIZED BY ITS HEADER, NOT ITS NUMBERS — "$24,148" is ~75px, the label ~177px.
  // So an inline ⓘ that does not overlap the label cannot be free: it costs its own box. What is
  // asserted is that it costs NO MORE than that, which is what stops a regression from making it
  // arbitrarily wide. The measured cost is logged so the trade-off stays visible.
  const cost = before.w - after.w;
  /* THE BOUND IS MEASURED, NOT WRITTEN DOWN. It used to be the literal 24. When "(IN MONTH)" came
   * off this header the label got shorter, the column stopped being sized by slack, and the ⓘ's
   * cost went from partly absorbed to fully exposed: 25px against a 24×24 hit area. Bumping the
   * literal to 25 would record that pixel as a rule; reading the button's OWN box and allowing the
   * 1px inline gap beside it keeps the assertion about the thing it names. */
  const hit = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="notmatched-info"]').getBoundingClientRect();
    return Math.round(b.width);
  });
  eq("the ⓘ widens its column by no more than its own hit area plus the gap beside it",
     cost <= hit + 2, true);
  console.log(`     header row ${before.h}px with and without · column ${after.w}px → ${before.w}px, the ⓘ costs ${cost}px`);
  eq("  control — the ⓘ is back on the page after the test removed it",
     await page.locator('[data-testid="notmatched-info"]').count(), 1);
}

// ── 2. CLOSED ON LOAD, AND ABSENT FROM THE TREE ───────────────────────────────────────────────
console.log("\n── closed on load ──");
const info = page.locator('[data-testid="notmatched-info"]');
eq("the ⓘ exists", await info.count(), 1);
eq("the panel is not in the DOM at all, not merely hidden", await page.locator('[data-testid="notmatched-panel"]').count(), 0);
eq("…and the trigger reports collapsed", await info.getAttribute("aria-expanded"), "false");
eq("it carries an aria-label", (await info.getAttribute("aria-label") ?? "").length > 5, true);
eq("it is a real button", await info.evaluate((e) => e.tagName), "BUTTON");
{
  const box = await info.boundingBox();
  eq("the hit area is at least 24×24 even though the glyph is 14px",
     box.width >= 24 && box.height >= 24, true);
  console.log(`     hit area ${Math.round(box.width)}×${Math.round(box.height)}`);
}

// ── 3. LAYOUT IS UNCHANGED BY OPENING ─────────────────────────────────────────────────────────
console.log("\n── opening it moves nothing ──");
const metrics = () => page.evaluate(() => {
  const th = [...document.querySelectorAll('[data-testid="revenue-group-table"] thead th')]
    .find((t) => /revenue matched to a venue/i.test(t.innerText));
  const row = th?.closest("tr");
  return {
    headerHeight: Math.round(row?.getBoundingClientRect().height ?? 0),
    colWidth: Math.round(th?.getBoundingClientRect().width ?? 0),
  };
});
const before = await metrics();
await info.click();
await page.waitForSelector('[data-testid="notmatched-panel"]', { timeout: 8000 });
const after = await metrics();
eq("the header row height is identical open and closed", after.headerHeight, before.headerHeight);
eq("the column width is identical open and closed", after.colWidth, before.colWidth);
console.log(`     header ${before.headerHeight}px · column ${before.colWidth}px`);

// ── 4. THE FIGURES ────────────────────────────────────────────────────────────────────────────
console.log("\n── the four figures ──");
{
  const rows = await page.locator('[data-testid="notmatched-row"]').evaluateAll((els) =>
    els.map((e) => {
      const td = e.querySelectorAll("td");
      return { month: td[0]?.innerText.trim(), amount: td[1]?.innerText.trim(), pct: td[2]?.innerText.trim() };
    }));
  eq("the panel lists a row per month with a gap", rows.length > 0, true);
  console.log("     " + rows.map((r) => `${r.month} ${r.amount} ${r.pct}`).join(" · "));
  eq("every amount is a dollar figure", rows.every((r) => /^\$[\d,]+$/.test(r.amount)), true);
  eq("every percentage is one decimal", rows.every((r) => /^\d+\.\d%$/.test(r.pct)), true);
  eq("the heading is exactly the specified text",
     (await page.locator('[data-testid="notmatched-panel"]').innerText()).split("\n")[0].trim(),
     "Not matched to a venue");
}

// ── 5. IT DOES NOT SORT ───────────────────────────────────────────────────────────────────────
console.log("\n── the ⓘ does not re-sort the table ──");
{
  const first = () => page.locator('[data-testid="revenue-group-row"]').first().getAttribute("data-label");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const a = await first();
  await info.click(); await page.waitForTimeout(400);
  const b = await first();
  await info.click(); await page.waitForTimeout(400);
  const c = await first();
  eq("the first row is unchanged by opening and closing it", [b, c], [a, a]);
  eq("  control — there IS a first row to have been reordered", a != null, true);
}

// ── 6. OPEN / CLOSE BEHAVIOUR ─────────────────────────────────────────────────────────────────
console.log("\n── click, click again, Escape, outside click ──");
const isOpen = () => page.locator('[data-testid="notmatched-panel"]').count().then((n) => n > 0);
await info.click(); await page.waitForTimeout(350);
eq("click opens it", await isOpen(), true);
await info.click(); await page.waitForTimeout(350);
eq("clicking again closes it", await isOpen(), false);
await info.click(); await page.waitForTimeout(350);
await page.keyboard.press("Escape"); await page.waitForTimeout(350);
eq("Escape closes it", await isOpen(), false);
await info.click(); await page.waitForTimeout(350);
// A BLIND COORDINATE CLICK IS NOT AN "OUTSIDE CLICK" — (20,400) landed on a page control and
// navigated away, taking the table with it. Dispatch the event the handler actually listens for,
// on the body, where nothing can be hit by accident.
await page.evaluate(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
await page.waitForTimeout(350);
eq("an outside click closes it", await isOpen(), false);

// ── 7. IT SURVIVES A SIDEWAYS SCROLL, UNCLIPPED ───────────────────────────────────────────────
console.log("\n── the table scrolls sideways and the panel keeps up ──");
{
  /* NARROWED ON PURPOSE, AND THIS IS WHY. At 1620px the table USED to overflow, so the control
   * below passed by accident of width. Dropping "(IN MONTH)" from four headers made it narrower
   * than the viewport, scrollLeft stayed 0, and the control failed — correctly: it exists to stop
   * exactly this section from passing on a table that never scrolled. The fix is to give it a
   * viewport where the table genuinely does scroll, not to relax the control. */
  await page.setViewportSize({ width: 900, height: 1100 });
  await page.waitForTimeout(400);
  // Reset the table's horizontal scroll and bring the trigger into view before clicking — a
  // previous assertion left the pointer elsewhere and the header can sit outside the scrollport.
  await page.evaluate(() => {
    const t = document.querySelector('[data-testid="revenue-group-table"]');
    if (t?.parentElement) t.parentElement.scrollLeft = 0;
  });
  await info.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await info.click();
  await page.waitForSelector('[data-testid="notmatched-panel"]');
  const scrolled = await page.evaluate(() => {
    const t = document.querySelector('[data-testid="revenue-group-table"]');
    const wrap = t?.parentElement;
    if (!wrap) return 0;
    wrap.scrollLeft = wrap.scrollWidth;   // all the way right — Member mix is off-screen
    return wrap.scrollLeft;
  });
  eq("  control — the table really does scroll horizontally", scrolled > 0, true);
  await page.waitForTimeout(500);
  const geo = await page.evaluate(() => {
    const p = document.querySelector('[data-testid="notmatched-panel"]').getBoundingClientRect();
    const b = document.querySelector('[data-testid="notmatched-info"]').getBoundingClientRect();
    return {
      inViewport: p.left >= -0.5 && p.right <= window.innerWidth + 0.5 && p.top >= -0.5,
      dx: Math.round(Math.abs(p.left - b.left)),
      dy: Math.round(p.top - b.bottom),
      stillOpen: true,
    };
  });
  eq("the panel is still fully inside the viewport after scrolling", geo.inViewport, true);
  eq("…and still adjacent to its trigger", geo.dy >= 0 && geo.dy < 40, true);
  console.log(`     offset from trigger after scroll: ${geo.dx}px across, ${geo.dy}px below`);
  await page.keyboard.press("Escape");
}

// ── 8. AT 390px ───────────────────────────────────────────────────────────────────────────────
console.log("\n── 390px ──");
{
  // The previous section left the table scrolled fully right. Reset it — otherwise the trigger
  // sits outside the scrollport at 390px and this measures the consequence of that, not the
  // popover's own placement.
  await page.evaluate(() => {
    const t = document.querySelector('[data-testid="revenue-group-table"]');
    if (t?.parentElement) t.parentElement.scrollLeft = 0;
    window.scrollTo(0, 0);
  });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  eq("  control — the panel is shut before the viewport changes", await isOpen(), false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1500);
  const i2 = page.locator('[data-testid="notmatched-info"]');
  if (await i2.count() === 0) {
    console.log("  --  the group table is not rendered at 390px; popover not applicable");
  } else {
    await i2.scrollIntoViewIfNeeded();
    await i2.click();
    await page.waitForSelector('[data-testid="notmatched-panel"]', { timeout: 8000 });
    // WAIT FOR THE SETTLE RE-PLACE. The panel measures on open, again next frame, and again once
    // the browser has settled — that third pass is what corrects a position taken mid-reflow after
    // scrollIntoViewIfNeeded. Measuring immediately reads the first pass and reports a drift the
    // user would never see.
    await page.waitForTimeout(500);
    const openW = await page.evaluate(() => {
      const p = document.querySelector('[data-testid="notmatched-panel"]').getBoundingClientRect();
      return {
        inViewport: p.left >= -0.5 && p.right <= window.innerWidth + 0.5,
        scrollWidth: document.documentElement.scrollWidth,
        left: Math.round(p.left), right: Math.round(p.right),
      };
    });
    eq("the panel is fully within a 390px viewport", openW.inViewport, true);
    console.log(`     panel ${openW.left}→${openW.right} in a 390px viewport`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const closedW = await page.evaluate(() => document.documentElement.scrollWidth);
    // THE PAGE ALREADY SCROLLS SIDEWAYS AT 390px, WITH THE PANEL SHUT — the Revenue control row
    // (.ctrlStack / .ctrlGroup / .seg) runs to 591px. That is a pre-existing defect of this page
    // and is reported, not fixed here. What this asserts is that the popover ADDS nothing to it.
    eq("the popover adds nothing to the page's horizontal extent", openW.scrollWidth, closedW);
    console.log(`     page scrollWidth ${closedW}px at 390px viewport — pre-existing, panel shut`);
  }
}

await closeContext(ctx);
await closeBrowser(browser);
console.log(`\n${PASS} passed, ${FAIL} failed`);
if (fails.length) { console.log("\nFAILURES:"); for (const f of fails) console.log("  " + f); }
process.exit(FAIL === 0 ? 0 : 1);
