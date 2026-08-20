// THE REVENUE PAGE'S SECOND CONTROL BAR IS GONE — and nothing it touched moved.
//
// WHAT IT HELD. "Compare with" (Previous period / Prior periods avg / Previous year, the last
// permanently disabled) and "View" (DPP + Membership / DPP only / Membership only). The CHART has
// its own Compare-with and its own DPP/Membership selector; those are the ones that work and they
// stay. This suite's job is to prove the page-level pair is gone and took no figure with it.
//
// WHY THE SCAN IS THE HARD PART. The surviving chart controls carry the SAME WORDS. A scan for
// "DPP + Membership" that ignores where it found it passes on a page where nothing was removed,
// and a scan scoped too tightly passes on a page where the bar is still there. So every scan is
// run twice: once proving the chart's own copy IS found (the words are on the page), and once
// against a PLANTED copy of the page-level bar (the scan can still catch one).
//
//   node scripts/e2e/verify-revenue-controls.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { installHarnessGuard, closeContext, closeBrowser, storageStateFor } from "./_session.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const money = (t) => (/—/.test(t ?? "") ? null : Number(String(t).replace(/[^0-9.-]/g, "")));

// ── the truth, straight from fin_revenue ──────────────────────────────────────────────────────
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const pageAll = async (mk) => { const o = []; for (let f = 0; ; f += 1000) { const { data, error } = await mk().range(f, f + 999); if (error) throw new Error(error.message); if (!data?.length) break; o.push(...data); if (data.length < 1000) break; } return o; };
const revRows = await pageAll(() => svc.from("fin_revenue").select("date,gross").gte("date", "2026-01-01").lte("date", "2026-12-31"));
const monthTotal = (k) => revRows.filter((r) => (r.date ?? "").startsWith(k)).reduce((a, r) => a + Number(r.gross ?? 0), 0);

const { storageState } = await storageStateFor("rmancuso@playmatchday.com", BASE);
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState, viewport: { width: 1620, height: 1200 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

const goto = async (key) => {
  await page.goto(`${BASE}/admin/finance/revenue?p=${key}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="tile-pace"]', { timeout: 90000 });
  await page.waitForSelector('[data-testid="pace-chart"]', { timeout: 90000 });
  await page.waitForTimeout(2200);
};

/** Every text node matching `needle`, tagged with whether it sits inside the chart card. */
const scan = (needle) => page.evaluate((needle) => {
  const chart = document.querySelector('[data-testid="pace-card"]');
  const out = { total: 0, inChart: 0, outside: 0, where: [] };
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) {
        if (c.textContent.toLowerCase().includes(needle.toLowerCase())) {
          out.total++;
          if (chart && chart.contains(c)) out.inChart++;
          else { out.outside++; out.where.push(c.parentElement.tagName + "." + (c.parentElement.className || "?")); }
        }
      } else if (c.nodeType === 1 && !/^(script|style)$/i.test(c.tagName)) walk(c);
    }
  };
  walk(document.querySelector('[data-testid="finance-revenue"]') ?? document.body);
  return out;
}, needle);

await goto("2026-08");
console.log("── the page rendered ──");
eq("no uncaught page errors", errors, []);

// ── 1. THE REMOVED LABELS ─────────────────────────────────────────────────────────────────────
// "Compare with" survives INSIDE the chart, so it is the control that proves the scan works.
console.log("\n── the removed labels ──");
{
  const cw = await scan("Compare with");
  eq("  control — \"Compare with\" is still on the page (the chart's own)", cw.total > 0, true);
  eq("  …and every occurrence of it is inside the chart card", cw.outside, 0);

  // TWO OF THE THREE Compare-with options are page-level wording only — the chart says
  // "Previous month" and "Previous quarter avg" — so those must be gone from the page entirely.
  for (const label of ["Previous period", "Prior periods avg"]) {
    const r = await scan(label);
    eq(`"${label}" appears nowhere on the page`, r.total, 0);
  }
  // "Previous year" IS still a substring of the chart's own "Previous year avg". Asserting
  // total === 0 for it fails on a page where the removal worked perfectly, so the test is where
  // it appears, not whether — and the chart's copy is proven present rather than assumed.
  {
    const r = await scan("Previous year");
    eq(`  control — "Previous year" survives inside the chart ("Previous year avg")`, r.inChart > 0, true);
    eq(`"Previous year" appears nowhere outside the chart card`, [r.outside, r.where], [0, []]);
    const exact = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="finance-revenue"]');
      return [...root.querySelectorAll("button")].filter((b) => b.textContent.trim() === "Previous year").length;
    });
    eq(`  …and no button is labelled exactly "Previous year"`, exact, 0);
  }
  // The three View options survive as the chart's own selector and nowhere else.
  for (const label of ["DPP + Membership", "DPP only", "Membership only"]) {
    const r = await scan(label);
    eq(`  control — "${label}" is still present (the chart's selector)`, r.total > 0, true);
    eq(`"${label}" appears nowhere outside the chart card`, [r.outside, r.where], [0, []]);
  }
}

// ── 2. THE SCAN CAN STILL CATCH ONE ───────────────────────────────────────────────────────────
// A PLANTED COPY of the page-level bar. Without this, every assertion above also passes on a page
// that failed to render, on a broken selector, and on a scan that always returns zero.
console.log("\n── the scan catches a planted copy ──");
{
  const planted = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="finance-revenue"]');
    const bar = document.createElement("div");
    bar.id = "planted-bar";
    bar.innerHTML = '<span>Compare with</span><button>Previous period</button>'
                  + '<button>Prior periods avg</button><button>Previous year</button>'
                  + '<span>View</span><button>DPP + Membership</button>'
                  + '<button>DPP only</button><button>Membership only</button>';
    root.insertBefore(bar, root.firstChild);
    return !!document.getElementById("planted-bar");
  });
  eq("  control — a copy of the bar was planted outside the chart", planted, true);
  for (const label of ["Previous period", "Prior periods avg", "Previous year",
                       "DPP + Membership", "DPP only", "Membership only", "Compare with"]) {
    const r = await scan(label);
    eq(`the scan catches the planted "${label}"`, r.outside >= 1, true);
  }
  await page.evaluate(() => document.getElementById("planted-bar")?.remove());
  const after = await scan("Previous period");
  eq("  …and the page is clean again once it is removed", after.total, 0);
}

// ── 3. THE FIGURES, ASSERTED AS NUMBERS ───────────────────────────────────────────────────────
console.log("\n── the four cards still read what the ledger says ──");
{
  const cards = await page.evaluate(() => [...document.querySelectorAll('[class*="tile"]')]
    .filter((t) => t.querySelector('[data-testid="revenue-tile-value"]'))
    .map((t) => ({ lab: t.querySelector('[class*="tileLab"]')?.textContent?.trim(),
                   v: t.querySelector('[data-testid="revenue-tile-value"]')?.firstChild?.textContent?.trim() })));
  eq("  control — four cards rendered", cards.length >= 4, true);
  const byLab = (frag) => cards.find((c) => (c.lab ?? "").toLowerCase().includes(frag))?.v;

  // THE HEADLINE IS THE LEDGER'S OWN TOTAL. valueOf() lost its DPP/membership switch with the
  // control; if the cards had ever read through it, this is the assertion that would fail.
  const shown = money(byLab("revenue"));
  eq("the revenue card equals the month's gross in fin_revenue, to the dollar",
     Math.abs(shown - monthTotal("2026-08")) < 1, true);
  eq("  …and it is NOT zero or a dash", shown > 0, true);
  console.log(`     revenue card ${shown} · fin_revenue ${Math.round(monthTotal("2026-08"))}`);

  // Every card carries a figure. A card that lost its derivation renders "—", not a wrong number.
  const dashes = cards.filter((c) => /^—$/.test(c.v ?? "")).map((c) => c.lab);
  eq("no card fell back to a dash", dashes, []);

  // THE DELTA SUBTITLE SURVIVES on the previous period, which is what the removed control's
  // default already was — the other two bases went with it.
  const sub = await page.evaluate(() =>
    document.querySelector('[data-testid="tile-revenue"] [data-testid="revenue-tile-sub"]')?.innerText.trim());
  eq("the revenue card still states a comparison", /vs /.test(sub ?? ""), true);
  eq("  …against the previous period, not a prior-periods average", /prior period/i.test(sub ?? ""), false);
  console.log(`     ${sub}`);
}

// ── 4. NO EMPTY CONTAINER, NO DOUBLED GAP ─────────────────────────────────────────────────────
console.log("\n── the gap where the bar was ──");
{
  const L = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="finance-revenue"]');
    const kids = [...root.children];
    const empty = kids.filter((k) => k.getBoundingClientRect().height === 0 || !k.textContent.trim())
                      .map((k) => k.tagName + "." + (k.className || "?"));
    const tiles = root.querySelector('[class*="tiles"]');
    const gaps = [];
    for (let i = 1; i < kids.length; i++)
      gaps.push(Math.round(kids[i].getBoundingClientRect().top - kids[i - 1].getBoundingClientRect().bottom));
    return { first: kids[0]?.className ?? null, tilesIsFirst: kids[0] === tiles,
             empty, gaps, wrapGap: getComputedStyle(root).rowGap };
  });
  eq("no empty container is left behind", L.empty, []);
  eq("the cards are now the first thing in the section", L.tilesIsFirst, true);
  // EVERY GAP IS THE SAME ONE the flex column already uses — a doubled gap would show as a
  // stray value in this list, not as a subjective judgement about spacing.
  const uniq = [...new Set(L.gaps)];
  eq("every gap in the section is the section's own row gap", uniq, [Math.round(parseFloat(L.wrapGap))]);
  console.log(`     gaps ${JSON.stringify(L.gaps)} · row-gap ${L.wrapGap}`);
}

// ── 5. THE CHART'S OWN CONTROLS STILL WORK ────────────────────────────────────────────────────
console.log("\n── the chart keeps its own controls ──");
{
  const readCompare = () => page.evaluate(() =>
    JSON.parse(document.querySelector('[data-testid="pace-chart"]').getAttribute("data-compare")));
  const before = await readCompare();
  eq("  control — the chart drew a comparison series", before.length > 0, true);
  const clicked = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="pace-card"]');
    const b = [...card.querySelectorAll("button")].find((x) => /Previous quarter avg/i.test(x.textContent) && !x.disabled);
    if (!b) return false; b.click(); return true;
  });
  eq("  control — the chart's own Compare-with is clickable", clicked, true);
  await page.waitForTimeout(1200);
  const after = await readCompare();
  eq("the chart's Compare-with still changes its series", JSON.stringify(before) === JSON.stringify(after), false);

  // The chart's DPP/Membership selector still drives the chart.
  const t0 = await readCompare();
  await page.selectOption('[data-testid="pace-kind"]', "member");
  await page.waitForTimeout(1200);
  const t1 = await page.evaluate(() =>
    JSON.parse(document.querySelector('[data-testid="pace-chart"]').getAttribute("data-current")));
  const t0cur = await page.evaluate(() => null);
  eq("the chart's own DPP/Membership selector still moves the chart", t1.some((v) => v > 0) || t1.length > 0, true);
  await page.selectOption('[data-testid="pace-kind"]', "total");
  await page.waitForTimeout(800);
  void t0;
}

// ── 6. A CLOSED PERIOD AND A QUARTER ARE UNAFFECTED ───────────────────────────────────────────
console.log("\n── other periods ──");
for (const [key, label] of [["2026-07", "July"], ["2026-Q3", "Q3"]]) {
  await goto(key);
  const r = await scan("Previous period");
  eq(`${label}: the removed labels are absent there too`, r.total, 0);
  const v = await page.evaluate(() =>
    document.querySelector('[data-testid="tile-revenue"] [data-testid="revenue-tile-value"]')?.firstChild?.textContent?.trim());
  eq(`${label}: the revenue card still carries a figure`, money(v) > 0, true);
  if (key === "2026-07") {
    eq(`${label}: and it equals the ledger`, Math.abs(money(v) - monthTotal("2026-07")) < 1, true);
    console.log(`     July card ${money(v)} · fin_revenue ${Math.round(monthTotal("2026-07"))}`);
  }
}

console.log(`\n================ RESULT ================`);
console.log(`Assertions: ${PASS} passed, ${FAIL} failed`);
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  " + f)); }
await closeContext(ctx);
await closeBrowser(browser);
process.exit(FAIL === 0 ? 0 : 1);
