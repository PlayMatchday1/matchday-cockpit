// Assertions for the OpEx month calendar + ledger: scripts/mocks/opex-calendar-v3.html AND the live
// page (/admin/finance/opex). Run:
//   node scripts/mocks/opex-calendar-v3.assert.mjs                      # the mock
//   node scripts/mocks/opex-calendar-v3.assert.mjs <http(s) url>        # a live page, signed in
//
// GENERALIZED 2026-10-02 (Ryan): the first version pinned the mock's illustrative October — 52 rows,
// 4 payments on Oct 15, "today is Oct 2", Oct 3 = Personnel + Fields, 4 payees on Oct 6. Against live
// data those are not facts, and the date ones go red the next day. Every expected value here is now
// DERIVED: from the month on screen, the Chicago calendar date, the page's own payment count
// (data-payments on the ledger — the number the data layer produced), and cross-checks between the
// calendar and the ledger. The day and category exercised are picked from the data (the busiest day,
// the biggest category), never named.
//
// Live URLs are opened with a session minted by scripts/e2e/_session.mjs for OPEX_ASSERT_EMAIL
// (default rmancuso@playmatchday.com); the mock needs none.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
const here = path.dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] || "file://" + path.join(here, "opex-calendar-v3.html");
const live = /^https?:/.test(url);
const tid = id => `[data-testid="${id}"]`;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + m); };
const num = s => Number(String(s).replace(/[^0-9.-]/g, ""));
const near = (a, b) => Math.abs(a - b) < 0.011;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const b = await chromium.launch();
let ctxOpts = { viewport: { width: 1600, height: 1100 } };
if (live) {
  const root = path.join(here, "..", "..");
  for (const l of fs.readFileSync(path.join(root, ".env.local"), "utf8").split("\n")) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, ""); }
  const { storageStateFor } = await import(path.join(root, "scripts", "e2e", "_session.mjs"));
  const { storageState } = await storageStateFor(process.env.OPEX_ASSERT_EMAIL || "rmancuso@playmatchday.com", new URL(url).origin);
  ctxOpts = { ...ctxOpts, storageState };
}
const p = await (await b.newContext(ctxOpts)).newPage();
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.goto(url); await p.waitForSelector(tid("calendar"), { timeout: 120000 });
ok(true, "instrument ran: calendar rendered");

// ── the month on screen, and today ─────────────────────────────────────────────────────────────
const label = (await p.locator(`${tid("month")}, ${tid("month-label")}`).first().textContent()).trim();   // "October 2026"
const [mName, yStr] = label.split(" ");
const Y = Number(yStr), M = MONTHS.indexOf(mName), MON = mName.slice(0, 3);
ok(M >= 0 && Y > 2000, `the month on screen parses (${label})`);
const DAYS = new Date(Y, M + 1, 0).getDate();
const LEAD = (new Date(Y, M, 1).getDay() + 6) % 7;                 // Monday first
const WEEKS = Math.ceil((LEAD + DAYS) / 7);
const WKEND = Array.from({ length: DAYS }, (_, i) => new Date(Y, M, i + 1).getDay()).filter(d => d === 0 || d === 6).length;
const shownToday = await p.$$eval(".day.today[data-day]", e => e.map(x => Number(x.dataset.day)));
const chicago = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const [cy, cm, cd] = chicago.split("-").map(Number);
const isCurrent = cy === Y && cm - 1 === M;
// The mock fixes its own "today"; a live page must agree with Chicago's calendar.
const TODAY = live ? (isCurrent ? cd : null) : (shownToday[0] ?? null);
const pastAll = live && (Y * 12 + M < cy * 12 + cm - 1);

// ── calendar shape ─────────────────────────────────────────────────────────────────────────────
const weeks = await p.locator(tid("week")).count();
ok(weeks === WEEKS, `${label} renders as ${WEEKS} week rows (got ${weeks})`);
ok(await p.$$eval(".wk.h div", d => d.map(x => x.textContent).join(",")) === "Mon,Tue,Wed,Thu,Fri,Sat,Sun", "weeks start on Monday like the Master Schedule");
ok(await p.locator(".day[data-day]").count() === DAYS, `${DAYS} day cells`);
const outN = WEEKS * 7 - DAYS;
ok(await p.locator(".day.out").count() === outN && await p.locator(".day.out .pay").count() === 0, `${outN} out-of-month cells, faded with no payments`);
ok(TODAY == null ? shownToday.length === 0 : (shownToday.length === 1 && shownToday[0] === TODAY),
  TODAY == null ? "no day is marked today (not the current month)" : `today (${MON} ${TODAY}) is marked`);
const pastDays = await p.$$eval(".day.past[data-day]", e => e.map(x => Number(x.dataset.day)));
const wantPast = Array.from({ length: DAYS }, (_, i) => i + 1).filter(d => pastAll || (TODAY != null && d < TODAY));
ok(JSON.stringify(pastDays) === JSON.stringify(wantPast), `past days shaded, future not (${pastDays.length} past)`);
ok(await p.locator(".day.wkend[data-day]").count() === WKEND, `weekends shaded (${WKEND} in ${mName})`);

// ── the ledger, read in full, is the reference the calendar is checked against ─────────────────
const rowsAll = await p.$$eval(`${tid("ledger-row")}`, r => r.map(x => ({ day: x.dataset.day === "" ? null : Number(x.dataset.day), cat: x.dataset.cat,
  payee: x.querySelector("td:nth-child(2)").textContent.trim(), amt: Number(x.querySelector("td.r b").textContent.replace(/[^0-9.-]/g, "")) })));
const PAY = Number(await p.getAttribute(tid("ledger"), "data-payments"));
ok(Number.isFinite(PAY) && PAY > 0, `the page reports its payment count (${PAY})`);
ok(rowsAll.length === PAY, `ledger lists every payment (${rowsAll.length} rows, ${PAY} payments)`);
const dated = rowsAll.filter(r => r.day != null);
const pairs = new Set(dated.map(r => `${r.day}:${r.cat}`));

// pills: one per category per day, payees on click
const bubbles = await p.$$eval(".day .pay", e => e.map(x => ({ day: Number(x.dataset.day), cat: x.dataset.cat, nm: x.querySelector(".nm").textContent, v: x.querySelector(".v").textContent, sw: x.querySelector(".sw").getAttribute("style"), paid: x.classList.contains("paid"), proj: x.classList.contains("proj") })));
ok(bubbles.length > 0 && bubbles.every(x => /\$/.test(x.v) && x.nm && /background/.test(x.sw)), `every bubble shows a category, amount and color (${bubbles.length} bubbles)`);
ok(bubbles.length === pairs.size && bubbles.every(x => pairs.has(`${x.day}:${x.cat}`)), `exactly one bubble per category per day with payments (${bubbles.length} bubbles, ${pairs.size} day-category pairs in the ledger)`);
const perDay = await p.$$eval(".day[data-day]", ds => Math.max(...ds.map(d => d.querySelectorAll(".pay").length)));
ok(perDay <= 6, `no day shows more than the six categories (max ${perDay})`);
const pillCountOk = bubbles.every(x => { const n = dated.filter(r => r.day === x.day && r.cat === x.cat).length; const shown = Number((x.nm.match(/(\d+)\s*$/) || [0, 1])[1]); return shown === n; });
ok(pillCountOk, "each bubble's count is that day's number of payments in its category");
ok(await p.locator(".day .more").count() === 0, "absence: no + more lines; payees live in the popover and ledger");
const calText = await p.textContent(tid("calendar"));
const CATWORDS = /^(Personnel|Fields?|Field Costs|Equipment|Marketing|Subscriptions|Misc|week|today)$/i;
const leaked = [...new Set(rowsAll.map(r => r.payee))].filter(n => n.length >= 4 && !CATWORDS.test(n) && !/^\d/.test(n) && calText.includes(n));
ok(rowsAll.length > 0 && leaked.length === 0, `absence: no payee names on the calendar (${leaked.length ? leaked.join(", ") : "checked " + new Set(rowsAll.map(r => r.payee)).size + " payees"})`);
const statusOk = bubbles.every(x => (TODAY != null ? x.day <= TODAY : pastAll) ? (x.paid && !x.proj) : (x.proj && !x.paid));
ok(statusOk, `bubbles on or before ${TODAY != null ? `${MON} ${TODAY}` : "today"} are solid (paid), after it dashed (projected)`);
ok(bubbles.some(x => x.paid) || bubbles.some(x => x.proj), "CONTROL: there are bubbles to classify");
const cellOk = await p.$$eval(".day[data-day]", ds => ds.every(d => { const t = Number(d.querySelector(".dt").dataset.total); const s = [...d.querySelectorAll(".pay .v")].reduce((a, x) => a + Number(x.textContent.replace(/[^0-9.]/g, "")), 0); return Math.abs(t - s) < 0.011; }));
ok(cellOk, "every day's bubbles add up to its total");
ok(await p.locator(".day[data-day] .dt").count() === DAYS, "every day has a total badge");

// ── totals ─────────────────────────────────────────────────────────────────────────────────────
const sumDays = await p.$$eval(".day[data-day] .dt", e => e.reduce((s, x) => s + Number(x.dataset.total), 0));
const noDaySum = rowsAll.filter(r => r.day == null).reduce((s, r) => s + r.amt, 0);
const month = num(await p.textContent(tid("sum-month")));
ok(near(sumDays + noDaySum, month), `day totals plus the no-day group add up to the month (${sumDays.toFixed(2)} + ${noDaySum.toFixed(2)} vs ${month})`);
const noDayLine = await p.locator(tid("noday-line")).count();
ok(noDaySum === 0 ? noDayLine === 0 : noDayLine === 1, noDaySum === 0 ? "no payments without a day, and no warning line" : "payments without a day are flagged under the chips");
ok(near(num(await p.textContent(tid("sum-paid"))) + num(await p.textContent(tid("sum-left"))), month), "paid + still to go = month");
// Chips print whole dollars on the live page (2026-10-02); the exact amount is data-total where set.
const chips = await p.$$eval(".chip", e => e.reduce((s, x) => s + Number(x.dataset.total ?? x.querySelector("b").textContent.replace(/[^0-9.]/g, "")), 0));
ok(near(chips, month), "category chips add up to the month");
ok(await p.locator(".chip").count() === 6, "six categories: Personnel, Field Costs, Equipment, Marketing, Subscriptions, Misc");
const names = await p.$$eval(".chip", e => e.map(x => x.textContent.trim().split(" $")[0]));
// The live chips use the pills' short label for Field Costs ("Fields", 2026-10-02); the mock says "Field Costs".
ok(["Field Costs", "Fields"].includes(names[1]) && JSON.stringify([names[0], ...names.slice(2)]) === JSON.stringify(["Personnel", "Equipment", "Marketing", "Subscriptions", "Misc"]), `chip order: ${names.join(", ")}`);
ok(!/City Manager Pay|Match Manager Pay|Corporate Salaries/.test(await p.textContent("#chips")), "absence: no pay sub-categories as top-level chips");
const ledgerText = await p.textContent(tid("ledger"));
ok(rowsAll.every(r => r.cat !== "pers") || /Personnel · /.test(ledgerText), "presence control: Personnel rows carry their sub-type on the ledger");

// ── ledger structure ───────────────────────────────────────────────────────────────────────────
const wantWeeks = new Set(dated.map(r => Math.floor((r.day - 1 + LEAD) / 7))).size;
ok(await p.locator(tid("ledger-week")).count() === wantWeeks, `ledger grouped by week with a subtotal each (${wantWeeks} weeks with payments)`);
const run = await p.$$eval(`${tid("ledger-row")} td.cum`, e => e.map(x => Number(x.textContent.replace(/[^0-9.-]/g, ""))));
ok(run.every((v, i) => i === 0 || v >= run[i - 1] - 0.011 || rowsAll[i].amt < 0) && near(run.at(-1), month), "running total climbs to the month total");
ok(near(Number(await p.getAttribute(`${tid("ledger-total")} td[data-total]`, "data-total")), month), "ledger total equals the header");
const heads = await p.$$eval(`${tid("ledger-table")} th`, e => e.map(x => x.textContent));
ok(JSON.stringify(heads) === JSON.stringify(["Date", "Payee", "Category", "City", "Status", "Amount", "Running total"]), `ledger columns: ${heads.join(" | ")}`);

// ── interactions, on the busiest day ───────────────────────────────────────────────────────────
const byDay = {}; for (const r of dated) byDay[r.day] = (byDay[r.day] || 0) + 1;
const D = Number(Object.entries(byDay).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0]);
const nD = byDay[D];
ok(Number.isFinite(D) && nD > 0, `CONTROL: picked the busiest day, ${MON} ${D} (${nD} payments)`);
const yBefore = await p.evaluate(() => scrollY);
await p.click(`${tid(`day-${D}`)} .n`);
const fRows = await p.locator(tid("ledger-row")).evaluateAll(r => r.map(x => x.dataset.day));
ok(fRows.length === nD && fRows.every(d => d === String(D)), `clicking a day filters the ledger to exactly that day's rows (${fRows.length} rows, ${nD} expected, all ${MON} ${D})`);
ok(await p.evaluate(() => scrollY) === yBefore, "absence: the page does not scroll");
ok(new RegExp(`Showing ${MON} ${D}\\b`).test(await p.textContent(tid("ledger-filter"))) && await p.locator(`${tid(`day-${D}`)}.sel`).count() === 1, "the day is marked on the calendar and named in the ledger header");
ok(near(Number(await p.getAttribute(`${tid("ledger-total")} td[data-total]`, "data-total")), Number(await p.getAttribute(`${tid(`day-${D}`)} .dt`, "data-total"))), "filtered ledger total equals the day's calendar total");
ok(await p.locator(tid("ledger-week")).count() === 0, "absence: no week groups while filtered");
await p.click(`${tid(`day-${D}`)} .n`);
ok(await p.locator(tid("ledger-row")).count() === PAY && await p.locator(tid("ledger-filter")).count() === 0, "clicking the day again shows the whole month");
await p.click(`${tid(`day-${D}`)} .n`); await p.click("#lclear");
ok(await p.locator(tid("ledger-row")).count() === PAY, "the × also clears it");

// categories: the biggest one, then another with payments
const catTotals = {}; for (const r of rowsAll) catTotals[r.cat] = (catTotals[r.cat] || 0) + r.amt;
const byAmt = Object.entries(catTotals).sort((a, b) => b[1] - a[1]).map(x => x[0]);
const C1 = byAmt[0], C2 = byAmt[1] ?? byAmt[0];
await p.click(tid(`chip-${C1}`));
const cats = await p.locator(`${tid("ledger-row")}`).evaluateAll(r => [...new Set(r.map(x => x.dataset.cat))]);
ok(cats.length === 1 && cats[0] === C1 && await p.locator(".day .pay").count() === bubbles.filter(x => x.cat === C1).length, `clicking ${C1} shows only that category on the calendar and ledger`);
ok(await p.locator('.chip[aria-pressed="true"]').count() === 1, "the other chips go dim");
ok(near(Number(await p.getAttribute(`${tid("ledger-total")} td[data-total]`, "data-total")), await p.$eval(tid(`chip-${C1}`), e => Number(e.dataset.total ?? e.querySelector("b").textContent.replace(/[^0-9.]/g, "")))), "ledger total equals the chip amount");
ok(near(num(await p.textContent(tid("sum-month"))), month), "header month total stays whole");
await p.click(tid(`chip-${C2}`));
ok(JSON.stringify(await p.locator(`${tid("ledger-row")}`).evaluateAll(r => [...new Set(r.map(x => x.dataset.cat))])) === JSON.stringify([C2]), `clicking another chip (${C2}) switches to it, no unselecting needed`);
await p.click(tid(`chip-${C2}`));
ok(await p.locator('.chip[aria-pressed="true"]').count() === 6 && await p.locator(tid("ledger-row")).count() === PAY, "clicking the active chip again shows all");
await p.click(tid(`chip-${C1}`)); await p.click("#all");
ok(await p.locator(tid("ledger-row")).count() === PAY, "the all-categories link also resets");

// popover: the busiest day's biggest bubble
ok(await p.isHidden(tid("popover")), "absence: no popover at rest");
const pill = bubbles.filter(x => x.day === D).sort((a, b) => num(b.v) - num(a.v))[0];
await p.locator(`.day .pay[data-day="${D}"][data-cat="${pill.cat}"]`).click();
const pt = await p.textContent(tid("popover"));
const pn = await p.locator(`${tid("popover")} dt`).count();
const wantPn = dated.filter(r => r.day === D && r.cat === pill.cat).length;
const catName = { pers: "Personnel", field: "Field Costs", equip: "Equipment", mkt: "Marketing", subs: "Subscriptions", misc: "Misc" }[pill.cat];
const wantStatus = pill.paid ? /Paid/ : /Projected/;
ok(await p.isVisible(tid("popover")) && new RegExp(`${MON} ${D} · ${catName}`).test(pt) && wantStatus.test(pt) && pn === wantPn,
  `clicking a bubble lists its payees (${pn}, ${wantPn} in the ledger) with the day, category and status`);
await p.keyboard.press("Escape");
ok(await p.isHidden(tid("popover")), "Escape closes it");
await p.click('.i[data-pop="how"]');
ok(/Personnel/.test(await p.textContent(tid("popover"))) && /Subscriptions/.test(await p.textContent(tid("popover"))), "the i explains each category");
ok(errs.length === 0, `no page errors (${errs.join("; ")})`);
await b.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
