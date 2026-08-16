// PARTNER PAYOUT — Parmer's public page, against REAL PRODUCTION DATA.
//
// NOT FIXTURED, DELIBERATELY. This page tells a venue owner what they are owed. A fixture proves
// the renderer works on numbers I chose; it cannot catch the two bugs that were actually here —
// an unplayed match being billed for, and cancelled roster rows counted as sold spots — because
// both live in how real rows are classified. The trade is that this suite depends on production
// data being present; it fails loudly (not vacuously) when it is not.
//
// THE CENTRAL ASSERTION is that FOUR NUMBERS ARE THE SAME NUMBER: the headline, the detail-table
// footer, the current month's row in the period list, and the phone. They are four renderings of
// one figure, and they disagreed before this rebuild because only some of them existed.
//
//   node scripts/e2e/verify-partner-payout.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { netRetry, installHarnessGuard, fatal, closeContext, closeBrowser } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";
const SLUG = "parmer-stadium-q8x2m5rk";
const PAGE = `${BASE}/partners/${SLUG}`;

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const RENTAL = 16000, MANAGER = 4000, SHARE_PCT = 40;

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const browser = await chromium.launch({ headless: true });
  const read = async (viewport) => {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    await page.goto(PAGE, { waitUntil: "domcontentloaded" });
    // PRESENCE WAIT on the page's own root before anything is measured or claimed absent.
    await page.waitForSelector('[data-testid="partner-rental"]', { timeout: 45000 });
    await page.waitForSelector('[data-testid="prv-total-row"]', { timeout: 45000 });
    await page.waitForTimeout(300);
    return { ctx, page };
  };

  console.log("partner payout — Parmer, real production data\n");

  const { ctx, page } = await read({ width: 1400, height: 1300 });

  // ── THE FOUR NUMBERS ─────────────────────────────────────────────────────
  console.log("the four figures that must be one figure:");
  const cents = (sel) => page.$eval(sel, (e) => e.getAttribute("data-cents"));
  const four = {
    headline: await cents('[data-testid="prv-headline"]'),
    detailFooter: await cents('[data-testid="prv-total-partner"]'),
    periodRow: await cents('[data-testid="prv-period-total"]'),
    phone: await cents('[data-testid="prv-period-total-mobile"]'),
  };
  const distinct = [...new Set(Object.values(four))];
  distinct.length === 1
    ? ok(`headline, detail footer, period row and phone all read ${(Number(distinct[0]) / 100).toFixed(2)}`)
    : bad("the four totals disagree", JSON.stringify(four));
  // POSITIVE CONTROL — a figure was actually found. All-null would satisfy "they agree".
  eq("…and it is a real figure, not four nulls", distinct[0] != null && Number(distinct[0]) > 0, true);

  // ── PER-ROW ARITHMETIC ───────────────────────────────────────────────────
  console.log("\nevery row's arithmetic, in cents:");
  const rows = await page.$$eval('[data-testid="prv-row"]', (els) => els.map((r) => ({
    match: r.getAttribute("data-match"),
    spots: Number(r.querySelector('[data-testid="prv-row-spots"]').textContent.trim()),
    gross: Number(r.querySelector('[data-testid="prv-row-gross"]').getAttribute("data-cents")),
    pool: Number(r.querySelector('[data-testid="prv-row-pool"]').getAttribute("data-cents")),
    share: Number(r.querySelector('[data-testid="prv-row-share"]').getAttribute("data-cents")),
    mdShare: Number(r.querySelector('[data-testid="prv-row-mdshare"]').getAttribute("data-cents")),
    total: Number(r.querySelector('[data-testid="prv-row-total"]').getAttribute("data-cents")),
  })));
  eq("the month renders played rows at all", rows.length > 0, true);
  {
    const poolBad = rows.filter((r) => r.pool !== r.gross - RENTAL - MANAGER);
    const totalBad = rows.filter((r) => r.total !== RENTAL + r.share);
    const mdBad = rows.filter((r) => r.mdShare !== r.pool - r.share);
    const shareBad = rows.filter((r) => r.share !== (r.pool > 0 ? Math.round((r.pool * SHARE_PCT) / 100) : 0));
    eq("pool = revenue − rental − manager, every row", poolBad, []);
    eq("total = rental + share, every row", totalBad, []);
    eq("MatchDay share = pool − your share, every row", mdBad, []);
    eq(`your share = ${SHARE_PCT}% of a positive pool, every row`, shareBad, []);
  }

  // ── THE FOOTER IS THE SUM OF THE ROWS ────────────────────────────────────
  console.log("\nthe footer is the sum of the rows above it:");
  {
    const f = {
      spots: Number(await page.$eval('[data-testid="prv-total-spots"]', (e) => e.textContent.trim())),
      gross: Number(await cents('[data-testid="prv-total-gross"]')),
      share: Number(await cents('[data-testid="prv-total-share"]')),
      total: Number(await cents('[data-testid="prv-total-partner"]')),
    };
    const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
    eq("spots", f.spots, sum("spots"));
    eq("revenue", f.gross, sum("gross"));
    eq("your share", f.share, sum("share"));
    eq("the partner total", f.total, sum("total"));
  }

  // ── NO UNPLAYED MATCH CONTRIBUTES ────────────────────────────────────────
  console.log("\nan unplayed match is listed and contributes nothing:");
  {
    const sched = await page.$$eval('[data-testid="prv-sched-row"]', (els) => els.map((e) => e.getAttribute("data-match")));
    const played = new Set(rows.map((r) => r.match));
    eq("scheduled matches are LISTED, not hidden", sched.length > 0, true);
    eq("…and none of them is also a counted row", sched.filter((s) => played.has(s)), []);
    eq("…each says so in its own row", await page.$$eval('[data-testid="prv-sched-row"]', (els) => els.every((e) => /not played yet/i.test(e.textContent))), true);
    eq("…and shows 'not counted' in the total column", await page.$eval('[data-testid="prv-sched-total"]', (e) => e.textContent.trim()), "not counted");
    // The identity that proves it: the footer equals the sum of PLAYED rows only, already asserted
    // above — so a scheduled match cannot be inside it.
    eq("…the match count counts only played matches", rows.length, Number(await page.$eval('[data-testid="prv-matches"]', (e) => e.getAttribute("data-value"))));
  }

  // ── NO SPOT COUNT EXCEEDS ITS OWN MATCH'S CAPACITY ───────────────────────
  console.log("\nno spot count exceeds its own match's capacity:");
  {
    const ids = rows.map((r) => Number(r.match)).filter(Boolean);
    const { data: caps } = await netRetry(() => svc.from("mdapi_matches").select("api_id, max_player_count").in("api_id", ids), "caps");
    const capOf = new Map((caps ?? []).map((c) => [String(c.api_id), c.max_player_count]));
    // POSITIVE CONTROL: capacities were actually found, or "nothing exceeds" is vacuous.
    eq("capacities were read for every rendered match", ids.length > 0 && ids.every((i) => capOf.get(String(i)) != null), true);
    const over = rows.filter((r) => { const c = capOf.get(r.match); return c != null && r.spots > c; })
      .map((r) => `${r.match}: ${r.spots} of ${capOf.get(r.match)}`);
    eq("every match is within its capacity", over, []);
  }

  // ── THE PERIOD LIST AGREES WITH THE DETAIL ───────────────────────────────
  console.log("\nthe period list and the detail agree:");
  eq("the current month's payment equals its detail footer",
    await cents('[data-testid="prv-period-total"]'), await cents('[data-testid="prv-total-partner"]'));
  {
    const st = await page.$eval('[data-testid="prv-status"]', (e) => e.getAttribute("data-status"));
    ["in_progress", "due", "nothing_owed"].includes(st)
      ? ok(`the status chip is a state that can be derived (${st})`)
      : bad("undeliverable status", st);
    // "Paid" cannot be derived — nothing records a payment — so it must never render.
    eq("…and 'Paid' never renders, because nothing records it",
      await page.evaluate(() => /\bPaid\b/.test(document.body.innerText)), false);
  }

  // ── THE WORDS ────────────────────────────────────────────────────────────
  console.log("\nthe copy:");
  {
    const txt = await page.evaluate(() => document.body.innerText);
    eq("the word 'owed' appears nowhere while the month is open", /owed/i.test(txt), false);
    eq("…and the month IS open (so that assertion had something to be true about)",
      await page.$('[data-testid="prv-sofar"]') !== null, true);
    eq("'MatchDay retained' appears nowhere", /MatchDay retained/i.test(txt), false);
    // POSITIVE CONTROL for the two absence checks above: the page did render its money copy.
    eq("…the page really rendered (control for the two absence checks)", /MatchDay share/i.test(txt), true);
    eq("the green box carries BOTH halves of the deal",
      await page.$eval('[data-testid="prv-green"]', (e) => e.textContent.replace(/\s+/g, " ").trim()),
      "$160.00 rental + 40% of the pool");
    eq("breakeven is stated in DOLLARS, not spots",
      await page.$eval('[data-testid="prv-breakeven"]', (e) => /\$200\.00 of revenue/.test(e.textContent) && !/\bspots?\b/i.test(e.textContent)), true);
    eq("the total column takes the partner's name",
      await page.$eval('[data-testid="prv-total-head"]', (e) => e.textContent.trim()), "Parmer total");
  }

  // ── THE TILES DO NOT REPEAT EACH OTHER ───────────────────────────────────
  console.log("\nthe stat tiles:");
  {
    const tiles = await page.$$eval('[data-testid="prv-metrics"] [data-value]', (els) =>
      els.map((e) => ({ k: e.querySelector("span").textContent.trim(), v: e.getAttribute("data-value") })));
    eq("four tiles render", tiles.length, 4);
    const dupes = tiles.map((t) => t.v).filter((v, i, a) => a.indexOf(v) !== i);
    // NEW 130 beside PLAYERS 130 was the bug: two defensible numbers that look broken together.
    eq("no two tiles show the same number under different labels", dupes, []);
    const players = Number(tiles.find((t) => t.k === "PLAYERS")?.v);
    const returning = Number(tiles.find((t) => t.k === "RETURNING")?.v);
    eq("PLAYERS and RETURNING are both present", Number.isFinite(players) && Number.isFinite(returning), true);
    eq("…and RETURNING is a subset of PLAYERS, never larger", returning <= players, true);
  }

  // ── THE TOTAL COLUMN WINS THE ROW ────────────────────────────────────────
  {
    const sizes = await page.evaluate(() => {
      const row = document.querySelector('[data-testid="prv-total-row"]');
      const tot = row.querySelector('[data-testid="prv-total-partner"]');
      const others = [...row.querySelectorAll("td")].filter((td) => td !== tot);
      return { tot: parseFloat(getComputedStyle(tot).fontSize), max: Math.max(...others.map((td) => parseFloat(getComputedStyle(td).fontSize))) };
    });
    sizes.tot > sizes.max
      ? ok(`the footer's partner total is the largest number in the footer (${sizes.tot}px vs ${sizes.max}px)`)
      : bad("footer total not largest", JSON.stringify(sizes));
  }
  await closeContext(ctx);

  // ── PHONE, 390 PORTRAIT ──────────────────────────────────────────────────
  console.log("\nphone at 390 portrait:");
  {
    const { ctx: mctx, page: mp } = await read({ width: 390, height: 844 });
    eq("the phone shows the SAME figure as the desktop headline",
      await mp.$eval('[data-testid="prv-period-total-mobile"]', (e) => e.getAttribute("data-cents")), four.headline);
    eq("the period list is a first-class list, not the desktop table",
      await mp.evaluate(() => {
        const t = document.querySelector('[data-testid="prv-periods"]');
        const l = document.querySelector('[data-testid="prv-periods-mobile"]');
        return { table: t ? getComputedStyle(t.closest("div")).display : "absent", list: l ? getComputedStyle(l).display : "absent" };
      }), { table: "none", list: "block" });
    eq("nothing overflows the page at 390",
      await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
    await closeContext(mctx);
  }

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await closeBrowser(browser);
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch(fatal);
