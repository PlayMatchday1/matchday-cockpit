// Assertions for scripts/mocks/opex-calendar-v3.html (OpEx as a month calendar + ledger)
// Run: node scripts/mocks/opex-calendar-v3.assert.mjs [url]
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
const here = path.dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] || "file://" + path.join(here, "opex-calendar-v3.html");
const tid = id => `[data-testid="${id}"]`;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + m); };
const num = s => Number(String(s).replace(/[^0-9.]/g, ""));
const near = (a, b) => Math.abs(a - b) < 0.011;

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 1100 } });
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.goto(url); await p.waitForSelector(tid("calendar"));
ok(true, "instrument ran: calendar rendered");

// calendar shape
const weeks = await p.locator(tid("week")).count();
ok(weeks === 5, `October 2026 renders as 5 week rows (got ${weeks})`);
ok(await p.$$eval(".wk.h div", d => d.map(x => x.textContent).join(",")) === "Mon,Tue,Wed,Thu,Fri,Sat,Sun", "weeks start on Monday like the Master Schedule");
ok(await p.locator(".day[data-day]").count() === 31, "31 day cells");
ok(await p.locator(".day.out").count() === 4, "4 out-of-month cells (Sep 28 to 30 and Nov 1), faded with no payments");
ok(await p.locator(`${tid("day-2")}.today`).count() === 1, "today (Oct 2) is marked");
ok(await p.locator(`${tid("day-1")}.past`).count() === 1 && await p.locator(`${tid("day-3")}.past`).count() === 0, "past days shaded, future not");
ok(await p.locator(".day.wkend[data-day]").count() === 9, "weekends shaded (9 in October)");

// bubbles: one per category per day, payees on click
const bubbles = await p.$$eval(".day .pay", e => e.map(x => ({ nm: x.querySelector(".nm").textContent, v: x.querySelector(".v").textContent, sw: x.querySelector(".sw").getAttribute("style") })));
ok(bubbles.length > 20 && bubbles.every(x => /\$/.test(x.v) && x.nm && /background/.test(x.sw)), `every bubble shows a category, amount and color (${bubbles.length} bubbles)`);
const perDay = await p.$$eval(".day[data-day]", ds => Math.max(...ds.map(d => d.querySelectorAll(".pay").length)));
ok(perDay <= 3, `no day shows more than 3 bubbles (max ${perDay})`);
ok(await p.locator(".day .more").count() === 0, "absence: no + more lines; payees live in the popover and ledger");
ok(!/One Touch|Garrett|Payroll/.test(await p.textContent(tid("calendar"))), "absence: no payee names on the calendar");
ok(await p.locator(".day .pay.paid").count() > 0 && await p.locator(".day .pay.proj").count() > 0, "paid bubbles are solid, projected are dashed");
ok(await p.locator(`${tid("day-1")} .pay.proj`).count() === 0 && await p.locator(`${tid("day-5")} .pay.paid`).count() === 0, "Oct 1 has only paid, Oct 5 only projected");
const d3 = p.locator(tid("day-3"));
ok(await d3.locator(".pay").count() === 2 && /Personnel/.test(await d3.textContent()) && /Fields/.test(await d3.textContent()), "Oct 3 shows two bubbles, Personnel and Fields");
const cellOk = await p.$$eval(".day[data-day]", ds => ds.every(d => { const t = Number(d.querySelector(".dt").dataset.total); const s = [...d.querySelectorAll(".pay .v")].reduce((a, x) => a + Number(x.textContent.replace(/[^0-9.]/g, "")), 0); return Math.abs(t - s) < 0.011; }));
ok(cellOk, "every day's bubbles add up to its total");

// day totals
const dayOk = await p.$$eval(".day[data-day]", ds => ds.every(d => { const t = Number(d.querySelector(".dt").dataset.total); return t === 0 || Math.abs(t - [...d.querySelectorAll(".pay")].length) >= 0; }));
ok(dayOk, "every day has a total badge");
const sumDays = await p.$$eval(".day[data-day] .dt", e => e.reduce((s, x) => s + Number(x.dataset.total), 0));
const month = num(await p.textContent(tid("sum-month")));
ok(near(sumDays, month), `day totals add up to the month (${sumDays.toFixed(2)} vs ${month})`);
ok(near(num(await p.textContent(tid("sum-paid"))) + num(await p.textContent(tid("sum-left"))), month), "paid + still to go = month");
const chips = await p.$$eval(".chip b", e => e.reduce((s, x) => s + Number(x.textContent.replace(/[^0-9.]/g, "")), 0));
ok(near(chips, month), "category chips add up to the month");
ok(await p.locator(".chip").count() === 6, "six categories: Personnel, Field Costs, Equipment, Marketing, Subscriptions, Misc");
const names = await p.$$eval(".chip", e => e.map(x => x.textContent.trim().split(" $")[0]));
ok(JSON.stringify(names) === JSON.stringify(["Personnel", "Field Costs", "Equipment", "Marketing", "Subscriptions", "Misc"]), `chip order: ${names.join(", ")}`);
const grid = await p.textContent("main");
ok(!/City Manager Pay|Match Manager Pay|Corporate Salaries/.test(await p.textContent("#chips")), "absence: no pay sub-categories as top-level chips");
ok(/Match manager pay/.test(grid), "presence control: the sub-category still appears on ledger rows");

// ledger
const rows = await p.locator(tid("ledger-row")).count();
ok(rows === 52, `ledger lists every payment (${rows})`);
ok(await p.locator(tid("ledger-week")).count() === 5, "ledger grouped by week with a subtotal each");
const run = await p.$$eval(`${tid("ledger-row")} td.cum`, e => e.map(x => Number(x.textContent.replace(/[^0-9.]/g, ""))));
ok(run.every((v, i) => i === 0 || v >= run[i - 1]) && near(run.at(-1), month), "running total climbs to the month total");
ok(near(Number(await p.getAttribute(`${tid("ledger-total")} td[data-total]`, "data-total")), month), "ledger total equals the header");
const heads = await p.$$eval(`${tid("ledger-table")} th`, e => e.map(x => x.textContent));
ok(JSON.stringify(heads) === JSON.stringify(["Date", "Payee", "Category", "City", "Status", "Amount", "Running total"]), `ledger columns: ${heads.join(" | ")}`);

// interactions
const yBefore = await p.evaluate(() => scrollY);
await p.click(`${tid("day-15")} .n`);
const fRows = await p.locator(tid("ledger-row")).evaluateAll(r => r.map(x => x.dataset.day));
ok(fRows.length === 4 && fRows.every(d => d === "15"), `clicking a day filters the ledger to that day (${fRows.length} rows, all Oct 15)`);
ok(await p.evaluate(() => scrollY) === yBefore, "absence: the page does not scroll");
ok(/Showing Oct 15/.test(await p.textContent(tid("ledger-filter"))) && await p.locator(`${tid("day-15")}.sel`).count() === 1, "the day is marked on the calendar and named in the ledger header");
ok(near(Number(await p.getAttribute(`${tid("ledger-total")} td[data-total]`, "data-total")), Number(await p.getAttribute(`${tid("day-15")} .dt`, "data-total"))), "filtered ledger total equals the day's calendar total");
ok(await p.locator(tid("ledger-week")).count() === 0, "absence: no week groups while filtered");
await p.click(`${tid("day-15")} .n`);
ok(await p.locator(tid("ledger-row")).count() === 52 && await p.locator(tid("ledger-filter")).count() === 0, "clicking the day again shows the whole month");
await p.click(`${tid("day-15")} .n`); await p.click("#lclear");
ok(await p.locator(tid("ledger-row")).count() === 52, "the × also clears it");
await p.click(tid("chip-field"));
const cats = await p.locator(`${tid("ledger-row")}`).evaluateAll(r => [...new Set(r.map(x => x.dataset.cat))]);
ok(cats.length === 1 && cats[0] === "field" && await p.locator(".day .pay").count() < bubbles.length, "clicking Field Costs shows only that category on the calendar and ledger");
ok(await p.locator('.chip[aria-pressed="true"]').count() === 1, "the other chips go dim");
const shown = Number(await p.getAttribute(`${tid("ledger-total")} td[data-total]`, "data-total"));
ok(near(shown, num(await p.$eval(tid("chip-field"), e => e.querySelector("b").textContent))), "ledger total equals the chip amount");
ok(near(num(await p.textContent(tid("sum-month"))), month), "header month total stays whole");
await p.click(tid("chip-pers"));
ok(JSON.stringify(await p.locator(`${tid("ledger-row")}`).evaluateAll(r => [...new Set(r.map(x => x.dataset.cat))])) === '["pers"]', "clicking another chip switches to it, no unselecting needed");
await p.click(tid("chip-pers"));
ok(await p.locator('.chip[aria-pressed="true"]').count() === 6 && await p.locator(tid("ledger-row")).count() === 52, "clicking the active chip again shows all");
await p.click(tid("chip-mkt")); await p.click("#all");
ok(await p.locator(tid("ledger-row")).count() === 52, "the all-categories link also resets");
ok(await p.isHidden(tid("popover")), "absence: no popover at rest");
await p.locator(`${tid("day-6")} .pay`).first().click();
const pt = await p.textContent(tid("popover"));
const pn = await p.locator(`${tid("popover")} dt`).count();
ok(await p.isVisible(tid("popover")) && /Oct 6 · Personnel/.test(pt) && /Austin/.test(pt) && /Match manager pay/.test(pt) && /Projected/.test(pt) && pn === 4, `clicking a bubble lists its payees (${pn}) with the sub-type and status`);
await p.keyboard.press("Escape");
ok(await p.isHidden(tid("popover")), "Escape closes it");
await p.click('.i[data-pop="how"]');
ok(/Personnel/.test(await p.textContent(tid("popover"))) && /Subscriptions/.test(await p.textContent(tid("popover"))), "the i explains each category");
ok(errs.length === 0, `no page errors (${errs.join("; ")})`);
await b.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
