// Assertions for scripts/mocks/field-costs-v2.html (Field Costs venue panel: two models, tight rows, calendar date picker)
// Run: node scripts/mocks/field-costs-v2.assert.mjs [url]
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
const here = path.dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] || "file://" + path.join(here, "field-costs-v2.html");
const tid = id => `[data-testid="${id}"]`;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + m); };
const num = s => Number(String(s).replace(/[^0-9.]/g, ""));

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 1100 } });
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.goto(url); await p.waitForSelector(tid("venues"));
ok(true, "instrument ran: table rendered");

const body = await p.textContent("main");
ok(!/Auto-bill|Slots|One reservation per time slot|MONTHLY FLAT|Monthly flat|KEYED|DPP price|Member price|Player pricing|cadence/i.test(body), "absence: no Auto-bill, Slots, Monthly flat, KEYED, player pricing or cadence dropdowns");
const tags = await p.$$eval('[data-testid^="tag-"]', e => [...new Set(e.map(x => x.textContent.replace(/ · \$.*/, "")))]);
ok(JSON.stringify(tags.sort()) === JSON.stringify(["Per match", "Profit share"]), `only two billing tags in the list: ${tags.join(", ")}`);
const heads = await p.$$eval(`${tid("venues")} thead th`, e => e.map(x => (x.childNodes[0]?.textContent || "").trim()));
ok(JSON.stringify(heads.slice(0, 5)) === JSON.stringify(["Venue", "Billing", "Oct matches", "Oct cost", "Pays on"]), `columns: ${heads.join(" | ")}`);

// compact, few words
// Every venue starts collapsed on the live page; open the first one (the mock starts it open).
if (await p.locator(tid("panel-0")).count() === 0) { await p.click(tid("row-0")); await p.waitForSelector(tid("panel-0")); }
const panelH = await p.$eval(`${tid("panel-0")} .pan`, e => e.getBoundingClientRect().height);
ok(panelH < 340, `open panel without the matches table is under 340px (${Math.round(panelH)}px)`);
const words = await p.$eval(`${tid("panel-0")} .pan`, e => e.innerText.split(/\s+/).filter(w => /[a-z]{3,}/i.test(w)).length);
ok(words < 55, `panel has fewer than 55 words (${words})`);
const labels = await p.$$eval(`${tid("panel-0")} .g .l`, e => e.map(x => x.textContent));
ok(JSON.stringify(labels) === JSON.stringify(["Billing", "Cancelled", "This month", "Notes"]), `left rows for a one-field venue: ${labels.join(" · ")} (no Fields row)`);
ok(await p.locator(tid("notes")).count() === 1 && (await p.inputValue(tid("notes"))) === "", "a free-text notes box, empty here");
await p.click(tid("row-0")); await p.click(tid("row-3"));
ok(/following month/.test(await p.inputValue(tid("notes"))), "Bob Jones Park carries its note");
await p.click(tid("row-3")); await p.click(tid("row-0"));
ok(await p.locator(`${tid("panel-0")} select`).count() === 1, "one dropdown only (the billing model)");

// override
ok(/set by hand · auto \$1,440/.test(await p.textContent(tid("calc"))) && /set by hand · computed \$1,440/.test(await p.textContent(`${tid("row-0")} td.cost`)), "overridden month is flagged in the panel and the list");
await p.click(`${tid("panel-0")} [data-clear]`);
ok(num(await p.getAttribute(`${tid("row-0")} td.cost`, "data-cost")) === 1440 && (await p.getAttribute(tid("override"), "placeholder")) === "1440", "reset clears it; the empty box shows the auto amount");

// calendar: pick dates
ok(await p.locator(`${tid("cal")} .d[data-d]`).count() === 31 && await p.locator(`${tid("cal")} .d.on`).count() === 1 && await p.locator(`${tid("cal-7")}.on`).count() === 1, "calendar shows October with the 7th selected");
ok(await p.locator(`${tid("cal")} .d.m`).count() === 8, "match days are marked on the calendar");
ok(/\$1,440 Oct 7/.test(await p.textContent(tid("when-calc"))), "result line: $1,440 Oct 7");
await p.click(tid("cal-20"));
ok(await p.locator(`${tid("cal")} .d.on`).count() === 2 && await p.locator(tid("amts")).count() === 1 && /\$720 Oct 7 · \$720 Oct 20/.test(await p.textContent(tid("when-calc"))), "clicking a second date selects it, shows amount boxes, and splits the month evenly until you type");
await p.fill(tid("amt-7"), "500"); await p.dispatchEvent(tid("amt-7"), "change");
ok(/\$500 Oct 7 · \$940 Oct 20/.test(await p.textContent(tid("when-calc"))) && /\$500 Oct 7 · \$940 Oct 20/.test(await p.textContent(tid("when-0"))), "$500 on the 7th, the rest ($940) on the 20th, in the panel and the list");
await p.fill(tid("amt-20"), "300"); await p.dispatchEvent(tid("amt-20"), "change");
ok(/\$640 unscheduled/.test(await p.textContent(tid("when-calc"))) && (await p.getAttribute(tid("when-calc"), "class")).includes("warn"), "if the dates don't cover the month it warns with the gap");
await p.click(tid("cal-20"));
ok(await p.locator(`${tid("cal")} .d.on`).count() === 1 && await p.locator(tid("amts")).count() === 0, "clicking a selected date removes it; amount boxes go away with one date");
await p.click(tid("cal-7"));
ok(await p.locator(`${tid("cal")} .d.on`).count() === 1, "the last date can't be removed");

// prepaid
await p.check(tid("prepaid"));
ok(/September 2026 · pays for October/.test(await p.textContent(tid("cal"))) && /Sep 7/.test(await p.textContent(tid("when-calc"))) && /Paid Sep 7/.test(await p.textContent(tid("when-0"))), "prepaid relabels the calendar to September and the list reads Paid Sep 7");
await p.uncheck(tid("prepaid"));

// weekly / biweekly / each match
await p.click(`${tid("modes")} [data-mode="weekly"]`);
ok(await p.locator(`${tid("cal")} .d.on`).count() === 4 && await p.locator(tid("prepaid")).count() === 0, "weekly highlights every Wednesday (4 in Oct) and hides prepaid");
await p.click(tid("cal-2"));
ok(/× 5 · Oct 2, Oct 9, Oct 16, Oct 23, Oct 30/.test(await p.textContent(tid("when-calc"))) && /Every Friday/.test(await p.textContent(tid("when-0"))), "clicking a date in weekly sets the weekday: every Friday");
await p.click(`${tid("modes")} [data-mode="biweekly"]`);
ok(await p.locator(`${tid("cal")} .d.on`).count() === 3 && /Oct 2, Oct 16, Oct 30/.test(await p.textContent(tid("when-calc"))), "every 2 weeks keeps alternate Fridays");
await p.click(`${tid("modes")} [data-mode="match"]`);
ok(await p.locator(tid("cal")).count() === 0 && /8 matches · \$180 each, on the match date · auto/.test(await p.textContent(tid("when-calc"))), "each match hides the calendar: nothing to pick, it's automatic");
await p.click(`${tid("modes")} [data-mode="dates"]`);
ok(await p.locator(`${tid("cal")} .d.on`).count() === 1 && await p.locator(tid("prepaid")).count() === 1, "back to pick dates: one date, prepaid box back");

// rates by day of week
await p.click(tid("add-rate"));
ok(await p.locator('[data-testid^="rate-"]').count() === 2 && await p.locator(".dy").count() === 14, "+ rate adds a second rate with day-of-week chips on both");
const d1 = await p.$$eval('[data-testid="rate-1"] .dy.on', e => e.map(x => x.title));
ok(JSON.stringify(d1) === JSON.stringify(["Saturday", "Sunday"]), `second rate defaults to the weekend (${d1.join(", ")})`);
await p.click('[data-testid="rate-1"] .dy[title="Friday"]');
ok((await p.$$eval('[data-testid="rate-1"] .dy.on', e => e.length)) === 3 && (await p.$$eval('[data-testid="rate-0"] .dy.on', e => e.length)) === 4, "clicking Friday on the second rate moves it off the first: each day belongs to one rate");
await p.fill('[data-testid="rate-1"] [data-testid="rate"]', "200"); await p.dispatchEvent('[data-testid="rate-1"] [data-testid="rate"]', "change");
ok(/0 Mon–Thu × \$180 \+ 8 Fri–Sun × \$200/.test(await p.textContent(tid("calc"))) && num(await p.getAttribute(`${tid("row-0")} td.cost`, "data-cost")) === 1600, "Ann Richards plays Fri to Sun only: 8 × $200 = $1,600");
ok(/\$180 Mon–Thu · \$200 Fri–Sun/.test(await p.textContent(tid("tag-0"))), "the list tag shows each rate with its days");
await p.click('[data-testid="rate-1"] [data-delrate]');
ok(await p.locator('[data-testid^="rate-"]').count() === 1 && num(await p.getAttribute(`${tid("row-0")} td.cost`, "data-cost")) === 1440, "removing the second rate gives its days back; $1,440 again");

// model
await p.selectOption(tid("model"), "share");
ok(await p.locator(tid("rate")).count() === 0 && await p.locator(tid("override")).count() === 1 && /Partners/.test(await p.textContent(tid("panel-0"))), "profit share: no rate, keeps the This month box, link to Partners");
ok(/Profit share/.test(await p.textContent(tid("tag-0"))), "the list tag follows the model");
await p.selectOption(tid("model"), "match");

// other rows
ok(/\$500 Oct 1 · \$1,320 Oct 15/.test(await p.textContent(tid("when-1"))), "ATH Katy row shows its two dates: $500 then the rest");
ok(/\$0 Mon–Thu · \$140 Fri–Sun/.test(await p.textContent(tid("tag-1"))) && /4 Mon–Thu × \$0 \+ 13 Fri–Sun × \$140/.test(await p.textContent(`${tid("row-1")} td.cost`)) && num(await p.getAttribute(`${tid("row-1")} td.cost`, "data-cost")) === 1820, "ATH Katy: Mon–Thu free, Fri–Sun $140, 13 matches = $1,820");
ok(/Paid Sep 10/.test(await p.textContent(tid("when-3"))), "Bob Jones Park row reads Paid Sep 10");
ok(/Every other Friday/.test(await p.textContent(tid("when-7"))), "NEMP row reads Every other Friday");
ok(/Profit share/.test(await p.textContent(tid("tag-6"))) && /set by hand · computed \$630/.test(await p.textContent(`${tid("row-6")} td.cost`)) && num(await p.getAttribute(`${tid("row-6")} td.cost`, "data-cost")) === 4334.4, "PARMER: profit share with a hand-set invoice total, payout shown underneath");
await p.click(tid("row-7"));
ok(await p.locator(`${tid("panel-7")} .g .l`).filter({ hasText: "Fields" }).count() === 1 && await p.locator(`${tid("panel-7")} [data-field]`).count() === 2 && !(await p.isChecked(`${tid("panel-7")} [data-field="1"]`)), "a venue with two fields shows the Fields row; NEMP's tournament field is unchecked");
ok(await p.locator(tid("panel-0")).count() === 0, "opening one venue closes the other");

ok(errs.length === 0, `no page errors (${errs.join("; ")})`);
await b.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
