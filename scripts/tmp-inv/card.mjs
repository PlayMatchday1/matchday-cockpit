process.loadEnvFile("/Users/ryanmancuso/Code/matchday-cockpit/.env.local");
const { chromium } = await import("playwright");
const { storageStateFor, installHarnessGuard } = await import("/Users/ryanmancuso/Code/matchday-cockpit/scripts/e2e/_session.mjs");
installHarnessGuard();
const { storageState } = await storageStateFor("rmancuso@playmatchday.com", "http://localhost:3000");
const b = await chromium.launch();
const c = await b.newContext({ storageState, viewport: { width: 1700, height: 1400 } });
const p = await c.newPage();
await p.goto("http://localhost:3000/admin/finance/cost", { waitUntil: "domcontentloaded" });
await p.waitForSelector('[data-testid="cost-row"]', { timeout: 90000 });
await p.locator('[data-testid="grain-field"]').click(); await p.waitForTimeout(2500);
const d = await p.evaluate(() => {
  const money = (t) => Number(String(t ?? "").replace(/[^0-9.-]/g, ""));
  const rows = [...document.querySelectorAll('[data-testid="cost-row"]')].map(r => ({
    name: r.querySelectorAll("td")[1]?.innerText.trim(),
    revenue: money(r.querySelector('[data-testid="cost-revenue-cell"]')?.innerText),
    costTxt: r.querySelector('[data-testid="cost-amount-cell"]')?.innerText.trim(),
  }));
  const tot = document.querySelector('[data-testid="cost-total-row"]');
  const tds = [...(tot?.querySelectorAll("td") ?? [])].map(t=>t.innerText.trim());
  return {
    rows,
    totalRevenue: money(tds[4]), totalCost: money(tds[5]), totalRatio: tds[6],
    cardRatio: document.querySelector('[data-testid="cost-tile-ratio"]')?.innerText.trim(),
    cardCost: [...document.querySelectorAll("span")].find(e=>e.previousElementSibling?.innerText?.trim()==="Field cost")?.innerText.trim(),
  };
});
const dashed = d.rows.filter(r => /—/.test(r.costTxt));
const dashedRev = dashed.reduce((s,r)=>s+r.revenue,0);
console.log("AUGUST 2026 · Field Economics\n");
console.log(`  dashed rows: ${dashed.map(r=>`${r.name} ($${r.revenue.toLocaleString()})`).join(", ")}`);
console.log(`  their revenue:        $${dashedRev.toLocaleString()}`);
console.log(`\n  FIELD COST card:      ${d.cardCost}`);
console.log(`  total row cost:       $${d.totalCost.toLocaleString()}`);
console.log(`  total row revenue:    $${d.totalRevenue.toLocaleString()}   ← INCLUDES the dashed rows' revenue`);
console.log(`  total row ratio:      ${d.totalRatio}`);
console.log(`  card ratio:           ${d.cardRatio}`);
console.log(`\n  ratio as printed:                 ${d.totalCost} / ${d.totalRevenue} = ${((d.totalCost/d.totalRevenue)*100).toFixed(1)}%`);
console.log(`  ratio if dashed revenue excluded:  ${d.totalCost} / ${(d.totalRevenue-dashedRev)} = ${((d.totalCost/(d.totalRevenue-dashedRev))*100).toFixed(1)}%`);
console.log(`  → the dashed rows move the ratio by ${(((d.totalCost/(d.totalRevenue-dashedRev)) - (d.totalCost/d.totalRevenue))*100).toFixed(1)} pp`);
await b.close();
