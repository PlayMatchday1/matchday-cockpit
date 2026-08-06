// Playwright DOM verification for the manager year report, against the production
// build served locally (deploy is SSO-gated). Numeric reconciliations (a)-(d) are
// proven independently by recon-year.mjs; this asserts the rendered document +
// negative controls (e)-(l). Picks a real manager with the richest coverage
// (cancelled, and if present two-manager / adjustments). Run: node scripts/e2e/verify-year.mjs

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const BASE = "http://localhost:3000", YEAR = 2026;
const money = (n) => (n < 0 ? "−$" : "$") + Math.abs(n).toLocaleString("en-US");
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const check = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e.message); } };

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const link = await svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
  const vv = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  const TOK = vv.data.session.access_token;
  const api = async (p) => (await (await fetch(`${BASE}${p}`, { headers: { Authorization: `Bearer ${TOK}` } })).json());

  const { managers } = await api(`/api/manager-pay/manager-year?year=${YEAR}`);
  // pick richest: cancelled>0, prefer twoManager and adjustments
  let pick = null, rep = null, best = -1;
  for (const m of managers.slice(0, 45)) {
    const r = await api(`/api/manager-pay/manager-year?year=${YEAR}&manager=${encodeURIComponent(m.email)}`);
    if (!r || !r.rows) continue;
    const twoM = r.rows.filter((x) => x.twoManager && !x.cancelled).length;
    const score = (r.cancelled > 0 ? 100 : 0) + twoM * 10 + r.adjustments.length * 25 + r.worked;
    if (score > best) { best = score; pick = m; rep = r; }
    if (r.cancelled > 0 && twoM > 0 && r.adjustments.length > 0) break;
  }
  const twoManRows = rep.rows.filter((r) => r.twoManager && !r.cancelled);
  console.log(`\nMANAGER: ${rep.managerName} <${pick.email}>  worked=${rep.worked} cancelled=${rep.cancelled} two-manager=${twoManRows.length} adjustments=${rep.adjustments.length} grand=${money(rep.grand)}`);
  console.log(`(for (d): node scripts/e2e/recon-year.mjs ${pick.email})`);

  // storageState session for the browser
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const key = `sb-${ref}-auth-token`;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: key, value: JSON.stringify(vv.data.session) }] }] } });
  const page = await context.newPage();
  const ev = (fn, arg) => page.evaluate(fn, arg);

  await page.goto(`${BASE}/match-ops/manager-pay/history`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".myr .picks select", { timeout: 30_000 });
  await page.selectOption('.myr select[aria-label="Year"]', String(YEAR));
  await page.selectOption('.myr select[aria-label="Manager"]', pick.email);
  await page.waitForSelector('.myr .tv[data-k="worked"]', { timeout: 30_000 });
  await page.waitForFunction(() => document.querySelectorAll(".myr .wk").length > 0, { timeout: 30_000 });

  console.log("\nRECONCILIATION (from the rendered report data)");
  await check("(a) per-match pay + adjustments == year total", async () => {
    const a = rep.rows.filter((r) => !r.cancelled).reduce((s, r) => s + r.pay, 0) + rep.adjustments.reduce((s, x) => s + x.amount, 0);
    if (a !== rep.grand) throw new Error(`${a} != ${rep.grand}`);
  });
  await check("(b) week totals sum to the year total", async () => {
    const b = rep.weeks.reduce((s, w) => s + w.total, 0);
    if (b !== rep.grand) throw new Error(`${b} != ${rep.grand}`);
  });
  await check("(c) field matches==worked; field pay==total-adj; city rows==field total", async () => {
    const fm = rep.fields.reduce((s, f) => s + f.matches, 0), fp = rep.fields.reduce((s, f) => s + f.pay, 0);
    const cm = rep.cities.reduce((s, c) => s + c.matches, 0), cp = rep.cities.reduce((s, c) => s + c.pay, 0);
    if (fm !== rep.worked) throw new Error(`field matches ${fm} != worked ${rep.worked}`);
    if (fp !== rep.grand - rep.adjustmentsTotal) throw new Error(`field pay ${fp} != ${rep.grand - rep.adjustmentsTotal}`);
    if (cm !== fm || cp !== fp) throw new Error(`city ${cm}/${cp} != field ${fm}/${fp}`);
  });

  console.log("\nRENDERED DOCUMENT");
  await check("(e) Matches worked + Cancelled == total match rows rendered", async () => {
    const t = await ev(() => ({ w: +document.querySelector('.tv[data-k="worked"]').textContent, c: +document.querySelector('.tv[data-k="cancelled"]').textContent, rows: document.querySelectorAll(".myr .mr:not(.adjust)").length }));
    if (t.w + t.c !== t.rows) throw new Error(`${t.w}+${t.c} != ${t.rows} match rows`);
  });
  await check("(f) every cancelled row shows an em-dash (never $0) and is struck through", async () => {
    const r = await ev(() => [...document.querySelectorAll(".myr .mr.cancelled")].map((row) => ({ pay: row.querySelector(".mp").textContent.trim(), strike: getComputedStyle(row.querySelector(".mf")).textDecorationLine })));
    for (const x of r) { if (x.pay !== "—") throw new Error(`cancelled pay "${x.pay}"`); if (!x.strike.includes("line-through")) throw new Error("not struck through"); }
    if (!r.length) throw new Error("no cancelled rows to check");
  });
  await check("(g) every two-manager row shows the per-manager share (matched by date+field, not position)", async () => {
    if (!twoManRows.length) { console.log("     (no two-manager rows for this manager — vacuously true)"); return; }
    const dom = await ev(() => [...document.querySelectorAll(".myr .mr")].filter((r) => r.querySelector(".pillx.two")).map((r) => ({ d: r.querySelector(".md").textContent, f: r.querySelector(".mf").textContent, pay: r.querySelector(".mp").textContent.trim() })));
    for (const src of twoManRows) {
      const m = dom.find((x) => x.f === src.field && x.d.startsWith(src.dateLabel));
      if (!m) throw new Error(`two-manager row ${src.field} ${src.dateLabel} not found in DOM`);
      if (m.pay !== money(src.pay)) throw new Error(`share ${m.pay} != source ${money(src.pay)}`);
    }
  });
  await check("(h) every adjustment row carries a reason and no field", async () => {
    const r = await ev(() => [...document.querySelectorAll(".myr .mr.adjust")].map((row) => ({ reason: row.querySelector(".mf").textContent.trim(), tag: row.querySelector(".mc").textContent.trim(), hasPill: !!row.querySelector(".pillx.adj") })));
    for (const x of r) { if (!x.reason) throw new Error("adjustment has no reason"); if (x.tag !== "Adjustment") throw new Error(`adjustment tag "${x.tag}"`); if (!x.hasPill) throw new Error("no Adjustment pill"); }
    if (!r.length) console.log("     (no adjustment rows for this manager — vacuously true)");
  });
  await check("(i) every week head names both the pay run and the arrival", async () => {
    const heads = await ev(() => [...document.querySelectorAll(".myr .wkd")].map((e) => e.textContent));
    for (const h of heads) if (!/Pay run/.test(h) || !/arrives/.test(h)) throw new Error(`week head "${h}"`);
  });
  await check("(j) CSV row count == matches + adjustments on screen", async () => {
    const onScreen = await ev(() => document.querySelectorAll(".myr .mr").length);
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click('.myr button:has-text("Download CSV")')]);
    const text = readFileSync(await dl.path(), "utf8");
    const csvRows = text.trim().split("\n").length - 1; // minus header
    if (csvRows !== onScreen) throw new Error(`csv ${csvRows} != on-screen ${onScreen}`);
    if (csvRows !== rep.rows.length + rep.adjustments.length) throw new Error(`csv ${csvRows} != rows+adj ${rep.rows.length + rep.adjustments.length}`);
  });
  await check("(k) print media hides the host bar and picker, keeps tiles + breakdown", async () => {
    await page.emulateMedia({ media: "print" });
    const r = await ev(() => ({ host: getComputedStyle(document.querySelector(".myr .hostbar")).display, picks: getComputedStyle(document.querySelector(".myr .picks")).display, tiles: getComputedStyle(document.querySelector(".myr .tiles")).display, loc: !!document.querySelector("#loc") }));
    await page.emulateMedia({ media: "screen" });
    if (r.host !== "none") throw new Error(`hostbar display ${r.host}`);
    if (r.picks !== "none") throw new Error(`picks display ${r.picks}`);
    if (r.tiles === "none") throw new Error("tiles hidden in print");
    if (!r.loc) throw new Error("breakdown missing in print");
  });
  await check("(l) contrast >= 4.5 normal / >= 3 large", async () => {
    const res = await ev(() => {
      const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const parse = (c) => c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
      const bgOf = (el) => { let e = el; while (e) { const b = getComputedStyle(e).backgroundColor; if (b && b !== "rgba(0, 0, 0, 0)" && b !== "transparent") return parse(b); e = e.parentElement; } return [255, 255, 255]; };
      const ratio = (el) => { if (!el) return 99; const s = getComputedStyle(el); const fg = parse(s.color), bg = bgOf(el); const L1 = lum(fg) + 0.05, L2 = lum(bg) + 0.05; const r = L1 > L2 ? L1 / L2 : L2 / L1; const px = parseFloat(s.fontSize); const large = px >= 24 || (px >= 18.66 && parseInt(s.fontWeight, 10) >= 700); return { r, large }; };
      return { tv: ratio(document.querySelector(".myr .tv")), tl: ratio(document.querySelector(".myr .tl")), md: ratio(document.querySelector(".myr .md")), mc: ratio(document.querySelector(".myr .mc")), recon: ratio(document.querySelector(".myr .recon")), foot: ratio(document.querySelector(".myr .foot")) };
    });
    for (const [k, v] of Object.entries(res)) { const min = v.large ? 3 : 4.5; if (v.r < min) throw new Error(`${k} ${v.r.toFixed(2)} < ${min}`); }
  });

  // ── negative controls ──
  console.log("\nNEGATIVE CONTROLS (each must FAIL cleanly)");
  let NCP = 0, NCF = 0;
  const reset = async () => { await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForSelector(".myr .picks select", { timeout: 30_000 }); await page.selectOption('.myr select[aria-label="Year"]', String(YEAR)); await page.selectOption('.myr select[aria-label="Manager"]', pick.email); await page.waitForFunction(() => document.querySelectorAll(".myr .wk").length > 0, { timeout: 30_000 }); };
  const neg = async (name, mutate, assertFn) => {
    await reset(); await ev(mutate);
    let threw = false, msg = "";
    try { await assertFn(); } catch (e) { threw = true; msg = e.message; }
    if (threw) { NCP++; console.log(`  ✓ ${name} — caught: ${msg}`); }
    else { NCF++; console.log(`  ✗ ${name} — did NOT fail (vacuous!)`); }
  };
  // location foots: field-pay sum == foot cell
  const footAssert = async () => { const r = await ev(() => ({ sum: [...document.querySelectorAll('#loc tbody tr[data-f] td:nth-child(4)')].reduce((s, td) => s + Number(td.textContent.replace(/[^0-9.-]/g, "")), 0), foot: Number(document.querySelector('[data-k="locpay"]').textContent.replace(/[^0-9.-]/g, "")) })); if (r.sum !== r.foot) throw new Error(`field sum ${r.sum} != foot ${r.foot}`); };
  const weekAssert = async () => { const r = await ev(() => { const wt = [...document.querySelectorAll(".myr .wkt")].reduce((s, e) => s + Number(e.dataset.wt), 0); const grand = Number(document.querySelector('.tv[data-k="total"]').textContent.replace(/[^0-9.-]/g, "")); return { wt, grand }; }); if (r.wt !== r.grand) throw new Error(`week totals ${r.wt} != grand ${r.grand}`); };
  const workedVsRows = async () => { const t = await ev(() => ({ w: +document.querySelector('.tv[data-k="worked"]').textContent, c: +document.querySelector('.tv[data-k="cancelled"]').textContent, rows: document.querySelectorAll(".myr .mr:not(.adjust)").length })); if (t.w + t.c !== t.rows) throw new Error(`${t.w}+${t.c} != ${t.rows}`); };
  const cancelledEmdash = async () => { const bad = await ev(() => [...document.querySelectorAll(".myr .mr.cancelled .mp")].filter((e) => e.textContent.trim() !== "—").length); if (bad) throw new Error(`${bad} cancelled rows not em-dash`); };
  const twoManShare = async () => { const dom = await ev(() => [...document.querySelectorAll(".myr .mr")].filter((r) => r.querySelector(".pillx.two")).map((r) => ({ f: r.querySelector(".mf").textContent, d: r.querySelector(".md").textContent, pay: r.querySelector(".mp").textContent.trim() }))); for (const src of twoManRows) { const m = dom.find((x) => x.f === src.field && x.d.startsWith(src.dateLabel)); if (m && m.pay !== money(src.pay)) throw new Error(`share ${m.pay} != ${money(src.pay)}`); } };
  const footnoteWords = async () => { const t = await ev(() => document.querySelector(".myr .foot").textContent); if (!/sums to match pay, not to Total paid/i.test(t)) throw new Error("footnote no longer says 'match pay, not to Total paid'"); };

  await neg("break the location footing", () => { const td = document.querySelector('#loc tbody tr[data-f] td:nth-child(4)'); td.textContent = "$999999"; }, footAssert);
  await neg("drift a week total", () => { const e = document.querySelector(".myr .wkt"); e.dataset.wt = String(Number(e.dataset.wt) + 5); }, weekAssert);
  await neg("fold cancelled into matches worked", () => { const w = document.querySelector('.tv[data-k="worked"]'); w.textContent = String(+w.textContent + +document.querySelector('.tv[data-k="cancelled"]').textContent); }, workedVsRows);
  await neg("make a cancelled match pay", () => { const mp = document.querySelector(".myr .mr.cancelled .mp"); if (mp) mp.textContent = "$20"; }, cancelledEmdash);
  await neg("make a two-manager match pay the whole match", () => { const r = [...document.querySelectorAll(".myr .mr")].find((x) => x.querySelector(".pillx.two")); if (r) { const mp = r.querySelector(".mp"); mp.textContent = "$" + (Number(mp.textContent.replace(/[^0-9]/g, "")) * 2); } }, twoManShare);
  await neg("rewrite the footnote to claim the field column sums to Total paid", () => { document.querySelector(".myr .foot").textContent = "This column sums to Total paid."; }, footnoteWords);

  console.log(`\n================ RESULT ================`);
  console.log(`Assertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log(`   FAILED: ${f}`));
  const applicableNeg = NCP + NCF;
  console.log(`Negative controls: ${NCP}/${applicableNeg} failed cleanly`);
  await browser.close();
  process.exit(FAIL === 0 && NCF === 0 ? 0 : 1);
}
main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
