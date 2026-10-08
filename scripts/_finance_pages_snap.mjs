/* READ-ONLY. Loads every Finance page for one period and saves its rendered text + a screenshot,
 * so a figure can be compared before and after a deploy. No clicks that write; page views only.
 *   BASE=https://… node --env-file=.env.local scripts/_finance_pages_snap.mjs <outDir> <tag> [p=2026-09] */
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { storageStateFor } from "./e2e/_session.mjs";
const [out, tag, p = "2026-09"] = process.argv.slice(2);
const BASE = process.env.BASE || "https://matchday-clubhouse.vercel.app";
const PAGES = ["revenue", "cost", "cities", "cash-flow", "opex", "ledger/revenue", "ledger/expenses", "ledger/field-costs"];
const { storageState } = await storageStateFor("rmancuso@playmatchday.com", BASE);
const b = await chromium.launch();
const ctx = await b.newContext({ storageState, viewport: { width: 1500, height: 1100 } });
for (const path of PAGES) {
  const page = await ctx.newPage();
  const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(`${BASE}/admin/finance/${path}?p=${p}`, { waitUntil: "domcontentloaded" });
  // READY = no "Loading…" left in main for 3 s straight, or 120 s.
  const t0 = Date.now(); let quiet = 0;
  while (Date.now() - t0 < 120_000) {
    await page.waitForTimeout(1000);
    const txt = await page.locator("main").innerText().catch(() => "");
    quiet = /Loading…|Loading\.\.\./.test(txt) || txt.length < 200 ? 0 : quiet + 1;
    if (quiet >= 3) break;
  }
  const txt = await page.locator("main").innerText().catch((e) => `READ FAILED ${e.message}`);
  const f = `${out}/${tag}-${path.replace(/\//g, "_")}`;
  writeFileSync(`${f}.txt`, txt);
  await page.screenshot({ path: `${f}.png`, fullPage: true });
  console.log(`${path.padEnd(20)} ${((Date.now() - t0) / 1000).toFixed(0)}s  ${txt.length} chars${errs.length ? `  PAGE ERRORS: ${errs.join(" | ")}` : ""}`);
  await page.close();
}
await b.close();
