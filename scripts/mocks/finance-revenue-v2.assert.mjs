// Assertions for scripts/mocks/finance-revenue-v2.html
// Run: node scripts/mocks/finance-revenue-v2.assert.mjs [url]
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
const here = path.dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] || "file://" + path.join(here, "finance-revenue-v2.html");
const tid = id => `[data-testid="${id}"]`;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + m); };
const num = s => Number(String(s).replace(/[^0-9.\-−]/g, "").replace("−", "-"));
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1400, height: 1000 } });
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.goto(url); await p.waitForSelector(tid("hero"));
ok(true, "instrument ran: hero rendered");

// status and assumptions
ok(/Updating · final by Oct 2/.test(await p.textContent(tid("status"))), "September shows Updating, final by Oct 2");
ok(await p.isHidden(tid("popover")), "absence: no popover open at rest");
await p.click(tid("info-how"));
const how = await p.textContent(tid("popover"));
ok(await p.isVisible(tid("popover")), "presence control: clicking the title i opens the assumptions");
for (const [re, m] of [[/Central time/, "Central time"], [/minus refunds, disputes and sales tax/, "net definition"], [/month they happen/, "refund timing"], [/Stripe fees are shown separately/, "fees separate"], [/Venmo/, "Venmo included"], [/Excludes test matches and internal accounts/, "test/internal excluded"], [/Unassigned/, "unassigned"], [/Updating.*Final/s, "updating and final"]])
  ok(re.test(how), `assumptions cover: ${m}`);
await p.click(tid("info-how"));
ok(await p.isHidden(tid("popover")), "clicking the same i again closes it");

// bridge
const gross = num(await p.textContent(tid("gross-revenue")));
const net = num(await p.textContent(tid("net-revenue")));
const bv = async k => num(await p.textContent(`[data-b="${k}"]`));
const [rf, ds, tx, nt] = [await bv("ref"), await bv("dis"), await bv("tax"), await bv("net")];
ok(gross > net, `headline is gross collected (${gross}), with net beneath it`);
ok(Math.abs(gross + rf + ds + tx - nt) <= 2, `calculation adds up: ${gross} ${rf} ${ds} ${tx} = ${nt}`);
const hb = await p.locator(tid("gross-revenue")).boundingBox(), nb = await p.locator(tid("net-revenue")).boundingBox();
ok(nb.y > hb.y, "net revenue sits underneath the gross figure");
ok(Math.abs(await bv("kept") - (nt + await bv("fees"))) <= 2, "Stripe fees shown under net, kept after fees = net minus fees");

// line items
ok(await p.isHidden(tid("line-items")), "absence: line items collapsed by default");
await p.click(tid("toggle-items"));
ok(await p.isVisible(tid("line-items")), "presence control: Show line items expands them");
const items = await p.$$eval(`${tid("line-items")} td[data-v]`, t => t.map(x => ({ v: Number(x.dataset.v), sub: x.closest("tr").className })));
const lines = items.filter(i => !i.sub);
const netRow = items.find(i => i.sub === "sub").v, kept = items.find(i => i.sub === "sub2").v;
const beforeNet = lines.slice(0, 6).reduce((a, i) => a + i.v, 0);
ok(Math.abs(beforeNet - netRow) < 0.02, `line items sum to net revenue to the cent (${beforeNet.toFixed(2)} vs ${netRow})`);
ok(Math.abs(netRow + lines[6].v - kept) < 0.02, "net minus Stripe fees equals kept after fees");
for (const t of ["card-charges", "venmo-manual-", "refunds", "failed-payments", "disputes", "sales-tax", "stripe-fees"])
  ok(await p.locator(tid("item-" + t)).count() === 1, `line item present: ${t}`);
const iCount = await p.locator(`${tid("line-items")} .i`).count();
ok(iCount >= 7, `every line item has an i (${iCount})`);

// city table
const rows = await p.$$eval(`${tid("city-table")} tbody tr:not(.tot) td[data-net]`, t => t.map(x => Number(x.dataset.net)));
const tot = Number(await p.$eval(`${tid("row-total")} td[data-net]`, x => x.dataset.net));
ok(Math.abs(rows.reduce((a, v) => a + v, 0) - tot) < 0.05, "city rows sum to the total");
ok(Math.abs(tot - netRow) < 1, "city total equals net revenue");
ok(await p.locator(tid("row-un")).count() === 1, "Unassigned row present so cities add up");
ok(!/Saint Louis/.test(await p.textContent(tid("city-table"))), "absence: no Saint Louis duplicate");
ok(/St\. Louis/.test(await p.textContent(tid("city-table"))), "presence control: St. Louis is there");

// fields
const opts = await p.$$eval(`${tid("field-select")} option`, o => o.map(x => x.textContent));
ok(!opts.some(o => /Friendly match|Grip Sock|Happy Hour|TestPaidMatch|- (Mon|Tue|Wed|Thu|Fri|Sat|Sun)/.test(o)), "absence: no match names or weekday variants in the field list");
ok(opts.length > 1, "presence control: the field list has entries");

await p.click(tid("info-status"));
const st = await p.textContent(tid("popover"));
ok(/Adjusted after final/.test(st) && /month they happen/.test(st), "status i explains final and adjustments");
ok(!/5th|closes Oct 5/.test(await p.textContent("main")), "absence: no fixed close date anywhere");
await p.click(tid("info-status"));
ok(errs.length === 0, `no page errors (${errs.join("; ")})`);
await b.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
