// A PARTIAL MONTH IS NOT A COLLAPSE — the same rule weekly already obeys, on the monthly bucket.
//
// Monthly treated EVERY bucket as complete. It did not bite on arrival because the period bar's
// quick pills already end on the last COMPLETE month — so this suite does the one thing that
// exposes it: PICKS A CUSTOM RANGE ENDING INSIDE THE CURRENT MONTH, which is what an operator does
// when they want to see how this month is going.
//
// AND IT CHECKS THE EXPORT. When the weekly fix landed, the screen was corrected and the CSV kept
// shipping the old number. The file is downloaded, parsed, and compared against the screen.
//
// READ ONLY. Every request is a GET.
//
//   node scripts/e2e/verify-behavior-monthly-partial.mjs
import { chromium } from "playwright";
import { installHarnessGuard, fatal, closeContext, closeBrowser, storageStateFor } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";
const ADMIN = "rmancuso@playmatchday.com";
const PAGE = `${BASE}/lifecycle/behavior`;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  XX  ${n} — ${d}`); };
const is = (n, got, exp) => (JSON.stringify(got) === JSON.stringify(exp) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(exp)}`));
const yes = (n, got, d = "") => (got === true ? ok(n) : bad(n, d || `got ${JSON.stringify(got)}`));
const near = (n, got, exp, tol = 0.15) =>
  (Math.abs(got - exp) <= tol ? ok(`${n} (${got})`) : bad(n, `got ${got} want ~${exp}`));

/* TODAY IN AMERICA/CHICAGO — the clock the buckets are cut in. Derived, never pinned: a suite that
 * hardcoded "September" would go green in September and red in October for no reason, which is
 * exactly how verify-pace-readout dated itself. */
const todayChi = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
const CUR_Y = Number(todayChi.slice(0, 4));
const CUR_M = Number(todayChi.slice(5, 7));          // 1-12
const CUR_LABEL = `${MON[CUR_M - 1]} ${CUR_Y}`;
// Six months back, so the range holds several complete months plus the partial current one.
const startIdx = CUR_Y * 12 + (CUR_M - 1) - 5;
const START_Y = Math.floor(startIdx / 12), START_M = (startIdx % 12) + 1;

const READ = () => {
  const heads = [...document.querySelectorAll('[data-testid="behavior-col-head"]')];
  const rows = [...document.querySelectorAll("#growthSummaryBody tr")];
  return {
    heads: heads.map((h) => ({
      text: h.childNodes[0]?.textContent?.trim() ?? h.textContent.trim(),
      partial: h.dataset.partial === "1",
      tag: /partial/i.test(h.textContent),
    })),
    rowNames: rows.map((tr) => tr.querySelector("td")?.textContent.trim() ?? ""),
    rowCells: rows.map((tr) => [...tr.querySelectorAll("td")].slice(1, -2).map((td) => Number(td.textContent.replace(/[,%]/g, "")))),
    rowChange: rows.map((tr) => [...tr.querySelectorAll("td")].pop().textContent.trim()),
    changeSub: document.querySelector('[data-testid="behavior-change-sub"]')?.textContent ?? "",
    changeTitle: document.querySelector('[data-testid="behavior-change-head"]')?.getAttribute("title") ?? "",
    partialSegs: document.querySelectorAll('[data-testid="behavior-partial-seg"]').length,
    partialNote: document.querySelector('[data-testid="behavior-partial-note"]')?.textContent ?? "",
    legendPartial: document.querySelector('[data-testid="behavior-legend-partial"]')?.textContent ?? "",
    seriesCount: document.querySelectorAll('[data-testid="behavior-legend-item"]').length,
  };
};

async function main() {
  process.loadEnvFile(".env.local");
  const { storageState } = await storageStateFor(ADMIN, BASE);
  const browser = await chromium.launch();
  // acceptDownloads so the CSV can be captured and read rather than trusted.
  const ctx = await browser.newContext({ storageState, viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
  const page = await ctx.newPage();
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="behavior-col-head"]', { timeout: 120000 });

  /* THE RANGE THAT EXPOSES IT: ending in the CURRENT month. The quick pills all end on the last
   * complete month, so only the custom selects reach here — which is the whole point. */
  console.log(`\n-- a custom range ending inside the current month (${MON[START_M - 1]} ${START_Y} – ${CUR_LABEL}) --`);
  /* "Change" MATCHES TWO ELEMENTS on this page, so it is addressed as the period bar's own button.
   * A text selector that resolves to two nodes is a selector that will one day click the wrong one. */
  await page.locator("button", { hasText: /^Change$/ }).first().click();
  await page.waitForTimeout(400);
  await page.selectOption("#pb-start-year", String(START_Y));
  await page.selectOption("#pb-start-month", String(START_M - 1));
  await page.selectOption("#pb-end-year", String(CUR_Y));
  await page.selectOption("#pb-end-month", String(CUR_M - 1));
  await page.waitForFunction((lbl) => [...document.querySelectorAll('[data-testid="behavior-col-head"]')]
    .some((h) => h.textContent.includes(lbl)), CUR_LABEL, { timeout: 60000 });
  await page.waitForTimeout(900);

  const d = await page.evaluate(READ);
  is("  CONTROL: the current month is actually on screen", d.heads[d.heads.length - 1].text, CUR_LABEL);
  yes(`  CONTROL: and there are several complete months before it (${d.heads.length})`, d.heads.length >= 5);

  console.log("\n-- 1. the partial month renders distinctly, chart and table --");
  is("exactly one column is flagged partial", d.heads.filter((h) => h.partial).length, 1);
  is("  …and it is the current month, last", d.heads[d.heads.length - 1].partial, true);
  is("  …carrying a visible 'partial' tag in the header", d.heads[d.heads.length - 1].tag, true);
  /* CONTROL: every OTHER column must be unflagged. A rule that marked everything would satisfy
   * "the last one is marked" and mean nothing. */
  is("  CONTROL: no complete month is flagged", d.heads.slice(0, -1).filter((h) => h.partial).map((h) => h.text), []);
  is("  the chart draws a dashed tail, one per series", d.partialSegs, d.seriesCount);
  is("  …and names it 'partial month', not 'partial week'", d.partialNote, "partial month");
  yes(`  the legend says which month is running — "${d.legendPartial.trim()}"`, d.legendPartial.includes(CUR_LABEL));

  console.log("\n-- 2 & 3. the change compares the last two COMPLETE months --");
  const iLast = d.heads.length - 1 - [...d.heads].reverse().findIndex((h) => !h.partial);
  const iPrev = iLast - 1 - [...d.heads.slice(0, iLast)].reverse().findIndex((h) => !h.partial);
  is(`  the pair is ${d.heads[iPrev].text} and ${d.heads[iLast].text}`,
    [d.heads[iPrev].partial, d.heads[iLast].partial], [false, false]);
  is("  CONTROL: neither is the current month", [d.heads[iPrev].text, d.heads[iLast].text].includes(CUR_LABEL), false);
  const screenChange = [];
  for (let r = 0; r < 4; r++) {
    const cells = d.rowCells[r];
    const want = ((cells[iLast] - cells[iPrev]) / cells[iPrev]) * 100;
    const got = Number(d.rowChange[r].replace(/[+%]/g, ""));
    screenChange.push({ name: d.rowNames[r], got });
    near(`  ${d.rowNames[r]}: badge equals (${cells[iLast]} − ${cells[iPrev]}) / ${cells[iPrev]}`, got, want);
  }
  /* THE CONTROL THAT MATTERS. The badge must NOT be the comparison against the partial month —
   * otherwise every assertion above could be passing on a coincidence. */
  const partialCmp = ((d.rowCells[0][d.heads.length - 1] - d.rowCells[0][iLast]) / d.rowCells[0][iLast]) * 100;
  yes(`  CONTROL: the badge is NOT the partial comparison (${screenChange[0].got}% vs ${partialCmp.toFixed(1)}%)`,
    Math.abs(screenChange[0].got - partialCmp) > 1);
  yes(`  CONTROL: …and that partial comparison is a large negative, so the defect is reproducible here`,
    partialCmp < -20, `partial comparison came out ${partialCmp.toFixed(1)}% — this range does not expose the bug`);
  is("  the column names the pair it used", d.changeSub, `${d.heads[iPrev].text} → ${d.heads[iLast].text}`);
  yes("  …and the tooltip says both are complete months",
    /COMPLETE months/.test(d.changeTitle) && /a month still running is never used/.test(d.changeTitle),
    `tooltip read: "${d.changeTitle}"`);

  console.log("\n-- 4. the CSV for the SAME range carries the SAME numbers --");
  /* THE BYTES ARE CAPTURED AT THE SOURCE, not via the download event. downloadCsv builds a Blob,
   * hands it to URL.createObjectURL and clicks a synthetic <a download>; headless Chromium does not
   * raise a download for that, and waiting on one times out having proved nothing.
   *
   * Patching createObjectURL reads the EXACT bytes the export produces — one step closer to the
   * thing under test than a file on disk, with no download plumbing in between. */
  await page.evaluate(() => {
    window.__csv = null;
    const real = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { blob.text().then((t) => { window.__csv = t; }); return real(blob); };
  });
  // THE PANEL'S OWN EXPORT, BY ID. Two other panels on this route also render an "Export" button,
  // and a text selector would eventually export the Data Room's file instead.
  await page.click("#growthExport");
  await page.waitForFunction(() => typeof window.__csv === "string" && window.__csv.length > 0, null, { timeout: 30000 });
  const csv = await page.evaluate(() => window.__csv);
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const cells = (l) => l.match(/("([^"]|"")*"|[^,]*)/g).filter((_, i, a) => i % 2 === 0).map((c) => c.replace(/^"|"$/g, "").replace(/""/g, '"'));
  const head = cells(lines[0]);
  yes(`  CONTROL: the file has a header and rows (${lines.length} lines)`, lines.length > 4);
  is("  the partial column is LABELLED partial in the file", head[head.length - 3], `${CUR_LABEL} (partial)`);
  /* CONTROL: only that one. A file that appended "(partial)" to everything would pass the check
   * above while telling the reader nothing. */
  is("  CONTROL: no complete month is labelled partial",
    head.slice(1, -3).filter((h) => /partial/i.test(h)), []);
  is("  the change column names the same pair the screen named",
    head[head.length - 1], `Latest MoM (${d.heads[iPrev].text} → ${d.heads[iLast].text})`);
  for (const { name, got } of screenChange) {
    const row = lines.map(cells).find((c) => c[0] === name);
    yes(`  CONTROL: ${name} is in the file`, !!row);
    if (row) {
      const csvVal = Number(row[row.length - 1].replace(/[+%]/g, ""));
      near(`  ${name}: the file's change equals the screen's ${got}%`, csvVal, got, 0.05);
    }
  }
  /* AND THE FILE'S CHANGE IS NOT THE PARTIAL COMPARISON EITHER — the specific regression this
   * whole section exists for, since last time the screen was fixed and the export was not. */
  const regRow = lines.map(cells).find((c) => c[0] === "Registrations");
  yes(`  CONTROL: the file is not shipping the partial comparison (${regRow[regRow.length - 1]} vs ${partialCmp.toFixed(1)}%)`,
    Math.abs(Number(regRow[regRow.length - 1].replace(/[+%]/g, "")) - partialCmp) > 1);

  /* ── THE DETAIL-MODE EXPORT IS A SECOND CODE PATH, AND IT NEEDS ITS OWN CHECK ────────────────
   * exportCsv builds Overall's rows from `toRow`, but City and Field Detail append their own
   * per-scope rows in a separate loop with a SECOND change computation. Breaking only that loop
   * and leaving the screen correct was caught above by the header label alone — the value checks
   * never reached it, because Overall mode does not run that code. This section does. */
  console.log("\n-- the DETAIL-mode export uses the same complete pair --");
  await page.click('[data-value="city"]');
  await page.waitForTimeout(900);
  await page.selectOption('[data-testid="behavior-metric"]', { label: "Registrations" });
  await page.waitForTimeout(700);
  const screenCity = await page.evaluate(() => [...document.querySelectorAll("#growthSummaryBody tr")].map((tr) => {
    const tds = [...tr.querySelectorAll("td")];
    return { name: tds[0].textContent.replace(/^\d+\s*/, "").trim(), change: tds[tds.length - 1].textContent.trim() };
  }));
  await page.evaluate(() => {
    window.__csv = null;
    const real = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { blob.text().then((t) => { window.__csv = t; }); return real(blob); };
  });
  await page.click("#growthExport");
  await page.waitForFunction(() => typeof window.__csv === "string" && window.__csv.length > 0, null, { timeout: 30000 });
  const csv2 = await page.evaluate(() => window.__csv);
  const rows2 = csv2.split(/\r?\n/).filter(Boolean).map(cells);
  const head2 = rows2[0];
  is("  the detail file labels the partial column too", head2[head2.length - 3], `${CUR_LABEL} (partial)`);
  is("  …and names the same pair", head2[head2.length - 1], `Latest MoM (${d.heads[iPrev].text} → ${d.heads[iLast].text})`);
  yes(`  CONTROL: the detail file carries the appended per-scope rows (${rows2.length} lines)`,
    rows2.length > screenCity.length + 2);
  let checked = 0;
  for (const r of screenCity.slice(0, 4)) {
    const row = rows2.find((c) => c[0] === r.name);
    if (!row) { bad(`  ${r.name} is in the detail file`); continue; }
    checked++;
    is(`  ${r.name}: the file's change equals the screen's`, row[row.length - 1], r.change);
  }
  yes(`  CONTROL: rows were actually compared (${checked})`, checked >= 3);
  /* AND THE APPENDED PER-SCOPE ROWS — the ones only this file has — must use the same pair. Their
   * change is recomputed in that second loop, so it is the one that can drift. */
  const appended = rows2.filter((c) => / · /.test(c[0]));
  yes(`  CONTROL: there are appended per-scope rows to check (${appended.length})`, appended.length > 0);
  const partialCol = head2.length - 3;
  let drifted = [];
  /* A RATE MOVES IN PERCENTAGE POINTS, NOT PERCENT. The first version of this assertion applied
   * the percent formula to every row and flagged all seven "% recurring" rows as drifted — the
   * code was right and the assertion was wrong. 48.1% -> 55.6% is +7.5 POINTS and +15.6 percent;
   * reporting the second overstates the move by the size of the base, which is the one thing this
   * metric makes easy to get wrong. The unit is in the exported value ("pts"), so it is read from
   * there rather than guessed from the row name. */
  let rates = 0;
  for (const c of appended) {
    const cellsN = c.slice(1, -2).map((v) => Number(String(v).replace(/[,%]/g, "")));
    const raw = String(c[c.length - 1]);
    const isRate = /pts/.test(raw);
    if (isRate) rates++;
    const want = isRate
      ? cellsN[iLast] - cellsN[iPrev]
      : ((cellsN[iLast] - cellsN[iPrev]) / cellsN[iPrev]) * 100;
    const got = Number(raw.replace(/[+%]|pts|\s/g, ""));
    if (Number.isFinite(want) && Math.abs(got - want) > 0.15) drifted.push([c[0], got, Number(want.toFixed(1))]);
  }
  is("  every appended row's change is the complete-month pair, recomputed here", drifted, []);
  yes(`  CONTROL: both units were exercised — ${rates} rate rows and ${appended.length - rates} count rows`,
    rates > 0 && appended.length - rates > 0);
  yes(`  CONTROL: the partial column is present in those rows and was NOT the one used (col ${partialCol})`,
    partialCol > iLast);

  await closeContext(ctx);
  await closeBrowser(browser);
  console.log(`\nbehavior-monthly-partial: ${PASS} passed, ${FAIL} failed`);
  if (FAIL) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
}
main().catch((e) => fatal(e));
