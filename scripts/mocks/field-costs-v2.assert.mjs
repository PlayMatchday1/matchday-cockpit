// Assertions for scripts/mocks/field-costs-v2.html (Field Costs venue panel: two models, tight rows, calendar date picker)
// Run: node scripts/mocks/field-costs-v2.assert.mjs                     (the mock)
//      node --env-file=.env.local scripts/mocks/field-costs-v2.assert.mjs http://localhost:3017/admin/finance/ledger/field-costs
//
// LIVE MODE (an http(s) url). Signs in, and BLOCKS EVERY WRITE: each non-GET except Supabase auth is
// answered here and never reaches a server, because the checks below click through rates, dates,
// the model and the override and each click would be a production write. A suite must not write
// production.
//
// DERIVE, DO NOT PIN. Eight checks were written against the mock's rows (ATH Katy at row 1, NEMP at
// row 7, an empty note on row 0…) and failed on every live run because live data is different, which
// told us nothing. In live mode each now either:
//   · LIVE: derives its subject and its expected value from the data the page itself loaded (the
//     fin_venues / fin_venue_fields / fin_venue_cost_overrides responses, read off the network), or
//   · MOCK-ONLY: is skipped, naming the interactive check that guards the same behaviour on any
//     venue. Skips are counted and printed; they never count as passes.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
const here = path.dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] || "file://" + path.join(here, "field-costs-v2.html");
const tid = id => `[data-testid="${id}"]`;
let pass = 0, fail = 0, skip = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + m); };
const LIVE = /^https?:/.test(url);
const mockOnly = (m, coveredBy) => { skip++; console.log(`SKIP (mock-only; live data differs — covered by "${coveredBy}") ${m}`); };
const num = s => Number(String(s).replace(/[^0-9.]/g, ""));

const b = await chromium.launch();
// What the live page loaded, read off the network (GETs only; pages concatenated, last copy wins).
const loaded = { fin_venues: new Map(), fin_venue_fields: new Map(), fin_venue_cost_overrides: new Map() };
const blocked = [];
let p;
if (LIVE) {
  const { storageStateFor } = await import("../e2e/_session.mjs");
  const { storageState } = await storageStateFor("rmancuso@playmatchday.com", new URL(url).origin);
  const ctx = await b.newContext({ storageState, viewport: { width: 1500, height: 1100 } });
  await ctx.route("**/*", async (route) => {
    const r = route.request(), m = r.method();
    if (m === "GET" || m === "HEAD" || m === "OPTIONS" || r.url().includes("/auth/v1/")) return route.continue();
    const u = new URL(r.url());
    blocked.push(`${m} ${u.pathname}`);
    let body = {}; try { body = JSON.parse(r.postData() || "{}"); } catch {}
    if (u.pathname === "/api/admin/fields/exclude") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ verdict: "LANDED", excluded: body.excluded }) });
    if (m === "DELETE") return route.fulfill({ status: 204, body: "" });
    const id = Number((u.searchParams.get("id") || "").replace("eq.", "")) || -1;
    const row = Array.isArray(body) ? body[0] : { id, ...body };
    if ((r.headers()["accept"] || "").includes("vnd.pgrst.object")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(row) });
    return route.fulfill({ status: 201, contentType: "application/json", body: "[]" });
  });
  p = await ctx.newPage();
  p.on("response", async (res) => {
    if (res.request().method() !== "GET") return;
    const m = /\/rest\/v1\/(fin_venues|fin_venue_fields|fin_venue_cost_overrides)(\?|$)/.exec(res.url());
    if (!m) return;
    try {
      const rows = await res.json();
      if (!Array.isArray(rows)) return;
      for (const r of rows) loaded[m[1]].set(m[1] === "fin_venue_fields" ? r.mdapi_field_id : r.id, r);
    } catch {}
  });
} else {
  p = await b.newPage({ viewport: { width: 1500, height: 1100 } });
}
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.goto(url); await p.waitForSelector(tid("venues"));
if (LIVE) await p.waitForSelector(tid("row-0"), { timeout: 60000 });   // presence first: data loads after the shell

// LIVE helpers — every expected value below comes from `loaded`, never from a constant.
const rowNames = async () => p.$$eval('[data-testid^="row-"]', rs => rs.map(r => ({ i: +r.dataset.testid.slice(4), name: r.querySelector("td.v b")?.textContent.trim(), city: (r.querySelector("td.v span")?.textContent || "").split(" · ")[0].trim() })));
const venueOfRow = (rn) => [...loaded.fin_venues.values()].find(v => v.venue_name === rn.name && (v.city ?? "") === rn.city);
const monthKey = async () => (await p.$eval(`${tid("venues")} thead th:nth-child(3)`, e => e.textContent)).replace(" matches", "").trim();   // "Oct"
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DAYS = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
const openRow = async (i) => { if (await p.locator(tid(`panel-${i}`)).count() === 0) { await p.click(tid(`row-${i}`)); await p.waitForSelector(tid(`panel-${i}`)); } };
let SUBJ = 0;   // LIVE: the row the panel walk used
const closeRow = async (i) => { if (await p.locator(tid(`panel-${i}`)).count() === 1) await p.click(tid(`row-${i}`)); };
ok(true, "instrument ran: table rendered");

const body = await p.textContent("main");
ok(!/Auto-bill|Slots|One reservation per time slot|MONTHLY FLAT|Monthly flat|KEYED|DPP price|Member price|Player pricing|cadence/i.test(body), "absence: no Auto-bill, Slots, Monthly flat, KEYED, player pricing or cadence dropdowns");
const tags = await p.$$eval('[data-testid^="tag-"]', e => [...new Set(e.map(x => x.textContent.replace(/ · \$.*/, "")))]);
ok(JSON.stringify(tags.sort()) === JSON.stringify(["Per match", "Profit share"]), `only two billing tags in the list: ${tags.join(", ")}`);
if (!LIVE) {
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
ok(/Every other Friday/.test(await p.textContent(tid("when-0"))), "the list reads Every other Friday for an every-2-weeks venue");
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
} else {
// ── LIVE: the same walk through one venue's panel, on a SUBJECT chosen from the data, with every
// expected value derived from what the page loaded (fin_venues, the overrides, the panel's own
// underlying-matches table) rather than from the mock's Ann Richards in October.
const names = await rowNames();
const monSel = await p.$eval("select", e => e.value);                 // "Oct 2026": the Month filter
const mon = monSel.split(" ")[0], year = Number(monSel.split(" ")[1]), m0 = MON.indexOf(mon);
const FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const dim = new Date(Date.UTC(year, m0 + 1, 0)).getUTCDate();
const wdOf = (d) => (new Date(Date.UTC(year, m0, d)).getUTCDay() + 6) % 7;        // Monday = 0
const fmt0 = (n) => `$${Math.round(n).toLocaleString("en-US")}`;
const amt = (s) => Number(String(s).replace(/[$,]/g, ""));
const heads = await p.$$eval(`${tid("venues")} thead th`, e => e.map(x => (x.childNodes[0]?.textContent || "").trim()));
ok(JSON.stringify(heads.slice(0, 5)) === JSON.stringify(["Venue", "Billing", `${mon} matches`, `${mon} cost`, "Pays on"]), `LIVE columns for ${monSel}: ${heads.join(" | ")}`);

// THE SUBJECT: a per-match venue on one picked date, not prepaid, one rate, not slot-billed, with
// matches this month and a computed figure big enough to split. The walk below needs that shape.
const linksOf = (vid) => [...loaded.fin_venue_fields.values()].filter(l => l.fin_venue_id === vid);
const ovFor = (vid) => [...loaded.fin_venue_cost_overrides.values()].find(o => o.venue_id === vid && o.month === monSel);
let S = null;
for (const n of names) {
  const v = venueOfRow(n), ps = v?.pay_schedule;
  if (!v || v.billing_type !== "per_match" || v.rate_days || v.bills_per_reservation || !(v.per_match_rate > 0)) continue;
  if (ps?.mode !== "dates" || ps.dates.length !== 1 || ps.prepaid) continue;
  await openRow(n.i);
  const lines = await p.$$eval(`${tid(`panel-${n.i}`)} ${tid("match-lines")} tbody tr`, rs => rs.map(r => r.dataset.date));
  const C = num(await p.getAttribute(`${tid(`panel-${n.i}`)} ${tid("override")}`, "placeholder"));
  if (lines.length > 0 && C >= 100) { S = { ...n, v, lines, C }; break; }
  await closeRow(n.i);
}
ok(!!S, `LIVE positive control: a subject venue for the panel walk (${S ? S.name : "none found"})`);
if (S) {
  SUBJ = S.i;
  const I = S.i, panel = tid(`panel-${I}`), v = S.v, C = S.C, R = v.per_match_rate, D = v.pay_schedule.dates[0].d;
  const P = await p.getAttribute(`${panel} ${tid("override")}`, "placeholder");
  const panelH = await p.$eval(`${panel} .pan`, e => e.getBoundingClientRect().height);
  ok(panelH < 340, `open panel without the matches table is under 340px (${Math.round(panelH)}px)`);
  const words = await p.$eval(`${panel} .pan`, e => e.innerText.split(/\s+/).filter(w => /[a-z]{3,}/i.test(w)).length);
  ok(words < 55, `panel has fewer than 55 words (${words})`);
  const labels = await p.$$eval(`${panel} .g .l`, e => e.map(x => x.textContent));
  const wantLabels = ["Billing", "Cancelled", "This month", ...(linksOf(v.id).length >= 2 ? ["Fields"] : []), "Notes"];
  ok(JSON.stringify(labels) === JSON.stringify(wantLabels), `LIVE left rows for ${S.name} (${linksOf(v.id).length} field link(s)): ${labels.join(" · ")}`);

  // notes: the box shows exactly this venue's stored note; another venue shows its own, not a stale one
  ok(await p.locator(`${panel} ${tid("notes")}`).count() === 1 && (await p.inputValue(`${panel} ${tid("notes")}`)) === (v.notes ?? ""), `LIVE a free-text notes box showing ${S.name}'s stored note (${JSON.stringify(v.notes ?? "")})`);
  const other = names.filter(n => n.i !== I).map(n => ({ n, v: venueOfRow(n) })).find(x => x.v && (x.v.notes ?? "") !== "" && (x.v.notes ?? "") !== (v.notes ?? ""));
  ok(!!other, "LIVE positive control: another venue on the page has a different, non-empty note");
  if (other) {
    await closeRow(I); await openRow(other.n.i);
    ok((await p.inputValue(`${tid(`panel-${other.n.i}`)} ${tid("notes")}`)) === other.v.notes, `LIVE ${other.n.name} carries its own note, not ${S.name}'s`);
    await closeRow(other.n.i); await openRow(I);
  }
  ok(await p.locator(`${panel} select`).count() === 1, "one dropdown only (the billing model)");

  // override: flagged when set (from fin_venue_cost_overrides), and reset shows the computed figure
  if (ovFor(v.id)) {
    ok((await p.textContent(tid("calc"))).includes(`set by hand · auto ${fmt0(C)}`) && (await p.textContent(`${tid(`row-${I}`)} td.cost`)).includes(`set by hand · computed ${fmt0(C)}`), `LIVE ${S.name}'s hand-set month is flagged in the panel and the list (computed ${fmt0(C)})`);
    await p.click(`${panel} [data-clear]`);
  } else {
    ok(/^auto ·/.test((await p.textContent(tid("calc"))).trim()), `LIVE ${S.name} has nothing set by hand for ${monSel}, and the panel says auto`);
  }
  ok(num(await p.getAttribute(`${tid(`row-${I}`)} td.cost`, "data-cost")) === C && (await p.getAttribute(tid("override"), "placeholder")) === P, `LIVE with nothing set by hand the cost is the computed ${fmt0(C)} and the empty box shows it`);

  // calendar: pick dates
  ok(await p.locator(`${tid("cal")} .d[data-d]`).count() === dim && await p.locator(`${tid("cal")} .d.on`).count() === 1 && await p.locator(`${tid(`cal-${D}`)}.on`).count() === 1, `LIVE calendar shows ${FULL[m0]} (${dim} days) with the ${D}th selected, as the pay schedule says`);
  const matchDays = new Set(S.lines.map(d => d.slice(8, 10))).size;
  ok(await p.locator(`${tid("cal")} .d.m`).count() === matchDays, `LIVE the ${matchDays} match days in the matches table are marked on the calendar`);
  ok((await p.textContent(tid("when-calc"))).includes(`${fmt0(C)} ${mon} ${D}`), `LIVE result line: ${fmt0(C)} ${mon} ${D}`);
  const E = D === 20 ? 21 : 20, [lo, hi] = [Math.min(D, E), Math.max(D, E)];
  await p.click(tid(`cal-${E}`));
  const two = new RegExp(`\\$([\\d,]+) ${mon} ${lo} · \\$([\\d,]+) ${mon} ${hi}`).exec(await p.textContent(tid("when-calc")));
  ok(await p.locator(`${tid("cal")} .d.on`).count() === 2 && await p.locator(tid("amts")).count() === 1 && !!two && Math.abs(amt(two[1]) + amt(two[2]) - C) <= 1 && Math.abs(amt(two[1]) - amt(two[2])) <= 1, `LIVE clicking a second date (${E}) selects it, shows amount boxes, and splits ${fmt0(C)} evenly (${two ? two[1] + " + " + two[2] : "no split line"})`);
  const X = Math.floor(C / 3), Y = Math.floor(C / 6);
  await p.fill(tid(`amt-${D}`), String(X)); await p.dispatchEvent(tid(`amt-${D}`), "change");
  const want = lo === D ? `${fmt0(X)} ${mon} ${lo} · ${fmt0(C - X)} ${mon} ${hi}` : `${fmt0(C - X)} ${mon} ${lo} · ${fmt0(X)} ${mon} ${hi}`;
  ok((await p.textContent(tid("when-calc"))).includes(want) && (await p.textContent(tid(`when-${I}`))).includes(want), `LIVE ${fmt0(X)} on the ${D}th, the rest on the ${E}th, in the panel and the list (${want})`);
  await p.fill(tid(`amt-${E}`), String(Y)); await p.dispatchEvent(tid(`amt-${E}`), "change");
  ok((await p.textContent(tid("when-calc"))).includes(`${fmt0(C - X - Y)} unscheduled`) && (await p.getAttribute(tid("when-calc"), "class")).includes("warn"), `LIVE if the dates don't cover the month it warns with the gap (${fmt0(C - X - Y)})`);
  await p.click(tid(`cal-${E}`));
  ok(await p.locator(`${tid("cal")} .d.on`).count() === 1 && await p.locator(tid("amts")).count() === 0, "clicking a selected date removes it; amount boxes go away with one date");
  await p.click(tid(`cal-${D}`));
  ok(await p.locator(`${tid("cal")} .d.on`).count() === 1, "the last date can't be removed");

  // prepaid
  const pm0 = (m0 + 11) % 12, py = m0 === 0 ? year - 1 : year;
  await p.check(tid("prepaid"));
  ok((await p.textContent(tid("cal"))).includes(`${FULL[pm0]} ${py} · pays for ${FULL[m0]}`) && (await p.textContent(tid("when-calc"))).includes(`${MON[pm0]} ${D}`) && (await p.textContent(tid(`when-${I}`))).includes(`Paid ${MON[pm0]} ${D}`), `LIVE prepaid relabels the calendar to ${FULL[pm0]} and the list reads Paid ${MON[pm0]} ${D}`);
  await p.uncheck(tid("prepaid"));

  // weekly / biweekly / each match
  const daysOn = (wd) => Array.from({ length: dim }, (_, k) => k + 1).filter(d => wdOf(d) === wd);
  await p.click(`${tid("modes")} [data-mode="weekly"]`);
  ok(await p.locator(`${tid("cal")} .d.on`).count() === daysOn(wdOf(D)).length && await p.locator(tid("prepaid")).count() === 0, `LIVE weekly highlights every ${DAYS[wdOf(D)]} (${daysOn(wdOf(D)).length} in ${mon}) and hides prepaid`);
  const F = [1, 2].find(d => wdOf(d) !== wdOf(D)), fdays = daysOn(wdOf(F));
  await p.click(tid(`cal-${F}`));
  ok((await p.textContent(tid("when-calc"))).includes(`× ${fdays.length} · ${fdays.map(d => `${mon} ${d}`).join(", ")}`) && (await p.textContent(tid(`when-${I}`))).includes(`Every ${DAYS[wdOf(F)]}`), `LIVE clicking the ${F}th in weekly sets the weekday: every ${DAYS[wdOf(F)]}`);
  await p.click(`${tid("modes")} [data-mode="biweekly"]`);
  const alt = [F, F + 14, F + 28].filter(d => d <= dim);
  ok(await p.locator(`${tid("cal")} .d.on`).count() === alt.length && (await p.textContent(tid("when-calc"))).includes(alt.map(d => `${mon} ${d}`).join(", ")), `LIVE every 2 weeks keeps alternate ${DAYS[wdOf(F)]}s (${alt.join(", ")})`);
  ok((await p.textContent(tid(`when-${I}`))).includes(`Every other ${DAYS[wdOf(F)]}`), `LIVE the list reads Every other ${DAYS[wdOf(F)]} for an every-2-weeks venue`);
  await p.click(`${tid("modes")} [data-mode="match"]`);
  ok(await p.locator(tid("cal")).count() === 0 && (await p.textContent(tid("when-calc"))).includes(`${S.lines.length} matches · $${R} each, on the match date · auto`), `LIVE each match hides the calendar: ${S.lines.length} matches · $${R} each`);
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
  const lineWd = S.lines.map(d => (new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7);
  const A = lineWd.filter(w => w <= 3).length, B = lineWd.length - A;
  ok((await p.textContent(tid("calc"))).includes(`${A} Mon–Thu × $${R} + ${B} Fri–Sun × $200`) && num(await p.getAttribute(`${tid(`row-${I}`)} td.cost`, "data-cost")) === A * R + B * 200, `LIVE ${S.name}: ${A} Mon–Thu × $${R} + ${B} Fri–Sun × $200 = ${fmt0(A * R + B * 200)}, counted from its matches table`);
  ok((await p.textContent(tid(`tag-${I}`))).includes(`$${R} Mon–Thu · $200 Fri–Sun`), "the list tag shows each rate with its days");
  await p.click('[data-testid="rate-1"] [data-delrate]');
  ok(await p.locator('[data-testid^="rate-"]').count() === 1 && num(await p.getAttribute(`${tid(`row-${I}`)} td.cost`, "data-cost")) === C, `LIVE removing the second rate gives its days back; ${fmt0(C)} again`);

  // model
  await p.selectOption(tid("model"), "share");
  ok(await p.locator(tid("rate")).count() === 0 && await p.locator(tid("override")).count() === 1 && /Partners/.test(await p.textContent(panel)), "profit share: no rate, keeps the This month box, link to Partners");
  ok(/Profit share/.test(await p.textContent(tid(`tag-${I}`))), "the list tag follows the model");
  await p.selectOption(tid("model"), "match");
}
}

// other rows
if (!LIVE) {
ok(/\$500 Oct 1 · \$1,320 Oct 15/.test(await p.textContent(tid("when-1"))), "ATH Katy row shows its two dates: $500 then the rest");
ok(/\$0 Mon–Thu · \$140 Fri–Sun/.test(await p.textContent(tid("tag-1"))) && /4 Mon–Thu × \$0 \+ 13 Fri–Sun × \$140/.test(await p.textContent(`${tid("row-1")} td.cost`)) && num(await p.getAttribute(`${tid("row-1")} td.cost`, "data-cost")) === 1820, "ATH Katy: Mon–Thu free, Fri–Sun $140, 13 matches = $1,820");
ok(/Paid Sep 10/.test(await p.textContent(tid("when-3"))), "Bob Jones Park row reads Paid Sep 10");
ok(/Every other Friday/.test(await p.textContent(tid("when-7"))), "NEMP row reads Every other Friday");
ok(/Profit share/.test(await p.textContent(tid("tag-6"))) && /set by hand · computed \$630/.test(await p.textContent(`${tid("row-6")} td.cost`)) && num(await p.getAttribute(`${tid("row-6")} td.cost`, "data-cost")) === 4334.4, "PARMER: profit share with a hand-set invoice total, payout shown underneath");
await p.click(tid("row-7"));
ok(await p.locator(`${tid("panel-7")} .g .l`).filter({ hasText: "Fields" }).count() === 1 && await p.locator(`${tid("panel-7")} [data-field]`).count() === 2 && !(await p.isChecked(`${tid("panel-7")} [data-field="1"]`)), "a venue with two fields shows the Fields row; NEMP's tournament field is unchecked");
ok(await p.locator(tid("panel-0")).count() === 0, "opening one venue closes the other");
} else {
  const names = await rowNames();
  const mon = await monthKey(), m0 = MON.indexOf(mon), prev = MON[(m0 + 11) % 12], year = 2026;
  const monthKeyFull = `${mon} ${year}`;
  mockOnly("ATH Katy row shows its two dates: $500 then the rest", "LIVE <amount> on the <D>th, the rest on the <E>th, in the panel and the list");

  // LIVE: every venue with day-of-week rates shows each rate with its days in the tag.
  const multi = names.map(n => ({ n, v: venueOfRow(n) })).filter(x => Array.isArray(x.v?.rate_days) && x.v.rate_days.length > 1);
  ok(multi.length >= 1, `LIVE positive control: at least one venue has day-of-week rates (${multi.map(x => x.n.name).join(", ")})`);
  for (const x of multi) {
    const tag = await p.textContent(tid(`tag-${x.n.i}`));
    ok(x.v.rate_days.every(r => tag.includes(`$${r.v}`)), `LIVE ${x.n.name}: the tag shows each of its rates (${tag.trim()})`);
  }
  mockOnly("ATH Katy: Mon–Thu free, Fri–Sun $140, 13 matches = $1,820", "LIVE <A> Mon–Thu × $<rate> + <B> Fri–Sun × $200, the tag checks and the Rate-column checks");

  // LIVE: every prepaid venue's list cell reads "Paid <previous month> <its date>".
  const prepaid = names.map(n => ({ n, v: venueOfRow(n) })).filter(x => x.v?.pay_schedule?.mode === "dates" && x.v.pay_schedule.prepaid === true);
  ok(prepaid.length >= 1, `LIVE positive control: at least one prepaid venue (${prepaid.map(x => x.n.name).join(", ")})`);
  for (const x of prepaid) {
    const d = x.v.pay_schedule.dates[0]?.d;
    ok(new RegExp(`Paid ${prev} ${d}(?!\\d)`).test(await p.textContent(tid(`when-${x.n.i}`))), `LIVE ${x.n.name} (prepaid) reads Paid ${prev} ${d}`);
  }

  mockOnly("NEMP row reads Every other Friday", "LIVE the list reads Every other <day> for an every-2-weeks venue");

  // LIVE: every profit-share row with an amount set for the month shows that amount, flagged, with the payout underneath.
  const ovFor = (vid) => [...loaded.fin_venue_cost_overrides.values()].find(o => o.venue_id === vid && o.month === monthKeyFull);
  const shareSet = [];
  for (const n of names) { const v = venueOfRow(n); const o = v && ovFor(v.id); if (o && /Profit share/.test(await p.textContent(tid(`tag-${n.i}`)))) shareSet.push({ n, o }); }
  ok(shareSet.length >= 1, `LIVE positive control: at least one profit-share venue has an amount set for ${monthKeyFull} (${shareSet.map(x => x.n.name).join(", ")})`);
  for (const x of shareSet) {
    const cell = `${tid(`row-${x.n.i}`)} td.cost`;
    ok(/set by hand · computed \$[\d,]+/.test(await p.textContent(cell)) && Math.abs(num(await p.getAttribute(cell, "data-cost")) - Number(x.o.override_amount)) < 0.005, `LIVE ${x.n.name}: profit share with a hand-set total ($${x.o.override_amount}), payout shown underneath`);
  }

  // LIVE: a venue with two or more linked fields shows the Fields row, one box per field, ticked
  // exactly where fin_venue_fields says the field is counted.
  const linksOf = (vid) => [...loaded.fin_venue_fields.values()].filter(l => l.fin_venue_id === vid);
  const multiField = names.map(n => ({ n, v: venueOfRow(n) })).find(x => x.v && x.n.i !== SUBJ && linksOf(x.v.id).length >= 2);
  ok(!!multiField, `LIVE positive control: a venue with two or more fields (${multiField?.n.name ?? "none"})`);
  if (multiField) {
    const links = linksOf(multiField.v.id), i = multiField.n.i;
    await openRow(SUBJ); await openRow(i);
    const boxes = p.locator(`${tid(`panel-${i}`)} [data-field]`);
    const checked = await boxes.evaluateAll(es => es.filter(e => e.checked).length);
    ok(await p.locator(`${tid(`panel-${i}`)} .g .l`).filter({ hasText: "Fields" }).count() === 1 && await boxes.count() === links.length && checked === links.filter(l => !l.excluded_from_venue).length,
       `LIVE ${multiField.n.name}: the Fields row has ${links.length} boxes, ${links.filter(l => !l.excluded_from_venue).length} ticked, as fin_venue_fields says`);
    ok(await p.locator(tid(`panel-${SUBJ}`)).count() === 0, "opening one venue closes the other");
    await closeRow(i);
  }

  // LIVE, THE RATE COLUMN: every per-match venue's underlying matches show the rate CHARGED for that
  // match (its weekday's rate), and rate-or-$0-same-slot summed over the rows shown equals the
  // computed figure. Subjects and expected rates come from fin_venues.rate_days.
  const rateFor = (v, ymd) => { const wd = (new Date(ymd + "T00:00:00Z").getUTCDay() + 6) % 7; const r = (v.rate_days ?? []).find(x => x.days.includes(wd)); return r ? r.v : (v.per_match_rate ?? 0); };
  let tables = 0, sundays = 0;
  for (const n of names) {
    if (!/Per match/.test(await p.textContent(tid(`tag-${n.i}`)))) continue;
    await openRow(n.i);
    const panel = tid(`panel-${n.i}`);
    if (await p.locator(`${panel} ${tid("match-lines")}`).count() === 1) {
      tables++;
      const v = venueOfRow(n);
      const lines = await p.$$eval(`${panel} ${tid("match-lines")} tbody tr`, rs => rs.map(r => ({ date: r.dataset.date, rate: +r.dataset.rate, cost: +r.dataset.cost })));
      const total = num(await p.getAttribute(`${panel} ${tid("match-lines-total")}`, "data-total"));
      const computed = num(await p.getAttribute(`${panel} ${tid("override")}`, "placeholder"));
      const sum = Math.round(lines.reduce((a, l) => a + l.cost, 0) * 100) / 100;
      ok(Math.abs(sum - total) < 0.005 && Math.abs(total - computed) < 0.005, `LIVE ${n.name}: ${lines.length} rows add to $${sum}, the computed $${computed}`);
      if (v && Array.isArray(v.rate_days) && v.rate_days.length > 1) {
        const wrong = lines.filter(l => l.rate !== rateFor(v, l.date));
        sundays += lines.filter(l => new Date(l.date + "T00:00:00Z").getUTCDay() === 0).length;
        ok(wrong.length === 0, `LIVE ${n.name}: every row shows its weekday's rate${wrong.length ? " — wrong: " + wrong.map(l => `${l.date} $${l.rate}`).join(", ") : ""}`);
      }
    }
    await closeRow(n.i);
  }
  ok(tables >= 1, `LIVE positive control: ${tables} per-match venues have an underlying-matches table`);
  console.log(`INFO  weekday-rate rows checked that fall on a Sunday this month: ${sundays}`);

  // LIVE, RATES DIFFER: every flag names a leg (the row's own venue, or "(leg name)" for another leg of
  // a combined row) whose cost per match and invoice rate, both on file, really differ — with both
  // numbers. And a row whose OWN venue's rates differ carries its unnamed flag. Profit share exempt.
  let flagged = 0, quiet = 0;
  const differs = (v) => v && v.billing_type === "per_match" && v.cost_per_match != null && v.per_match_rate != null && Math.abs(v.cost_per_match - v.per_match_rate) >= 0.005;
  const m0$ = (n) => `$${Math.round(n).toLocaleString("en-US")}`;
  for (const n of names) {
    const v = venueOfRow(n);
    if (!v) continue;
    const share = /Profit share/.test(await p.textContent(tid(`tag-${n.i}`)));
    const texts = await p.$$eval(`[data-testid="rates-differ-${n.i}"]`, es => es.map(e => e.textContent.trim()));
    if (share) { ok(texts.length === 0, `LIVE ${n.name} (profit share) carries no "rates differ" flag`); continue; }
    if (!texts.length) { if (differs(v)) ok(false, `LIVE ${n.name}: cost $${v.cost_per_match} vs invoice $${v.per_match_rate} but no flag`); else quiet++; continue; }
    for (const t of texts) {
      const leg = /^rates differ \((.+?)\)/.exec(t)?.[1];
      const lv = leg ? [...loaded.fin_venues.values()].find(x => x.venue_name === leg && (x.city ?? "") === n.city) : v;
      flagged++;
      ok(differs(lv) && t.includes(`cost ${m0$(lv.cost_per_match)}`) && t.includes(`invoice ${m0$(lv.per_match_rate)}`), `LIVE ${n.name}${leg ? ` (leg ${leg})` : ""}: "${t}" matches fin_venues (cost $${lv?.cost_per_match}, invoice $${lv?.per_match_rate})`);
    }
    if (differs(v)) ok(texts.some(t => !/^rates differ \(/.test(t)), `LIVE ${n.name}: its own rates differ, and the unnamed flag is there`);
  }
  ok(flagged >= 1 && quiet >= 1, `LIVE positive and negative control: ${flagged} flag(s) checked, ${quiet} venue(s) correctly quiet`);

  // LIVE, SHOW INACTIVE: the footer reads the same with inactive venues hidden and shown.
  const foot = async () => [await p.textContent(tid("total-matches")), await p.getAttribute(tid("total-cost"), "data-total")].join(" | ");
  const label = await p.textContent(`label:has(${tid("show-inactive")})`);
  const hiddenN = Number((/\((\d+)\)/.exec(label) || [])[1]);
  const before = { foot: await foot(), rows: names.length };
  await p.check(tid("show-inactive"));
  const after = { foot: await foot(), rows: await p.locator('[data-testid^="row-"]').count(), dim: await p.locator('[data-testid^="row-"][data-inactive]').count() };
  ok(after.rows === before.rows + hiddenN && after.dim === hiddenN, `LIVE "Show inactive (${hiddenN})" adds exactly ${hiddenN} rows, each marked inactive (${before.rows} → ${after.rows})`);
  ok(after.foot === before.foot, `LIVE the month total is identical with inactive venues hidden and shown (${before.foot})`);
  await p.uncheck(tid("show-inactive"));
}

ok(errs.length === 0, `no page errors (${errs.join("; ")})`);
if (LIVE) console.log(`\nwrites blocked (never sent): ${blocked.length}${blocked.length ? " — " + [...new Set(blocked)].join(", ") : ""}`);
await b.close(); console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped (mock-only)` : ""}`); process.exit(fail ? 1 : 0);
