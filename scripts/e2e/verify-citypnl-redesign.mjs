// CITY P&L — six columns, one answer, and a bar that is honest about scale.
//
// WHAT THIS EXISTS TO CATCH. Nine numeric columns at equal weight, a badge on every row, and
// Austin rendered identically to a city 27x smaller. The redesign makes Net P&L dominant and the
// badge rare — both of which are easy to undo by accident, because CSS specificity decides them
// rather than markup. It already happened once: `.tbl tbody td` sets 14.5px and outranks a bare
// `.net6`, so Net P&L shipped at exactly Revenue's size until this suite measured it.
//
// EVERY EXPECTED FIGURE IS DERIVED — from the row's own cells, from another row, or from the
// footer. Nothing is pinned: these are live production numbers and they move nightly.

import { chromium } from "playwright";
import { installHarnessGuard, closeContext, closeBrowser, storageStateFor , nonEmpty } from "./_session.mjs";

installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
let passed = 0;
const failures = [];
const ok = (n) => { passed += 1; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

/** "−$1,852" → -1852. The minus is U+2212, not a hyphen. */
const money = (t) => {
  const s = String(t ?? "").replace(/[,$\s]/g, "");
  if (!/\d/.test(s)) return null;
  const neg = /^[−-]/.test(s);
  return (neg ? -1 : 1) * Number(s.replace(/[−-]/g, ""));
};
const pct = (t) => {
  const s = String(t ?? "").replace(/[%\s]/g, "");
  if (!/\d/.test(s)) return null;
  return (/^[−-]/.test(s) ? -1 : 1) * Number(s.replace(/[−-]/g, ""));
};

const browser = await chromium.launch();
const { storageState } = await storageStateFor("rmancuso@playmatchday.com", BASE);
const errors = [];

// ══ DESKTOP ══════════════════════════════════════════════════════════════════════════════════
for (const W of [1440, 1120]) {
  console.log(`\n════════ desktop ${W} ════════`);
  const ctx = await browser.newContext({ storageState, viewport: { width: W, height: 1000 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${W}: ${e}`));
  await page.goto(`${BASE}/admin/finance/cities`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="citypnl-row"]', { timeout: 240000 });
  await page.waitForTimeout(1500);

  const heads = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="citypnl-table"] thead th')].map((t) => t.textContent.trim()));
  console.log("\n── the six columns ──");
  eq("six headers, in P&L order, with their minus signs", heads,
    ["City", "Revenue", "− Field cost", "− Overhead", "Net P&L", "Margin"]);

  const rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid="citypnl-row"]')].map((r) => {
    const g = (id) => r.querySelector(`[data-testid="${id}"]`);
    const cs = (e) => (e ? getComputedStyle(e) : null);
    const net = g("citypnl-net"), rev = g("citypnl-rev");
    const barRev = g("citypnl-bar-rev"), barNet = g("citypnl-bar-net");
    return {
      city: r.getAttribute("data-city"), loss: r.getAttribute("data-loss") === "true",
      rev: rev?.textContent, field: g("citypnl-field")?.textContent,
      over: g("citypnl-overhead-cell")?.textContent, net: net?.textContent,
      margin: g("citypnl-margin")?.textContent,
      netSize: parseFloat(cs(net)?.fontSize ?? "0"), netWeight: Number(cs(net)?.fontWeight ?? 0),
      revSize: parseFloat(cs(rev)?.fontSize ?? "0"), revWeight: Number(cs(rev)?.fontWeight ?? 0),
      netColor: cs(net)?.color, revColor: cs(rev)?.color,
      barRevW: barRev?.getBoundingClientRect().width ?? 0,
      barNetW: barNet?.getBoundingClientRect().width ?? 0,
      badge: !!g("citypnl-loss-badge"),
      // NO VERTICAL RULES — they chop a row meant to be read across.
      vrules: [...r.querySelectorAll("td")].filter((td) => {
        const c = getComputedStyle(td);
        return parseFloat(c.borderLeftWidth) > 0 || parseFloat(c.borderRightWidth) > 0;
      }).length,
    };
  }));
  eq("  control — rows rendered", rows.length > 0, true);

  // ── THE HIERARCHY ──────────────────────────────────────────────────────────────────────────
  console.log("\n── Net P&L is the answer ──");
  {
    eq("Net P&L is larger than Revenue in every row",
      rows.filter((r) => !(r.netSize > r.revSize)).map((r) => `${r.city} ${r.netSize}/${r.revSize}`), []);
    eq("  …and heavier", rows.filter((r) => !(r.netWeight >= r.revWeight)).map((r) => r.city), []);
    eq("  …and the largest figure in its row", rows.every((r) => r.netSize >= r.revSize), true);
    // REVENUE IS GREEN, NET IS A DARKER GREEN. Both green, and the answer still wins on tone.
    const rgb = (c) => (String(c).match(/\d+/g) ?? []).map(Number);
    const lum = (c) => { const [r, g, b] = rgb(c); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const profitable = rows.filter((r) => !r.loss);
    eq("  control — there are profitable rows to compare", profitable.length > 0, true);
    eq("revenue is green", profitable.every((r) => { const [rr, g, b] = rgb(r.revColor); return g > rr && g > b; }), true);
    eq("  …and Net P&L is a DARKER green than it",
      profitable.filter((r) => !(lum(r.netColor) < lum(r.revColor))).map((r) => r.city), []);
    // A LOSS PRINTS ITS MINUS IN RED.
    for (const r of rows.filter((x) => x.loss)) {
      const [rr, g, b] = rgb(r.netColor);
      eq(`  ${r.city}: a loss prints red`, rr > g && rr > b, true);
      eq(`    …with a minus sign`, /^[−-]/.test(r.net.trim()), true);
    }
  }

  // ── BADGES ONLY ON LOSSES ──────────────────────────────────────────────────────────────────
  console.log("\n── the badge is a signal ──");
  {
    const losses = rows.filter((r) => r.loss);
    const badged = rows.filter((r) => r.badge);
    eq("  control — there is at least one loss and one profit", [losses.length > 0, losses.length < rows.length], [true, true]);
    eq("badge count equals loss count", badged.length, losses.length);
    eq("  …and they are the same rows", badged.map((r) => r.city).sort(), losses.map((r) => r.city).sort());
    // THE POSITIVE CONTROL: profitable rows carry none. If every row is badged the badge means
    // nothing, which is the state this replaced.
    eq("no profitable row is badged", rows.filter((r) => !r.loss && r.badge).map((r) => r.city), []);
  }

  // ── NO VERTICAL RULES ──────────────────────────────────────────────────────────────────────
  eq("no cell draws a vertical rule", rows.reduce((a, r) => a + r.vrules, 0), 0);

  // ── THE BAR ────────────────────────────────────────────────────────────────────────────────
  console.log("\n── the bar carries scale and margin ──");
  {
    const byRev = [...rows].sort((a, b) => money(b.rev) - money(a.rev));
    // LENGTH ORDERS THE CITIES BY REVENUE, whatever order the table is sorted in.
    const widths = byRev.map((r) => Math.round(r.barRevW));
    eq("bar length orders the cities by revenue",
      widths.every((w, i) => i === 0 || w <= widths[i - 1] + 1), true);
    // AND THE RATIO IS THE REVENUE RATIO — Austin is 27x St. Louis and must draw 27x.
    const big = byRev[0], small = byRev[byRev.length - 1];
    const revRatio = money(big.rev) / money(small.rev);
    const barRatio = big.barRevW / small.barRevW;
    eq(`  control — the widest/narrowest revenue ratio is worth testing (${revRatio.toFixed(1)}x)`, revRatio > 3, true);
    eq(`  …and the bars draw it (${barRatio.toFixed(1)}x vs ${revRatio.toFixed(1)}x)`,
      Math.abs(barRatio - revRatio) / revRatio < 0.12, true);

    // THE GREEN SHARE IS THE MARGIN.
    for (const r of rows.filter((x) => !x.loss && x.barRevW > 60)) {
      const share = r.barNetW / r.barRevW;
      const m = pct(r.margin) / 100;
      eq(`  ${r.city}: green share equals its margin (${Math.round(share * 100)}% vs ${r.margin})`,
        Math.abs(share - m) < 0.03, true);
    }
    // A LOSING CITY SHOWS NO GREEN.
    for (const r of rows.filter((x) => x.loss)) {
      eq(`  ${r.city}: a loss shows no green at all`, Math.round(r.barNetW), 0);
    }
    /* AND EVERY PROFITABLE CITY SHOWS SOME — including the one that earns $15 on $965, whose
     * true-to-scale segment is 0.08px. Without a minimum sliver "barely profitable" draws
     * identically to "losing", which is the single distinction the bar exists to make. */
    const thin = rows.filter((r) => !r.loss).sort((a, b) => a.barNetW - b.barNetW)[0];
    eq("  control — the thinnest profitable city is genuinely tiny", thin.barRevW < 40, true);
    eq(`every profitable city shows green, ${thin.city} included (${thin.barNetW.toFixed(2)}px)`,
      rows.filter((r) => !r.loss).every((r) => r.barNetW >= 1), true);
  }

  // ── THE ARITHMETIC ─────────────────────────────────────────────────────────────────────────
  console.log("\n── revenue − field − overhead = net ──");
  {
    for (const r of nonEmpty(rows, "rows")) {
      const calc = money(r.rev) + money(r.field) + money(r.over);
      eq(`  ${r.city}: ${r.rev} ${r.field} ${r.over} = ${r.net}`, Math.abs(calc - money(r.net)) <= 1, true);
    }
    const t = await page.evaluate(() => {
      const tds = [...document.querySelectorAll('[data-testid="citypnl-total-row"] td')].map((x) => x.textContent.trim());
      return { cells: tds, net: document.querySelector('[data-testid="citypnl-total-net"]')?.textContent };
    });
    eq("  control — the footer has six cells", t.cells.length, 6);
    const fc = t.cells.map(money);
    eq("the footer reconciles too", Math.abs((fc[1] + fc[2] + fc[3]) - money(t.net)) <= 1, true);
    // AND THE FOOTER IS THE SUM OF THE ROWS.
    const sumNet = rows.reduce((a, r) => a + money(r.net), 0);
    eq("  …and equals the sum of the city rows", Math.abs(sumNet - money(t.net)) <= 2, true);
  }

  // ── THE EXPANSION ──────────────────────────────────────────────────────────────────────────
  console.log("\n── the expansion holds what moved ──");
  {
    eq("it opens closed", await page.locator('[data-testid="citypnl-expansion"]').count(), 0);
    const first = rows[0].city;
    await page.click(`[data-testid="citypnl-row"][data-city="${first}"]`);
    await page.waitForSelector('[data-testid="citypnl-expansion"]', { timeout: 20000 });
    const d = await page.evaluate(() => {
      const g = (id) => document.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
      const pitches = [...document.querySelectorAll('[data-testid="citypnl-pitch-row"]')].map((r) => ({
        rev: r.querySelector('[data-testid="citypnl-pitch-rev"]')?.textContent,
      }));
      return { dpp: g("citypnl-dpp"), member: g("citypnl-member"), fieldNet: g("citypnl-fieldnet"),
        fieldMargin: g("citypnl-fieldmargin"), overhead: !!document.querySelector('[data-testid="citypnl-overhead"]'), pitches };
    });
    // THE FOUR COLUMNS THAT LEFT THE TOP LEVEL ARE ALL HERE.
    eq("  the DPP / member split is present", [d.dpp != null, d.member != null], [true, true]);
    eq("  …and field net and field margin", [d.fieldNet != null, d.fieldMargin != null], [true, true]);
    eq("  …and the overhead makeup", d.overhead, true);
    // DPP + MEMBER = THE REVENUE ON THE ROW ABOVE.
    eq("  DPP + member equals the city's revenue",
      Math.abs(money(d.dpp) + money(d.member) - money(rows[0].rev)) <= 1, true);
    // THE PITCH ROWS SUM TO THE CITY ROW.
    eq("  control — pitches rendered", d.pitches.length > 0, true);
    const pitchSum = d.pitches.reduce((a, p) => a + (money(p.rev) ?? 0), 0);
    const untracked = await page.evaluate(() => {
      const t = document.querySelector('[data-testid="citypnl-untracked"]')?.textContent ?? "";
      const m = t.replace(/[,\s]/g, "").match(/\$(\d+)/);
      return m ? Number(m[1]) : 0;
    });
    // MINUS, for the reason spelled out in the phone block: the pitch list carries the unmapped
    // fields that the city's gross deliberately holds out.
    eq(`  the pitch rows sum to the city revenue (${pitchSum} − ${untracked} vs ${rows[0].rev})`,
      Math.abs(pitchSum - untracked - money(rows[0].rev)) <= 2, true);
    await page.click(`[data-testid="citypnl-row"][data-city="${first}"]`);
    await page.waitForTimeout(200);
    eq("  …and it closes again", await page.locator('[data-testid="citypnl-expansion"]').count(), 0);
  }

  await closeContext(ctx);
}

// ══ PHONE ════════════════════════════════════════════════════════════════════════════════════
for (const [W, H] of [[393, 852], [320, 700]]) {
  console.log(`\n════════ phone ${W}x${H} ════════`);
  const ctx = await browser.newContext({
    storageState, viewport: { width: W, height: H }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${W}: ${e}`));
  await page.goto(`${BASE}/admin/finance/cities`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="citypnl-card"]', { timeout: 240000 });
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--sat", "59px");
    document.documentElement.style.setProperty("--sab", "34px");
  });
  await page.waitForTimeout(1200);

  const m = await page.evaluate(() => ({
    inner: window.innerWidth, scrollW: document.documentElement.scrollWidth,
    cards: document.querySelectorAll('[data-testid="citypnl-card"]').length,
    tableVisible: (() => {
      const t = document.querySelector('[data-testid="citypnl-table"]');
      return t ? t.getBoundingClientRect().width > 0 : false;
    })(),
    heads: [...document.querySelectorAll('[data-testid="citypnl-card-head"]')].map((b) => {
      const r = b.getBoundingClientRect();
      return { h: Math.round(r.height), w: Math.round(r.width) };
    }),
  }));
  // A SIX-COLUMN TABLE DOES NOT SURVIVE 393px, so it is not attempted — the cards replace it.
  eq(`the layout viewport is the device width (${W})`, m.inner, W);
  eq("  …and nothing scrolls horizontally", m.scrollW <= m.inner, true);
  eq("the table is not rendered at all", m.tableVisible, false);
  eq("  …and every city is a card", m.cards > 0, true);
  eq("every card head is at least 44px tall", m.heads.every((h) => h.h >= 44), true);

  // SCROLLED TO THE BOTTOM, THE LAST CARD CLEARS THE TAB BAR.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(400);
  const clear = await page.evaluate(() => {
    const bar = document.querySelector('nav[aria-label="Primary"]')?.getBoundingClientRect();
    const cards = [...document.querySelectorAll('[data-testid="citypnl-card"], [data-testid="citypnl-card-total"]')];
    const last = cards[cards.length - 1]?.getBoundingClientRect();
    return bar && last ? { last: Math.round(last.bottom), bar: Math.round(bar.top) } : null;
  });
  eq("  control — the tab bar and a last card both exist", clear != null, true);
  eq(`the last card clears the tab bar (${clear?.last} <= ${clear?.bar})`, clear.last <= clear.bar + 1, true);


  // ── THE CARD EXPANSION ──────────────────────────────────────────────────────────────────────
  // Same content as desktop, so the risk here is LAYOUT rather than arithmetic — the desktop pitch
  // table has six columns and a phone has none to spare. Unverified is how that breaks quietly.
  console.log("\n── the card expansion ──");
  {
    // POSITIVE CONTROL FIRST: closed cards show no pitch rows, so "present after tapping" cannot
    // pass on a page that renders them all the time.
    eq("  control — a collapsed card shows no pitch rows",
      await page.locator('[data-testid="citypnl-mobile-pitch"]').count(), 0);

    const first = await page.evaluate(() =>
      document.querySelector('[data-testid="citypnl-card"]')?.getAttribute("data-city"));
    eq("  control — there is a card to open", first != null, true);
    await page.click(`[data-testid="citypnl-card"][data-city="${first}"] [data-testid="citypnl-card-head"]`);
    await page.waitForSelector('[data-testid="citypnl-mobile-expansion"]', { timeout: 20000 });
    await page.waitForTimeout(300);

    const x = await page.evaluate(() => {
      const pitches = [...document.querySelectorAll('[data-testid="citypnl-mobile-pitch"]')];
      const card = document.querySelector('[data-testid="citypnl-card"]');
      const untracked = document.querySelector('[data-testid="citypnl-mobile-untracked"]')?.textContent ?? "";
      const um = untracked.replace(/[,\s]/g, "").match(/\$(\d+)/);
      return {
        n: pitches.length,
        revs: pitches.map((p) => p.querySelector('[data-testid="citypnl-mobile-pitch-rev"]')?.textContent),
        cardRev: card?.querySelector('[data-testid="citypnl-card-rev"]')?.textContent,
        untracked: um ? Number(um[1]) : 0,
        // READABLE: nothing under 11px, and no pitch block wider than the card that holds it.
        minFont: Math.min(...pitches.map((p) => parseFloat(getComputedStyle(p).fontSize))),
        overflowing: pitches.filter((p) => p.scrollWidth > p.clientWidth + 1).length,
        widest: Math.max(...pitches.map((p) => Math.round(p.getBoundingClientRect().right))),
        overhead: !!document.querySelector('[data-testid="citypnl-overhead"]'),
        docW: document.documentElement.scrollWidth, inner: window.innerWidth,
      };
    });
    eq("tapping a card expands it and the pitch rows are present", x.n > 0, true);
    eq("  …and readable — nothing under 11px", x.minFont >= 11, true);
    eq("  …with no pitch block overflowing its card", x.overflowing, 0);
    eq("  …and the overhead makeup is there too", x.overhead, true);

    // THE LIKELY FAILURE: six columns of pitch detail on a 320px phone.
    eq("no horizontal scroll while expanded", x.docW <= x.inner, true);
    eq(`  …and nothing extends past the viewport (${x.widest} <= ${W})`, x.widest <= W, true);

    /* THE SAME ARITHMETIC AS DESKTOP — ON EVERY CARD, not just the first.
     * Asserting only the first card passed while the untracked note was DELETED, because Austin
     * happens to carry no untracked revenue. The note is exactly what makes the sum reconcile for
     * the cities that do, so the assertion has to reach one of them to mean anything. */
    const cities = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="citypnl-card"]')].map((c) => c.getAttribute("data-city")));
    let withUntracked = 0;
    for (const city of cities) {
      const sel = `[data-testid="citypnl-card"][data-city="${city}"]`;
      const alreadyOpen = await page.locator(`${sel} [data-testid="citypnl-mobile-expansion"]`).count();
      if (!alreadyOpen) {
        await page.click(`${sel} [data-testid="citypnl-card-head"]`);
        await page.waitForTimeout(180);
      }
      const c = await page.evaluate((s2) => {
        const card = document.querySelector(s2);
        const revs = [...card.querySelectorAll('[data-testid="citypnl-mobile-pitch-rev"]')].map((e) => e.textContent);
        const un = card.querySelector('[data-testid="citypnl-mobile-untracked"]')?.textContent ?? "";
        const um = un.replace(/[,\s]/g, "").match(/\$(\d+)/);
        return { revs, untracked: um ? Number(um[1]) : 0,
          rev: card.querySelector('[data-testid="citypnl-card-rev"]')?.textContent };
      }, sel);
      if (c.untracked > 0) withUntracked += 1;
      /* THE IDENTITY IS MINUS, NOT PLUS, and I had it backwards in both places.
       * cityPnl.ts:196 — gross = mappedDpp + membership, and mappedDpp EXCLUDES unmapped fields.
       * The pitch list renders ALL fields, mapped and not. So pitchSum = gross + untracked, which
       * means gross = pitchSum − untracked. Houston: 14,591 − 126 = 14,465 against 14,464.
       * The `+` version passed everywhere untracked was 0, which is six cities out of seven. */
      const sum = c.revs.reduce((a, t) => a + (money(t) ?? 0), 0);
      eq(`  ${city}: pitches ${sum} − untracked ${c.untracked} = ${c.rev}`,
        Math.abs(sum - c.untracked - money(c.rev)) <= 2, true);
      await page.click(`${sel} [data-testid="citypnl-card-head"]`);
      await page.waitForTimeout(120);
    }
    // THE CONTROL FOR THE UNTRACKED NOTE ITSELF. If no city carries any, the note is unexercised
    // and this run has NOT proven it — said out loud rather than left to look covered.
    if (withUntracked === 0) {
      bad("  the untracked note is exercised by at least one city", "no city has untracked revenue in this period — the note is UNPROVEN by this run");
    } else {
      ok(`  the untracked note is exercised by ${withUntracked} city(ies)`);
    }

    // THE LOOP ABOVE CLOSES EACH CARD AS IT GOES, so the page must end with none open. A trailing
    // click here re-opened Austin and then asserted it was shut — the assertion was right and the
    // step before it was wrong.
    eq("  every card is closed again afterwards",
      await page.locator('[data-testid="citypnl-mobile-pitch"]').count(), 0);
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
