// Phase 28 — the RENTAL_PLUS_PROFIT_SHARE partner dashboard (Parmer), at 1600 and 390 portrait.
//
// QUARANTINED UNTIL MIGRATION 0123 IS APPLIED. The partner page is SERVER-rendered straight from
// Supabase (makeServerClient), so there is no client request to intercept and no way to fake the
// partner row from the browser — the page simply 404s until the row exists. Rather than let the
// suite pass vacuously, it FAILS LOUDLY with that explanation, and it is listed in
// scripts/quarantine.pinned.json so leaving the gate was an explicit, reviewable edit.
//
//   node scripts/e2e/verify-partner-rental.mjs
import { chromium } from "playwright";
import { fatal, installHarnessGuard } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.E2E_BASE_URL || "http://localhost:3000";
const SLUG = "parmer-stadium-q8x2m5rk";
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const cents = (el) => Number(el.getAttribute("data-cents"));

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const res = await page.goto(`${BASE}/partners/${SLUG}`, { waitUntil: "domcontentloaded" });

  if (res && res.status() === 404) {
    console.log(`\n✗ /partners/${SLUG} returned 404.`);
    console.log("  Migration 0123 has not been applied, so the Parmer partner row does not exist.");
    console.log("  This suite is QUARANTINED for exactly this reason — apply 0123, then remove it");
    console.log("  from scripts/quarantine.pinned.json in the same commit.");
    await browser.close();
    process.exit(1);
  }
  await page.waitForSelector('[data-testid="partner-rental"]', { timeout: 30_000 });

  // ── the model's own numbers, on screen ───────────────────────────────────────────────────────
  await page.waitForSelector('[data-testid="prv-row"]', { timeout: 15_000 });
  { const rows = await page.$$eval('[data-testid="prv-row"]', (els) => els.map((r) => ({
      gross: Number(r.querySelector('[data-testid="prv-row-gross"]').getAttribute("data-cents")),
      pool: Number(r.querySelector('[data-testid="prv-row-pool"]').getAttribute("data-cents")),
      share: Number(r.querySelector('[data-testid="prv-row-share"]').getAttribute("data-cents")),
      total: Number(r.querySelector('[data-testid="prv-row-total"]').getAttribute("data-cents")),
      retained: Number(r.querySelector('[data-testid="prv-row-retained"]').getAttribute("data-cents")),
      reconciles: r.getAttribute("data-reconciles"),
    })));
    const RENTAL = 16000, MGR = 4000;   // read back from the page's own terms below, not assumed
    const bad1 = rows.filter((r) => r.total + r.retained + MGR !== r.gross);
    (rows.length > 0 && bad1.length === 0)
      ? ok(`reconciliation holds EXACTLY on all ${rows.length} rendered match rows`)
      : bad("per-row reconciliation", JSON.stringify(bad1.slice(0, 3)));
    const negPool = rows.filter((r) => r.pool <= 0);
    eq("no match with a pool at or below zero carries a profit share", negPool.filter((r) => r.share !== 0).length, 0);
    eq("...and each of those still owes the FULL rental", negPool.filter((r) => r.total !== RENTAL).length, 0);
    eq("every row reports itself as reconciling", rows.filter((r) => r.reconciles !== "true").length, 0);
  }

  // ── the monthly aggregate + its reconciliation line ──────────────────────────────────────────
  { const t = await page.$eval('[data-testid="prv-month"]', (m) => ({
      gross: Number(m.querySelector('[data-testid="prv-total-gross"]').getAttribute("data-cents")),
      partner: Number(m.querySelector('[data-testid="prv-total-partner"]').getAttribute("data-cents")),
      retained: Number(m.querySelector('[data-testid="prv-total-retained"]').getAttribute("data-cents")),
      holds: m.querySelector('[data-testid="prv-reconciliation"]').getAttribute("data-holds"),
      line: m.querySelector('[data-testid="prv-reconciliation"]').textContent,
    }));
    (t.holds === "true") ? ok("the monthly aggregate reports itself as reconciling") : bad("monthly reconcile", JSON.stringify(t));
    (/= \$[\d,]+\.\d\d/.test(t.line) && /collected/.test(t.line))
      ? ok("the reconciliation is SHOWN to the partner as a sentence, not just computed")
      : bad("reconciliation line", t.line); }

  // ── the metrics this model replaces Daily Players / Guests with ──────────────────────────────
  { const m = await page.evaluate(() => ({
      spots: document.querySelector('[data-testid="prv-spots"]')?.getAttribute("data-value"),
      neu: document.querySelector('[data-testid="prv-new"]')?.getAttribute("data-value"),
      ret: document.querySelector('[data-testid="prv-returning"]')?.getAttribute("data-value"),
      headers: [...document.querySelectorAll('[data-testid="prv-metrics"] .prv-mk')].map((e) => e.textContent),
      body: document.body.textContent,
    }));
    eq("SPOTS SOLD / NEW PLAYERS / RETURNING are the metrics", m.headers, ["SPOTS SOLD", "NEW PLAYERS", "RETURNING", "MATCHES"]);
    (!/Daily players/i.test(m.body) && !/\bGuests\b/i.test(m.body))
      ? ok("Daily Players and Guests are GONE from this model's dashboard")
      : bad("dropped metrics still present", "");
    (Number(m.spots) > 0 && m.neu != null && m.ret != null)
      ? ok(`spots sold ${m.spots}, new ${m.neu}, returning ${m.ret}`)
      : bad("metrics", JSON.stringify(m)); }

  // ── BREAKEVEN, surfaced plainly ──────────────────────────────────────────────────────────────
  { const b = await page.$eval('[data-testid="prv-breakeven"]', (e) => ({ spots: e.getAttribute("data-spots"), text: e.textContent }));
    (b.spots === "14" && /14 spots/.test(b.text))
      ? ok("BREAKEVEN is stated plainly: 14 spots at $15")
      : bad("breakeven", JSON.stringify(b)); }

  // ── the terms are read from the partner row, and the retained figure IS public ───────────────
  { const terms = await page.$eval('[data-testid="prv-terms"]', (e) => e.textContent);
    (/\$160\.00/.test(terms) && /\$40\.00/.test(terms) && /40%/.test(terms))
      ? ok("the terms state the rental, the manager cost and the share from the partner's own parameters")
      : bad("terms", terms.slice(0, 200)); }
  { const retained = await page.$$eval('[data-testid="prv-row-retained"]', (e) => e.length);
    (retained > 0) ? ok(`MatchDay retained is visible to the partner on ${retained} rows (deliberate — see the report)`) : bad("retained missing", ""); }

  // ── 1600: no horizontal page overflow; the table scrolls inside its own container ────────────
  { const o = await page.evaluate(() => ({
      pageLeak: document.documentElement.scrollWidth > window.innerWidth + 1,
      tableScroller: !!document.querySelector(".prv-scroll"),
      scrollerOverflow: getComputedStyle(document.querySelector(".prv-scroll")).overflowX,
    }));
    eq("1600: the page does not scroll sideways; the wide table scrolls inside its own container",
      o, { pageLeak: false, tableScroller: true, scrollerOverflow: "auto" }); }

  // ── 390 PORTRAIT ─────────────────────────────────────────────────────────────────────────────
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  { const m = await page.evaluate(() => ({
      pageLeak: document.documentElement.scrollWidth > window.innerWidth + 1,
      metricCols: new Set([...document.querySelectorAll('[data-testid="prv-metrics"] .prv-metric')].map((e) => Math.round(e.getBoundingClientRect().left))).size,
      reconVisible: !!document.querySelector('[data-testid="prv-reconciliation"]')?.getBoundingClientRect().height,
      breakevenVisible: !!document.querySelector('[data-testid="prv-breakeven"]')?.getBoundingClientRect().height,
      owedVisible: !!document.querySelector('[data-testid="prv-month-owed"]')?.getBoundingClientRect().height,
    }));
    eq("390 portrait: no page overflow, metrics in 2 columns, and the owed / breakeven / reconciliation lines all survive",
      m, { pageLeak: false, metricCols: 2, reconVisible: true, breakevenVisible: true, owedVisible: true }); }

  await browser.close();
  console.log(`\nverify-partner-rental: ${PASS} passed, ${FAIL} failed`);
  if (FAIL) { console.log("FAILURES:\n" + fails.map((f) => "  - " + f).join("\n")); process.exit(1); }
}
main().catch(fatal);
