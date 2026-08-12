// Playwright verify for the v1_4 partner dashboard against the production build
// served locally (deploy is SSO-gated; the partner page itself is public via its
// token slug). Targets PAC Global — weekly cadence, both grains meaningful, and
// the real Jun 28 paid-snapshot divergence. Run: node scripts/e2e/verify-partner.mjs

import { chromium } from "playwright";
import { fatal, installHarnessGuard } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.E2E_BASE_URL || "http://localhost:3000";
const SLUG = "pac-global-7vdybfv4";
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const check = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e.message); } };

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext()).newPage();
  const ev = (fn, arg) => page.evaluate(fn, arg);
  await page.goto(`${BASE}/partners/${SLUG}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".pv14 table", { timeout: 30_000 });

  console.log("POSITIVE ASSERTIONS");
  await check("8 columns in exact order", async () => {
    const cols = await ev(() => [...document.querySelectorAll(".pv14 thead th")].map((t) => t.textContent.trim()));
    const want = ["Period", "Matches", "Spots filled", "Daily players", "Guests", "Revenue", "Your payment", "Status"];
    if (JSON.stringify(cols) !== JSON.stringify(want)) throw new Error(`got ${JSON.stringify(cols)}`);
  });
  await check("Month is the default grain", async () => {
    const on = await ev(() => document.querySelector(".pv14 .seg button.on").textContent.trim());
    const title = await ev(() => document.querySelector(".pv14 .card:last-of-type .ctitle").textContent.trim());
    if (on !== "Month") throw new Error(`active tab ${on}`);
    if (title !== "Every month") throw new Error(`table title ${title}`);
  });
  await check("rows are newest first", async () => {
    const keys = await ev(() => [...document.querySelectorAll(".pv14 tbody tr[data-k]")].map((r) => r.dataset.k));
    const nonOpening = keys.filter((k) => k >= "2026-05");
    const sorted = [...nonOpening].sort().reverse();
    if (JSON.stringify(nonOpening) !== JSON.stringify(sorted)) throw new Error("not descending");
  });
  await check("snapshot = latest COMPLETE month (July) with deltas vs June", async () => {
    const name = await ev(() => document.querySelector(".pv14 .snapname b").textContent.trim());
    if (name !== "July 2026") throw new Error(`snapshot period ${name}`);
    const deltas = await ev(() => [...document.querySelectorAll(".pv14 .tiles .deltac")].map((d) => d.textContent.trim()));
    if (deltas.length !== 5) throw new Error(`${deltas.length} delta chips`);
    if (!deltas.some((d) => /[+−]\d/.test(d))) throw new Error(`no numeric delta among: ${deltas.join(" | ")}`);
  });
  await check("since-launch strip: 4 items incl. 'Distinct people'", async () => {
    const labels = await ev(() => [...document.querySelectorAll(".pv14 .launch .lk span")].map((s) => s.textContent.trim()));
    if (labels.length !== 4) throw new Error(`${labels.length} strip items`);
    if (!labels.includes("Distinct people")) throw new Error(`labels ${labels.join(", ")}`);
  });
  await check("zero-match periods show em-dashes, never $0", async () => {
    // switch to week view where PAC has zero weeks (May 10, Jun 21)
    await page.click('.pv14 .seg button:has-text("Week")');
    await page.waitForTimeout(150);
    const bad = await ev(() => {
      const rows = [...document.querySelectorAll(".pv14 tbody tr[data-k]")];
      // a zero week: matches cell == "0"
      const zeros = rows.filter((r) => r.children[1].textContent.trim() === "0");
      for (const r of zeros) { if (r.children[6].textContent.includes("$0")) return "found $0 in a zero week"; }
      return zeros.length ? "" : "no zero weeks found";
    });
    if (bad) throw new Error(bad);
    await page.click('.pv14 .seg button:has-text("Month")');
    await page.waitForTimeout(150);
  });
  await check('the Jun 28 paid-snapshot divergence shows the frozen $13 with a ✱ marker', async () => {
    await page.click('.pv14 .seg button:has-text("Week")');
    await page.waitForTimeout(150);
    const r = await ev(() => { const row = document.querySelector('.pv14 tbody tr[data-k="2026-06-28"]'); if (!row) return { missing: true }; return { pay: row.children[6].textContent.trim(), diverged: row.dataset.diverged === "1" }; });
    if (r.missing) throw new Error("no Jun 28 row");
    if (!/\$13/.test(r.pay)) throw new Error(`payment shows "${r.pay}" (expected frozen $13)`);
    if (!/✱/.test(r.pay)) throw new Error("no ✱ divergence marker");
    if (!r.diverged) throw new Error("row not flagged diverged");
    await page.click('.pv14 .seg button:has-text("Month")');
    await page.waitForTimeout(150);
  });
  // (rental rendering is exercised by the monthly verify on Hattrick — PAC Global's
  // only rental predates its payment start, so it sits in the opening lump, not an
  // itemised period. The weekly rental-row code path is inspected, not asserted here.)
  for (const g of ["Month", "Week"]) {
    await check(`"member"/"promo" appear nowhere in rendered text (${g} grain)`, async () => {
      await page.click(`.pv14 .seg button:has-text("${g}")`);
      await page.waitForTimeout(150);
      const hit = await ev(() => (document.querySelector(".pv14").innerText.match(/\b(member|promo)\w*/gi) || []));
      if (hit.length) throw new Error(`found: ${[...new Set(hit)].join(", ")}`);
    });
  }
  await check("table scrolls inside its card; header + total stay stuck (by measurement)", async () => {
    await page.click('.pv14 .seg button:has-text("Week")'); await page.waitForTimeout(150); // week has more rows to scroll
    const r = await ev(() => {
      const sc = document.querySelector(".pv14 .scroller");
      sc.scrollTop = Math.max(1, Math.floor(sc.scrollHeight / 2));
      const scr = sc.getBoundingClientRect();
      const th = document.querySelector(".pv14 thead th").getBoundingClientRect();
      const tf = document.querySelector(".pv14 tfoot td").getBoundingClientRect();
      return { scrolled: sc.scrollTop, headTop: th.top - scr.top, footBottom: scr.bottom - tf.bottom, canScroll: sc.scrollHeight - sc.clientHeight };
    });
    if (r.canScroll <= 0) throw new Error("content does not scroll inside the card");
    if (Math.abs(r.headTop) > 2) throw new Error(`header not stuck to top (offset ${r.headTop.toFixed(1)}px while scrolled)`);
    if (Math.abs(r.footBottom) > 2) throw new Error(`total row not stuck to bottom (offset ${r.footBottom.toFixed(1)}px)`);
    await page.click('.pv14 .seg button:has-text("Month")'); await page.waitForTimeout(150);
  });
  await check("footnote reads the exact copy and names 'other seat types'", async () => {
    const t = await ev(() => document.querySelector('.pv14 [data-testid="footnote"]').textContent);
    if (!/Spots filled is every seat paid for and held\. MatchDay does not record check-in, so it is not attendance\./.test(t)) throw new Error("intro sentence changed");
    if (!/remainder of Spots filled is made up of other seat types/.test(t)) throw new Error("'other seat types' clause missing");
  });
  await check("table totals row equals the sum of the period rows", async () => {
    const r = await ev(() => {
      const rows = [...document.querySelectorAll(".pv14 tbody tr[data-k]")];
      const col = (i) => rows.reduce((s, row) => { const t = row.children[i].textContent.replace(/[^0-9]/g, ""); return s + (t ? +t : 0); }, 0);
      const foot = [...document.querySelectorAll(".pv14 tfoot td")];
      const fv = (i) => { const t = foot[i].textContent.replace(/[^0-9]/g, ""); return t ? +t : 0; };
      return { matches: [col(1), fv(1)], spots: [col(2), fv(2)], guests: [col(4), fv(4)] };
    });
    for (const [k, [c, f]] of Object.entries(r)) if (c !== f) throw new Error(`${k}: rows ${c} != foot ${f}`);
  });

  // ── negative controls ──
  console.log("\nNEGATIVE CONTROLS (each must FAIL cleanly)");
  let NCP = 0, NCF = 0;
  const reset = async () => { await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForSelector(".pv14 table", { timeout: 30_000 }); };
  const neg = async (name, mutate, assertFn) => {
    await reset(); await ev(mutate);
    let threw = false, msg = "";
    try { await assertFn(); } catch (e) { threw = true; msg = e.message; }
    if (threw) { NCP++; console.log(`  ✓ ${name} — caught: ${msg}`); }
    else { NCF++; console.log(`  ✗ ${name} — did NOT fail (vacuous!)`); }
  };
  const noMemberPromo = async () => { const hit = await ev(() => (document.querySelector(".pv14").innerText.match(/\b(member|promo)\w*/gi) || [])); if (hit.length) throw new Error(`found ${hit.join(",")}`); };
  const totalsFoot = async () => { const r = await ev(() => { const rows = [...document.querySelectorAll(".pv14 tbody tr[data-k]")]; const col = rows.reduce((s, row) => s + (+row.children[2].textContent.replace(/[^0-9]/g, "") || 0), 0); const foot = +document.querySelectorAll(".pv14 tfoot td")[2].textContent.replace(/[^0-9]/g, "") || 0; return { col, foot }; }); if (r.col !== r.foot) throw new Error(`spots rows ${r.col} != foot ${r.foot}`); };
  const eightCols = async () => { const cols = await ev(() => [...document.querySelectorAll(".pv14 thead th")].map((t) => t.textContent.trim())); if (JSON.stringify(cols) !== JSON.stringify(["Period", "Matches", "Spots filled", "Daily players", "Guests", "Revenue", "Your payment", "Status"])) throw new Error("column order broken"); };

  await neg("inject the word 'members' into the footnote", () => { document.querySelector('.pv14 [data-testid="footnote"]').textContent += " Members 25 and promo 5 spots are included."; }, noMemberPromo);
  await neg("drift the totals row", () => { const td = document.querySelectorAll(".pv14 tfoot td")[2]; td.textContent = String(+td.textContent.replace(/[^0-9]/g, "") + 5); }, totalsFoot);
  await neg("reorder a column header", () => { const ths = document.querySelectorAll(".pv14 thead th"); ths[2].textContent = "Guests"; }, eightCols);

  console.log(`\n================ RESULT ================`);
  console.log(`Assertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log(`   FAILED: ${f}`));
  console.log(`Negative controls: ${NCP}/${NCP + NCF} failed cleanly`);
  await browser.close();
  process.exit(FAIL === 0 && NCF === 0 ? 0 : 1);
}
main().catch(fatal);
