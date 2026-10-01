// Assertions for scripts/mocks/opex-calendar-v2.html
// Run: node scripts/mocks/opex-calendar-v2.assert.mjs [url]
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
const here = path.dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] || "file://" + path.join(here, "opex-calendar-v2.html");
const tid = id => `[data-testid="${id}"]`;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + m); };
const num = s => Number(String(s).replace(/[^0-9.]/g, ""));
// OPEX_STATE (optional): a Playwright storageState JSON, so the same checks can run against the signed-in dev page.
const state = process.env.OPEX_STATE ? JSON.parse((await import("node:fs")).readFileSync(process.env.OPEX_STATE, "utf8")) : undefined;
const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1400, height: 900 }, storageState: state })).newPage();
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.goto(url); await p.waitForSelector(tid("grid"), { timeout: 120000 });
ok(true, "instrument ran: grid rendered");

// clutter gone
const grid = await p.textContent(tid("grid"));
ok(!/COMPUTED|Field Costs config|add month override|from Expenses|fin_expenses|PER-VENUE CADENCE/i.test(grid), "absence: no COMPUTED lines, config links, override links or source subtitles");
ok(!/\bMONTHLY\b|\bPER-MATCH\b|\bWEEKLY\b/.test(grid), "absence: no cadence badges on rows");
ok(/ATH Pearland/.test(grid) && /Houston/.test(grid), "presence control: venue name and city are there");
const rows = await p.$$(`tr.sub`);
let oneI = true; for (const r of rows) { if ((await r.$$(".i")).length !== 1) oneI = false; }
ok(rows.length > 10 && oneI, `every line item has exactly one i (${rows.length} rows)`);

// popover
ok(await p.isHidden(tid("popover")), "absence: no popover at rest");
await p.click(`${tid("row-field-4")} .i`);
const pt = await p.textContent(tid("popover"));
ok(/Billed/.test(pt) && /Rate/.test(pt) && /Source/.test(pt) && /2026 so far/.test(pt), "presence control: the i shows billing, rate, source and year to date");
await p.click(`${tid("row-field-4")} .i`);
ok(await p.isHidden(tid("popover")), "second click closes it");

// sticky dates and names
const wrap = p.locator(tid("grid-wrap"));
const before = await p.locator(tid("day-17")).boundingBox();
await wrap.evaluate(e => { e.scrollTop = 600; });
await p.waitForTimeout(100);
const after = await p.locator(tid("day-17")).boundingBox();
const wb = await wrap.boundingBox();
ok(Math.abs(after.y - before.y) < 2 && after.y >= wb.y - 1, `dates stay at the top while scrolling down (y ${Math.round(before.y)} -> ${Math.round(after.y)})`);
await wrap.evaluate(e => { e.scrollTop = 0; e.scrollLeft = 900; });
await p.waitForTimeout(100);
const nameBox = await p.locator(`${tid("row-field-4")} td.c-name`).boundingBox();
ok(Math.abs(nameBox.x - wb.x) < 3, "names stay on the left while scrolling across the month");
const sticky = await wrap.evaluate(e => e.scrollLeft);
ok(sticky > 0, "presence control: the grid really scrolled sideways");
await wrap.evaluate(e => { e.scrollLeft = 0; });

// totals
const subRows = await p.$$eval("tr.sub", rs => rs.map(r => ({ cat: r.dataset.cat, tot: Number(r.querySelector(".c-tot").dataset.total), cells: [...r.querySelectorAll("td.day .chip")].reduce((a, c) => a + Number(c.textContent.replace(/[^0-9.]/g, "")), 0) })));
ok(subRows.every(r => r.tot === r.cells), "each row's month total equals its day amounts");
const cats = await p.$$eval("tr.cat", rs => rs.map(r => ({ key: r.dataset.testid.replace("cat-", ""), tot: Number(r.querySelector(".c-tot").dataset.total) })));
ok(cats.every(c => c.tot === subRows.filter(r => r.cat === c.key).reduce((a, r) => a + r.tot, 0)), "each category total equals its rows");
const month = num(await p.textContent(tid("sum-month")));
ok(month === cats.reduce((a, c) => a + c.tot, 0), `Cash out in October equals the categories (${month})`);
ok(num(await p.textContent(tid("sum-paid"))) + num(await p.textContent(tid("sum-left"))) === month, "paid so far + still to go = month");
ok(await p.locator(tid("next-day")).count() === 7, "next 7 days shows seven day tiles");
const dsum = await p.$$eval('[data-testid="next-day"] .a', e => e.reduce((s, x) => s + (Number(x.textContent.replace(/[^0-9]/g, "")) || 0), 0));
ok(dsum > 0, `next 7 days totals come from the grid (${dsum})`);
const fill = await p.$eval("#paidFill", e => parseFloat(e.style.width));
ok(Math.abs(fill - num(await p.textContent(tid("sum-paid"))) / month * 100) < 0.2, "paid bar width matches paid share");

// paid vs projected, today, weekends
ok(await p.locator(`${tid("day-1")}.today`).count() === 1, "today's column is marked");
ok(await p.locator("tr.sub td.day[data-day='1'] .chip.actual").count() > 0 && await p.locator("tr.sub td.day[data-day='17'] .chip.proj").count() > 0, "past days show paid style, future days show projected style");
ok(await p.locator("thead th.day.wkend").count() >= 8, "weekends are shaded");

// collapse
await p.click(`${tid("cat-field")} .catbtn`);
ok(await p.locator('tr.sub[data-cat="field"]').count() === 0, "collapsing Field Costs hides its rows");
await p.click(`${tid("cat-field")} .catbtn`);
ok(await p.locator('tr.sub[data-cat="field"]').count() > 0, "presence control: expanding shows them again");

ok(errs.length === 0, `no page errors (${errs.join("; ")})`);
await b.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
