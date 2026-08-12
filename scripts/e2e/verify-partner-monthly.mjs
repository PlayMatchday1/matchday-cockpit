// Playwright verify for the monthly-cadence partner dashboard (Hattrick) against
// the production build served locally. Run: node scripts/e2e/verify-partner-monthly.mjs

import { chromium } from "playwright";
import { fatal, installHarnessGuard } from "./_session.mjs";
installHarnessGuard();
const BASE = process.env.E2E_BASE_URL || "http://localhost:3000";
const SLUG = "hattrick-yx4sur4t";
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const check = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e.message); } };

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext()).newPage();
  const ev = (fn, arg) => page.evaluate(fn, arg);
  await page.goto(`${BASE}/partners/${SLUG}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".pm14 table", { timeout: 30_000 });

  console.log("POSITIVE ASSERTIONS");
  await check("5 since-launch tiles incl. 'Cancelled inside 24 hours'", async () => {
    const tiles = await ev(() => [...document.querySelectorAll(".pm14 .tiles .tl")].map((t) => t.textContent.trim()));
    if (tiles.length !== 5) throw new Error(`${tiles.length} tiles`);
    for (const w of ["Spots filled", "Booked by registered players", "Guest spots", "Cancelled inside 24 hours", "Distinct people"]) if (!tiles.includes(w)) throw new Error(`missing tile ${w}`);
  });
  await check("9 columns in exact order", async () => {
    const cols = await ev(() => [...document.querySelectorAll(".pm14 thead th")].map((t) => t.textContent.trim()));
    const want = ["Period", "Matches", "Spots filled", "Daily players", "Guests", "Qualifying revenue", "Your payment", "Status", "When"];
    if (JSON.stringify(cols) !== JSON.stringify(want)) throw new Error(JSON.stringify(cols));
  });
  await check("months are newest LAST (ascending), opening period first", async () => {
    const r = await ev(() => { const rows = [...document.querySelectorAll(".pm14 tbody tr[data-k]")]; return { keys: rows.map((x) => x.dataset.k), firstOpening: !!rows[0].querySelector(".tag") }; });
    if (JSON.stringify(r.keys) !== JSON.stringify([...r.keys].sort())) throw new Error("not ascending");
    if (!r.firstOpening) throw new Error("first row is not the opening period");
  });
  await check("opening period tagged with em-dash counts", async () => {
    const r = await ev(() => { const row = [...document.querySelectorAll(".pm14 tbody tr")].find((x) => x.querySelector(".tag")); if (!row) return { missing: true }; return { matches: row.children[1].textContent.trim(), spots: row.children[2].textContent.trim(), pay: row.children[6].textContent.trim() }; });
    if (r.missing) throw new Error("no opening-period row");
    if (r.matches !== "—" || r.spots !== "—") throw new Error(`opening counts not em-dash: ${r.matches}/${r.spots}`);
    if (!/\$/.test(r.pay)) throw new Error(`opening has no payment: ${r.pay}`);
  });
  await check("running month: In progress + 'Not yet calculated' payment + partial note", async () => {
    const r = await ev(() => { const row = document.querySelector(".pm14 tbody tr.running"); if (!row) return { missing: true }; return { pill: row.querySelector(".pill")?.textContent.trim(), pay: row.children[6].textContent, note: row.querySelector(".sub")?.textContent || "" }; });
    if (r.missing) throw new Error("no running month");
    if (r.pill !== "In progress") throw new Error(`pill ${r.pill}`);
    if (!/Not yet calculated/.test(r.pay)) throw new Error(`payment "${r.pay}"`);
    if (!/Partial/.test(r.note)) throw new Error("no partial note");
  });
  await check("private rental itemised inside the revenue cell (Morning Match), never a match count", async () => {
    const r = await ev(() => { const sub = [...document.querySelectorAll(".pm14 tbody .sub.rent")]; return { n: sub.length, txt: sub[0]?.textContent || "", inMatchCol: sub.some((s) => s.closest("td") !== s.closest("tr").children[5]) }; });
    if (r.n === 0) throw new Error("no rental sub-line in any month");
    if (!/matches \+ \$\d+ Morning Match/.test(r.txt)) throw new Error(`rental line "${r.txt}"`);
    if (r.inMatchCol) throw new Error("rental sub-line not in the revenue column");
  });
  await check("two totals: detailed counts + closed payment, with rental split", async () => {
    const r = await ev(() => { const f = document.querySelector(".pm14 tfoot tr"); return { text: f.textContent, hasDetail: /months with detail/.test(f.textContent), hasClosed: /closed months only/.test(f.textContent), hasRentSplit: /matches \+ \$[\d,]+ rentals/.test(f.textContent) }; });
    if (!r.hasDetail) throw new Error("no 'months with detail' total");
    if (!r.hasClosed) throw new Error("no 'closed months only' total");
    if (!r.hasRentSplit) throw new Error("no rental split in revenue total");
  });
  await check("last-8-weeks strip has week cards", async () => {
    const n = await ev(() => document.querySelectorAll('.pm14 [data-testid="week-card"]').length);
    if (n === 0 || n > 8) throw new Error(`${n} week cards`);
  });
  await check("'member'/'promo' appear nowhere in rendered text", async () => {
    const hit = await ev(() => (document.querySelector(".pm14").innerText.match(/\b(member|promo)\w*/gi) || []));
    if (hit.length) throw new Error(`found: ${[...new Set(hit)].join(", ")}`);
  });
  await check("footnote names 'other seat types' and explains rentals", async () => {
    const t = await ev(() => document.querySelector('.pm14 [data-testid="footnote"]').textContent);
    if (!/remainder of Spots filled is made up of other seat types/.test(t)) throw new Error("'other seat types' missing");
    if (!/A private rental is a booking with no MatchDay match behind it/.test(t)) throw new Error("rental explanation missing");
  });
  await check("detailed totals equal the sum of the detail rows", async () => {
    const r = await ev(() => {
      const rows = [...document.querySelectorAll(".pm14 tbody tr[data-k]")].filter((row) => row.children[1].textContent.trim() !== "—");
      const col = (i) => rows.reduce((s, row) => s + (+row.children[i].textContent.replace(/[^0-9]/g, "").slice(0, 12) || 0), 0);
      const foot = [...document.querySelectorAll(".pm14 tfoot td")];
      const fv = (i) => +foot[i].firstChild.textContent.replace(/[^0-9]/g, "") || 0;
      return { m: [col(1), fv(1)], s: [col(2), fv(2)], g: [col(4), fv(4)] };
    });
    for (const [k, [c, f]] of Object.entries(r)) if (c !== f) throw new Error(`${k}: rows ${c} != foot ${f}`);
  });

  // ── negative controls ──
  console.log("\nNEGATIVE CONTROLS");
  let NCP = 0, NCF = 0;
  const reset = async () => { await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForSelector(".pm14 table", { timeout: 30_000 }); };
  const neg = async (name, mutate, assertFn) => { await reset(); await ev(mutate); let t = false, m = ""; try { await assertFn(); } catch (e) { t = true; m = e.message; } if (t) { NCP++; console.log(`  ✓ ${name} — caught: ${m}`); } else { NCF++; console.log(`  ✗ ${name} — vacuous!`); } };
  const noMP = async () => { const h = await ev(() => (document.querySelector(".pm14").innerText.match(/\b(member|promo)\w*/gi) || [])); if (h.length) throw new Error(`found ${h.join(",")}`); };
  const nineCols = async () => { const c = await ev(() => [...document.querySelectorAll(".pm14 thead th")].map((t) => t.textContent.trim())); if (JSON.stringify(c) !== JSON.stringify(["Period", "Matches", "Spots filled", "Daily players", "Guests", "Qualifying revenue", "Your payment", "Status", "When"])) throw new Error("order broken"); };
  const openingEm = async () => { const r = await ev(() => { const row = [...document.querySelectorAll(".pm14 tbody tr")].find((x) => x.querySelector(".tag")); return { m: row.children[1].textContent.trim(), s: row.children[2].textContent.trim() }; }); if (r.m !== "—" || r.s !== "—") throw new Error(`opening counts ${r.m}/${r.s}`); };

  await neg("inject 'members' into the footnote", () => { document.querySelector('.pm14 [data-testid="footnote"]').textContent += " Members 24 and promo 6 are included."; }, noMP);
  await neg("reorder a column header", () => { document.querySelectorAll(".pm14 thead th")[5].textContent = "Guests"; }, nineCols);
  await neg("put a count on the opening period", () => { const row = [...document.querySelectorAll(".pm14 tbody tr")].find((x) => x.querySelector(".tag")); row.children[1].textContent = "21"; }, openingEm);

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log(`   FAILED: ${f}`));
  console.log(`Negative controls: ${NCP}/${NCP + NCF} failed cleanly`);
  await browser.close();
  process.exit(FAIL === 0 && NCF === 0 ? 0 : 1);
}
main().catch(fatal);
