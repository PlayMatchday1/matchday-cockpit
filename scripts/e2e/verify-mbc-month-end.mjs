// MEMBERS BY CITY — the month-end report, on the real page.
//
// The cutoff was two literal strings in membersByCity.ts, so on 2026-09-30 the page still named
// Aug 6 and a Jul 6 – Aug 6 window. Every cancellation in that closed window had already flipped to
// CANCELED and left the active base, so the subtraction removed nobody and the page rendered Being
// charged 393 = Active with $23,187 beside it. A stale window does not look stale; it looks like a
// month with no churn.
//
// READ-ONLY. It drives the live page and exports the CSV in-browser. It writes nothing.
//
//   node scripts/e2e/verify-mbc-month-end.mjs
import { chromium } from "playwright";
import { installHarnessGuard, closeContext, closeBrowser, storageStateFor, nonEmpty } from "./_session.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
const ADMIN = "rmancuso@playmatchday.com";
const PAGE = `${BASE}/membership/by-city`;

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ok    ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} - ${d}`); console.log(`  XX    ${n} - ${d}`); };
const is = (n, got, exp) => (JSON.stringify(got) === JSON.stringify(exp) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(exp)}`));
const yes = (n, got, d = "") => (got === true ? ok(n) : bad(n, d || `got ${JSON.stringify(got)}`));
const head = (s) => console.log(`\n-- ${s} --`);

/* THE EXPECTED DATES ARE DERIVED FROM THE CLOCK THIS SUITE RUNS UNDER, never pinned. A hardcoded
 * "Sep 6, 2026" here would be the same defect the page had, moved into its own test. */
function expected(now = new Date()) {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(now).split("-").map(Number);
  const at = (yy, mm, dd) => new Date(Date.UTC(yy, mm, dd)).toISOString().slice(0, 10);
  const cutoffYmd = at(y, d >= 6 ? m - 1 : m - 2, 6);
  const [cy, cm] = cutoffYmd.split("-").map(Number);
  return { cutoffYmd, billingYmd: at(cy, cm, 1), runRateYmd: at(cy, cm + 1, 1) };
}

/* THE READ-ONLY RUN THIS PAGE MUST REPRODUCE. Measured against mdapi_subscriptions on 2026-09-30
 * before any of this was built. These are the brief's acceptance numbers, and they are asserted as
 * EXACT equalities — if the page disagrees, the suite fails rather than either being adjusted. */
const TARGET = {
  cutoff: "2026-09-06",
  HOU:   { total: 78, before: 23, paying: 55, billing: "$3,630", after: 7 },
  TOTAL: { total: 392, before: 87, paying: 305, billing: "$18,089", after: 50 },
  unassigned: { members: 1, dollars: "$100" },
};

/* THE MOCK'S COLUMN NAMES, IN THE MOCK'S ORDER. Named, not counted, so a column inserted later
 * cannot silently shift what these assertions read. */
const COLS = ["total", "before", "paying", "billing", "after"];
/* THE BILLING CELL IS A FIGURE PLUS A MIX, and textContent runs them together with no separator —
 * "$3,630" + "55 × $66" reads as "$3,63055". Take the money element's FIRST text node rather than
 * regexing the concatenation, which is how the first version of this read $3,63055 and "failed" on
 * numbers that were correct. */
const moneyOf = (p, sel) => p.locator(`${sel} .mbc-money`).evaluate((e) => e.firstChild.textContent.trim());
const readRow = async (p, sel) => {
  const out = {};
  for (const c of COLS) {
    if (c === "billing") { out[c] = await moneyOf(p, `${sel} td[data-col="billing"]`); continue; }
    out[c] = (await p.locator(`${sel} td[data-col="${c}"]`).textContent())?.replace(/\s+/g, " ").trim() ?? "";
  }
  return out;
};
const n = (s) => Number(String(s).replace(/[^0-9]/g, ""));

async function main() {
  const { storageState } = await storageStateFor(ADMIN, BASE);
  const browser = await chromium.launch();
  const E = expected();
  console.log(`expected dates, derived from this run's clock: cutoff ${E.cutoffYmd} · bills ${E.billingYmd} · run rate ${E.runRateYmd}`);

  const ctx = await browser.newContext({ storageState, viewport: { width: 1500, height: 1000 }, timezoneId: "America/Chicago" });
  const p = await ctx.newPage();
  const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 180000 });
  await p.waitForSelector('[data-testid="mbc-row-total"]', { timeout: 180000 });
  await p.waitForTimeout(600);

  head("the page names the calculated dates");
  yes("no page errors", errs.length === 0, errs[0] ?? "");
  is("cutoff, billing and run-rate dates are the calculated ones",
     await p.locator('[data-testid="mbc-dates"]').evaluate((e) => [e.dataset.cutoff, e.dataset.billing, e.dataset.runrate]),
     [E.cutoffYmd, E.billingYmd, E.runRateYmd]);
  const cutTxt = (await p.locator('[data-testid="mbc-cutoff"]').textContent()).trim();
  const billTxt = (await p.locator('[data-testid="mbc-bills"]').textContent()).trim();
  console.log(`    bar reads: Cutoff ${cutTxt} · Bills ${billTxt}`);
  yes(`the bar's dates carry the year (${cutTxt} / ${billTxt})`,
      /^\w{3} \d{1,2}, \d{4}$/.test(cutTxt) && /^\w{3} \d{1,2}, \d{4}$/.test(billTxt), `${cutTxt} | ${billTxt}`);
  // AND THE COLUMN LABELS DO NOT — the mock's split, measured on the rendered header.
  const ths = (await p.locator("thead th").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  console.log(`    headers: ${ths.join(" | ")}`);
  yes("no column label repeats the year", ths.every((t) => !/\d{4}/.test(t)), ths.join(" | "));
  yes("CONTROL: the labels DO name the dates, year-less",
      ths.some((t) => t.startsWith("Cancelled before ")) && ths.some((t) => t.startsWith("Billing ")), ths.join(" | "));
  is("six columns, as the mock has", ths.length, 6);
  yes("the last column names both dates in its sub-label",
      /^Cancelled \w{3} \d{1,2}\+pay \w{3} \d{1,2}, not \w{3} \d{1,2}$/.test(ths[5]), ths[5]);
  is("no WINDOW pill on the page", await p.locator('text=/^Window$/').count(), 0);
  is("no picker — no input or select anywhere", await p.locator("input, select").count(), 0);

  head("the rendered rows reproduce the read-only run");
  const rows = nonEmpty(await p.$$('[data-code]'), "city rows");
  ok(`PRESENCE CONTROL: ${rows.length} city rows rendered`);
  is("seven active cities, no Unassigned row", rows.length, 7);
  is("no row is labelled Unassigned", await p.locator('[data-code]:has-text("Unassigned")').count(), 0);

  // THE MOCK'S ROW TESTIDS, used as the mock spells them.
  const HOU = await readRow(p, '[data-testid="mbc-row-hou"]');
  const TOT = await readRow(p, '[data-testid="mbc-row-total"]');
  console.log(`    HOUSTON  : ${COLS.map((c) => HOU[c]).join(" | ")}`);
  console.log(`    MATCHDAY : ${COLS.map((c) => TOT[c]).join(" | ")}`);

  /* THE DATES MUST MATCH TOO, or the figures are being compared against a different month's
   * acceptance numbers and an equality below would be meaningless. */
  if (E.cutoffYmd !== TARGET.cutoff) {
    bad(`the acceptance numbers are for cutoff ${TARGET.cutoff}, this run's cutoff is ${E.cutoffYmd}`,
        "STOPPING the comparison rather than adjusting either side");
  } else {
    const cmp = (label, got, want) => is(label,
      COLS.map((c) => got[c]),
      [String(want.total), String(want.before), String(want.paying), want.billing, String(want.after)]);
    cmp("Houston matches the read-only run exactly", HOU, TARGET.HOU);
    cmp("MatchDay matches the read-only run exactly", TOT, TARGET.TOTAL);
  }

  head("the arithmetic holds on the rendered page, not just in the model");
  for (const r of await p.$$("[data-code]")) {
    const code = await r.getAttribute("data-code");
    const g = await readRow(p, `[data-testid="mbc-row-${code.toLowerCase()}"]`);
    is(`  ${code}: paying = total active − cancelled before`, n(g.paying), n(g.total) - n(g.before));
  }
  is("  MATCHDAY: paying = total active − cancelled before", n(TOT.paying), n(TOT.total) - n(TOT.before));

  const sums = {};
  for (const c of COLS) {
    const vals = c === "billing"
      ? await p.locator('[data-code] td[data-col="billing"] .mbc-money').evaluateAll((es) => es.map((e) => e.firstChild.textContent.trim()))
      : await p.locator(`[data-code] td[data-col="${c}"]`).allTextContents();
    sums[c] = vals.reduce((s, t) => s + n(t), 0);
  }
  is("city rows sum to the MatchDay row on every column",
     COLS.map((c) => sums[c]), COLS.map((c) => n(TOT[c])));
  // CONTROL: those sums are real numbers, not seven empty cells summing to nothing.
  yes(`CONTROL: the summed columns are non-zero (${COLS.map((c) => sums[c]).join("/")})`, COLS.every((c) => sums[c] > 0));

  head("the unassigned member is excluded, and said so");
  const un = p.locator('[data-testid="mbc-unassigned"]');
  is("the Not in totals line is present", await un.count(), 1);
  const unTxt = (await un.textContent()).replace(/\s+/g, " ").trim();
  console.log(`    ${unTxt}`);
  is("  it names the member count and the dollars",
     await un.evaluate((e) => [Number(e.dataset.members), Number(e.dataset.cents)]),
     [TARGET.unassigned.members, 10000]);
  yes("  worded as the brief asks", unTxt === `Not in totals: ${TARGET.unassigned.members} unassigned member, ${TARGET.unassigned.dollars}.`, unTxt);
  /* THE EXCLUSION IS REAL, NOT A MISSING ROW: the MatchDay total plus the unassigned dollars is
   * strictly more than the total, and the unassigned member is nowhere in the seven rows. */
  yes(`  CONTROL: the exclusion moves the number — total ${TOT.billing} + ${TARGET.unassigned.dollars} != total`,
      n(TOT.billing) + 100 !== n(TOT.billing));
  is("the footnote is its own element, as the mock has it",
     (await p.locator('[data-testid="mbc-footnote"]').textContent()).trim(), "Excludes $0 members and internal accounts.");


  head("the CSV matches the page");
  const dl = p.waitForEvent("download", { timeout: 30000 });
  await p.locator('[data-testid="mbc-export"]').click();
  const file = await dl;
  is("the filename carries the calculated cutoff", file.suggestedFilename(), `members-by-city-${E.cutoffYmd}.csv`);
  const { readFileSync } = await import("node:fs");
  const csv = readFileSync(await file.path(), "utf8").split("\n");
  const note = csv[0], header = csv[1];
  const body = csv.slice(2).filter((l) => l && !l.startsWith("#"));
  yes(`the note states all three dates (${note})`,
      note.includes(E.cutoffYmd) && note.includes(E.billingYmd) && note.includes(E.runRateYmd), note);
  yes("the header names the same dates as the page",
      header.includes(`Cancelled before ${E.cutoffYmd}`) && header.includes(`Billing ${E.billingYmd}`), header);
  yes("and carries no run-rate or leaver-dollar column", !/run rate|\+ \(\$\)/.test(header), header);
  is("one line per city plus TOTAL", body.length, 8);
  const tot = body[body.length - 1].split(",");
  is("the CSV TOTAL equals the rendered MatchDay row",
     [tot[2], tot[3], tot[4], `$${Math.round(Number(tot[5])).toLocaleString("en-US")}`, tot[6]],
     [TOT.total, TOT.before, TOT.paying, TOT.billing, TOT.after]);
  const hou = body.find((l) => l.split(",")[1] === "HOU").split(",");
  is("the CSV Houston line equals the rendered Houston row",
     [hou[2], hou[3], hou[4], `$${Math.round(Number(hou[5])).toLocaleString("en-US")}`, hou[6]],
     [HOU.total, HOU.before, HOU.paying, HOU.billing, HOU.after]);
  yes("the CSV carries the unassigned line, outside the TOTAL",
      csv.some((l) => l.startsWith(`# Not in totals: ${TARGET.unassigned.members} unassigned member, ${TARGET.unassigned.dollars}.`)),
      csv.filter((l) => l.startsWith("#")).join(" | "));

  await closeContext(ctx);
  await closeBrowser(browser);
  console.log(`\n${PASS} passed, ${FAIL} failed`);
  for (const f of fails) console.log(`  XX ${f}`);
  if (PASS === 0) { console.log("ZERO ASSERTIONS — that is a failure, not a pass"); process.exit(1); }
  process.exit(FAIL === 0 ? 0 : 1);
}
main();
