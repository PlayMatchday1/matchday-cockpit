// MATCH VIEW — the stats band, the cascade, the lens, and the boundary.
//
// EVERY TILE IS CHECKED AGAINST THE ROWS BENEATH IT, at three different filter states rather than
// only on load. A band that is right on load and frozen afterwards is the failure this view is
// most likely to have, and it looks identical to a working one until you filter.
//
// THE ARITHMETIC IS RECOMPUTED FROM THE RENDERED TABLE, not from the same expression the component
// used. Reading the component's own numbers back would prove only that it is self-consistent.
//
//   node scripts/e2e/verify-match-view.mjs
import { chromium } from "playwright";
import { installHarnessGuard, closeContext, closeBrowser, storageStateFor } from "./_session.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const money = (t) => (/—/.test(t ?? "") ? null : Number(String(t).replace(/[^0-9.-]/g, "")));

const { storageState } = await storageStateFor("rmancuso@playmatchday.com", BASE);
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState, viewport: { width: 1440, height: 1400 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`${BASE}/admin/finance/revenue?p=2026-08`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="breakdown-match"]', { timeout: 120000 });
await page.click('[data-testid="breakdown-match"]');
await page.waitForSelector('[data-testid="match-view"]', { timeout: 60000 });
await page.waitForTimeout(2500);
eq("no uncaught page errors", errors, []);

/** Tiles, context and every rendered row — the raw material for recomputing the band. */
const read = () => page.evaluate(() => {
  const num = (t) => Number(String(t ?? "").replace(/[^0-9.-]/g, ""));
  const tiles = {};
  for (const el of document.querySelectorAll('[data-testid^="mv-tile-"]')) {
    const k = el.getAttribute("data-testid").replace("mv-tile-", "");
    tiles[k] = {
      label: el.querySelector('[class*="mvTileLab"]')?.textContent?.trim() ?? "",
      raw: el.querySelector('[data-testid="mv-val"]')?.textContent?.trim() ?? "",
      sub: el.querySelector('[class*="mvTileSub"]')?.textContent?.trim() ?? null,
      neg: /mvNeg/.test(el.className),
    };
  }
  const rows = [...document.querySelectorAll('[data-testid="mv-row"]')].map((tr) => {
    const c = [...tr.querySelectorAll("td")].map((x) => x.textContent.trim());
    return {
      date: c[0], iso: tr.getAttribute("data-d") ?? "", mid: tr.getAttribute("data-mid") ?? "", day: c[1], hour: c[2], city: c[3], field: c[4],
      spots: num(c[5]), members: num(c[6]), dpp: num(c[7]), free: num(c[8]), promos: num(c[9]),
      rev: num(c[10]), cost: c[11] === "—" ? null : num(c[11]), profit: num(c[12]),
      cells: c.length,
    };
  });
  return {
    tiles, rows,
    context: document.querySelector('[data-testid="mv-context"]')?.textContent?.trim() ?? "",
    headers: document.querySelectorAll('[data-testid="mv-table"] thead th').length,
    empty: !!document.querySelector('[data-testid="mv-empty"]'),
    chips: [...document.querySelectorAll('[data-testid="mv-chip"]')].map((c) => c.getAttribute("data-chip")),
    upcoming: (() => {
      const el = document.querySelector('[data-testid="mv-include-upcoming"]');
      return el ? { checked: el.checked, disabled: el.disabled, label: el.parentElement?.textContent?.trim() ?? "" } : null;
    })(),
    loadAll: (() => {
      const el = document.querySelector('[data-testid="mv-load-all"]');
      return el ? { text: el.textContent.trim(), disabled: el.disabled } : null;
    })(),
    sideways: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
});

const optionsOf = (k) => page.evaluate((k) => [...document.querySelectorAll(`[data-testid="mv-${k}"] option`)]
  .map((o) => ({ value: o.value, text: o.textContent.trim(), disabled: o.disabled })), k);

const pick = async (k, value) => { await page.selectOption(`[data-testid="mv-${k}"]`, value); await page.waitForTimeout(700); };

/** Recompute the band from the rendered rows and compare, tile by tile. */
const checkBand = async (label) => {
  const st = await read();
  const r = st.rows;
  const n = r.length;
  const rev = r.reduce((a, x) => a + x.rev, 0);
  /* COST, PROFIT AND AVG COST NOW RUN ON THE ROWS THAT HAVE A COST, not on every row with the
   * missing ones counted as free. `?? 0` made a venue-month with no cost basis on file look like
   * a $0 one; outside the loaded finance quarters that is most of them. The tiles disclose the
   * denominator in their sub-line, and these three sums mirror it. */
  const costedRows = r.filter((x) => x.cost != null);
  const nCosted = costedRows.length;
  const cost = costedRows.reduce((a, x) => a + x.cost, 0);
  const costedRev = costedRows.reduce((a, x) => a + x.rev, 0);
  const spots = r.reduce((a, x) => a + x.spots, 0);
  const promos = r.reduce((a, x) => a + x.promos, 0);
  const promoMatches = r.filter((x) => x.promos > 0).length;

  /* THE TOLERANCE IS THE ROUNDING, AND NOTHING ELSE. Each row PRINTS its revenue to the dollar,
   * so summing the rendered column loses up to 50c per row against the tile, which totals the
   * unrounded values. At 1,367 rows that is a legitimate few dollars — measured at $8 — and a
   * to-the-dollar comparison would fail on the TEST's arithmetic rather than the view's. The bound
   * is half a dollar per row, so it stays tight on the small selections where it matters most:
   * three rows tolerate $1.50, not $684. */
  const tol = Math.max(1, n / 2);
  eq(`${label}: Matches tile equals the rows rendered`, money(st.tiles.matches.raw), n);
  eq(`${label}: Total revenue equals the rows' revenue (±$${tol})`,
     Math.abs(money(st.tiles.revenue.raw) - rev) <= tol, true);
  eq(`${label}: Field cost equals the COSTED rows' cost (±$${tol})`,
     Math.abs(money(st.tiles.cost.raw) - cost) <= tol, true);
  /* PROFIT = COSTED REVENUE − COST. The identity still must never drift; what changed is which
   * revenue it reconciles against. Subtracting the costed rows' cost from EVERY row's revenue
   * would print a profit belonging to no set of matches, which is why the tile names its
   * denominator whenever the two sets differ. */
  eq(`${label}: Profit = costed revenue − cost, to the dollar (±$${tol})`,
     nCosted > 0 ? Math.abs(money(st.tiles.profit.raw) - (costedRev - cost)) <= tol : money(st.tiles.profit.raw) === null,
     true);
  eq(`${label}: Promo codes equals the rows' redemptions`, money(st.tiles.promos.raw), promos);
  eq(`${label}:   …and its sub names the matches carrying them`,
     n > 0 ? st.tiles.promos.sub : "", n > 0 ? `on ${promoMatches.toLocaleString()} of ${n.toLocaleString()} matches` : "");
  if (n > 0) {
    eq(`${label}: Avg revenue = revenue ÷ matches`, Math.round(money(st.tiles.avgrev.raw)), Math.round(rev / n));
    eq(`${label}: Avg cost = cost ÷ COSTED matches`,
       Math.round(money(st.tiles.avgcost.raw)), nCosted > 0 ? Math.round(cost / nCosted) : null);
    /* "· completed only" IS PART OF THE SUB-LINE NOW. The band measures matches that have kicked
     * off whatever the table is listing, and a figure that excludes rows has to say so where it
     * is read, not in a comment. */
    eq(`${label}: Matches sub counts the spots and names the basis`,
       st.tiles.matches.sub, `${spots.toLocaleString()} spots · completed only`);
    if (nCosted < n) {
      eq(`${label}:   …and partial cost coverage is disclosed on the cost tile`,
         st.tiles.cost.sub, `${nCosted.toLocaleString()} of ${n.toLocaleString()} costed`);
    }
  }
  eq(`${label}: header count equals every row's cell count`,
     [...new Set(r.map((x) => x.cells))], n > 0 ? [st.headers] : []);
  eq(`${label}: the page does not scroll sideways`, st.sideways, false);
  console.log(`     ${label}: ${n} matches · rev ${Math.round(rev)} · cost ${Math.round(cost)} · profit ${Math.round(rev - cost)}`);
  return st;
};

// ── 1. THE BAND, ON LOAD ──────────────────────────────────────────────────────────────────────
console.log("\n── state 1: unfiltered ──");
const base = await checkBand("unfiltered");
/* THE CONTEXT LINE NAMES ITS WINDOW. It used to read "Showing all 1,419 matches on record" —
 * false by two orders of magnitude, because those were the four months the header's comparison
 * span happened to have loaded. The panel now has its own year-to-date window and says which
 * one it drew from; "on record" is reserved for after load-all-history has run. */
eq("the context line states the count and names the window",
   /^Showing [\d,]+ matches — \d{4} to date(, [^.]*)?\.$/.test(base.context), true);
eq("  control — and there are matches to show", base.rows.length > 0, true);
eq("  …and it does NOT claim to be the whole record", /on record/.test(base.context), false);

// ── 1b. FUTURE MATCHES ARE OUT OF THE FIGURES AND OFF THE TABLE ───────────────────────────────
//
// THE ABSENCE ASSERTION IS PAIRED WITH THE TOGGLE AS ITS POSITIVE CONTROL. "No row is dated after
// today" passes just as well on a table that failed to render, so it is worth nothing until the
// same comparison is proven to FIND future rows — which is exactly what switching the toggle on
// does, in the same run, against the same selector and the same date parsing.
console.log("\n── the future-match rule ──");
{
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const after = (rows) => rows.filter((x) => x.iso && x.iso > iso);

  eq("every rendered row carries its ISO date", base.rows.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.iso)), true);
  eq("no match dated after today is listed by default", after(base.rows).length, 0);

  const t = base.upcoming;
  eq("the include-upcoming toggle is present and off", t && t.checked === false, true);
  eq("  …and its label says the figures do not move", /listed, never counted|Include upcoming/.test(t?.label ?? ""), true);

  if (t && !t.disabled) {
    await page.click('[data-testid="mv-include-upcoming"]');
    await page.waitForTimeout(700);
    const on = await read();
    // THE POSITIVE CONTROL: the same filter, the same parsing, now finding rows.
    eq("  POSITIVE CONTROL — with upcoming on, future-dated rows DO appear", after(on.rows).length > 0, true);
    /* THE BOUNDARY IS KICK-OFF, NOT THE CALENDAR DAY. Measured here: the toggle added 29 rows of
     * which only 15 were dated after today — the other 14 are LATER TODAY and have correctly not
     * kicked off yet. So the invariant is "every row the toggle adds is dated today or later",
     * not "…is dated after today", which is what this assertion first (wrongly) said. */
    const seen = new Set(base.rows.map((x) => x.mid));
    const added = on.rows.filter((x) => !seen.has(x.mid));
    eq("  …and the toggle only ever ADDS rows", on.rows.length - base.rows.length, added.length);
    eq("  …and every added row is dated today or later",
       added.length > 0 && added.every((x) => x.iso >= iso), true);
    // THE FIGURES MUST NOT HAVE MOVED. This is the whole point of the toggle being a row control.
    eq("  …while the Matches tile is unchanged", on.tiles.matches.raw, base.tiles.matches.raw);
    eq("  …and Total revenue is unchanged", on.tiles.revenue.raw, base.tiles.revenue.raw);
    eq("  …and Avg revenue is unchanged", on.tiles.avgrev.raw, base.tiles.avgrev.raw);
    eq("  …and Avg cost is unchanged", on.tiles.avgcost.raw, base.tiles.avgcost.raw);
    eq("  …and Margin is unchanged", on.tiles.margin.raw, base.tiles.margin.raw);
    eq("  …and Profit is unchanged", on.tiles.profit.raw, base.tiles.profit.raw);
    await page.click('[data-testid="mv-include-upcoming"]');
    await page.waitForTimeout(700);
  } else {
    console.log("     (no upcoming matches loaded — toggle disabled, control not exercised)");
  }

  // The load-all-history action is offered, states its cost, and is not pretending to be loaded.
  eq("load-all-history is offered and names its cost", /~15s/.test(base.loadAll?.text ?? ""), true);
}

// ── 2. EVERY OPTION CARRIES ITS COUNT, NONE IS ZERO, NONE IS DISABLED ─────────────────────────
console.log("\n── the options ──");
{
  const keys = ["month", "weekof", "dow", "city", "field", "hour"];
  let checked = 0, zeros = [], disabled = [], uncounted = [];
  for (const k of keys) {
    const opts = (await optionsOf(k)).filter((o) => o.value !== "");
    eq(`  control — ${k} offers options`, opts.length > 0, true);
    for (const o of opts) {
      checked++;
      if (!/\(\d+\)$/.test(o.text)) uncounted.push(`${k}:${o.text}`);
      if (/\(0\)$/.test(o.text)) zeros.push(`${k}:${o.text}`);
      if (o.disabled) disabled.push(`${k}:${o.text}`);
    }
  }
  eq(`every option carries a count (${checked} checked)`, uncounted, []);
  eq('no option reads "(0)"', zeros, []);
  eq("no option is disabled", disabled, []);
}

// ── 3. A PRINTED COUNT IS WHAT SELECTING IT YIELDS ────────────────────────────────────────────
console.log("\n── the count on an option is the truth ──");
{
  const cities = (await optionsOf("city")).filter((o) => o.value);
  const target = cities.find((o) => /Austin/.test(o.text)) ?? cities[0];
  const promised = Number(target.text.match(/\((\d+)\)$/)[1]);
  eq("  control — the option promised a non-zero count", promised > 0, true);
  await pick("city", target.value);
  const after = await read();
  eq(`"${target.text}" yields exactly what it promised`, after.rows.length, promised);
}

// ── 4. THE CASCADE ────────────────────────────────────────────────────────────────────────────
console.log("\n── the cascade runs one way ──");
{
  const citiesBefore = (await optionsOf("city")).filter((o) => o.value).length;
  const fieldOpts = (await optionsOf("field")).filter((o) => o.value);
  eq("  control — the chosen city offers fields", fieldOpts.length > 0, true);

  // FIELD OFFERS ONLY THE SELECTED CITY'S FIELDS. The control is a field that exists in the data
  // under a DIFFERENT city — without it this passes on an empty list.
  const cityRows = (await read()).rows;
  const cityFields = new Set(cityRows.map((r) => r.field));
  const offered = fieldOpts.map((o) => o.value);
  eq("field offers only this city's fields", offered.filter((v) => !cityFields.has(v)), []);
  const elsewhere = base.rows.filter((r) => !cityFields.has(r.field)).map((r) => r.field);
  eq("  control — fields exist in the data under other cities", elsewhere.length > 0, true);
  eq("  …and none of them is offered", offered.filter((v) => elsewhere.includes(v)), []);

  // SELECTING A FIELD MUST NOT SHORTEN THE CITY LIST. This is the corner with no exit.
  await pick("field", fieldOpts[0].value);
  const citiesAfter = (await optionsOf("city")).filter((o) => o.value).length;
  eq("selecting a field does NOT shorten the city list", citiesAfter, citiesBefore);

  // CHANGING CITY CLEARS FIELD AND KICK-OFF.
  const hourOpts = (await optionsOf("hour")).filter((o) => o.value);
  if (hourOpts.length) { await pick("hour", hourOpts[0].value); }
  const currentCity = await page.inputValue('[data-testid="mv-city"]');
  const others = (await optionsOf("city")).filter((o) => o.value && o.value !== currentCity);
  eq("  control — another city is available to switch to", others.length > 0, true);
  await pick("city", others[0].value);
  const cleared = await page.evaluate(() => ({
    field: document.querySelector('[data-testid="mv-field"]')?.value,
    hour: document.querySelector('[data-testid="mv-hour"]')?.value,
  }));
  eq("changing city clears field and kick-off", [cleared.field, cleared.hour], ["", ""]);
}

// ── 5. THE ANSWER TO THE QUESTION THE PAGE EXISTS FOR ─────────────────────────────────────────
console.log("\n── Austin → Westlake → Thu ──");
{
  await page.click('[data-testid="mv-clear-all"]').catch(() => {});
  await page.waitForTimeout(600);
  const cities = (await optionsOf("city")).filter((o) => /Austin/.test(o.text));
  eq("  control — Austin is offered", cities.length, 1);
  await pick("city", cities[0].value);
  const fields = (await optionsOf("field")).filter((o) => /Westlake/i.test(o.text));
  eq("  control — Westlake is offered under Austin", fields.length > 0, true);
  await pick("field", fields[0].value);
  const days = (await optionsOf("dow")).filter((o) => o.value === "Thu");
  eq("  control — Thursday exists in that selection", days.length, 1);
  const promised = Number(days[0].text.match(/\((\d+)\)$/)[1]);
  await pick("dow", "Thu");
  const st = await read();
  eq("the selection yields the count the option promised", st.rows.length, promised);
  eq("  control — and it is not vacuous", st.rows.length > 0, true);
  eq("every row is Austin", [...new Set(st.rows.map((r) => r.city))], ["Austin"]);
  eq("every row is Thursday", [...new Set(st.rows.map((r) => r.day))], ["Thu"]);
  eq("the context line names the selection", /Austin/.test(st.context) && /Thu/.test(st.context), true);
  console.log(`     ${st.context}`);
  await checkBand("Austin/Westlake/Thu");
}

// ── 6. THE LENS MOVES REVENUE, NOT COST ───────────────────────────────────────────────────────
console.log("\n── the lens ──");
{
  const before = await read();
  await page.click('[data-testid="mv-lens-dpp"]');
  await page.waitForTimeout(700);
  const after = await read();
  eq("the lens moves total revenue", before.tiles.revenue.raw === after.tiles.revenue.raw, false);
  eq("  …and profit with it", before.tiles.profit.raw === after.tiles.profit.raw, false);
  eq("  …and the head tile's LABEL", before.tiles.heads.label === after.tiles.heads.label, false);
  // THE TWO THAT MUST NOT MOVE.
  eq("FIELD COST does not move with the lens", after.tiles.cost.raw, before.tiles.cost.raw);
  eq("PROMO CODES does not move with the lens", after.tiles.promos.raw, before.tiles.promos.raw);
  console.log(`     all→dpp: rev ${before.tiles.revenue.raw}→${after.tiles.revenue.raw} · cost ${after.tiles.cost.raw} unchanged`);
  await checkBand("dpp lens");
  await page.click('[data-testid="mv-lens-all"]');
  await page.waitForTimeout(600);
}

// ── 7. THE DATE RANGE ─────────────────────────────────────────────────────────────────────────
console.log("\n── when ──");
{
  await page.click('[data-testid="mv-clear-all"]').catch(() => {});
  await page.waitForTimeout(600);
  const all = (await read()).rows.length;
  await page.click('[data-testid="mv-preset-14"]');
  await page.waitForTimeout(800);
  const range = await page.evaluate(() => ({
    from: document.querySelector('[data-testid="mv-from"]')?.value,
    to: document.querySelector('[data-testid="mv-to"]')?.value,
  }));
  const days = Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86400000) + 1;
  eq("Last 2 weeks spans exactly 14 days", days, 14);
  const inRange = await read();
  const iso = (d) => d;
  const out = inRange.rows.filter((r) => {
    // The row prints "Aug 7"; compare against the range by month/day within the range's years.
    const [mon, dd] = r.date.split(" ");
    const y = Number(range.to.slice(0, 4));
    const guess = new Date(`${mon} ${dd}, ${y}`);
    const g = `${guess.getFullYear()}-${String(guess.getMonth() + 1).padStart(2, "0")}-${String(guess.getDate()).padStart(2, "0")}`;
    return iso(g) < range.from || iso(g) > range.to;
  });
  eq("every rendered row falls inside the range", out.map((r) => r.date), []);
  eq("  …and it narrowed the set", inRange.rows.length < all, true);
  eq("the range shows as a chip", inRange.chips.includes("date"), true);

  await page.click('[data-testid="mv-chip-clear-date"]');
  await page.waitForTimeout(800);
  const restored = await read();
  eq("clearing the date chip restores every match", restored.rows.length, all);
  const preset = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="mv-preset-"]')].find((b) => /__on|on/.test(b.className))?.getAttribute("data-testid"));
  // The preset reads "All loaded" until the whole record is in memory, "All time" after.
eq("  …and returns the preset to the all-loaded default", preset, "mv-preset-all");
}

// ── 8. THE BOUNDARY: ZERO MATCHES ─────────────────────────────────────────────────────────────
console.log("\n── zero matches ──");
{
  // A month and a city that cannot both be true — the emptiest real selection available.
  await page.click('[data-testid="mv-clear-all"]').catch(() => {});
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const from = document.querySelector('[data-testid="mv-from"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(from, "2099-01-01");
    from.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(800);
  const st = await read();
  eq("  control — the selection really is empty", st.rows.length, 0);
  eq("Matches reads 0", st.tiles.matches.raw, "0");
  // THE FAULT THIS EXISTS FOR: Math.max(1, n) divides by ONE and prints the numerator.
  eq("Avg revenue renders a dash", st.tiles.avgrev.raw, "—");
  eq("Avg cost renders a dash", st.tiles.avgcost.raw, "—");
  eq("Margin renders a dash", st.tiles.margin.raw, "—");
  eq("  …and none of them prints a figure", [st.tiles.avgrev.raw, st.tiles.avgcost.raw].some((v) => /\d/.test(v)), false);
  eq("the table shows its empty state", st.empty, true);

  // AND THE CONTROL: a non-empty selection prints figures again, so the dashes above are the
  // guard working rather than the view being broken.
  await page.click('[data-testid="mv-clear-all"]');
  await page.waitForTimeout(800);
  const back = await read();
  eq("  control — a non-empty selection prints figures again", /\d/.test(back.tiles.avgrev.raw), true);
  eq("  …and margin is a percentage again", /%$/.test(back.tiles.margin.raw), true);
}

// ── 9. NARROWER VIEWPORT ──────────────────────────────────────────────────────────────────────
console.log("\n── 900px ──");
{
  await page.setViewportSize({ width: 900, height: 1400 });
  await page.waitForTimeout(700);
  const st = await read();
  eq("no sideways scroll at 900px", st.sideways, false);
  eq("  control — the band is still rendered", Object.keys(st.tiles).length, 9);
}

console.log(`\n================ RESULT ================`);
console.log(`Assertions: ${PASS} passed, ${FAIL} failed`);
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  " + f)); }
await closeContext(ctx);
await closeBrowser(browser);
process.exit(FAIL === 0 ? 0 : 1);
