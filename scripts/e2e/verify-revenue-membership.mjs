// REVENUE BREAKDOWN — membership at FIELD grain, and the month qualifier said once.
//
// TWO CHANGES. (1) The Field view's Membership revenue and Member mix columns were "—" on every
// row; they now carry the allocation that already existed. (2) Four headers carried "(in month)";
// that fact is stated once above the table instead.
//
// NOTHING HERE IS PINNED TO A LIVE FIGURE. The reconciliation reads BOTH numbers off the running
// app — the Revenue Field view's total row and the Cities page's own revenue split — and compares
// them to each other. A pinned $7,749 would go stale the next time anyone books a match, and would
// then be "fixed" by copying whatever the page said, which records the bug instead of catching it.

import { chromium } from "playwright";
import { installHarnessGuard, fatal, closeContext, closeBrowser, storageStateFor } from "./_session.mjs";

installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
const ADMIN = "rmancuso@playmatchday.com";

let passed = 0;
const failures = [];
const ok = (n) => { passed += 1; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const atLeast = (n, got, min) => (got >= min ? ok(`${n} (${got} ≥ ${min})`) : bad(n, `got ${got}, want ≥ ${min}`));

const money = (t) => {
  const s = String(t ?? "").trim();
  if (s === "—" || s === "") return null;
  const n = Number(s.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

async function main() {
  const browser = await chromium.launch();
  const { storageState } = await storageStateFor(ADMIN, BASE);
  const ctx = await browser.newContext({ storageState, viewport: { width: 1600, height: 1200 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  // ---- Revenue, Field view ------------------------------------------------------------------
  await page.goto(`${BASE}/admin/finance/revenue`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!document.querySelector('[data-testid="revenue-group-table"]'), null, { timeout: 240000 });
  for (const b of await page.$$("button")) { if ((await b.innerText()).trim() === "Field") { await b.click(); break; } }
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="revenue-group-row"]').length > 0, null, { timeout: 120000 });

  const readRows = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="revenue-group-row"]')].map((tr) => ({
    label: tr.getAttribute("data-label"),
    launched: tr.querySelector('[data-testid="gt-launched"]')?.textContent.trim() ?? null,
    total: tr.querySelector('[data-testid="gt-total"]')?.textContent.trim() ?? null,
    dpp: tr.querySelector('[data-testid="gt-dpp"]')?.textContent.trim() ?? null,
    member: tr.querySelector('[data-testid="gt-member"]')?.textContent.trim() ?? null,
    mix: tr.querySelector('[data-testid="gt-mix"]')?.textContent.trim() ?? null,
  })));

  console.log("\n── the Field view carries membership at all");
  const rows = await readRows();
  atLeast("field rows render", rows.length, 1);
  const withMember = rows.filter((r) => money(r.member) != null && money(r.member) > 0);
  // Expects >= 1: the defect this fixes rendered "—" on EVERY row, which yields 0 here.
  atLeast("at least one field carries NON-ZERO membership", withMember.length, 1);
  atLeast("…and a member mix beside it", rows.filter((r) => /%/.test(r.mix ?? "")).length, 1);

  // ---- null is not zero ---------------------------------------------------------------------
  console.log("\n── a field with no member spots renders —, never $0");
  const dashed = rows.filter((r) => r.member === "—");
  // POSITIVE CONTROL for the zero-valued assertion below: dashes are proven present first, so
  // "no $0 anywhere" is not passing on a table that failed to render.
  atLeast("control: some field DOES render — for membership", dashed.length, 1);
  eq("no membership cell prints $0", rows.filter((r) => /^\$0(\.00)?$/.test(r.member ?? "")), []);
  eq("…and every dashed membership has a dashed mix", dashed.filter((r) => r.mix !== "—"), []);

  // ---- the mix formula, from each row's own printed cells ------------------------------------
  console.log("\n── member mix = membership ÷ total, checked on every row");
  const mixOff = [];
  for (const r of rows) {
    const m = money(r.member), t = money(r.total), shown = r.mix;
    if (m == null) continue;
    if (t == null || t <= 0) continue;
    const want = (m / t) * 100;
    /* THE TOLERANCE IS DERIVED FROM THE ROW, NOT PICKED. The cell prints dollars, so m and t are
     * each ±$0.50 of the values the page divided; the percentage that follows can move by
     * (0.5/t + 0.5·m/t²)·100. On a $26,203 row that is 0.003pp; on an $83 row it is 0.8pp. A single
     * constant would either pass a wrong formula on the big rows or fail a correct one on the small
     * ones — which is what a flat 0.1 did here first time out.
     * IT STILL HAS TEETH: membership ÷ DPP on that $337 row reads 56%, not 36%. */
    const tol = ((0.5 / t) + (0.5 * m) / (t * t)) * 100 + 0.05;
    const d = Math.abs(parseFloat(shown) - want);
    if (!(d <= tol)) mixOff.push({ label: r.label, shown, want: want.toFixed(2), tol: tol.toFixed(2), member: r.member, total: r.total });
  }
  const checked = rows.filter((r) => money(r.member) != null && (money(r.total) ?? 0) > 0).length;
  atLeast("control: rows actually checked", checked, 1);
  eq("every row's mix equals membership ÷ total", mixOff, []);
  /* AND IS NOT THE OTHER DEFINITION. membership ÷ DPP is the ratio someone reaches for when
   * "mix" is not written down; on every row where the two differ by more than a point, the printed
   * value must be the share-of-total one. This is what stops the tolerance above from quietly
   * accepting the wrong formula on a row where the two happen to be close. */
  const wrongDef = [];
  for (const r of rows) {
    const m = money(r.member), t = money(r.total), d = money(r.dpp);
    if (m == null || t == null || d == null || t <= 0 || d <= 0) continue;
    const share = (m / t) * 100, ratio = (m / d) * 100;
    if (Math.abs(share - ratio) < 1) continue;              // indistinguishable here — proves nothing
    if (Math.abs(parseFloat(r.mix) - ratio) < Math.abs(parseFloat(r.mix) - share)) {
      wrongDef.push({ label: r.label, shown: r.mix, share: share.toFixed(1), overDpp: ratio.toFixed(1) });
    }
  }
  atLeast("control: rows where the two definitions are distinguishable", 
    rows.filter((r) => {
      const m = money(r.member), t = money(r.total), d = money(r.dpp);
      return m != null && t && d && Math.abs((m / t) * 100 - (m / d) * 100) >= 1;
    }).length, 1);
  eq("…and no row is membership ÷ DPP instead", wrongDef, []);

  // ---- the month qualifier, once -------------------------------------------------------------
  console.log("\n── the month qualifier");
  const qual = await page.evaluate(() => {
    const body = document.body.innerText;
    return {
      inMonth: (body.match(/\(in month\)/g) ?? []).length,
      note: (body.match(/Figures are for the selected month/g) ?? []).length,
      noteText: document.querySelector('[data-testid="breakdown-scope"]')?.textContent.trim() ?? null,
      headers: [...document.querySelectorAll('[data-testid="revenue-group-table"] thead th')].map((th) => th.textContent.trim()),
    };
  });
  eq("no header still carries \"(in month)\"", qual.inMonth, 0);
  eq("the qualifier is stated exactly once", qual.note, 1);
  eq("…and names LAUNCHED as the exception on Field view",
    /except Launched/.test(qual.noteText ?? ""), true);
  // POSITIVE CONTROL: the header row is proven non-empty before asserting anything about its text.
  atLeast("control: headers read", qual.headers.length, 8);
  eq("LAUNCHED carries no month qualifier of its own",
    qual.headers.filter((h) => /^Launched/.test(h)), ["Launched"]);
  /* The Total revenue header carries the not-matched popover's ⓘ button inside the <th>, so its
   * textContent is "Total revenueⓘ". Stripped rather than special-cased: the assertion is about
   * the WORDS, and the popover is a control that has always been there. */
  eq("the five figure headers read exactly as intended",
    qual.headers.filter((h) => /revenue|Member mix/i.test(h)).map((h) => h.replace(/[^\x20-\x7E]/g, "").trim()),
    ["Total revenue", "Avg revenue / match", "DPP revenue", "Membership revenue", "Member mix"]);

  // ---- alignment: computed, not class --------------------------------------------------------
  console.log("\n── header and value alignment agree");
  const align = await page.evaluate(() => {
    const tbl = document.querySelector('[data-testid="revenue-group-table"]');
    const ths = [...tbl.querySelectorAll("thead th")];
    const firstRow = tbl.querySelector('[data-testid="revenue-group-row"]');
    const tds = [...firstRow.querySelectorAll("td")];
    const out = [];
    for (let i = 0; i < Math.min(ths.length, tds.length); i++) {
      out.push({ i, header: ths[i].textContent.trim().slice(0, 24),
        th: getComputedStyle(ths[i]).textAlign, td: getComputedStyle(tds[i]).textAlign });
    }
    return out;
  });
  atLeast("control: columns measured", align.length, 8);
  eq("every column's header and value share a computed text-align",
    align.filter((c) => c.th !== c.td), []);
  const numeric = align.filter((c) => /revenue|mix|Matches/i.test(c.header));
  atLeast("control: numeric columns identified", numeric.length, 4);
  eq("…and the numeric columns are right-aligned, not centred",
    numeric.filter((c) => c.td !== "right"), []);

  // ---- THE RECONCILIATION: both figures derived, neither pinned -------------------------------
  console.log("\n── Field view membership vs the Cities page, city by city");
  const chips = [];
  for (const c of await page.$$('[data-testid="city-chip"]')) {
    const n = await c.getAttribute("data-city");
    if (n && n !== "all") chips.push(n);
  }
  atLeast("control: city chips found", chips.length, 1);
  const fieldTotals = {};
  for (const n of chips) {
    await (await page.$(`[data-testid="city-chip"][data-city="${n}"]`)).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="revenue-group-row"]').length > 0, null, { timeout: 60000 });
    await page.waitForTimeout(400);
    fieldTotals[n] = money(await page.evaluate(() => document.querySelector('[data-testid="gt-tot-member"]')?.textContent.trim()));
  }

  const cities = await ctx.newPage();
  await cities.goto(`${BASE}/admin/finance/cities`, { waitUntil: "domcontentloaded" });
  await cities.waitForFunction(() => document.querySelectorAll("tbody tr").length > 2, null, { timeout: 240000 });
  await cities.waitForTimeout(800);
  const cityTotals = {};
  for (const n of chips) {
    for (const r of await cities.$$("tbody tr")) {
      const t = (await r.innerText()).split("\n")[0].replace(/[^\w .]/g, "").trim();
      if (t === n) { await r.click(); break; }
    }
    await cities.waitForTimeout(500);
    const txt = await cities.evaluate(() => document.body.innerText);
    const m = txt.match(/\+ Member rev \$([\d,]+)/);
    cityTotals[n] = m ? Number(m[1].replace(/,/g, "")) : null;
    for (const r of await cities.$$("tbody tr")) {
      const t = (await r.innerText()).split("\n")[0].replace(/[^\w .]/g, "").trim();
      if (t === n) { await r.click(); break; }
    }
    await cities.waitForTimeout(250);
  }

  const withMembers = chips.filter((n) => (cityTotals[n] ?? 0) > 0);
  atLeast("control: cities with member revenue on the Cities page", withMembers.length, 1);
  const gaps = withMembers.filter((n) => Math.abs((fieldTotals[n] ?? -1) - cityTotals[n]) > 1)
    .map((n) => ({ city: n, field: fieldTotals[n], cities: cityTotals[n] }));
  eq("every city's field membership equals the Cities page figure", gaps, []);
  for (const n of withMembers) console.log(`     ${n}: field $${fieldTotals[n]} = cities $${cityTotals[n]}`);
  await closeContext(cities);

  eq("no page errors", pageErrors, []);
  await closeContext(ctx);
  await closeBrowser(browser);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log(`  ✗ ${f}`)); process.exit(1); }
  if (passed === 0) { console.log("ZERO ASSERTIONS — that is a failure, not a pass"); process.exit(1); }
}

main().catch(fatal);
